import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS } from "../../core/src/coordinator-auth-device-claim-schema.js";
import {
	AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL, AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS,
	AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL, AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS,
	AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS,
} from "../../core/src/coordinator-auth-lifecycle-schema.js";
import {
	AUTH_LINK_CHANGE_ATTEMPT_TABLE_SQL, AUTH_LINK_CHANGE_ATTEMPT_INDEX_STATEMENTS,
	AUTH_LINK_CHANGE_ATTEMPT_GUARD_STATEMENTS, AUTH_LINK_CHANGE_END_RECEIPT_GUARD_SQL,
} from "../../core/src/coordinator-auth-link-change-schema.js";

const db = env.COORDINATOR_DB;
const links = "coordinator_auth_account_links", associations = "coordinator_auth_account_associations";
const attempts = "coordinator_auth_link_change_attempts", claims = "coordinator_auth_device_claims";
const hash = "a".repeat(64);
const association = { coordinator_id: "coordinator", issuer: "https://accounts.google.com", subject: "subject", identity_id: "actor", first_link_id: "link", created_at_ms: 0 };
const birth = { coordinator_id: association.coordinator_id, issuer: association.issuer, subject: association.subject, identity_id: association.identity_id, link_id: "link", attempt_id: "genesis", controller_attestation_id: null, device_claim_id: "claim", authority_kind: "device_claim", auth_config_revision: hash, created_at_ms: 0, revoked_at_ms: null, generation: 1, ended_at_ms: null, end_reason: null, end_attempt_id: null, signin_sequence_floor: 0 };
const pending = { coordinator_id: birth.coordinator_id, attempt_id: "change", identity_id: birth.identity_id, target_link_id: birth.link_id, target_generation: 1, target_subject: birth.subject, origin: "http://127.0.0.1:43123", intent: "disconnect", purpose: "coordinator-account-link-change-v1", group_id: "group", device_id: "device", public_key: "fixture public key\r\n", fingerprint: hash, key_id: "b".repeat(64), authority_kind: "device_claim", device_claim_id: "claim", issuer: birth.issuer, auth_config_revision: hash, runtime_verifier_hash: "c".repeat(64), browser_start_hash: "d".repeat(64), loopback_redirect: "http://127.0.0.1:43123/callback", state: "pending", created_at_ms: 10, expires_at_ms: 600010 };
type Row = Record<string, unknown>;
const stages: Row[] = [
	{ state: "browser_claimed", browser_transaction_hash: "e".repeat(64), browser_binder_hash: "7".repeat(64), browser_sequence: 1, claimed_at_ms: 20 },
	{ state: "oidc_verified", account_subject: birth.subject, oidc_verified_at_ms: 30 },
	{ state: "confirmed", completion_secret_hash: "f".repeat(64), confirmed_at_ms: 40 },
	{ state: "completed", completed_at_ms: 50 },
];
function insert(table: string, row: Row, mode = "INSERT") {
	const columns = Object.keys(row);
	return db.prepare(`${mode} INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).bind(...Object.values(row)).run();
}
function update(changes: Row, attemptId = "change") {
	return db.prepare(`UPDATE ${attempts} SET ${Object.keys(changes).map((key) => `${key} = ?`).join(",")} WHERE attempt_id = ?`).bind(...Object.values(changes), attemptId).run();
}
async function rows(table = attempts) { return (await db.prepare(`SELECT * FROM ${table}`).all()).results; }
async function complete() { for (const stage of stages) await update(stage); }
function end() { return db.prepare(`UPDATE ${links} SET ended_at_ms = 50, end_reason = 'user_disconnected', end_attempt_id = 'change' WHERE link_id = 'link'`).run(); }

beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	// Isolated local D1 only; each complete trigger body is one prepared statement.
	for (const table of [links, associations, attempts, claims]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
	await db.batch([
		...COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS,
		AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL, AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL,
		...AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS, ...AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS,
		...AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS, AUTH_LINK_CHANGE_ATTEMPT_TABLE_SQL,
		...AUTH_LINK_CHANGE_ATTEMPT_INDEX_STATEMENTS, ...AUTH_LINK_CHANGE_ATTEMPT_GUARD_STATEMENTS,
		AUTH_LINK_CHANGE_END_RECEIPT_GUARD_SQL,
	].map((sql) => db.prepare(sql)));
	await db.prepare("PRAGMA recursive_triggers = OFF").run();
	await insert(associations, association); await insert(links, birth);
	await insert(claims, { coordinator_id: birth.coordinator_id, claim_id: "claim", identity_id: birth.identity_id, group_id: "original-group", device_id: pending.device_id, public_key: pending.public_key, fingerprint: pending.fingerprint, key_id: pending.key_id, attempt_id: "genesis", issuer: birth.issuer, auth_config_revision: hash, created_at_ms: 0 });
});
afterEach(() => {
	try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
	finally { vi.restoreAllMocks(); }
});

// SQL metadata checks do not verify Google/signatures, canonical keys, or current authority.
it("compiles intact D1 triggers and ends only an exact completed disconnect target", async () => {
	// Arrange
	await insert(attempts, pending);
	// Act
	await complete(); await end();
	// Assert
	expect(await rows()).toMatchObject([{ state: "completed", account_subject: birth.subject, completed_at_ms: 50 }]);
	expect(await rows(links)).toEqual([{ ...birth, ended_at_ms: 50, end_reason: "user_disconnected", end_attempt_id: "change" }]);
	expect(await rows(associations)).toEqual([association]);
});

it("stores refresh completion but refuses its use as a disconnect receipt", async () => {
	// Arrange
	await insert(attempts, { ...pending, intent: "refresh" }); await complete();
	// Act
	const write = () => end();
	// Assert
	await expect(write()).rejects.toThrow(/auth_link_change_end_receipt_invalid/);
	expect(await rows()).toMatchObject([{ intent: "refresh", state: "completed" }]);
	expect(await rows(links)).toEqual([birth]);
});

it("rejects malformed key hashes, wrong verified subjects, and mismatched claim-key metadata", async () => {
	// Arrange
	const malformed = () => insert(attempts, { ...pending, key_id: "not-a-hash" });
	// Act
	await expect(malformed()).rejects.toThrow(/CHECK constraint failed/);
	await insert(attempts, { ...pending, key_id: "9".repeat(64) }); await update(stages[0] as Row);
	const wrongSubject = () => update({ ...stages[1], account_subject: "other" });
	// Assert
	await expect(wrongSubject()).rejects.toThrow(/CHECK constraint failed/);
	expect(await rows()).toMatchObject([{ state: "browser_claimed", account_subject: null }]);
	// Act: a well-shaped hash still must match the immutable claim.
	for (const stage of stages.slice(1)) await update(stage);
	// Assert
	await expect(end()).rejects.toThrow(/auth_link_change_end_receipt_invalid/);
	expect(await rows(links)).toEqual([birth]);
});

it("refuses end when an older generation is admin-revoked", async () => {
	// Arrange: an ended generation becomes historical after a successful reconnect.
	await insert(attempts, pending); await complete(); await end();
	await insert(links, { ...birth, link_id: "next", attempt_id: "next-genesis", generation: 2 });
	await insert(attempts, { ...pending, attempt_id: "later", target_link_id: "next", target_generation: 2, runtime_verifier_hash: "1".repeat(64), browser_start_hash: "2".repeat(64) });
	for (const stage of stages) {
		const proof = { ...stage };
		if (proof.browser_transaction_hash) proof.browser_transaction_hash = "3".repeat(64);
		if (proof.completion_secret_hash) proof.completion_secret_hash = "4".repeat(64);
		await update(proof, "later");
	}
	await db.prepare(`UPDATE ${links} SET revoked_at_ms = 60 WHERE link_id = 'link'`).run();
	const before = await rows(links);
	// Act
	const write = () => db.prepare(`UPDATE ${links} SET ended_at_ms = 50, end_reason = 'user_disconnected', end_attempt_id = 'later' WHERE link_id = 'next'`).run();
	// Assert
	await expect(write()).rejects.toThrow(/auth_link_change_end_receipt_invalid/);
	expect(await rows(links)).toEqual(before);
});

it("preserves completed receipts against UPDATE, DELETE and REPLACE with recursive triggers off", async () => {
	// Arrange
	await insert(attempts, pending); await complete(); const before = await rows();
	// Act
	const writes = [() => update({ completed_at_ms: 51 }), () => db.prepare(`DELETE FROM ${attempts}`).run(), () => insert(attempts, { ...pending, intent: "refresh" }, "INSERT OR REPLACE")];
	// Assert
	expect((await db.prepare("PRAGMA recursive_triggers").first())?.recursive_triggers).toBe(0);
	for (const write of writes) await expect(write()).rejects.toThrow(/auth_link_change_(receipt_immutable|collision)/);
	expect(await rows()).toEqual(before);
});

it("rejects a newly revoked target at completion without retaining a false receipt", async () => {
	// Arrange: keep the real birth and completion target guards installed.
	await insert(attempts, pending);
	for (const stage of stages.slice(0, 3)) await update(stage);
	await db.prepare(`UPDATE ${links} SET revoked_at_ms = 45 WHERE link_id = 'link'`).run();
	const before = await rows();
	// Act
	const finish = () => update(stages[3] as Row);
	// Assert
	await expect(finish()).rejects.toThrow(/auth_link_change_target_unavailable/);
	expect(await rows()).toEqual(before);
	expect(await rows()).toMatchObject([{ state: "confirmed", completed_at_ms: null }]);
});

it("rejects skipped phases and missing browser proof without a lifecycle effect", async () => {
	// Arrange
	await insert(attempts, pending); const before = await rows();
	// Act
	const skip = () => update({ ...Object.assign({}, ...stages) });
	const missing = () => update({ ...stages[0], browser_binder_hash: null });
	// Assert
	await expect(skip()).rejects.toThrow(/auth_link_change_transition_invalid/);
	await expect(missing()).rejects.toThrow(/CHECK constraint failed/);
	expect(await rows()).toEqual(before); expect(await rows(links)).toEqual([birth]);
});
