import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { readVerifiedRejoinStartEvidence } from "./coordinator-device-rejoin-start-evidence.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";

type Fixture = Pick<AuthLinkBackend, "first"> & {
	run(sql: string, ...values: string[]): Promise<unknown>;
};
type WithFixture = (run: (db: Fixture) => Promise<void>) => Promise<void>;

const NOW = 1_791_028_800_000;
const CONFIG = { coordinatorId: "coordinator", origin: "https://coordinator.example.test" };
const encoder = new TextEncoder();
const publicKeyHeader = Buffer.from("0000000b7373682d6564323535313900000020", "hex");

async function signingFixture() {
	const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
	if (!("publicKey" in key)) throw new Error("Fixture needs an Ed25519 key pair");
	const raw = Buffer.from(await crypto.subtle.exportKey("raw", key.publicKey));
	const wire = Buffer.concat([publicKeyHeader, raw]);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const keyId = await ed25519KeyId(publicKey);
	if (!keyId) throw new Error("Fixture needs a canonical key");
	const input = {
		deviceId: "device",
		publicKey: `${publicKey} request-comment`,
		attemptId: "attempt",
		browserStartHash: "a".repeat(64),
		loopbackRedirect: "http://127.0.0.1:12345/codemem/auth/complete",
		timestampMs: NOW,
		signature: "",
	};
	const message = JSON.stringify([
		"codemem-device-rejoin-start-v1",
		CONFIG.origin,
		input.attemptId,
		input.deviceId,
		input.publicKey,
		keyId,
		input.browserStartHash,
		input.loopbackRedirect,
		input.timestampMs,
	]);
	const signature = await crypto.subtle.sign("Ed25519", key.privateKey, encoder.encode(message));
	input.signature = Buffer.from(signature).toString("base64url");
	return { publicKey, keyId, input };
}

async function seedBinding(db: Fixture, keyId: string, device = "device") {
	await db.run(
		`INSERT INTO coordinator_device_ownership_bindings
		(device_id, key_id, coordinator_id, identity_id, binding_id, provenance, source_ref, bound_at)
		VALUES (?, ?, 'coordinator', 'identity', 'binding', 'owner_enrollment', 'fixture', 'fixture-time')`,
		device,
		keyId,
	);
}

async function seedRemoval(
	db: Fixture,
	device: string,
	group: string,
	keyId: string,
	publicKey: string,
) {
	await db.run(
		`INSERT INTO coordinator_device_removals
		(removal_id, group_id, device_id, public_key, fingerprint, key_id, removed_at)
		VALUES (?, ?, ?, ?, 'fingerprint', ?, 'fixture-time')`,
		`removal-${group}`,
		group,
		device,
		publicKey,
		keyId,
	);
}

function registerSnapshotTest(withFixture: WithFixture) {
	it("pins only active own tombstones and same-key aliases in removal order without writing", () =>
		withFixture(async (db) => {
			const { input, publicKey, keyId } = await signingFixture();
			await seedBinding(db, keyId);
			await seedRemoval(db, "device", "group-z", keyId, publicKey);
			await seedRemoval(db, "alias", "group-alias", keyId, publicKey);
			await seedRemoval(db, "device", "group-a", keyId, publicKey);
			await seedRemoval(db, "device", "group-lifted", keyId, publicKey);
			await db.run(`UPDATE coordinator_device_removals SET lifted_at = 'fixture-lift', lifted_by_invite_id = 'fixture-invite'
			WHERE group_id = 'group-lifted'`);
			const own = [
				[1, "group-z", publicKey, "fingerprint"],
				[3, "group-a", publicKey, "fingerprint"],
			];
			const before = await readEffects(db);
			const first = await readVerifiedRejoinStartEvidence(db, CONFIG, input, NOW);
			expect(first).toEqual({
				bindingId: "binding",
				identityId: "identity",
				keyId,
				deviceId: "device",
				ownTombstones: own,
				aliasRemovalSeqs: [2],
				removalDigest: createHash("sha256")
					.update(JSON.stringify([["binding", "identity", "device", keyId], own, [2]]))
					.digest("hex"),
			});
			expect(await readVerifiedRejoinStartEvidence(db, CONFIG, input, NOW)).toEqual(first);
			expect(await readEffects(db)).toEqual(before);
			await seedRemoval(db, "alias", "another-alias-group", keyId, publicKey);
			const later = await readVerifiedRejoinStartEvidence(db, CONFIG, input, NOW);
			expect(later?.aliasRemovalSeqs).toEqual([2, 5]);
			expect(later?.removalDigest).not.toBe(first?.removalDigest);
		}));
}

async function seedBlock(
	db: Fixture,
	kind: "device_id" | "ed25519_key",
	value: string,
	publicKey: string,
) {
	await db.run(
		`INSERT INTO coordinator_device_revocations
					(subject_kind, subject_value, revocation_id, evidence_group_id, evidence_device_id,
					evidence_public_key, evidence_fingerprint, created_at)
					VALUES (?, ?, 'block', 'group', 'device', ?, 'fingerprint', 'fixture-time')`,
		kind,
		value,
		publicKey,
	);
}

type RefusalFixture = {
	name: string;
	bindingDevice?: string | null;
	tombstoneDevice?: string;
	tombstoneKey?: string;
	conflict?: boolean;
	block?: "device_id" | "ed25519_key";
	config?: Partial<{ coordinatorId: string | null; origin: string }>;
	signature?: string;
	now?: number;
};

async function seedRefusalEvidence(
	db: Fixture,
	scenario: RefusalFixture,
	keyId: string,
	publicKey: string,
) {
	if (scenario.bindingDevice !== null)
		await seedBinding(db, keyId, scenario.bindingDevice ?? "device");
	await seedRemoval(
		db,
		scenario.tombstoneDevice ?? "device",
		"group",
		keyId,
		scenario.tombstoneKey ?? publicKey,
	);
	if (scenario.conflict) await seedRemoval(db, "device", "conflict", "0".repeat(64), publicKey);
	if (scenario.block)
		await seedBlock(
			db,
			scenario.block,
			scenario.block === "device_id" ? "device" : keyId,
			publicKey,
		);
}

function registerRefusalTests(withFixture: WithFixture) {
	const cases: RefusalFixture[] = [
		{ name: "no binding", bindingDevice: null },
		{ name: "wrong device", bindingDevice: "other" },
		{ name: "wrong coordinator", config: { coordinatorId: "other" } },
		{ name: "no trusted coordinator", config: { coordinatorId: null } },
		{ name: "no own tombstone", tombstoneDevice: "alias" },
		{ name: "conflicting key", conflict: true },
		{ name: "bad recorded key", tombstoneKey: "opaque" },
		{ name: "blocked ID", block: "device_id" },
		{ name: "blocked key", block: "ed25519_key" },
		{ name: "wrong origin", config: { origin: "https://other.example.test" } },
		{ name: "bad signature", signature: "invalid" },
		{ name: "stale", now: NOW + 300_001 },
	];
	it.each(cases)("returns no evidence or writes for $name", (scenario) =>
		withFixture(async (db) => {
			const { input, publicKey, keyId } = await signingFixture();
			const config = { ...CONFIG, ...scenario.config };
			await seedRefusalEvidence(db, scenario, keyId, publicKey);
			const now = scenario.now ?? NOW;
			input.signature = scenario.signature ?? input.signature;
			const before = await readEffects(db);
			expect(await readVerifiedRejoinStartEvidence(db, config, input, now)).toBeNull();
			expect(await readEffects(db)).toEqual(before);
		}),
	);
}

export function registerRejoinStartEvidenceTests(withFixture: WithFixture) {
	registerSnapshotTest(withFixture);
	registerRefusalTests(withFixture);
}

function readEffects(db: Fixture) {
	return db.first({
		sql: `SELECT (SELECT COUNT(*) FROM coordinator_device_rejoin_attempts) AS attempts,
		 (SELECT COUNT(*) FROM coordinator_device_rejoin_audit_log) AS audit,
		 (SELECT COUNT(*) FROM enrolled_devices) AS enrolled,
		 (SELECT json_group_array(json_array(removal_seq, lifted_at)) FROM
		   (SELECT removal_seq, lifted_at FROM coordinator_device_removals ORDER BY removal_seq)) AS removals`,
		values: [],
	});
}
