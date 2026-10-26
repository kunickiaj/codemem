import { env } from "cloudflare:workers";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { hashCoordinatorAuthProofBytes32 } from "../../core/src/coordinator-auth-proof.js";
import {
	commitDeviceRebind,
	readDeviceRebindReceipt,
} from "../../core/src/coordinator-device-rebind-commit.js";
import {
	type DeviceRebindAttempt,
	deviceRebindConfirmationHash,
	deviceRebindFinalMessage,
} from "../../core/src/coordinator-device-rebind-proof.js";
import { ed25519KeyId } from "../../core/src/coordinator-ed25519-key-id.js";
import { createD1AuthLinkBackend } from "../../core/src/d1-coordinator-store.js";

const NOW = 1_791_028_800_000;
const REVISION = "a".repeat(64);
const db = env.COORDINATOR_DB;

function deviceKey() {
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const wire = Buffer.alloc(51);
	wire.writeUInt32BE(11, 0);
	wire.write("ssh-ed25519", 4);
	wire.writeUInt32BE(32, 15);
	raw.copy(wire, 19);
	return {
		publicKey: `ssh-ed25519 ${wire.toString("base64")}`,
		sign: (message: string) => sign(null, Buffer.from(message), keys.privateKey).toString("base64url"),
	};
}

async function seed(suffix: string) {
	const key = deviceKey();
	const secret = createHash("sha256").update(`secret-${suffix}`).digest("base64url");
	const device = `device-${suffix}`;
	const target = `identity-target-${suffix}`;
	const attempt: DeviceRebindAttempt = {
		coordinator_id: "native-coordinator",
		attempt_id: `rebind-${suffix}`,
		origin: "https://coordinator.example.test",
		device_id: device,
		public_key: key.publicKey,
		key_id: (await ed25519KeyId(key.publicKey)) as string,
		fingerprint: createHash("sha256").update(key.publicKey).digest("hex"),
		current_identity_id: `local:${device}`,
		issuer: "https://accounts.example.test",
		auth_config_revision: REVISION,
		loopback_redirect: "http://127.0.0.1:4567/rebind",
		browser_start_hash: createHash("sha256").update(`start-${suffix}`).digest("hex"),
		browser_transaction_hash: createHash("sha256").update(`txn-${suffix}`).digest("hex"),
		browser_binder_hash: "d".repeat(64),
		account_subject: `subject-${suffix}`,
		target_identity_id: target,
		link_id: `link-${suffix}`,
		link_authority_kind: "device_claim",
		review_digest: "e".repeat(64),
		team_effects_json: "{\"requests\":[]}",
		enrollment_count: 2,
		confirmation_hash: null,
		completion_secret_hash: await hashCoordinatorAuthProofBytes32(Buffer.from(secret, "base64url")),
		final_key_proof_hash: null,
		state: "confirmed",
		created_at_ms: NOW - 60_000,
		expires_at_ms: NOW + 540_000,
		finalized_at_ms: null,
		binding_id: null,
		audit_event_id: null,
		final_outcome_json: null,
	};
	attempt.confirmation_hash = await deviceRebindConfirmationHash(attempt);
	const entries = Object.entries(attempt);
	const groups = [`group-a-${suffix}`, `group-b-${suffix}`];
	await db.batch([
		...groups.flatMap((group) => [
			db.prepare("INSERT INTO groups (group_id, created_at) VALUES (?, 'created')").bind(group),
			db.prepare(`INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, identity_id, enabled, created_at)
			 VALUES (?, ?, ?, ?, NULL, 1, 'created')`).bind(group, device, key.publicKey, attempt.fingerprint),
		]),
		db.prepare(`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
		 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'device_claim', ?)`).bind(
			attempt.coordinator_id,
			attempt.link_id,
			attempt.issuer,
			attempt.account_subject,
			target,
			`link-attempt-${suffix}`,
			REVISION,
			`claim-${suffix}`,
		),
		db.prepare(`INSERT INTO coordinator_device_rebind_attempts (${entries.map(([k]) => k).join(", ")})
		 VALUES (${entries.map(() => "?").join(", ")})`).bind(...entries.map(([, value]) => value)),
	]);
	return {
		attempt,
		input: (signature = key.sign(deviceRebindFinalMessage(attempt, secret))) => ({
			backend: createD1AuthLinkBackend(db),
			coordinatorId: attempt.coordinator_id,
			attemptId: attempt.attempt_id,
			revision: REVISION,
			now: NOW,
			completionSecret: secret,
			signature,
		}),
	};
}

const identities = async (device: string) =>
	(
		await db
			.prepare("SELECT identity_id FROM enrolled_devices WHERE device_id = ? ORDER BY group_id")
			.bind(device)
			.all<{ identity_id: string | null }>()
	).results.map((row) => row.identity_id);

it("native D1 commits a rebind atomically and returns the same receipt on retry", async () => {
	// Arrange
	const f = await seed("commit");
	// Act
	const first = await commitDeviceRebind(f.input());
	const retry = await commitDeviceRebind(f.input());
	// Assert
	if (first.kind !== "committed") throw new Error(`expected a commit, got ${first.kind}`);
	expect(retry).toEqual({ kind: "prior_commit", receipt: first.receipt });
	expect(await identities(f.attempt.device_id)).toEqual([
		f.attempt.target_identity_id,
		f.attempt.target_identity_id,
	]);
	expect(
		await readDeviceRebindReceipt(createD1AuthLinkBackend(db), f.attempt.coordinator_id, f.attempt.attempt_id),
	).toEqual(first.receipt);
});

it("native D1 writes nothing when the device signature is wrong or a later write fails", async () => {
	// Arrange
	const forged = await seed("forged");
	const failing = await seed("failing");
	await db
		.prepare(`CREATE TRIGGER fail_native_rebind_audit BEFORE INSERT ON coordinator_device_rebind_audit_log
		 WHEN NEW.attempt_id = 'rebind-failing' BEGIN SELECT RAISE(ABORT, 'injected_failure'); END`)
		.run();
	// Act
	const refused = await commitDeviceRebind(forged.input("A".repeat(86)));
	const failed = commitDeviceRebind(failing.input());
	// Assert
	expect(refused).toEqual({ kind: "refused" });
	await expect(failed).rejects.toThrow();
	for (const f of [forged, failing]) {
		expect(await identities(f.attempt.device_id)).toEqual([null, null]);
		const state = await db
			.prepare("SELECT state FROM coordinator_device_rebind_attempts WHERE attempt_id = ?")
			.bind(f.attempt.attempt_id)
			.first<{ state: string }>();
		expect(state?.state).toBe("confirmed");
	}
	const bindings = await db
		.prepare("SELECT count(*) AS n FROM coordinator_device_ownership_bindings WHERE device_id IN (?, ?)")
		.bind(forged.attempt.device_id, failing.attempt.device_id)
		.first<{ n: number }>();
	expect(bindings?.n).toBe(0);
});
