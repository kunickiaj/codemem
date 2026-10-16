import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AUTH_LINK_AUTHORITY_UPGRADE_SQL, AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS } from "../../core/src/coordinator-auth-link-authority-upgrade.js";
import { AUTH_LINK_SCHEMA_SQL } from "../../core/src/coordinator-auth-link-contract.js";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS as proof } from "../../core/src/coordinator-auth-device-claim-schema.js";
import { AUTH_SCHEMA_READINESS_SQL, AUTH_SCHEMA_READY_COUNT } from "../../core/src/coordinator-auth-schema.js";
import {
	legacyLinkAuthorityRowsSql,
	linkAuthorityDefinitionsSql,
	linkAuthorityTables,
	withoutNewAuthorityColumns,
} from "./link-authority-upgrade-fixture.js";

// These source strings contain no triggers or semicolons inside literals.
function batch(sql: string) {
	return env.COORDINATOR_DB.batch(
		sql
			.split(";")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => env.COORDINATOR_DB.prepare(part)),
	);
}

async function snapshot() {
	return Promise.all(
		linkAuthorityTables.map(
			async (table) =>
				(
					await env.COORDINATOR_DB.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all<
						Record<string, unknown>
					>()
				).results,
		),
	);
}
async function definitions() {
	return (await env.COORDINATOR_DB.prepare(linkAuthorityDefinitionsSql).all()).results;
}

it("rolls back all swaps when proof installation fails, then commits the exact cutover statements", async () => {
	await env.COORDINATOR_DB.prepare("DROP TABLE coordinator_auth_device_claims").run();
	const before = await snapshot();
	const schema = await definitions();
	const fault = AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS.map((sql) => sql.replace("BEFORE DELETE ON coordinator_auth_device_claims", "BEFORE DELETE ON missing_fixture_table"));
	await expect(env.COORDINATOR_DB.batch(fault.map((sql) => env.COORDINATOR_DB.prepare(sql)))).rejects.toThrow(/missing_fixture_table/);
	expect(await snapshot()).toEqual(before);
	expect(await definitions()).toEqual(schema);
	expect((await env.COORDINATOR_DB.prepare("SELECT name FROM sqlite_master WHERE name = 'coordinator_auth_device_claims'").all()).results).toEqual([]);
	await env.COORDINATOR_DB.batch(AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS.map((sql) => env.COORDINATOR_DB.prepare(sql)));
	expect((await env.COORDINATOR_DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'coordinator_auth_device_claims'").all()).results).toEqual([{ sql: expect.stringContaining("WITHOUT ROWID") }]);
});

beforeEach(async () => {
	// Freeze the legacy input at the actual pre-authority migrations, not the
	// current fresh DDL installed by the shared test setup.
	await batch(linkAuthorityTables.map((table) => `DROP TABLE ${table};`).join("\n"));
	for (const name of ["0017_add_auth_account_links.sql", "0019_add_auth_link_attempt_limit_indexes.sql", "0025_add_auth_link_browser_start_hash.sql"]) {
		const migration = env.TEST_MIGRATIONS.find((migration) => migration.name === name);
		if (!migration) throw new Error(`Missing legacy fixture migration: ${name}`);
		await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
	}
	await batch(legacyLinkAuthorityRowsSql);
});

it.each([
	"CREATE TABLE coordinator_auth_device_claims (claim_id TEXT)",
	// SQLite resolves these names to the expected objects despite their case.
	"CREATE TABLE COORDINATOR_AUTH_DEVICE_CLAIMS (claim_id TEXT)",
	"CREATE TABLE Coordinator_Auth_Device_Claims (claim_id TEXT)",
	"CREATE TRIGGER COORDINATOR_AUTH_DEVICE_CLAIMS_IMMUTABLE_UPDATE BEFORE UPDATE ON coordinator_auth_device_claims BEGIN SELECT 1; END;",
	"CREATE TRIGGER Coordinator_Auth_Device_Claims_Insert_Collision BEFORE INSERT ON coordinator_auth_device_claims BEGIN SELECT 1; END;",
	proof[0].replace("UNIQUE (coordinator_id, identity_id),", ""),
	proof[2].replace(/SELECT RAISE\([^;]+;/u, "SELECT 1;"),
])("native D1 rejects unknown proof DDL atomically (case %#)", async (damage) => {
	// Arrange: retain the complete legacy rows and schema, including incompatible proof objects.
	await env.COORDINATOR_DB.prepare("DROP TABLE coordinator_auth_device_claims").run();
	if (damage.trimStart().startsWith("CREATE TABLE")) await env.COORDINATOR_DB.prepare(damage).run();
	else {
		await env.COORDINATOR_DB.prepare(proof[0]).run();
		await env.COORDINATOR_DB.prepare(damage).run();
	}
	const before = await snapshot();
	const schema = (await env.COORDINATOR_DB.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).results;
	// Act / Assert: reject before any link swap commits, not just at readiness checking.
	await expect(env.COORDINATOR_DB.batch(AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS.map((sql) => env.COORDINATOR_DB.prepare(sql)))).rejects.toThrow(/CHECK/);
	expect(await snapshot()).toEqual(before);
	expect((await env.COORDINATOR_DB.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).results).toEqual(schema);
	expect((await env.COORDINATOR_DB.prepare(AUTH_SCHEMA_READINESS_SQL).first<{ ready: number }>())?.ready).not.toBe(AUTH_SCHEMA_READY_COUNT);
});
afterEach(async () => {
	// Restore only the isolated fixture tables, never a profile or deployment DB.
	await env.COORDINATOR_DB.prepare("DROP TABLE IF EXISTS coordinator_auth_device_claims").run();
	await env.COORDINATOR_DB.batch(proof.map((sql) => env.COORDINATOR_DB.prepare(sql)));
	await batch(
		`${linkAuthorityTables.map((table) => `DROP TABLE ${table};`).join("\n")} ${AUTH_LINK_SCHEMA_SQL}`,
	);
});

it("native D1 copies every old column, rowid, revoked link and audit event using the exact planned source", async () => {
	const before = await snapshot();
	await batch(AUTH_LINK_AUTHORITY_UPGRADE_SQL);
	const after = await snapshot();
	expect(after.map(withoutNewAuthorityColumns)).toEqual(before);
	for (const rows of after)
		expect(rows.every((row) => row.authority_kind === "controller_attestation")).toBe(true);
	expect((await definitions()).some((row) => String(row.name).includes("authority_upgrade"))).toBe(
		false,
	);
	await expect(batch(AUTH_LINK_AUTHORITY_UPGRADE_SQL)).rejects.toThrow(/CHECK/);
	expect(await snapshot()).toEqual(after);
	expect(await env.COORDINATOR_DB.prepare(AUTH_SCHEMA_READINESS_SQL).first()).toEqual({ ready: AUTH_SCHEMA_READY_COUNT });
	await env.COORDINATOR_DB.prepare("DROP TRIGGER coordinator_auth_device_claims_immutable_update").run();
	await env.COORDINATOR_DB.prepare(proof[2].replace(/SELECT RAISE\([^;]+;/u, "SELECT 1;")).run();
	expect(await env.COORDINATOR_DB.prepare(AUTH_SCHEMA_READINESS_SQL).first()).toEqual({ ready: AUTH_SCHEMA_READY_COUNT - 1 });
});

it.each([
	[
		"rowid corruption before swap",
		"SELECT rowid, coordinator_id",
		"SELECT rowid + 10, coordinator_id",
	],
	[
		"column corruption before swap",
		"SELECT rowid, coordinator_id",
		"SELECT rowid, 'changed-coordinator'",
	],
	[
		"row loss before swap",
		"FROM coordinator_auth_link_attempts;",
		"FROM coordinator_auth_link_attempts WHERE 0;",
	],
	[
		"late failure after earlier swaps",
		"ALTER TABLE coordinator_auth_link_audit_log_authority_upgrade RENAME",
		"ALTER TABLE missing_copy RENAME",
	],
	...linkAuthorityTables.flatMap((table) => [
		[
			`before ${table} swap`,
			`DROP TABLE ${table};`,
			`SELECT * FROM missing_copy; DROP TABLE ${table};`,
		],
		[
			`after ${table} swap`,
			`RENAME TO ${table};`,
			`RENAME TO ${table}; SELECT * FROM missing_copy;`,
		],
	]),
])("native D1 rolls back %s across the entire batch", async (_label, target, replacement) => {
	const before = await snapshot();
	const schema = await definitions();
	expect(AUTH_LINK_AUTHORITY_UPGRADE_SQL).toContain(target);
	const expected =
		target.startsWith("SELECT") || target.startsWith("FROM") ? /CHECK/ : /missing_copy/;
	await expect(batch(AUTH_LINK_AUTHORITY_UPGRADE_SQL.replace(target, replacement))).rejects.toThrow(
		expected,
	);
	expect(await snapshot()).toEqual(before);
	expect(await definitions()).toEqual(schema);
});

it("native D1 requires active attempts to drain before copying", async () => {
	await env.COORDINATOR_DB.prepare(
		"UPDATE coordinator_auth_link_attempts SET state = 'pending', failure_reason = NULL, failed_at_ms = NULL WHERE attempt_id = 'retired'",
	).run();
	const before = await snapshot();
	const schema = await definitions();
	await expect(batch(AUTH_LINK_AUTHORITY_UPGRADE_SQL)).rejects.toThrow(/CHECK/);
	expect(await snapshot()).toEqual(before);
	expect(await definitions()).toEqual(schema);
});

it.each(["has\u200bformat", "", new Uint8Array([0]).buffer])(
	"native D1 rejects failed-attempt group ID %j and rolls back every schema and row change",
	async (value) => {
		// Arrange: this failed attempt has no linked rows to cause a join mismatch.
		await env.COORDINATOR_DB.prepare(
			"UPDATE coordinator_auth_link_attempts SET group_id = ? WHERE attempt_id = 'retired'",
		)
			.bind(value)
			.run();
		const before = await snapshot();
		const schema = await definitions();
		// Act / Assert.
		await expect(batch(AUTH_LINK_AUTHORITY_UPGRADE_SQL)).rejects.toThrow(/CHECK/);
		expect(await snapshot()).toEqual(before);
		expect(await definitions()).toEqual(schema);
	},
);

it("native D1 leaves an unexpected assertion table and its contents untouched", async () => {
	await batch(
		"CREATE TABLE coordinator_auth_link_authority_upgrade_checks (valuable TEXT); INSERT INTO coordinator_auth_link_authority_upgrade_checks VALUES ('keep');",
	);
	try {
		const before = await snapshot();
		const schema = await definitions();
		await expect(batch(AUTH_LINK_AUTHORITY_UPGRADE_SQL)).rejects.toThrow(/already exists/);
		expect(await snapshot()).toEqual(before);
		expect(await definitions()).toEqual(schema);
		expect(
			(
				await env.COORDINATOR_DB.prepare(
					"SELECT valuable FROM coordinator_auth_link_authority_upgrade_checks",
				).all()
			).results,
		).toEqual([{ valuable: "keep" }]);
	} finally {
		await env.COORDINATOR_DB.prepare(
			"DROP TABLE coordinator_auth_link_authority_upgrade_checks",
		).run();
	}
});
