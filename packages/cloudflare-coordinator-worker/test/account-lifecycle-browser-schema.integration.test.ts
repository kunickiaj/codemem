import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AUTH_LIFECYCLE_BROWSER_TRANSACTION_TABLE_SQL, AUTH_LIFECYCLE_BROWSER_TRANSACTION_INDEX_STATEMENTS, AUTH_LIFECYCLE_BROWSER_SEQUENCE_GUARD_STATEMENTS } from "../../core/src/coordinator-auth-lifecycle-browser-schema.js";
import { AUTH_LIFECYCLE_ACCOUNT_PROFILE_TABLE_SQL, AUTH_LIFECYCLE_LINK_PROFILE_TABLE_SQL, AUTH_LINK_PROFILE_REFRESH_TABLE_SQL } from "../../core/src/coordinator-auth-lifecycle-profile-schema.js";
import { AUTH_SCHEMA_V2_READINESS_SQL } from "../../core/src/coordinator-auth-lifecycle-predecessor.js";

const db = env.COORDINATOR_DB;
const browser = "coordinator_auth_browser_transactions";
const refresh = "coordinator_auth_link_profile_refreshes";
const hash = "a".repeat(64);
const transaction = { coordinator_id: "coordinator", browser_transaction_hash: hash, purpose: "link_change", attempt_id: "attempt", state_hash: hash, binder_hash: hash, issuer: "https://accounts.google.com", auth_config_revision: hash, redirect_uri: "http://127.0.0.1:1234/callback", state: "pending", nonce: "n".repeat(43), pkce_verifier: "p".repeat(43), created_at_ms: 0, expires_at_ms: 600000 };
function insert(table: string, row: Record<string, unknown>) {
	const columns = Object.keys(row);
	return db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).bind(...columns.map((key) => row[key])).run();
}
beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	// Only isolated Miniflare fixtures change; trigger bodies remain whole statements.
	for (const table of [browser, "coordinator_auth_account_profiles", "coordinator_auth_link_profiles", refresh]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
	await db.batch([AUTH_LIFECYCLE_BROWSER_TRANSACTION_TABLE_SQL, ...AUTH_LIFECYCLE_BROWSER_TRANSACTION_INDEX_STATEMENTS, ...AUTH_LIFECYCLE_BROWSER_SEQUENCE_GUARD_STATEMENTS, AUTH_LIFECYCLE_ACCOUNT_PROFILE_TABLE_SQL, AUTH_LIFECYCLE_LINK_PROFILE_TABLE_SQL, AUTH_LINK_PROFILE_REFRESH_TABLE_SQL].map((sql) => db.prepare(sql)));
});
afterEach(() => {
	try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
	finally { vi.restoreAllMocks(); }
});

it("retains link-change attempt pins and monotonic immutable sequences after cleanup", async () => {
	// Arrange
	await insert(browser, transaction);
	// Act
	await db.prepare(`DELETE FROM ${browser}`).run(); await insert(browser, transaction);
	const move = () => db.prepare(`UPDATE ${browser} SET browser_sequence = ?`).bind(40).run();
	const wrongPurposePin = () => insert(browser, { ...transaction, attempt_id: null });
	// Assert
	expect(await db.prepare(`SELECT browser_sequence FROM ${browser}`).first()).toEqual({ browser_sequence: 2 });
	await expect(move()).rejects.toThrow(/auth_browser_transaction_sequence_immutable/);
	await expect(wrongPurposePin()).rejects.toThrow(/CHECK/);
	expect(await db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).first()).toEqual({ ready: 10 });
});

it("permits sequence-plus-one up to the safe limit and denies further allocation", async () => {
	// Arrange
	await insert(browser, { ...transaction, browser_sequence: Number.MAX_SAFE_INTEGER - 1 });
	// Act
	await db.prepare(`INSERT INTO ${refresh} (coordinator_id, link_id, source_attempt_id, verified_at_ms, source_order) SELECT coordinator_id, ?, ?, ?, browser_sequence + 1 FROM ${browser}`).bind("link", "attempt", 10).run();
	await db.prepare(`DELETE FROM ${browser}`).run();
	const overflow = () => insert(browser, transaction);
	// Assert
	expect(await db.prepare(`SELECT source_order FROM ${refresh}`).first()).toEqual({ source_order: Number.MAX_SAFE_INTEGER });
	await expect(overflow()).rejects.toThrow(/CHECK/);
	expect((await db.prepare(`SELECT * FROM ${browser}`).all()).results).toEqual([]);
});

it("retains legacy profile baselines and keeps refreshes attempt-sourced", async () => {
	// Arrange
	const account = { coordinator_id: "coordinator", link_id: "link", source_session_id: "session", source_signed_in_at_ms: 10 };
	const staged = { coordinator_id: "coordinator", attempt_id: "attempt", issuer: transaction.issuer, subject: "google-a", auth_config_revision: hash, browser_transaction_hash: hash, verified_at_ms: 10 };
	// Act
	await insert("coordinator_auth_account_profiles", account); await insert("coordinator_auth_link_profiles", staged);
	await insert(refresh, { coordinator_id: "coordinator", link_id: "link", source_attempt_id: "refresh", verified_at_ms: 10, source_order: 2 });
	const falsePublication = () => insert("coordinator_auth_link_profiles", { ...staged, attempt_id: "other", source_purpose: "link_change", source_order: 2, link_id: "other" });
	// Assert
	expect(await db.prepare("SELECT source_order FROM coordinator_auth_account_profiles").first()).toEqual({ source_order: 1 });
	expect(await db.prepare("SELECT source_order, source_purpose FROM coordinator_auth_link_profiles").first()).toEqual({ source_order: 0, source_purpose: "link" });
	await expect(falsePublication()).rejects.toThrow(/CHECK/);
	expect((await db.prepare(`SELECT * FROM ${refresh}`).all()).results).toHaveLength(1);
});

it.each([{}, { source_order: 0 }])("rejects link-change legacy order %j while retaining link baseline zero", async (order) => {
	// Arrange
	const table = "coordinator_auth_link_profiles";
	const staged = { coordinator_id: "coordinator", attempt_id: "attempt", issuer: transaction.issuer, subject: "google-a", auth_config_revision: hash, browser_transaction_hash: hash, verified_at_ms: 10 };
	// Act
	const invalid = () => insert(table, { ...staged, source_purpose: "link_change", ...order });
	// Assert
	await expect(invalid()).rejects.toThrow(/CHECK/);
	await insert(table, staged);
	await insert(table, { ...staged, attempt_id: "change", source_purpose: "link_change", source_order: 2 });
	expect((await db.prepare(`SELECT source_purpose, source_order FROM ${table} ORDER BY source_order`).all()).results).toEqual([{ source_purpose: "link", source_order: 0 }, { source_purpose: "link_change", source_order: 2 }]);
});
