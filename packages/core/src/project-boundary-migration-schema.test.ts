import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	connect,
	type Database,
	ensureAdditiveSchemaCompatibility,
	getSchemaVersion,
	SCHEMA_VERSION,
	tableExists,
} from "./db.js";
import {
	listProjectBoundaryMigrationRecords,
	recordProjectBoundaryMigration,
} from "./project-boundary-migration-records.js";

const TABLE = "project_boundary_migrations";
let directory: string;
let db: Database;

function storeRecord(database: Database) {
	return recordProjectBoundaryMigration(database, {
		boundaryScopeId: "managed-project:project-p",
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

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-boundary-schema-"));
	db = connect(join(directory, "memory.sqlite"));
});

afterEach(() => {
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("the migration record table in the schema", () => {
	it("is at schema version 22", () => {
		expect(SCHEMA_VERSION).toBe(22);
	});

	it("exists in a new database before anything is written to it", () => {
		expect(tableExists(db, TABLE)).toBe(true);
		expect(listProjectBoundaryMigrationRecords(db)).toEqual([]);
	});

	it("is added to a database from the previous release when it is opened", () => {
		downgradeToSchema21(db);

		ensureAdditiveSchemaCompatibility(db);

		expect(tableExists(db, TABLE)).toBe(true);
		expect(getSchemaVersion(db)).toBe(22);
		expect(db.prepare("SELECT applied_schema_version FROM schema_compat_state").pluck().get()).toBe(
			22,
		);
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
