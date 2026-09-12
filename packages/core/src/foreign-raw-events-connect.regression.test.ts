import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { connect } from "./db.js";

function schemaSnapshot(db: Database): unknown[] {
	return db
		.prepare(
			`SELECT type, name, tbl_name, sql
			 FROM sqlite_master
			 WHERE name NOT LIKE 'sqlite_%'
			 ORDER BY type, name`,
		)
		.all();
}

describe("plain connections to foreign SQLite files", () => {
	it("does not mutate an unrelated raw_events table", () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "codemem-foreign-raw-events-"));
		const dbPath = join(directory, "foreign.sqlite");
		const foreign = new Database(dbPath);
		foreign.exec("CREATE TABLE raw_events(foreign_id TEXT PRIMARY KEY, opaque BLOB)");
		const before = schemaSnapshot(foreign);
		foreign.close();

		try {
			// Act
			let connectionError: string | null = null;
			try {
				const opened = connect(dbPath);
				opened.close();
			} catch (error) {
				connectionError = error instanceof Error ? error.message : String(error);
			}
			const inspected = new Database(dbPath);
			const after = schemaSnapshot(inspected);
			inspected.close();

			// Assert
			expect({ connectionError, after }).toEqual({ connectionError: null, after: before });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
