import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	columnExists,
	connect,
	type Database,
	ensureAdditiveSchemaCompatibility,
	getSchemaVersion,
	SCHEMA_VERSION,
	tableExists,
} from "./db.js";
import { getProjectBoundaryMigrationHold } from "./project-boundary-migration-hold.js";
import {
	listProjectBoundaryMigrationRecords,
	recordProjectBoundaryMigration,
} from "./project-boundary-migration-records.js";

const TABLE = "project_boundary_migrations";
const BOUNDARY = "managed-project:project-p";
const HOLD_COLUMNS = [
	"hold_cleared_generation",
	"hold_cleared_reason",
	"hold_cleared_at",
	"hold_withdrawn_generation",
	"hold_withdrawn_device_ids_json",
];
let directory: string;
let db: Database;

function storeRecord(database: Database) {
	return recordProjectBoundaryMigration(database, {
		boundaryScopeId: BOUNDARY,
		sourceScopeId: "team:group-a:default",
		state: "committed",
		generation: 1,
	});
}

/** A database as the previous release left it: schema 21, marked as upgraded, without the table. */
function downgradeToSchema21(database: Database) {
	database.exec(`
		DROP TABLE ${TABLE};
		PRAGMA user_version = 21;
		CREATE TABLE IF NOT EXISTS schema_compat_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			applied_schema_version INTEGER NOT NULL,
			applied_at TEXT NOT NULL
		);
		INSERT OR REPLACE INTO schema_compat_state VALUES (1, 21, '2026-11-01T00:00:00Z');
	`);
}

/** A database as schema version 22 left it: the table with the record columns only. */
function downgradeToSchema22(database: Database) {
	database.exec(`
		DROP TABLE ${TABLE};
		CREATE TABLE ${TABLE} (
			boundary_scope_id TEXT PRIMARY KEY NOT NULL,
			source_scope_id TEXT NOT NULL,
			additional_source_scope_ids_json TEXT NOT NULL DEFAULT '[]',
			state TEXT NOT NULL,
			generation INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		PRAGMA user_version = 22;
		UPDATE schema_compat_state SET applied_schema_version = 22;
	`);
}

function missingHoldColumns(database: Database) {
	return HOLD_COLUMNS.filter((column) => !columnExists(database, TABLE, column));
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-boundary-schema-"));
	db = connect(join(directory, "memory.sqlite"));
});

afterEach(() => {
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("the migration record table in the schema", () => {
	it("is at schema version 23", () => {
		expect(SCHEMA_VERSION).toBe(23);
	});

	it("exists in a new database before anything is written to it", () => {
		expect(tableExists(db, TABLE)).toBe(true);
		expect(listProjectBoundaryMigrationRecords(db)).toEqual([]);
	});

	it("is added to a database from the previous release when it is opened", () => {
		downgradeToSchema21(db);

		ensureAdditiveSchemaCompatibility(db);

		expect(tableExists(db, TABLE)).toBe(true);
		expect(missingHoldColumns(db)).toEqual([]);
		expect(getSchemaVersion(db)).toBe(23);
		expect(db.prepare("SELECT applied_schema_version FROM schema_compat_state").pluck().get()).toBe(
			23,
		);
		expect(storeRecord(db)).toBe(true);
	});

	it("is added on a later open when an earlier attempt failed and the database was marked upgraded", () => {
		ensureAdditiveSchemaCompatibility(db);
		db.exec(`DROP TABLE ${TABLE}`);
		expect(getSchemaVersion(db)).toBe(23);

		ensureAdditiveSchemaCompatibility(db);

		expect(tableExists(db, TABLE)).toBe(true);
		expect(storeRecord(db)).toBe(true);
	});

	it("keeps stored records when the schema step runs again", () => {
		storeRecord(db);

		ensureAdditiveSchemaCompatibility(db);

		expect(listProjectBoundaryMigrationRecords(db)).toHaveLength(1);
	});

	it("is not created by storing a record", () => {
		db.exec(`DROP TABLE ${TABLE}`);

		expect(() => storeRecord(db)).toThrow();
		expect(tableExists(db, TABLE)).toBe(false);
	});
});

describe("the hold columns in the schema", () => {
	it("exist in a new database", () => {
		expect(missingHoldColumns(db)).toEqual([]);
	});

	it("are added to a database at schema version 22, and its records start held", () => {
		ensureAdditiveSchemaCompatibility(db);
		downgradeToSchema22(db);
		storeRecord(db);

		ensureAdditiveSchemaCompatibility(db);

		expect(missingHoldColumns(db)).toEqual([]);
		expect(getSchemaVersion(db)).toBe(23);
		expect(listProjectBoundaryMigrationRecords(db)).toHaveLength(1);
		expect(getProjectBoundaryMigrationHold(db, BOUNDARY)).toMatchObject({
			generation: 1,
			held: true,
			withdrawnAtFirstPassDeviceIds: null,
		});
	});

	it("are added on a later open when an earlier attempt failed and the database was marked upgraded", () => {
		ensureAdditiveSchemaCompatibility(db);
		downgradeToSchema22(db);
		db.exec(`
			PRAGMA user_version = 23;
			UPDATE schema_compat_state SET applied_schema_version = 23;
		`);

		ensureAdditiveSchemaCompatibility(db);

		expect(missingHoldColumns(db)).toEqual([]);
	});

	it("reads a record as held while the columns are missing", () => {
		ensureAdditiveSchemaCompatibility(db);
		downgradeToSchema22(db);
		storeRecord(db);

		expect(getProjectBoundaryMigrationHold(db, BOUNDARY)).toMatchObject({
			generation: 1,
			held: true,
		});
	});
});
