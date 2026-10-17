import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AUTH_LIFECYCLE_CURRENT_READINESS_SQL, AUTH_LIFECYCLE_CURRENT_READY_COUNT } from "../../core/src/coordinator-auth-lifecycle-current-readiness.js";
import { authLifecycleFirstLinkStatements, type AuthLifecycleFirstLinkOptions } from "../../core/src/coordinator-auth-lifecycle-first-link.js";
import { AUTH_LIFECYCLE_FRESH_SCHEMA_STATEMENTS } from "../../core/src/coordinator-auth-lifecycle-fresh-schema.js";
import { AUTH_SCHEMA_V2_READINESS_SQL } from "../../core/src/coordinator-auth-lifecycle-predecessor.js";
import { AUTH_LIFECYCLE_UPGRADE_STATEMENTS } from "../../core/src/coordinator-auth-lifecycle-upgrade.js";

const db = env.COORDINATOR_DB;
const attempts = "coordinator_auth_link_attempts";
const links = "coordinator_auth_account_links";
const associations = "coordinator_auth_account_associations";
const claims = "coordinator_auth_device_claims";
const browser = "coordinator_auth_browser_transactions";
const revision = "a".repeat(64);
const options: AuthLifecycleFirstLinkOptions = { coordinatorId: "synthetic", issuer: "https://issuer.example.test", authConfigRevision: revision, attemptId: "attempt", linkId: "new-link", now: 10 };
const winning = {
	coordinator_id: options.coordinatorId, issuer: options.issuer, auth_config_revision: revision, attempt_id: "attempt", identity_id: "actor", group_id: "group", device_id: "device", public_key: "synthetic-key\r\n", fingerprint: revision,
	controller_attestation_id: "attestation", controller_review_receipt_id: "review", controller_revision: 1, runtime_verifier_hash: revision, loopback_redirect: "http://127.0.0.1:1234/callback", state: "finalized", browser_transaction_hash: revision,
	account_subject: "subject", completion_secret_hash: revision, link_id: "new-link", created_at_ms: 0, expires_at_ms: 600000, claimed_at_ms: 1, oidc_verified_at_ms: 2, confirmed_at_ms: 3, finalized_at_ms: 10, authority_kind: "controller_attestation", browser_start_hash: revision,
};
const claim = { claim_id: "new-link", coordinator_id: options.coordinatorId, identity_id: "actor", group_id: "group", device_id: "device", public_key: winning.public_key, fingerprint: revision, key_id: "b".repeat(64), attempt_id: "attempt", issuer: options.issuer, auth_config_revision: revision, created_at_ms: 10 };
const deviceAuthority = { authority_kind: "device_claim", controller_attestation_id: null, controller_review_receipt_id: null, controller_revision: null };
type Definition = { type: string; name: string; tbl_name: string; sql: string | null };
const schema = async () => (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all<Definition>()).results;
// The native setup installed actual Worker predecessor migrations and the authority cutover.
const oldDefinitions = (await schema()).filter(({ tbl_name }) => tbl_name.startsWith("coordinator_auth_"));
const batch = (sql: readonly string[]) => db.batch(sql.map((statement) => db.prepare(statement)));
const ready = () => db.prepare(AUTH_LIFECYCLE_CURRENT_READINESS_SQL).first();
const rows = async (table: string) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
function insertion(table: string, row: Record<string, unknown>) {
	const names = Object.keys(row);
	return db.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).bind(...Object.values(row));
}
function firstLink(changes: Partial<AuthLifecycleFirstLinkOptions> = {}) {
	return authLifecycleFirstLinkStatements({ ...options, ...changes }).map(({ sql, values }) => db.prepare(sql).bind(...values));
}
async function reset(statements: readonly string[]) {
	// Isolated local D1 only; trigger bodies remain intact prepared statements.
	for (const { type, name } of (await schema()).filter(({ tbl_name }) => tbl_name.startsWith("coordinator_auth_")).sort((a, b) => Number(b.type === "trigger") - Number(a.type === "trigger"))) await db.prepare(`DROP ${type.toUpperCase()} IF EXISTS "${name}"`).run();
	await batch(statements);
}
async function browserRow(coordinator_id: string, browser_sequence: number) {
	await insertion(browser, { coordinator_id, browser_sequence, browser_transaction_hash: revision, purpose: "signin", state_hash: revision, binder_hash: revision, issuer: options.issuer, auth_config_revision: revision, redirect_uri: "http://127.0.0.1:1234/callback", state: "pending", nonce: "n".repeat(43), pkce_verifier: "p".repeat(43), created_at_ms: 0, expires_at_ms: 600000 }).run();
}
beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	await reset(AUTH_LIFECYCLE_FRESH_SCHEMA_STATEMENTS);
});
afterEach(() => { try { expect(globalThis.fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

it("installs unused fresh definitions and recognizes the complete current definition inventory on native D1", async () => {
	// Arrange
	const before = await schema();
	// Act: exercise the full recursive/json_each query, not a stub or Node SQLite substitute.
	const current = await ready();
	// Assert
	expect(current).toEqual({ ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT });
	expect(await db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).first()).toEqual({ ready: 9 });
	expect(await schema()).toEqual(before);
	expect(new TextEncoder().encode(AUTH_LIFECYCLE_CURRENT_READINESS_SQL).byteLength).toBeLessThan(100000);
});

it("recognizes the actual empty Worker predecessor only after the complete explicit upgrade", async () => {
	// Arrange
	const old = [...oldDefinitions].sort((a, b) => Number(b.type === "table") - Number(a.type === "table"));
	await reset(old.map(({ sql }) => sql as string));
	expect(await ready()).not.toEqual({ ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT });
	// Act
	await batch(AUTH_LIFECYCLE_UPGRADE_STATEMENTS);
	// Assert
	expect(await ready()).toEqual({ ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT });
	expect(await db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).first()).toEqual({ ready: 9 });
});

it.each([
	"DROP TRIGGER coordinator_auth_device_claims_first_generation",
	"DROP TRIGGER auth_sessions_insert_admission",
	"CREATE TRIGGER coordinator_auth_account_links AFTER INSERT ON coordinator_auth_account_links BEGIN SELECT 1; END",
])("rejects missing guards and a wrong-type namespace collision %#", async (damage) => {
	// Arrange
	expect(await ready()).toEqual({ ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT });
	// Act
	await db.prepare(damage).run();
	// Assert
	expect(await ready()).not.toEqual({ ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT });
});

it.each(["controller_attestation", "device_claim"])("inserts %s first generation from winning pins and isolates the coordinator sequence floor", async (authority_kind) => {
	// Arrange: synthetic rows test SQL pinning, not device signatures or provider authorization.
	await browserRow(options.coordinatorId, 31);
	await browserRow("other-coordinator", 99);
	await insertion(attempts, { ...winning, ...(authority_kind === "device_claim" ? deviceAuthority : {}) }).run();
	if (authority_kind === "device_claim") await insertion(claims, claim).run();
	// Act: future callers append audits/profile publication after these statements.
	await db.batch(firstLink());
	const before = [await rows(links), await rows(associations)];
	await db.batch(firstLink());
	// Assert: a retry does not rewrite the permanent association or duplicate the link.
	expect(await rows(links)).toMatchObject([{ identity_id: "actor", authority_kind, controller_attestation_id: authority_kind === "device_claim" ? null : "attestation", device_claim_id: authority_kind === "device_claim" ? "new-link" : null, generation: 1, signin_sequence_floor: 31 }]);
	expect(await rows(associations)).toMatchObject([{ identity_id: "actor", first_link_id: "new-link", created_at_ms: 10 }]);
	expect([await rows(links), await rows(associations)]).toEqual(before);
	expect(await rows("coordinator_auth_link_profiles")).toEqual([]);
	expect(await rows("coordinator_auth_link_audit_log")).toEqual([]);
});

it("defaults the floor to zero without borrowing another coordinator's high sequence", async () => {
	// Arrange
	await browserRow("other-coordinator", 99);
	await insertion(attempts, winning).run();
	// Act
	await db.batch(firstLink());
	// Assert
	expect(await rows(links)).toMatchObject([{ signin_sequence_floor: 0 }]);
});

it("rolls back the winning transition and root claim when another actor reserved the account", async () => {
	// Arrange
	await insertion(associations, { coordinator_id: options.coordinatorId, issuer: options.issuer, subject: "subject", identity_id: "other-actor", first_link_id: "other-link", created_at_ms: 1 }).run();
	await insertion(attempts, { ...winning, ...deviceAuthority, state: "confirmed", link_id: null, finalized_at_ms: null }).run();
	const before = await rows(attempts);
	const statements = [db.prepare(`UPDATE ${attempts} SET state = 'finalized', link_id = 'new-link', finalized_at_ms = 10 WHERE attempt_id = 'attempt'`), insertion(claims, claim), ...firstLink()];
	// Act / Assert: all writes belong to the future caller's one atomic transaction.
	await expect(db.batch(statements)).rejects.toThrow(/auth_account_link_unavailable/);
	expect(await rows(attempts)).toEqual(before);
	expect(await rows(claims)).toEqual([]);
	expect(await rows(links)).toEqual([]);
	expect(await rows(associations)).toMatchObject([{ identity_id: "other-actor", first_link_id: "other-link" }]);
});

it.each([{ authConfigRevision: "b".repeat(64) }, { linkId: "wrong-link" }, { now: 11 }])("does not insert for mismatched winning options %j", async (changes) => {
	// Arrange
	await insertion(attempts, winning).run();
	const before = await rows(attempts);
	// Act
	await db.batch(firstLink(changes));
	// Assert
	expect(await rows(links)).toEqual([]);
	expect(await rows(associations)).toEqual([]);
	expect(await rows(attempts)).toEqual(before);
});

it("does not manufacture a first link from a non-finalized attempt", async () => {
	// Arrange
	await insertion(attempts, { ...winning, state: "confirmed", link_id: null, finalized_at_ms: null }).run();
	// Act
	await db.batch(firstLink());
	// Assert
	expect(await rows(links)).toEqual([]);
	expect(await rows(associations)).toEqual([]);
});

it("rolls back finalization instead of reconnecting an actor with revoked link history", async () => {
	// Arrange
	await insertion(attempts, winning).run();
	await db.batch(firstLink());
	await db.prepare(`UPDATE ${links} SET revoked_at_ms = 20`).run();
	const before = [await rows(links), await rows(associations), await rows(claims)];
	const nextHash = "c".repeat(64);
	await insertion(attempts, { ...winning, attempt_id: "next-attempt", state: "confirmed", link_id: null, finalized_at_ms: null, account_subject: "next-subject", runtime_verifier_hash: nextHash, browser_transaction_hash: nextHash, completion_secret_hash: nextHash, browser_start_hash: nextHash }).run();
	const attemptsBefore = await rows(attempts);
	const statements = [db.prepare(`UPDATE ${attempts} SET state = 'finalized', link_id = 'next-link', finalized_at_ms = 10 WHERE attempt_id = 'next-attempt' AND state = 'confirmed'`), ...firstLink({ attemptId: "next-attempt", linkId: "next-link" })];
	// Act / Assert: rejection must undo the caller's transition and any new reservation.
	await expect(db.batch(statements)).rejects.toThrow(/auth_account_link_unavailable/);
	expect(await rows(attempts)).toEqual(attemptsBefore);
	expect(await db.prepare(`SELECT state,link_id,finalized_at_ms FROM ${attempts} WHERE attempt_id = 'next-attempt'`).first()).toEqual({ state: "confirmed", link_id: null, finalized_at_ms: null });
	expect([await rows(links), await rows(associations), await rows(claims)]).toEqual(before);
});

it("rolls back a device-claim finalization when the required genesis claim is missing", async () => {
	// Arrange: metadata pins model the signed writer's confirmed result, not signature/provider authorization.
	await insertion(attempts, { ...winning, ...deviceAuthority, state: "confirmed", link_id: null, finalized_at_ms: null }).run();
	const attemptsBefore = await rows(attempts);
	const before = [await rows(links), await rows(associations), await rows(claims)];
	const statements = [db.prepare(`UPDATE ${attempts} SET state = 'finalized', link_id = 'new-link', finalized_at_ms = 10 WHERE attempt_id = 'attempt' AND state = 'confirmed'`), ...firstLink()];
	// Act / Assert: intentionally omit the genesis-claim INSERT from the same caller-owned batch.
	await expect(db.batch(statements)).rejects.toThrow(/NOT NULL constraint failed: coordinator_auth_account_links\.generation/);
	expect(await rows(attempts)).toEqual(attemptsBefore);
	expect(await db.prepare(`SELECT state,link_id,finalized_at_ms FROM ${attempts} WHERE attempt_id = 'attempt'`).first()).toEqual({ state: "confirmed", link_id: null, finalized_at_ms: null });
	expect([await rows(links), await rows(associations), await rows(claims)]).toEqual(before);
});
