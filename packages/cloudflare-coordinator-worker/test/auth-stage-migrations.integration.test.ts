import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
	COORDINATOR_AUTH_STAGE_MIGRATIONS,
	coordinatorAuthStageBaselineSql,
	coordinatorD1BaselineMigrations,
	readCoordinatorAuthSchemaStage,
} from "../../core/src/coordinator-auth-schema-stage.js";
import { seedD1ConnectionOrder } from "../../core/src/coordinator-account-schema-test-fixtures.js";
import { config, seedEnrollmentSql, seedLinkSql } from "./device-claim-eligibility-fixture.js";
import { resetNativeAuthStage } from "./native-auth-stage.js";

const db = env.COORDINATOR_DB;
const stageNames = Object.values(COORDINATOR_AUTH_STAGE_MIGRATIONS);
const backend = {
	first: async <T>({ sql, values }: { sql: string; values: unknown[] }) =>
		(await db.prepare(sql).bind(...values).first()) as T | null,
};
const stage = () => readCoordinatorAuthSchemaStage(backend as never);
const ledger = async () =>
	(await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results.map(
		({ name }) => name,
	);
const definitions = async () =>
	(await db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).results;
const linkTables = [
	"coordinator_auth_link_attempts",
	"coordinator_auth_browser_transactions",
	"coordinator_auth_account_links",
	"coordinator_auth_link_audit_log",
];
const rows = (table: string) =>
	db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all<Record<string, unknown>>();
// These fixture inserts have no trigger bodies or semicolons in string literals.
async function seed(sql: string) {
	await db.batch(
		sql
			.split(";")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => db.prepare(part)),
	);
}

it("takes a fresh native D1 database from the numbered chain alone to the current schema", async () => {
	// Arrange: an empty database, as a new deployment starts.
	await resetNativeAuthStage("legacy");
	expect(await stage()).toBe("legacy");
	// Act
	await applyD1Migrations(db, env.TEST_MIGRATIONS);
	// Assert: no export, baseline or out-of-band install was needed.
	expect(await stage()).toBe("current");
	expect((await ledger()).slice(-3)).toEqual(stageNames);
});

it("upgrades an existing V2 deployment and keeps every link, proof and audit row", async () => {
	// Arrange: V2 with a committed link and its proof history.
	await resetNativeAuthStage("v2");
	await seed(`${seedEnrollmentSql} ${seedLinkSql}`);
	const before = await Promise.all(linkTables.map(async (table) => (await rows(table)).results));
	// Act: the next deployment applies only what the ledger lacks.
	await applyD1Migrations(db, env.TEST_MIGRATIONS);
	// Assert: original columns keep their values; the coordinator gets its first order.
	expect(await stage()).toBe("current");
	for (const [index, table] of linkTables.entries()) {
		const after = (await rows(table)).results;
		expect(after.map((row) => Object.fromEntries(Object.keys(before[index]?.[0] ?? {}).map((k) => [k, row[k]])))).toEqual(before[index]);
	}
	expect(
		(await db.prepare("SELECT * FROM coordinator_auth_account_connection_orders").all()).results,
	).toEqual([{ coordinator_id: config.coordinatorId, last_order: 1 }]);
});

it("refuses a partial extension without writing a definition, row or ledger entry", async () => {
	// Arrange: V2 plus one extension table, as an interrupted manual install leaves it.
	await resetNativeAuthStage("v2");
	await seed(`${seedEnrollmentSql} ${seedLinkSql}`);
	await db
		.prepare(
			"CREATE TABLE coordinator_auth_account_connection_orders (coordinator_id TEXT PRIMARY KEY, last_order INTEGER NOT NULL)",
		)
		.run();
	const before = {
		definitions: await definitions(),
		rows: await Promise.all(linkTables.map(async (table) => (await rows(table)).results)),
		ledger: await ledger(),
	};
	expect(await stage()).toBe("unknown");
	// Act / Assert: the migration's first statement aborts the whole file.
	await expect(applyD1Migrations(db, env.TEST_MIGRATIONS)).rejects.toThrow();
	expect({
		definitions: await definitions(),
		rows: await Promise.all(linkTables.map(async (table) => (await rows(table)).results)),
		ledger: await ledger(),
	}).toEqual(before);
});

// Wrangler's own ledger table, as `wrangler d1 migrations list` creates it.
const bootstrapLedger = `CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
/** A current database with live rows whose schema came from outside the numbered chain. */
async function currentWithoutLedger() {
	await resetNativeAuthStage("legacy");
	await applyD1Migrations(db, env.TEST_MIGRATIONS);
	await seed(`${seedEnrollmentSql} ${seedLinkSql}`);
	await seedD1ConnectionOrder(db, config.coordinatorId);
	await db.prepare("DROP TABLE d1_migrations").run();
	expect(await stage()).toBe("current");
}
const retained = () => Promise.all(linkTables.map(async (table) => (await rows(table)).results));

it("baselines an existing current database without a ledger once, then the chain has nothing to apply", async () => {
	// Arrange
	await currentWithoutLedger();
	const before = await retained();
	// Act: no ledger is an error of its own; the operator then creates the empty ledger.
	const missing = db.prepare(coordinatorAuthStageBaselineSql("current")).run();
	await expect(missing).rejects.toThrow(/no such table: d1_migrations/u);
	await db.prepare(bootstrapLedger).run();
	const schema = await definitions();
	await db.prepare(coordinatorAuthStageBaselineSql("current")).run();
	await db.prepare(coordinatorAuthStageBaselineSql("current")).run();
	await applyD1Migrations(db, env.TEST_MIGRATIONS);
	// Assert: every numbered migration is recorded once, from 0001, and nothing replayed.
	expect(await ledger()).toEqual(env.TEST_MIGRATIONS.map(({ name }) => name));
	expect(await ledger()).toEqual([...coordinatorD1BaselineMigrations("current")]);
	expect(await definitions()).toEqual(schema);
	expect(await retained()).toEqual(before);
});

it.each([
	["table", "DROP TABLE coordinator_scope_membership_effect_receipts"],
	["column", "ALTER TABLE coordinator_invites DROP COLUMN reviewed_intent_json"],
	["attestations table", "DROP TABLE coordinator_auth_controller_attestations"],
	["purge floors table", "DROP TABLE coordinator_auth_signin_purge_floors"],
])("records nothing when an earlier %s is missing", async (_kind, damage) => {
	// Arrange: auth is current, but part of the earlier chain never ran.
	await currentWithoutLedger();
	await db.prepare(damage).run();
	await db.prepare(bootstrapLedger).run();
	// Act
	await db.prepare(coordinatorAuthStageBaselineSql("current")).run();
	// Assert
	expect(await ledger()).toEqual([]);
});

it("records nothing when the baseline names a stage the database is not at", async () => {
	// Arrange
	await resetNativeAuthStage("v2");
	await db.prepare("DELETE FROM d1_migrations").run();
	// Act: on V2 the current guard names a missing table, so the statement fails.
	const current = db.prepare(coordinatorAuthStageBaselineSql("current")).run();
	const prior = db.prepare(coordinatorAuthStageBaselineSql("prior_extension")).run();
	// Assert
	await expect(current).rejects.toThrow(/no such (table|column)/);
	await expect(prior).rejects.toThrow(/no such (table|column)/);
	expect(await ledger()).toEqual([]);
});

it.each([
	["sessions table", "DROP TABLE coordinator_auth_sessions"],
	["browser transactions table", "DROP TABLE coordinator_auth_browser_transactions"],
	["profile column", "ALTER TABLE coordinator_auth_account_profiles DROP COLUMN display_name"],
])("records nothing on V2 without its %s", async (_kind, damage) => {
	await resetNativeAuthStage("v2");
	await db.prepare("DELETE FROM d1_migrations").run();
	await db.prepare(damage).run();
	await db.prepare(coordinatorAuthStageBaselineSql("v2")).run();
	expect(await ledger()).toEqual([]);
});
