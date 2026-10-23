import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES } from "../../core/src/coordinator-auth-historical-migration-test-fixture.js";
import { AUTH_LIFECYCLE_COPY_TABLE_NAMES } from "../../core/src/coordinator-auth-lifecycle-upgrade-copy.js";
import { AUTH_LIFECYCLE_UPGRADE_SQL, AUTH_LIFECYCLE_UPGRADE_STATEMENTS } from "../../core/src/coordinator-auth-lifecycle-upgrade.js";
import { AUTH_SCHEMA_V2_READINESS_SQL } from "../../core/src/coordinator-auth-lifecycle-predecessor.js";
import { AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS } from "../../core/src/coordinator-auth-link-authority-upgrade.js";

const db = env.COORDINATOR_DB;
const links = "coordinator_auth_account_links";
const browser = "coordinator_auth_browser_transactions";
const claims = "coordinator_auth_device_claims";
const snapshotKeys: Record<string, string[]> = {
	[claims]: ["claim_id"],
	coordinator_owner_enrollment_qualifications: ["qualification_id"],
	coordinator_legacy_owner_resolutions: ["coordinator_id", "resolution_id"],
};
const hash = (index: number) => String(index + 1).repeat(64);
type Definition = { type: string; name: string; tbl_name: string; sql: string | null };
type Inventory = { table: string; columns: string[]; rowid: boolean }[];
const schema = async () => (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all<Definition>()).results;
type FixtureMigration = (typeof env.TEST_MIGRATIONS)[number];
function frozenPredecessorMigrations(all: readonly FixtureMigration[]): FixtureMigration[] {
	return AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES.map((name) => {
		const matches = all.filter((migration) => migration.name === name);
		const [migration] = matches;
		if (matches.length !== 1 || !migration) throw new Error(`Expected exactly one historical fixture migration: ${name}`);
		return migration;
	});
}
async function restoreFrozenAuthPredecessor() {
	// Validate inputs before changing even this isolated local test binding.
	const migrations = frozenPredecessorMigrations(env.TEST_MIGRATIONS);
	const current = await schema();
	const dropOrder: Record<string, number> = { trigger: 0, view: 1, index: 2, table: 3 };
	const resetObjects = current.filter(({ sql, name, tbl_name }) => sql !== null && (tbl_name.startsWith("coordinator_auth_") || /coordinator_auth_/iu.test(sql) || name.startsWith("coordinator_lifecycle_") || name.startsWith("unrelated_") || name === "late_failure"));
	resetObjects.sort((a, b) => (dropOrder[a.type] ?? 4) - (dropOrder[b.type] ?? 4) || Number(a.tbl_name.startsWith("coordinator_auth_")) - Number(b.tbl_name.startsWith("coordinator_auth_")));
	for (const { type, name } of resetObjects) {
		await db.prepare(`DROP ${type.toUpperCase()} IF EXISTS "${name.replaceAll('"', '""')}"`).run();
	}
	for (const migration of migrations) await db.batch(migration.queries.map((sql) => db.prepare(sql)));
	// Reuse the explicit authority cutover source, not DDL captured from latest setup.
	await db.batch(AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS.map((sql) => db.prepare(sql)));
}
async function inventory(tables: readonly string[]): Promise<Inventory> {
	return Promise.all(tables.map(async (table) => ({ table, columns: (await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>().catch((cause) => { throw new Error(`Cannot inspect fixture table ${table}`, { cause }); })).results.map(({ name }) => name), rowid: snapshotKeys[table] === undefined })));
}
async function raw(tables: Inventory) {
	return Promise.all(tables.map(async ({ table, columns, rowid }) => {
		const chunks = [];
		// Native D1 permits at most 100 result columns; three encodings per field need smaller projections.
		for (let offset = 0; offset < columns.length; offset += 24) {
			const projection = columns.slice(offset, offset + 24).flatMap((name) => [`typeof(s."${name}") AS "${name}:type"`, `hex(CAST(s."${name}" AS BLOB)) AS "${name}:bytes"`, `CASE WHEN typeof(s."${name}") IN ('integer','real') THEN s."${name}" ELSE NULL END AS "${name}:number"`]);
			if (rowid) projection.unshift("s.rowid AS source_rowid");
			const orderBy = (snapshotKeys[table] ?? ["rowid"]).map((name) => `s."${name}"`).join(",");
			chunks.push((await db.prepare(`SELECT ${projection.join(",")} FROM "${table}" s ORDER BY ${orderBy}`).all()).results);
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
	await restoreFrozenAuthPredecessor();
	await db.prepare("DELETE FROM coordinator_identity_group_grants").run();
	await db.prepare("DELETE FROM groups").run();
	await seed();
});
afterEach(() => { try { expect(globalThis.fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
const upgrade = (statements: readonly string[] = AUTH_LIFECYCLE_UPGRADE_STATEMENTS) => db.batch(statements.map((sql) => db.prepare(sql)));

it("selects only exact historical auth migrations in order despite later setup inputs", () => {
	// Arrange: a future auth migration must not silently redefine the old input.
	const future = { name: "0034_future_auth.sql", queries: ["CREATE TABLE coordinator_auth_future (value TEXT)"] };
	const all = [...env.TEST_MIGRATIONS, future].reverse();
	// Act
	const selected = frozenPredecessorMigrations(all);
	// Assert
	expect(selected.map(({ name }) => name)).toEqual(AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES);
	expect(selected).not.toContain(future);
	expect(selected.flatMap(({ queries }) => queries).join("\n")).not.toContain("coordinator_auth_future");
});

it.each(AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES)("rejects a missing historical migration %s", (missing) => {
	// Arrange
	const all = env.TEST_MIGRATIONS.filter(({ name }) => name !== missing);
	// Act / Assert
	expect(() => frozenPredecessorMigrations(all)).toThrow(`Expected exactly one historical fixture migration: ${missing}`);
});

it("rejects ambiguous duplicate historical migration names", () => {
	// Arrange
	const required = frozenPredecessorMigrations(env.TEST_MIGRATIONS)[0];
	// Act / Assert
	expect(() => frozenPredecessorMigrations([...env.TEST_MIGRATIONS, required])).toThrow(`Expected exactly one historical fixture migration: ${required.name}`);
});

it("includes every pre-0034 migration that mentions auth storage", () => {
	// Arrange: this coverage check detects omissions without admitting later files.
	const historical = env.TEST_MIGRATIONS.filter(({ name }) => /^\d{4}_/u.test(name) && Number(name.slice(0, 4)) <= 33);
	// Act
	const authNames = historical.filter(({ queries }) => queries.some((sql) => /coordinator_auth_/iu.test(sql))).map(({ name }) => name).sort();
	// Assert
	expect(authNames).toEqual([...AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES]);
});

it("removes later shared-setup auth objects before restoring the frozen predecessor", async () => {
	// Arrange: simulate an expanded setup without changing actual migration files.
	await db.prepare("CREATE TABLE coordinator_auth_future (value TEXT)").run();
	await db.prepare(`CREATE INDEX future_setup_index ON ${links}(subject)`).run();
	const callerOwned = await raw(await inventory(["groups", "coordinator_identity_group_grants"]));
	// Act: do not reseed groups or other caller-owned rows during this auth-only reset.
	await restoreFrozenAuthPredecessor();
	// Assert
	expect((await schema()).filter(({ name }) => ["coordinator_auth_future", "future_setup_index"].includes(name))).toEqual([]);
	expect(await db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).first()).toEqual({ ready: 10 });
	expect(await raw(await inventory(["groups", "coordinator_identity_group_grants"]))).toEqual(callerOwned);
});

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

it("removes future external auth dependencies before restoring and upgrading the frozen predecessor", async () => {
	// Arrange: these names are outside the auth prefix; only their SQL identifies the dependency.
	await db.batch([
		`CREATE TABLE future_dependent (coordinator_id TEXT, link_id TEXT, FOREIGN KEY (coordinator_id, link_id) REFERENCES ${links}(coordinator_id, link_id))`,
		"INSERT INTO future_dependent VALUES ('synthetic', 'link-0')",
		`CREATE VIEW future_reader AS SELECT * FROM ${links}`,
		`CREATE TRIGGER future_reader_trigger AFTER INSERT ON future_dependent BEGIN SELECT * FROM ${links}; END`,
	].map((sql) => db.prepare(sql)));
	const callerOwned = await raw(await inventory(["groups", "coordinator_identity_group_grants"]));
	// Act
	await restoreFrozenAuthPredecessor();
	const restored = await schema();
	const readiness = await db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).first();
	await upgrade();
	// Assert
	expect(restored.filter(({ name }) => ["future_dependent", "future_reader", "future_reader_trigger"].includes(name))).toEqual([]);
	expect(readiness).toEqual({ ready: 10 });
	expect(await db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).first()).toEqual({ ready: 9 });
	expect(await raw(await inventory(["groups", "coordinator_identity_group_grants"]))).toEqual(callerOwned);
});

it.each([
	"CREATE INDEX custom_index ON coordinator_auth_account_links(subject)",
	"CREATE TRIGGER custom_trigger BEFORE INSERT ON coordinator_auth_account_links BEGIN SELECT 1; END",
	"CREATE VIEW leaked_associations AS SELECT * FROM coordinator_auth_account_associations",
	"CREATE VIEW leaked_change_attempts AS SELECT * FROM coordinator_auth_link_change_attempts",
	"CREATE TABLE external_refresh_reader (refresh_id TEXT REFERENCES coordinator_auth_link_profile_refreshes(refresh_id))",
	"CREATE TRIGGER external_association_reader AFTER INSERT ON unrelated_notes BEGIN SELECT * FROM coordinator_auth_account_associations; END",
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
