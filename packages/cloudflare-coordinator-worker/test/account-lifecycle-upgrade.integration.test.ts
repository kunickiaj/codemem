import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AUTH_LIFECYCLE_COPY_TABLE_NAMES } from "../../core/src/coordinator-auth-lifecycle-upgrade-copy.js";
import { AUTH_LIFECYCLE_UPGRADE_SQL, AUTH_LIFECYCLE_UPGRADE_STATEMENTS } from "../../core/src/coordinator-auth-lifecycle-upgrade.js";
import { AUTH_SCHEMA_V2_READINESS_SQL } from "../../core/src/coordinator-auth-lifecycle-predecessor.js";

const db = env.COORDINATOR_DB;
const links = "coordinator_auth_account_links";
const browser = "coordinator_auth_browser_transactions";
const claims = "coordinator_auth_device_claims";
const hash = (index: number) => String(index + 1).repeat(64);
type Definition = { type: string; name: string; tbl_name: string; sql: string | null };
type Inventory = { table: string; columns: string[]; rowid: boolean }[];
const schema = async () => (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all<Definition>()).results;
// apply-migrations.ts installed actual Worker 0001–0033 and the frozen authority cutover.
const baseline = (await schema()).filter(({ tbl_name, sql }) => tbl_name.startsWith("coordinator_auth_") && sql !== null);
async function inventory(tables: readonly string[]): Promise<Inventory> {
	return Promise.all(tables.map(async (table) => ({ table, columns: (await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>().catch((cause) => { throw new Error(`Cannot inspect fixture table ${table}`, { cause }); })).results.map(({ name }) => name), rowid: table !== claims })));
}
async function raw(tables: Inventory) {
	return Promise.all(tables.map(async ({ table, columns, rowid }) => {
		const chunks = [];
		// Native D1 permits at most 100 result columns; three encodings per field need smaller projections.
		for (let offset = 0; offset < columns.length; offset += 24) {
			const projection = columns.slice(offset, offset + 24).flatMap((name) => [`typeof(s."${name}") AS "${name}:type"`, `hex(CAST(s."${name}" AS BLOB)) AS "${name}:bytes"`, `CASE WHEN typeof(s."${name}") IN ('integer','real') THEN s."${name}" ELSE NULL END AS "${name}:number"`]);
			if (rowid) projection.unshift("s.rowid AS source_rowid");
			chunks.push((await db.prepare(`SELECT ${projection.join(",")} FROM "${table}" s ORDER BY ${rowid ? "s.rowid" : 's."claim_id"'}`).all()).results);
		}
		return { table, chunks };
	}));
}
async function state() {
	const definitions = await schema();
	// D1 exposes its internal metadata definition but denies reading its columns or rows.
	return { definitions, rows: await raw(await inventory(definitions.filter(({ type, name }) => type === "table" && name !== "_cf_METADATA").map(({ name }) => name))) };
}
async function insert(table: string, row: Record<string, unknown>) {
	const names = Object.keys(row);
	await db.prepare(`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`).bind(...Object.values(row)).run();
}
async function seed() {
	for (const { table, columns } of await inventory(AUTH_LIFECYCLE_COPY_TABLE_NAMES)) {
		for (const index of [0, 1]) {
			const device = index === 1;
			const values: Record<string, unknown> = {
				coordinator_id: "synthetic", link_id: `link-${index}`, attempt_id: `attempt-${index}`, identity_id: `identity-${index}`, issuer: "https://issuer.example.test", subject: `subject-${index}`,
				controller_attestation_id: device ? null : "attestation", controller_review_receipt_id: device ? null : "review", controller_revision: device ? null : 1, authority_kind: device ? "device_claim" : "controller_attestation", device_claim_id: device ? `link-${index}` : null,
				auth_config_revision: hash(0), created_at_ms: 1000, revoked_at_ms: device ? 2000 : null, group_id: `group-${index}`, device_id: `device-${index}`, public_key: "synthetic-key\r\nΩ", fingerprint: hash(index), key_id: hash(index), claim_id: `link-${index}`,
				runtime_verifier_hash: hash(index), loopback_redirect: "http://127.0.0.1:1234/callback", state: "finalized", browser_transaction_hash: hash(index), account_subject: `subject-${index}`, completion_secret_hash: hash(index), failure_reason: null,
				expires_at_ms: 601000, claimed_at_ms: 1001, oidc_verified_at_ms: 1002, confirmed_at_ms: 1003, finalized_at_ms: 1004, failed_at_ms: null, browser_start_hash: hash(index), action: "link_created",
				purpose: "link", state_hash: hash(index), binder_hash: hash(index), redirect_uri: "https://coordinator.example.test/callback?raw=%2f", nonce: null, pkce_verifier: null, claim_token: `token-${index}`, consumed_at_ms: 1003,
				session_id: `session-${index}`, credential_hash: hash(index), source: "link_redeem", purge_eligible: 0, display_name: device ? null : "Synthetic Ω 'quote'\0tail", email: device ? null : "synthetic@example.test", email_verified: device ? null : 0,
				picture_url: null, source_session_id: `session-${index}`, source_signed_in_at_ms: 1000, verified_at_ms: 1002,
			};
			if (table === browser) Object.assign(values, { state: device ? "pending" : "consumed", nonce: device ? "n".repeat(43) : null, pkce_verifier: device ? "p".repeat(43) : null, claim_token: device ? null : "token-0", consumed_at_ms: device ? null : 1003 });
			if (table === "coordinator_auth_sessions") values.expires_at_ms = 28801000;
			const row = Object.fromEntries(columns.map((name) => [name, values[name]]));
			if (table !== claims) row.rowid = device ? 42 : 3;
			await insert(table, row);
		}
	}
	await db.batch(["CREATE TABLE unrelated_sequence (id INTEGER PRIMARY KEY AUTOINCREMENT)", "INSERT INTO unrelated_sequence VALUES (500)", "DELETE FROM unrelated_sequence", "CREATE TABLE unrelated_notes (body BLOB)", "INSERT INTO unrelated_notes VALUES (X'0000FF00')"].map((sql) => db.prepare(sql)));
	await insert("groups", { group_id: "preserved-group", created_at: "2026-10-01T00:00:00.000Z" });
	await insert("coordinator_identity_group_grants", { coordinator_id: "synthetic", identity_id: "identity-0", group_id: "preserved-group", status: "active", revision: 1, source_kind: "controller_attestation", source_receipt_id: "review", created_at: "2026-10-01T00:00:00.000Z", revoked_at: null });
}
beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	// Only the isolated local binding changes. Restore actual predecessor definitions for each case.
	const current = await schema();
	for (const { type, name, tbl_name } of current.filter(({ sql }) => sql !== null).sort((a, b) => Number(b.type === "trigger") - Number(a.type === "trigger"))) {
		if (tbl_name.startsWith("coordinator_auth_") || name.startsWith("coordinator_lifecycle_") || name.startsWith("unrelated_") || name === "late_failure") await db.prepare(`DROP ${type.toUpperCase()} IF EXISTS "${name}"`).run();
	}
	for (const { sql } of [...baseline].sort((a, b) => Number(b.type === "table") - Number(a.type === "table"))) if (sql) await db.prepare(sql).run();
	await db.prepare("DELETE FROM coordinator_identity_group_grants").run();
	await db.prepare("DELETE FROM groups").run();
	await seed();
});
afterEach(() => { try { expect(globalThis.fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
const upgrade = (statements: readonly string[] = AUTH_LIFECYCLE_UPGRADE_STATEMENTS) => db.batch(statements.map((sql) => db.prepare(sql)));

it("upgrades populated Worker predecessors atomically and preserves all nine old raw inventories", async () => {
	// Arrange
	const old = await inventory(AUTH_LIFECYCLE_COPY_TABLE_NAMES);
	const before = await raw(old);
	const unrelated = await raw(await inventory(["groups", "coordinator_identity_group_grants", "unrelated_notes", "unrelated_sequence"]));
	expect(await db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).first()).toEqual({ ready: 10 });
	// Act: every trigger stays one prepared statement in the same D1 transaction.
	await upgrade();
	// Assert
	expect(await raw(old)).toEqual(before);
	expect(await raw(await inventory(["groups", "coordinator_identity_group_grants", "unrelated_notes", "unrelated_sequence"]))).toEqual(unrelated);
	expect(await db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).first()).toEqual({ ready: 9 });
	expect((await db.prepare(`SELECT generation, signin_sequence_floor FROM ${links} ORDER BY rowid`).all()).results).toEqual([{ generation: 1, signin_sequence_floor: 0 }, { generation: 1, signin_sequence_floor: 0 }]);
	expect((await db.prepare("SELECT first_link_id FROM coordinator_auth_account_associations ORDER BY first_link_id").all()).results).toEqual([{ first_link_id: "link-0" }, { first_link_id: "link-1" }]);
	expect(await db.prepare("SELECT source_order FROM coordinator_auth_account_profiles LIMIT 1").first()).toEqual({ source_order: 1 });
	expect(await db.prepare("SELECT source_order, source_purpose FROM coordinator_auth_link_profiles LIMIT 1").first()).toEqual({ source_order: 0, source_purpose: "link" });
	expect(await db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").bind(browser).first()).toEqual({ seq: 42 });
	expect(await db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'unrelated_sequence'").first()).toEqual({ seq: 500 });
	expect((await schema()).filter(({ name }) => name.includes("lifecycle_snapshot_") || name.endsWith("_lifecycle_upgrade") || name === "coordinator_lifecycle_upgrade_checks")).toEqual([]);
	await expect(db.prepare(`UPDATE ${browser} SET browser_sequence = 100 WHERE browser_sequence = 3`).run()).rejects.toThrow(/immutable/);
	await expect(db.prepare(`UPDATE ${links} SET ended_at_ms = 3000, end_reason = 'user_disconnected', end_attempt_id = 'missing' WHERE link_id = 'link-0'`).run()).rejects.toThrow();
	await expect(db.prepare("DELETE FROM coordinator_auth_account_associations").run()).rejects.toThrow(/immutable/);
	await expect(db.prepare(`INSERT INTO ${claims} (claim_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,key_id,attempt_id,issuer,auth_config_revision,created_at_ms) SELECT 'new-claim',coordinator_id,'new-identity','new-group','new-device',public_key,fingerprint,?,'missing-attempt',issuer,auth_config_revision,created_at_ms FROM ${claims} WHERE claim_id = 'link-1'`).bind("f".repeat(64)).run()).rejects.toThrow(/genesis_unavailable/);
});

it.each([
	"CREATE INDEX custom_index ON coordinator_auth_account_links(subject)",
	"CREATE TRIGGER custom_trigger BEFORE INSERT ON coordinator_auth_account_links BEGIN SELECT 1; END",
	"CREATE TABLE coordinator_auth_lifecycle_snapshot_account_links (foreign_value TEXT)",
])("rejects unsafe predecessor objects without changing any schema or data %#", async (damage) => {
	// Arrange
	await db.prepare(damage).run();
	const before = await state();
	// Act / Assert
	await expect(upgrade()).rejects.toThrow();
	expect(await state()).toEqual(before);
});

it("rolls back all migration writes and sequence changes for a late execution-time CHECK failure", async () => {
	// Arrange: both appended statements compile; the insert fails only when executed after the upgrade.
	const before = await state();
	const statements = [...AUTH_LIFECYCLE_UPGRADE_STATEMENTS, "CREATE TABLE late_failure (value INTEGER CHECK(value = 1))", "INSERT INTO late_failure VALUES (0)"];
	// Act / Assert
	await expect(upgrade(statements)).rejects.toThrow(/CHECK/);
	expect(await state()).toEqual(before);
});

it("rejects a second application without rewriting the upgraded state", async () => {
	// Arrange
	await upgrade();
	const before = await state();
	// Act / Assert
	await expect(upgrade()).rejects.toThrow();
	expect(await state()).toEqual(before);
});

it("rejects a copy mutation inside the transaction before publishing any rebuilt table", async () => {
	// Arrange
	const before = await state();
	const statements = [...AUTH_LIFECYCLE_UPGRADE_STATEMENTS];
	const copy = statements.findIndex((sql) => sql.startsWith(`INSERT INTO "${links}_lifecycle_upgrade"`));
	expect(copy).toBeGreaterThan(0);
	statements.splice(copy + 1, 0, `UPDATE ${links}_lifecycle_upgrade SET revoked_at_ms = NULL WHERE rowid = 42`);
	// Act / Assert
	await expect(upgrade(statements)).rejects.toThrow(/NOT NULL constraint failed: coordinator_lifecycle_upgrade_checks\.passed/);
	expect(await state()).toEqual(before);
});

it("keeps the exported native statement protocol within D1 limits without transaction or TEMP SQL", () => {
	// Arrange
	const statements = AUTH_LIFECYCLE_UPGRADE_STATEMENTS;
	// Act
	const largest = Math.max(...statements.map((sql) => new TextEncoder().encode(sql).byteLength));
	// Assert
	expect(largest).toBeLessThan(100000);
	expect(AUTH_LIFECYCLE_UPGRADE_SQL).not.toMatch(/sqlite_temp_master|\b(?:BEGIN TRANSACTION|COMMIT|ROLLBACK)\b|PRAGMA\s+foreign_keys/iu);
	expect(statements.some((sql) => /CREATE TRIGGER/u.test(sql) && /;\s*END/u.test(sql))).toBe(true);
});
