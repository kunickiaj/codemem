import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { connectCoordinator, initializeBaseSchema } from "./better-sqlite-coordinator-store.js";
import { readConnectionSchemaState } from "./coordinator-account-connection-schema.js";
import { prepareHistoricalAccountDatabase } from "./coordinator-auth-historical-test-fixture.js";
import {
	COORDINATOR_AUTH_STAGE_MIGRATION_SQL,
	COORDINATOR_AUTH_STAGE_MIGRATIONS,
	coordinatorAuthStageBaselineSql,
	coordinatorD1BaselineMigrations,
	readCoordinatorAuthSchemaStage,
} from "./coordinator-auth-schema-stage.js";
import {
	COORDINATOR_D1_BASE_INVENTORY,
	COORDINATOR_D1_MIGRATION_NAMES,
} from "./coordinator-d1-schema-inventory.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";

const migrations = new URL("../../cloudflare-coordinator-worker/migrations/", import.meta.url);
const numbered = readdirSync(migrations)
	.filter((name) => name.endsWith(".sql"))
	.sort();
const { authorityCutover, accountConnections, accountUnlink } = COORDINATOR_AUTH_STAGE_MIGRATIONS;
const migrationText = (name: string) => readFileSync(new URL(name, migrations), "utf8");
/**
 * Runs one migration file in one transaction, as local applyD1Migrations does through one
 * atomic binding batch. Whether remote Wrangler applies are atomic is not verified here.
 */
const apply = (db: Database.Database, name: string) =>
	db.transaction(() => db.exec(migrationText(name)))();

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

/** A database built only from the numbered chain, through `last` (inclusive). */
function chainThrough(last: string): Database.Database {
	const db = new Database(":memory:");
	databases.push(db);
	for (const name of numbered.filter((n) => n <= last)) apply(db, name);
	return db;
}
const stage = (db: Database.Database) => readCoordinatorAuthSchemaStage(nativeBackend(db));
/** Every object definition and every auth row, for no-write assertions. */
function everything(db: Database.Database) {
	const objects = db
		.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
		.all() as { type: string; name: string; sql: string | null }[];
	const rows = ({ name, sql }: { name: string; sql: string | null }) =>
		sql?.includes("WITHOUT ROWID")
			? db.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all()
			: db.prepare(`SELECT rowid, * FROM "${name}" ORDER BY rowid`).all();
	return objects.map((object) => ({
		...object,
		rows: object.type === "table" ? rows(object) : [],
	}));
}
function v2HistoryFile() {
	const directory = mkdtempSync(join(tmpdir(), "auth-stage-"));
	directories.push(directory);
	const path = join(directory, "fixture.sqlite");
	const db = new Database(path);
	databases.push(db);
	prepareHistoricalAccountDatabase(db, { authority: "device_claim" });
	// The rest of the V2 coordinator file that an earlier release's startup created.
	initializeBaseSchema(db);
	return { path, db };
}

describe("numbered auth-stage migrations", () => {
	it("are the generated statements the SQLite coordinator runs", () => {
		// Assert: the committed files cannot drift from the shared statement arrays.
		for (const [name, text] of Object.entries(COORDINATOR_AUTH_STAGE_MIGRATION_SQL))
			expect(migrationText(name)).toBe(text);
		expect(numbered.slice(-3)).toEqual([authorityCutover, accountConnections, accountUnlink]);
	});

	it("take a fresh database from the chain alone to the current schema at each recognized stage", async () => {
		// Act / Assert: no export, baseline or out-of-band install is needed.
		const db = chainThrough(numbered[numbered.indexOf(authorityCutover) - 1] as string);
		expect(await stage(db)).toBe("legacy");
		apply(db, authorityCutover);
		expect(await stage(db)).toBe("v2");
		apply(db, accountConnections);
		expect(await stage(db)).toBe("prior_extension");
		apply(db, accountUnlink);
		expect(await stage(db)).toBe("current");
		expect(await readConnectionSchemaState(nativeBackend(db))).toBe("ready");
	});

	it("open a fresh SQLite coordinator on the current schema", async () => {
		const db = connectCoordinator(":memory:");
		databases.push(db);
		expect(await stage(db)).toBe("current");
	});

	it("upgrade existing V2 history to current and keep every original row", async () => {
		// Arrange
		const { db } = v2HistoryFile();
		expect(await stage(db)).toBe("v2");
		const before = everything(db).filter(({ type }) => type === "table");
		// Act
		apply(db, accountConnections);
		apply(db, accountUnlink);
		// Assert: original rows keep their values over their original columns.
		expect(await stage(db)).toBe("current");
		for (const table of before) {
			const columns = Object.keys((table.rows[0] as object | undefined) ?? {});
			if (columns.length === 0) continue;
			const order = columns[0] === "rowid" ? "rowid" : "1";
			const after = db
				.prepare(
					`SELECT ${columns.map((c) => `"${c}"`).join(",")} FROM "${table.name}" ORDER BY ${order}`,
				)
				.all();
			expect(after).toEqual(table.rows);
		}
	});

	it.each([
		["the cutover on V2", "v2", authorityCutover],
		["the extension on current", "current", accountConnections],
		["unlink on V2", "v2", accountUnlink],
	] as const)("refuse %s before any change", async (_label, from, name) => {
		// Arrange
		const db =
			from === "v2" ? chainThrough(authorityCutover) : chainThrough(numbered.at(-1) as string);
		const before = everything(db);
		// Act / Assert: the first statement aborts the file.
		expect(() => apply(db, name)).toThrow();
		expect(everything(db)).toEqual(before);
	});

	it("refuse a partial extension, leaving rows, proofs and definitions untouched", async () => {
		// Arrange: V2 history plus one object of the extension, as an interrupted manual install.
		const { path, db } = v2HistoryFile();
		db.exec(
			"CREATE TABLE coordinator_auth_account_connection_orders (coordinator_id TEXT PRIMARY KEY, last_order INTEGER NOT NULL)",
		);
		const before = everything(db);
		expect(await stage(db)).toBe("unknown");
		// Act
		const migrate = () => apply(db, accountConnections);
		const finish = () => apply(db, accountUnlink);
		const opened = connectCoordinator(path);
		databases.push(opened);
		// Assert: neither migration nor startup writes; authentication still asks for an upgrade.
		expect(migrate).toThrow();
		expect(finish).toThrow();
		expect(everything(db)).toEqual(before);
		expect(await readConnectionSchemaState(nativeBackend(opened))).toBe("upgrade_required");
		expect(everything(opened)).toEqual(before);
	});
});

// Wrangler's own ledger table, as `wrangler d1 migrations list` creates it.
const ledger = `CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
const names = (db: Database.Database) =>
	(db.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[]).map(
		({ name }) => name,
	);
const current = () => chainThrough(numbered.at(-1) as string);
const fromWorkerSchema = () => {
	const db = new Database(":memory:");
	databases.push(db);
	db.exec(readFileSync(new URL("../schema.sql", migrations), "utf8"));
	return db;
};
const qualificationObjects = (source: Database.Database) =>
	everything(source).filter(
		({ name }) =>
			name === "coordinator_owner_enrollment_qualifications" ||
			name.startsWith("owner_enrollment_qualification_"),
	);

describe("guarded ledger baseline", () => {
	it("baselines a fresh Worker schema without prerequisite repairs", () => {
		const db = fromWorkerSchema();
		expect(qualificationObjects(db)).toEqual(qualificationObjects(current()));
		db.exec(ledger);
		db.exec(coordinatorAuthStageBaselineSql("current"));
		expect(names(db)).toEqual(numbered);
	});

	it("requires qualification storage repair before baselining an older Worker schema", () => {
		const db = fromWorkerSchema();
		db.exec("DROP TABLE IF EXISTS coordinator_owner_enrollment_qualifications");
		db.exec(ledger);
		db.exec(coordinatorAuthStageBaselineSql("current"));
		expect(names(db)).toEqual([]);
		const before = everything(db);
		apply(db, "0035_add_owner_enrollment_qualifications.sql");
		const repaired = everything(db);
		expect(repaired.filter(({ name }) => before.some((object) => object.name === name))).toEqual(
			before,
		);
		const reference = current();
		expect(qualificationObjects(db)).toEqual(qualificationObjects(reference));
		apply(db, "0035_add_owner_enrollment_qualifications.sql");
		expect(everything(db)).toEqual(repaired);
		db.exec(coordinatorAuthStageBaselineSql("current"));
		expect(names(db)).toEqual(numbered);
	});

	it("pins every table and column through V2 without excluding auth tables", () => {
		const db = chainThrough(authorityCutover);
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all() as { name: string }[];
		const inventory = Object.fromEntries(
			tables.map(({ name }) => [
				name,
				(db.pragma(`table_info("${name}")`) as { name: string }[]).map((c) => c.name),
			]),
		);
		// Assert
		expect([...COORDINATOR_D1_MIGRATION_NAMES]).toEqual(numbered);
		expect(inventory).toEqual(COORDINATOR_D1_BASE_INVENTORY);
	});

	it("records the whole numbered prefix of an existing current database once", async () => {
		// Arrange: current schema with no ledger, then the empty ledger Wrangler creates.
		const db = current();
		expect(await stage(db)).toBe("current");
		expect(() => db.exec(coordinatorAuthStageBaselineSql("current"))).toThrow(
			/no such table: d1_migrations/u,
		);
		db.exec(ledger);
		// Act
		db.exec(coordinatorAuthStageBaselineSql("current"));
		db.exec(coordinatorAuthStageBaselineSql("current"));
		// Assert: from 0001, so no later apply replays earlier migrations.
		expect(names(db)).toEqual(numbered);
		expect(coordinatorD1BaselineMigrations("v2")).toEqual(
			numbered.slice(0, numbered.indexOf(authorityCutover) + 1),
		);
	});

	it.each([
		["table", "DROP TABLE coordinator_scope_membership_effect_receipts"],
		["column", "ALTER TABLE coordinator_invites DROP COLUMN reviewed_intent_json"],
		["attestations table", "DROP TABLE coordinator_auth_controller_attestations"],
		["purge floors table", "DROP TABLE coordinator_auth_signin_purge_floors"],
	])("records nothing when an earlier %s is missing", async (_kind, damage) => {
		// Arrange: auth is current, but part of the earlier chain never ran.
		const db = current();
		db.exec(damage);
		db.exec(ledger);
		expect(await stage(db)).toBe("current");
		// Act
		db.exec(coordinatorAuthStageBaselineSql("current"));
		// Assert
		expect(names(db)).toEqual([]);
	});

	it.each([
		["current", "v2"],
		["v2", "current"],
		["prior_extension", "v2"],
	] as const)(
		"writes nothing when asked to baseline %s on a %s database",
		async (claimed, actual) => {
			// Arrange
			const db = actual === "v2" ? chainThrough(authorityCutover) : current();
			db.exec(ledger);
			// Act: the guard either compiles and selects nothing or names a missing object.
			const baseline = () => db.exec(coordinatorAuthStageBaselineSql(claimed));
			// Assert
			if (actual === "v2" && claimed !== "v2") expect(baseline).toThrow(/no such (table|column)/);
			else baseline();
			expect(names(db)).toEqual([]);
		},
	);

	it.each([
		["sessions table", "DROP TABLE coordinator_auth_sessions"],
		["browser transactions table", "DROP TABLE coordinator_auth_browser_transactions"],
		["profile column", "ALTER TABLE coordinator_auth_account_profiles DROP COLUMN display_name"],
	])("records nothing on V2 without its %s", (_kind, damage) => {
		const db = chainThrough(authorityCutover);
		db.exec(damage);
		db.exec(ledger);
		db.exec(coordinatorAuthStageBaselineSql("v2"));
		expect(names(db)).toEqual([]);
	});
});
