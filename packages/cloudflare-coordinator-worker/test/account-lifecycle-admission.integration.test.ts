import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AUTH_LIFECYCLE_CONTINUATION_COLUMN_STATEMENTS, AUTH_LIFECYCLE_CONTINUATION_GUARD_STATEMENTS, AUTH_LIFECYCLE_SESSION_ADMISSION_GUARD_STATEMENTS } from "../../core/src/coordinator-auth-lifecycle-admission-schema.js";
import { AUTH_LIFECYCLE_BROWSER_TRANSACTION_TABLE_SQL } from "../../core/src/coordinator-auth-lifecycle-browser-schema.js";
import { AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL, AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL, AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS } from "../../core/src/coordinator-auth-lifecycle-schema.js";

const db = env.COORDINATOR_DB;
const links = "coordinator_auth_account_links";
const browser = "coordinator_auth_browser_transactions";
const attempts = "coordinator_auth_link_attempts";
const receipts = "coordinator_auth_session_receipts";
const sessions = "coordinator_auth_sessions";
const hash = "a".repeat(64);
const currentRevision = "b".repeat(64);
const link = { coordinator_id: "coordinator", link_id: "link-b", issuer: "https://accounts.google.com", subject: "google-b", identity_id: "actor", attempt_id: "attempt-b", controller_attestation_id: "attestation", auth_config_revision: hash, created_at_ms: 10, authority_kind: "controller_attestation", generation: 2, signin_sequence_floor: 10 };
const transaction = { coordinator_id: "coordinator", browser_transaction_hash: hash, purpose: "signin", state_hash: hash, binder_hash: hash, issuer: link.issuer, auth_config_revision: currentRevision, redirect_uri: "http://127.0.0.1:1234/callback", state: "consumed", claim_token: "claim", consumed_at_ms: 20, created_at_ms: 0, expires_at_ms: 600000, browser_sequence: 11 };
const receipt = { coordinator_id: "coordinator", browser_transaction_hash: hash, source: "signin", link_id: "link-b", session_id: "session", auth_config_revision: currentRevision, created_at_ms: 20 };
const session = { coordinator_id: "coordinator", session_id: "session", credential_hash: hash, browser_transaction_hash: hash, link_id: "link-b", identity_id: "actor", issuer: link.issuer, subject: link.subject, auth_config_revision: currentRevision, created_at_ms: 20, expires_at_ms: 28800020 };
function insert(table: string, row: Record<string, unknown>) {
	const columns = Object.keys(row);
	return db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).bind(...columns.map((key) => row[key])).run();
}
beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	// Reset only this isolated Miniflare fixture; complete trigger statements stay intact.
	for (const table of [sessions, receipts, attempts]) {
		const definition = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first<{ sql: string }>();
		if (!definition) throw new Error("Missing predecessor fixture");
		await db.prepare(`DROP TABLE ${table}`).run(); await db.prepare(definition.sql).run();
	}
	for (const table of [links, browser, "coordinator_auth_account_associations"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
	await db.batch([AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL, AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL, ...AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS, AUTH_LIFECYCLE_BROWSER_TRANSACTION_TABLE_SQL].map((sql) => db.prepare(sql)));
	const columns = (await db.prepare(`PRAGMA table_info(${attempts})`).all<{ name: string }>()).results;
	if (!columns.some(({ name }) => name === "prior_link_id")) await db.batch(AUTH_LIFECYCLE_CONTINUATION_COLUMN_STATEMENTS.map((sql) => db.prepare(sql)));
	for (const subject of ["google-a", link.subject]) await insert("coordinator_auth_account_associations", { coordinator_id: "coordinator", issuer: link.issuer, subject, identity_id: "actor", first_link_id: subject === "google-a" ? "link-a" : "link-b", created_at_ms: 0 });
	await insert(links, { ...link, link_id: "link-a", subject: "google-a", attempt_id: "attempt-a", generation: 1, created_at_ms: 0, ended_at_ms: 5, end_reason: "user_disconnected", end_attempt_id: "disconnect-a", signin_sequence_floor: 0 });
	await insert(links, link);
	await db.batch([...AUTH_LIFECYCLE_CONTINUATION_GUARD_STATEMENTS, ...AUTH_LIFECYCLE_SESSION_ADMISSION_GUARD_STATEMENTS].map((sql) => db.prepare(sql)));
});
afterEach(() => {
	try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
	finally { vi.restoreAllMocks(); }
});

it.each([10, 11])("enforces the sign-in sequence floor at %s without relying on clocks", async (browser_sequence) => {
	// Arrange
	await insert(browser, { ...transaction, browser_sequence });
	// Act
	const write = () => insert(receipts, receipt);
	// Assert
	if (browser_sequence === 10) { await expect(write()).rejects.toThrow(/auth_session_admission_unavailable/); return; }
	await write(); await insert(sessions, session);
	expect((await db.prepare(`SELECT * FROM ${sessions}`).all()).results).toHaveLength(1);
	// Act: revoking old account A blocks admission for current account B as well.
	await db.prepare(`UPDATE ${links} SET revoked_at_ms = ? WHERE link_id = ?`).bind(30, "link-a").run();
	// Assert
	await expect(insert(receipts, { ...receipt, session_id: "other" })).rejects.toThrow(/auth_session_admission_unavailable/);
	await expect(insert(sessions, { ...session, credential_hash: "c".repeat(64) })).rejects.toThrow(/auth_session_admission_unavailable/);
});

it("admits the exact own-link redemption below the floor without requiring a session first", async () => {
	// Arrange
	await insert(browser, { ...transaction, purpose: "link", attempt_id: "attempt-b", auth_config_revision: hash, browser_sequence: 1 });
	const attempt = { coordinator_id: "coordinator", attempt_id: "attempt-b", identity_id: "actor", group_id: "group", device_id: "device", public_key: "key", fingerprint: hash, controller_attestation_id: "attestation", controller_review_receipt_id: "review", controller_revision: 1, issuer: link.issuer, auth_config_revision: hash, runtime_verifier_hash: hash, loopback_redirect: transaction.redirect_uri, state: "finalized", browser_transaction_hash: hash, account_subject: link.subject, completion_secret_hash: hash, link_id: "link-b", created_at_ms: 0, expires_at_ms: 600000, claimed_at_ms: 1, oidc_verified_at_ms: 2, confirmed_at_ms: 3, finalized_at_ms: 10, authority_kind: "controller_attestation", browser_start_hash: hash, prior_link_id: "link-a", prior_generation: 1 };
	await insert(attempts, attempt);
	// Act
	await insert(receipts, { ...receipt, source: "link_redeem", attempt_id: "attempt-b", auth_config_revision: hash });
	await insert(sessions, { ...session, auth_config_revision: hash });
	const rewrite = () => db.prepare(`UPDATE ${attempts} SET prior_generation = 2`).run();
	// Assert
	expect((await db.prepare(`SELECT * FROM ${sessions}`).all()).results).toHaveLength(1);
	await expect(rewrite()).rejects.toThrow(/auth_link_continuation_immutable/);
});
