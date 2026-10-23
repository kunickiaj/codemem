import { env } from "cloudflare:workers";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519KeyId } from "../../core/src/coordinator-ed25519-key-id.js";
import {
	type CoordinatorLegacyTeamCompletionManifestV1,
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
} from "../../core/src/coordinator-legacy-team-completion.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "../../core/src/recipient-policy-identifiers.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";

const NOW = "2026-09-01T00:00:00.000Z";

function publicKeyFor(index: number): string {
	// Synthetic deterministic seeds produce real curve points, not fabricated SSH bytes.
	const seed = Buffer.alloc(32);
	seed.writeUInt32BE(index);
	const privateKey = createPrivateKey({
		key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
		format: "der",
		type: "pkcs8",
	});
	const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
	const wire = Buffer.concat([
		Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
		publicKey.subarray(-32),
	]);
	return `ssh-ed25519 ${wire.toString("base64")}`;
}

function roster(groupId: string, count: number, offset = 0) {
	return Array.from({ length: count }, (_, index) => ({
		deviceId: `${groupId}-device-${index}`,
		owner: `${groupId}-owner-${index}`,
		publicKey: publicKeyFor(index + offset),
	}));
}

function manifest(groupId: string, devices: ReturnType<typeof roster>) {
	const coordinatorId = "native-legacy-owner-coordinator";
	const candidateRef = legacyTeamCandidateId(coordinatorId, groupId);
	const input: CoordinatorLegacyTeamCompletionManifestV1 = {
		version: 1,
		coordinator_id: coordinatorId,
		candidate_ref: candidateRef,
		candidate_digest: "a".repeat(64),
		team_id: deterministicPolicyTeamId(candidateRef),
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Native legacy roster",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: devices.map(({ owner }) => ({ identity_id: owner, role: "member" })),
		device_decisions: devices.map(({ deviceId, owner, publicKey }) => ({
			device_id: deviceId,
			key_fingerprint: fingerprintPublicKey(publicKey),
			enabled: true,
			identity_id: owner,
			decision: "included",
		})),
		project_mappings: [],
		project_recipients: [],
		completed_at: NOW,
	};
	return JSON.parse(
		canonicalCoordinatorLegacyTeamCompletionManifestJson(input),
	) as CoordinatorLegacyTeamCompletionManifestV1;
}

async function seed(groupId: string, devices: ReturnType<typeof roster>) {
	const store = new D1CoordinatorStore(env.COORDINATOR_DB);
	await store.createGroup(groupId);
	// Trusted historical enrollment fixtures: no owner-authority grants or V3 bindings.
	// Each statement uses six binds; batches avoid 500 sequential setup round trips.
	for (let start = 0; start < devices.length; start += 50) {
		await env.COORDINATOR_DB.batch(
			devices.slice(start, start + 50).map(({ deviceId, owner, publicKey }) =>
				env.COORDINATOR_DB.prepare(`INSERT INTO enrolled_devices
					(group_id, device_id, public_key, fingerprint, identity_id, enabled, created_at)
					VALUES (?, ?, ?, ?, ?, 1, ?)`).bind(
					groupId,
					deviceId,
					publicKey,
					fingerprintPublicKey(publicKey),
					owner,
					NOW,
				),
			),
		);
	}
	return store;
}

describe("native D1 legacy completion owner compatibility", () => {
	afterEach(() => vi.restoreAllMocks());

	it("persists 500 distinct devices, owners and canonical keys within normal native limits", async () => {
		// Arrange: maximize the owner/key comparisons, without increasing the default timeout.
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		const groupId = "native-legacy-owner-max";
		const devices = roster(groupId, 500);
		const input = manifest(groupId, devices);
		const keyIds = await Promise.all(devices.map(({ publicKey }) => ed25519KeyId(publicKey)));
		expect(keyIds.every((id) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id))).toBe(true);
		expect(new Set(keyIds).size).toBe(500);
		expect(new Set(input.device_decisions.map((device) => device.key_fingerprint)).size).toBe(500);
		expect(new Set(input.device_decisions.map((device) => device.device_id)).size).toBe(500);
		expect(new Set(input.memberships.map((member) => member.identity_id)).size).toBe(500);
		const store = await seed(groupId, devices);

		// Act: execute the actual shared conditional INSERT against native D1.
		const result = await store.createLegacyTeamCompletion(groupId, input);

		// Assert: persistence, not just an in-memory success result.
		expect(result).toEqual({ status: "created", manifest: input });
		const row = await env.COORDINATOR_DB.prepare(
			"SELECT manifest_json FROM coordinator_legacy_team_completions WHERE group_id = ?",
		)
			.bind(groupId)
			.first<{ manifest_json: string }>();
		expect(row?.manifest_json).toBe(canonicalCoordinatorLegacyTeamCompletionManifestJson(input));
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects a conflicting canonical-key owner without persisting a completion", async () => {
		// Arrange: two distinct devices and owners share one real canonical key across groups.
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		const firstGroup = "native-legacy-owner-control-first";
		const secondGroup = "native-legacy-owner-control-second";
		const first = roster(firstGroup, 1, 1000);
		const second = roster(secondGroup, 1, 1000);
		const store = await seed(firstGroup, first);
		await store.createLegacyTeamCompletion(firstGroup, manifest(firstGroup, first));
		await seed(secondGroup, second);

		// Act
		const pending = store.createLegacyTeamCompletion(secondGroup, manifest(secondGroup, second));

		// Assert: materializing key metadata must not bypass owner denial.
		await expect(pending).rejects.toMatchObject({ code: "completion_conflict" });
		const row = await env.COORDINATOR_DB.prepare(
			"SELECT COUNT(*) AS count FROM coordinator_legacy_team_completions WHERE group_id = ?",
		)
			.bind(secondGroup)
			.first<{ count: number }>();
		expect(row?.count).toBe(0);
		expect(fetch).not.toHaveBeenCalled();
	});
});
