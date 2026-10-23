import { env } from "cloudflare:workers";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "../../core/src/coordinator-api.js";
import { ed25519KeyIdForRevocation } from "../../core/src/coordinator-ed25519-key-id-compat.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "../../core/src/coordinator-legacy-team-completion.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "../../core/src/recipient-policy-identifiers.js";
import { buildCanonicalRequest, SIGNATURE_VERSION } from "../../core/src/sync-auth.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { verifyCloudflareCoordinatorRequest } from "../src/request-verifier.js";

const NOW = 1791028800000;
const DATE = new Date(NOW).toISOString();
const secret = "fixture-history-admin-secret";
const groups = new Set<string>();
const devices = new Set<string>();
const coordinators = new Set<string>();
type Fixture = Awaited<ReturnType<typeof setup>>;
type Subject = ReturnType<typeof key>;

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(async () => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	for (const coordinator of coordinators) {
		for (const table of ["link_audit_log", "link_attempts", "controller_attestations"]) {
			await env.COORDINATOR_DB.prepare(
				`DELETE FROM coordinator_auth_${table} WHERE coordinator_id = ?`,
			)
				.bind(coordinator)
				.run();
		}
	}
	for (const device of devices)
		await env.COORDINATOR_DB.prepare("DELETE FROM request_nonces WHERE device_id = ?")
			.bind(device)
			.run();
	for (const group of groups) {
		for (const table of [
			"coordinator_legacy_team_completions",
			"enrolled_devices",
			"coordinator_invites",
			"groups",
		]) {
			await env.COORDINATOR_DB.prepare(`DELETE FROM ${table} WHERE group_id = ?`).bind(group).run();
		}
	}
	groups.clear();
	devices.clear();
	coordinators.clear();
});

function key() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(8 + kind.length + raw.length);
	wire.writeUInt32BE(kind.length, 0);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	return {
		publicKey: `ssh-ed25519 ${wire.toString("base64")}`,
		privateKey,
		deviceId: randomUUID(),
	};
}
async function enroll(store: D1CoordinatorStore, subject: Subject, group = randomUUID()) {
	groups.add(group);
	devices.add(subject.deviceId);
	await store.createGroup(group);
	await store.enrollDevice(group, {
		deviceId: subject.deviceId,
		publicKey: subject.publicKey,
		fingerprint: fingerprintPublicKey(subject.publicKey),
	});
	return group;
}
async function setup(comment = "") {
	const subject = key();
	subject.publicKey += comment;
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW });
	const group = await enroll(store, subject);
	const config = {
		enabled: true,
		coordinatorId: randomUUID(),
		issuer: "https://accounts.example.test",
		revision: "a".repeat(64),
		redirectUri: "https://coordinator.example.test/auth/callback",
	};
	coordinators.add(config.coordinatorId);
	const input = {
		group_id: group,
		device_id: subject.deviceId,
		identity_id: randomUUID(),
		fingerprint: fingerprintPublicKey(subject.publicKey),
	};
	const app = createCoordinatorApp({
		storeFactory: () => store,
		requestVerifier: verifyCloudflareCoordinatorRequest,
		runtime: { adminSecret: () => secret, now: () => DATE },
		authLink: { config, storeFactory: () => store },
	});
	return { ...subject, store, config, input, app };
}
function review(f: Fixture, digest?: string) {
	return f.app.request("/v1/admin/auth-controller-reviews", {
		method: "POST",
		headers: { "content-type": "application/json", "X-Codemem-Coordinator-Admin": secret },
		body: JSON.stringify({ ...f.input, ...(digest ? { confirm_evidence_digest: digest } : {}) }),
	});
}
function manifest(
	f: Fixture,
	group: string,
	subject: Subject = f,
	owner: string | null = randomUUID(),
) {
	const candidate = legacyTeamCandidateId(f.config.coordinatorId, group);
	return normalize({
		version: 1,
		coordinator_id: f.config.coordinatorId,
		candidate_ref: candidate,
		candidate_digest: "a".repeat(64),
		team_id: deterministicPolicyTeamId(candidate),
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Historical Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: owner ? [{ identity_id: owner, role: "member" }] : [],
		device_decisions: [
			{
				device_id: subject.deviceId,
				key_fingerprint: fingerprintPublicKey(subject.publicKey),
				enabled: true,
				identity_id: owner,
				decision: owner ? "included" : "excluded",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: DATE,
	});
}
async function history(f: Fixture, subject: Subject = f, owner?: string | null) {
	const group = randomUUID();
	groups.add(group);
	const record = manifest(f, group, subject, owner);
	// Pre-upgrade bytes: new writers intentionally refuse contradictory ownership now.
	await env.COORDINATOR_DB.prepare(
		"INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES (?,?,1,?,?,?)",
	)
		.bind(group, record.candidate_ref, canonical(record), DATE, DATE)
		.run();
	return { group, record };
}
async function snapshot() {
	return Promise.all(
		[
			"coordinator_legacy_team_completions",
			"enrolled_devices",
			"coordinator_device_ownership_bindings",
			"coordinator_scope_memberships",
			"coordinator_bootstrap_grants",
			"coordinator_auth_controller_attestations",
		].map(
			async (table) =>
				(await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
		),
	);
}
async function controllers(f: Fixture) {
	return (
		await env.COORDINATOR_DB.prepare(
			"SELECT * FROM coordinator_auth_controller_attestations WHERE coordinator_id = ?",
		)
			.bind(f.config.coordinatorId)
			.all()
	).results;
}
async function preview(f: Fixture) {
	const response = await review(f);
	expect(response.status).toBe(200);
	return response.json<{ evidence_digest: string; legacy_history: unknown[] }>();
}
function signedLink(f: Fixture) {
	const path = "/v1/auth/link-attempts";
	const body = JSON.stringify({
		group_id: f.input.group_id,
		identity_id: f.input.identity_id,
		authority: "controller_attestation",
		attempt_id: randomUUID(),
		runtime_verifier_hash: "c".repeat(64),
		browser_start_hash: "d".repeat(64),
		loopback_redirect: "http://127.0.0.1:4567/codemem/auth/complete",
	});
	const timestamp = String(NOW / 1000);
	const nonce = randomUUID();
	const signature = sign(
		null,
		buildCanonicalRequest("POST", path, timestamp, nonce, Buffer.from(body)),
		f.privateKey,
	);
	return f.app.request(path, {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"X-Opencode-Device": f.deviceId,
			"X-Opencode-Timestamp": timestamp,
			"X-Opencode-Nonce": nonce,
			"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature.toString("base64")}`,
		},
	});
}

it("native default review pins contradictory A/B history without changing canonical bytes or enrollment", async () => {
	// Arrange: both historical included owners differ from the current requested owner C.
	const f = await setup();
	const a = await history(f);
	const b = await history(f);
	const before = await snapshot();
	// Act
	const initial = await preview(f);
	const afterPreview = await snapshot();
	const result = await review(f, initial.evidence_digest);
	// Assert: default review records authority only; it does not repair historical Teams.
	expect(initial.legacy_history).toEqual(
		[a, b]
			.sort((x, y) => x.group.localeCompare(y.group))
			.map(({ group, record }) => ({
				group_id: group,
				candidate_ref: record.candidate_ref,
				manifest_version: 1,
				manifest_json: canonical(record),
				manifest: record,
				completed_at: DATE,
				created_at: DATE,
			})),
	);
	expect(a.record.device_decisions[0].identity_id).not.toBe(
		b.record.device_decisions[0].identity_id,
	);
	expect(afterPreview).toEqual(before);
	expect(result.status).toBe(201);
	expect((await snapshot()).slice(0, -1)).toEqual(before.slice(0, -1));
	expect(await controllers(f)).toHaveLength(1);
});

it.each([false, true])(
	"native winning create/retry rejects newly relevant history, retry=%s",
	async (retry) => {
		// Arrange: inject after the asynchronous preview checks, at the actual store write boundary.
		const f = await setup();
		const initial = await preview(f);
		if (retry) expect((await review(f, initial.evidence_digest)).status).toBe(201);
		const before = await controllers(f);
		const create = f.store.createAuthControllerAttestation.bind(f.store);
		let injected: Awaited<ReturnType<typeof snapshot>> | undefined;
		const spy = vi
			.spyOn(f.store, "createAuthControllerAttestation")
			.mockImplementation(async (input) => {
				await history(f);
				injected = await snapshot();
				return create(input);
			});
		// Act
		const result = await review(f, initial.evidence_digest);
		// Assert
		expect(spy).toHaveBeenCalledTimes(1);
		expect(result.status).toBe(409);
		expect(await result.json()).toEqual({ error: "review_stale" });
		expect(await controllers(f)).toEqual(before);
		expect(await snapshot()).toEqual(injected);
	},
);

it.each([false, true])(
	"native winning create/retry rejects a newly known canonical alias, retry=%s",
	async (retry) => {
		// Arrange: history is initially unrelated until its different-device key is enrolled.
		const f = await setup();
		const alias = {
			...f,
			deviceId: randomUUID(),
			publicKey: `${f.publicKey} ordinary.user@example.test 雪`,
		};
		const old = await history(f, alias);
		const initial = await preview(f);
		expect(initial.legacy_history).toEqual([]);
		if (retry) expect((await review(f, initial.evidence_digest)).status).toBe(201);
		const create = f.store.createAuthControllerAttestation.bind(f.store);
		let injected: Awaited<ReturnType<typeof snapshot>> | undefined;
		vi.spyOn(f.store, "createAuthControllerAttestation").mockImplementation(async (input) => {
			await enroll(f.store, alias, old.group);
			injected = await snapshot();
			return create(input);
		});
		// Act
		const result = await review(f, initial.evidence_digest);
		// Assert
		expect(result.status).toBe(409);
		expect(await result.json()).toEqual({ error: "review_stale" });
		expect(await snapshot()).toEqual(injected);
	},
);

it.each([false, true])(
	"native unrelated enrolled person's completion preserves confirmation/retry, retry=%s",
	async (retry) => {
		// Arrange: this is a real enrolled unrelated key and a completion written by the normal producer.
		const f = await setup();
		const other = key();
		const group = await enroll(f.store, other);
		const initial = await preview(f);
		if (retry) expect((await review(f, initial.evidence_digest)).status).toBe(201);
		await f.store.createLegacyTeamCompletion(group, manifest(f, group, other));
		const before = await snapshot();
		// Act
		const fresh = await preview(f);
		const afterPreview = await snapshot();
		const result = await review(f, initial.evidence_digest);
		const after = await snapshot();
		const repeated = await review(f, initial.evidence_digest);
		// Assert
		expect(fresh).toEqual(initial);
		expect(afterPreview).toEqual(before);
		expect(result.status).toBe(retry ? 200 : 201);
		expect(repeated.status).toBe(200);
		expect(await snapshot()).toEqual(after);
		expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
		if (retry) expect(after).toEqual(before);
	},
);

it("native comment aliases retain cross-group history and prove possession with a real signature", async () => {
	// Arrange: canonical wire text with an ASCII email and Unicode comment is verifier-compatible.
	const f = await setup(" ordinary.user@example.test 雪");
	const alias = {
		...f,
		deviceId: randomUUID(),
		publicKey: f.publicKey.split(" ").slice(0, 2).join(" "),
	};
	const group = await enroll(f.store, alias);
	const record = manifest(f, group, alias);
	await f.store.createLegacyTeamCompletion(group, record);
	const before = await snapshot();
	// Act
	const denied = await signedLink(f);
	const initial = await preview(f);
	const committed = await review(f, initial.evidence_digest);
	const allowed = await signedLink(f);
	// Assert
	expect(await ed25519KeyIdForRevocation(alias.publicKey)).toBe(
		await ed25519KeyIdForRevocation(f.publicKey),
	);
	expect(fingerprintPublicKey(alias.publicKey)).not.toBe(f.input.fingerprint);
	expect(initial.legacy_history).toHaveLength(1);
	expect(denied.status).toBe(403);
	expect(committed.status).toBe(201);
	expect(allowed.status).toBe(201);
	expect((await snapshot()).slice(0, -1)).toEqual(before.slice(0, -1));
});

it("native concurrent different-owner completions commit at most one exact device/key assignment", async () => {
	// Arrange: simultaneous native binding calls, not a SQLite-backed D1 shim.
	const f = await setup();
	const second = await enroll(f.store, f);
	const a = manifest(f, f.input.group_id);
	const b = manifest(f, second);
	const before = await snapshot();
	// Act
	const results = await Promise.allSettled([
		f.store.createLegacyTeamCompletion(f.input.group_id, a),
		f.store.createLegacyTeamCompletion(second, b),
	]);
	// Assert: one local native database execution, not a multi-region runtime claim.
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	const rejected = results.find((result) => result.status === "rejected");
	expect(rejected).toMatchObject({ status: "rejected", reason: { code: "completion_conflict" } });
	const after = await snapshot();
	expect(after[0]).toHaveLength(1);
	expect(after.slice(1)).toEqual(before.slice(1));
});

it.each(["same-owner", "excluded"] as const)(
	"native %s history permits a legitimate new completion",
	async (kind) => {
		// Arrange: neither the same owner nor an exclusion is a competing included owner.
		const f = await setup();
		const owner = randomUUID();
		const second = await enroll(f.store, f);
		await f.store.createLegacyTeamCompletion(
			f.input.group_id,
			manifest(f, f.input.group_id, f, kind === "excluded" ? null : owner),
		);
		const before = await snapshot();
		const next = manifest(f, second, f, owner);
		// Act
		const result = await f.store.createLegacyTeamCompletion(second, next);
		// Assert
		expect(result.status).toBe("created");
		expect((await snapshot())[0]).toHaveLength(2);
		expect((await snapshot()).slice(1)).toEqual(before.slice(1));
	},
);

it("native different-device comment alias refuses a competing historical owner without writes", async () => {
	// Arrange
	const f = await setup();
	await f.store.createLegacyTeamCompletion(f.input.group_id, manifest(f, f.input.group_id));
	const alias = {
		...f,
		deviceId: randomUUID(),
		publicKey: `${f.publicKey} ordinary.user@example.test 雪`,
	};
	const group = await enroll(f.store, alias);
	const before = await snapshot();
	// Act
	const pending = f.store.createLegacyTeamCompletion(group, manifest(f, group, alias));
	// Assert
	await expect(pending).rejects.toMatchObject({ code: "completion_conflict" });
	expect(await snapshot()).toEqual(before);
});

it("native exact historical retry stays immutable despite pre-upgrade contradictory ownership", async () => {
	// Arrange: intentionally bypass today's producer to represent existing legacy bad state.
	const f = await setup();
	const a = await history(f);
	await history(f);
	await f.store.createGroup(a.group);
	const before = await snapshot();
	// Act
	const result = await f.store.createLegacyTeamCompletion(a.group, a.record);
	const changed = { ...a.record, completed_at: "2026-10-02T00:00:00.000Z" };
	// Assert
	expect(result.status).toBe("existing");
	await expect(f.store.createLegacyTeamCompletion(a.group, changed)).rejects.toMatchObject({
		code: "completion_conflict",
	});
	expect(await snapshot()).toEqual(before);
});
