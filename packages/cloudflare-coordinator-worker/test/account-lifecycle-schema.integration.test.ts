import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS } from "../../core/src/coordinator-auth-device-claim-schema.js";
import {
	AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL, AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS,
	AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL, AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS,
	AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS, AUTH_LINK_AUDIT_RECEIPT_GUARD_STATEMENTS,
	AUTH_DEVICE_CLAIM_FIRST_GENERATION_GUARD_SQL,
} from "../../core/src/coordinator-auth-lifecycle-schema.js";
import { authLinkLiveGenerationSql } from "../../core/src/coordinator-auth-link-liveness.js";
import { AUTH_SCHEMA_READINESS_SQL } from "../../core/src/coordinator-auth-schema.js";

const db = env.COORDINATOR_DB;
const links = "coordinator_auth_account_links";
const associations = "coordinator_auth_account_associations";
const audits = "coordinator_auth_link_audit_log";
const hash = "a".repeat(64);
const association = { coordinator_id: "coordinator", issuer: "https://accounts.google.com", subject: "google-a", identity_id: "actor-a", first_link_id: "link-a", created_at_ms: 10 };
const link = { ...association, link_id: "link-a", attempt_id: "attempt-a", controller_attestation_id: null, device_claim_id: "link-a", authority_kind: "device_claim", auth_config_revision: hash, revoked_at_ms: null, generation: 1, ended_at_ms: null, end_reason: null, end_attempt_id: null, signin_sequence_floor: 0 };
const { first_link_id: _firstLinkId, ...birth } = link;
const audit = { coordinator_id: "coordinator", link_id: "link-a", action: "link_created", attempt_id: "attempt-a", identity_id: "actor-a", group_id: "group", device_id: "device", fingerprint: hash, controller_attestation_id: null, device_claim_id: "link-a", auth_config_revision: hash, created_at_ms: 10, authority_kind: "device_claim" };
function insert(table: string, row: Record<string, unknown>, mode = "INSERT") {
	const columns = Object.keys(row);
	return db.prepare(`${mode} INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).bind(...columns.map((key) => row[key])).run();
}
async function rows(table: string) { return (await db.prepare(`SELECT * FROM ${table}`).all()).results; }
async function seed() { await insert(associations, association); await insert(links, birth); }
async function end() {
	await db.prepare(`UPDATE ${links} SET ended_at_ms = ?, end_reason = ?, end_attempt_id = ? WHERE link_id = ?`).bind(20, "user_disconnected", "disconnect-a", "link-a").run();
}
async function reconnect() {
	await insert(associations, { ...association, subject: "google-b", first_link_id: "link-b" });
	await insert(links, { ...birth, subject: "google-b", link_id: "link-b", attempt_id: "attempt-b", generation: 2 });
}

beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	// Only isolated local D1 fixtures change; complete trigger bodies stay intact.
	await db.prepare("DROP TRIGGER IF EXISTS coordinator_auth_device_claims_first_generation").run();
	await db.prepare(`DROP TABLE ${links}`).run();
	await db.prepare(`DROP TABLE IF EXISTS ${associations}`).run();
	const auditDefinition = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(audits).first<{ sql: string }>();
	if (!auditDefinition) throw new Error("Missing predecessor audit fixture");
	await db.prepare(`DROP TABLE ${audits}`).run();
	await db.prepare(auditDefinition.sql).run();
	const attemptColumns = (await db.prepare("PRAGMA table_info(coordinator_auth_link_attempts)").all<{ name: string }>()).results;
	for (const column of ["prior_link_id TEXT", "prior_generation INTEGER"]) {
		if (!attemptColumns.some(({ name }) => name === column.split(" ")[0])) await db.prepare(`ALTER TABLE coordinator_auth_link_attempts ADD COLUMN ${column}`).run();
	}
	await db.batch([
		AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL, AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL,
		...AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS, ...AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS,
		...AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS, ...AUTH_LINK_AUDIT_RECEIPT_GUARD_STATEMENTS,
	].map((sql) => db.prepare(sql)));
	await db.prepare("PRAGMA recursive_triggers = OFF").run();
});
afterEach(() => {
	try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
	finally { vi.restoreAllMocks(); }
});

it("stores A then B with the same root claim, retaining A's permanent reservation", async () => {
	// Arrange
	await seed();
	await insert(associations, { ...association, subject: "google-b", first_link_id: "link-b" });
	// Act
	const secondOpen = () => insert(links, { ...birth, subject: "google-b", link_id: "link-b", attempt_id: "attempt-b", generation: 2 });
	// Assert: an open Identity cannot acquire another open generation.
	await expect(secondOpen()).rejects.toThrow(/auth_account_link_collision/);
	// Act: completing an ordinary end allows the next generation, not account transfer.
	await end(); await secondOpen();
	// Assert
	expect((await rows(links)).map((row) => row.device_claim_id)).toEqual(["link-a", "link-a"]);
	await expect(insert(associations, { ...association, identity_id: "actor-b" })).rejects.toThrow(/auth_account_association_collision/);
	expect(await rows(associations)).toContainEqual(association);
	await expect(insert(links, { ...birth, identity_id: "actor-b", link_id: "link-c", attempt_id: "attempt-c" })).rejects.toThrow();
});

it("historical admin revocation blocks live B and future C in native D1", async () => {
	// Arrange
	await seed(); await end(); await reconnect();
	const live = () => db.prepare(`SELECT l.link_id FROM ${links} l WHERE ${authLinkLiveGenerationSql({ link: "l" })}`).all();
	expect((await live()).results).toEqual([{ link_id: "link-b" }]);
	// Act
	await db.prepare(`UPDATE ${links} SET revoked_at_ms = ? WHERE link_id = ?`).bind(30, "link-a").run();
	const future = () => insert(links, { ...birth, link_id: "link-c", attempt_id: "attempt-c", generation: 3 });
	// Assert
	expect((await live()).results).toEqual([]);
	await expect(future()).rejects.toThrow(/auth_account_link_unavailable/);
	expect(await rows(links)).toHaveLength(2);
});

it("rejects reservation, generation and audit REPLACE with recursive triggers off", async () => {
	// Arrange
	await seed(); await insert(audits, audit);
	const before = await Promise.all([rows(associations), rows(links), rows(audits)]);
	// Act
	const writes = [
		() => insert(associations, { ...association, identity_id: "other" }, "INSERT OR REPLACE"),
		() => insert(links, { ...birth, created_at_ms: 11 }, "INSERT OR REPLACE"),
		() => insert(audits, { ...audit, created_at_ms: 11 }, "INSERT OR REPLACE"),
	];
	// Assert
	expect((await db.prepare("PRAGMA recursive_triggers").first())?.recursive_triggers).toBe(0);
	for (const write of writes) await expect(write()).rejects.toThrow(/collision/);
	expect(await Promise.all([rows(associations), rows(links), rows(audits)])).toEqual(before);
});

it("compiles the fourth genesis trigger and prevents old initialization restoring readiness", async () => {
	// Arrange: C0 intentionally keeps the actual pre-V3 readiness SQL unchanged.
	const ready = () => db.prepare(AUTH_SCHEMA_READINESS_SQL).first();
	expect(await ready()).toEqual({ ready: 10 });
	// Act: send the entire trigger, including its internal semicolon, as one statement.
	await db.prepare(AUTH_DEVICE_CLAIM_FIRST_GENERATION_GUARD_SQL).run();
	const fenced = await ready();
	await db.batch(COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
	// Assert
	expect(fenced).toEqual({ ready: 9 }); expect(await ready()).toEqual({ ready: 9 });
	expect(await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").bind("coordinator_auth_device_claims").first()).toEqual({ n: 4 });
});
