import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AUTH_LINK_AUTHORITY_UPGRADE_SQL, AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS } from "../../core/src/coordinator-auth-link-authority-upgrade.js";
import { AUTH_LINK_SCHEMA_SQL } from "../../core/src/coordinator-auth-link-contract.js";
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
afterEach(async () => {
	// Restore only the isolated fixture tables, never a profile or deployment DB.
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
