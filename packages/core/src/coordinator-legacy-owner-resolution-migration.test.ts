import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { readBrowserFixtureMigrations } from "../../cloudflare-coordinator-worker/test/browser-purpose-migrations-fixture.js";
import { normalizeDefinitions } from "./coordinator-auth-browser-migration-test-harness.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	LEGACY_OWNER_RESOLUTION_SCHEMA_SQL,
	LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS,
} from "./coordinator-legacy-owner-resolution-schema.js";

const table = "coordinator_legacy_owner_resolutions";
const definitions = `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name = '${table}' ORDER BY type, name`;
const worker = new URL("../../cloudflare-coordinator-worker/", import.meta.url);

describe("inert owner-resolution migration inputs", () => {
	it("migration 0037, complete statements and Worker fresh schema match source DDL", async () => {
		const migrations = await readBrowserFixtureMigrations();
		const migration = migrations.find(
			({ name }) => name === "0037_add_legacy_owner_resolutions.sql",
		);
		if (!migration) throw new Error("Missing owner-resolution migration");
		const reference = new Database(":memory:");
		try {
			reference.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
			const expected = normalizeDefinitions(
				reference.prepare(definitions).all() as Record<string, unknown>[],
			);
			for (const statements of [
				migration.queries,
				LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS,
				[readFileSync(new URL("schema.sql", worker), "utf8")],
			]) {
				const db = new Database(":memory:");
				try {
					for (let retry = 0; retry < 2; retry++) {
						for (const sql of statements) db.exec(sql);
					}
					expect(
						normalizeDefinitions(db.prepare(definitions).all() as Record<string, unknown>[]),
					).toEqual(expected);
					expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
				} finally {
					db.close();
				}
			}
		} finally {
			reference.close();
		}
	});

	it("ordinary SQLite startup does not install the inert sidecar", () => {
		const fixture = setupStore("SQLite");
		try {
			expect(fixture.db.prepare(definitions).all()).toEqual([]);
		} finally {
			fixture.db.close();
		}
	});

	it("never rebuilds an unrecognized preexisting table", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`CREATE TABLE ${table} (old_value TEXT NOT NULL)`);
			db.prepare(`INSERT INTO ${table} VALUES (?)`).run("synthetic-preserved-data");
			const before = db.prepare(definitions).all();
			expect(() => db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL)).toThrow();
			expect(db.prepare(definitions).all()).toEqual(before);
			expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([
				{ old_value: "synthetic-preserved-data" },
			]);
		} finally {
			db.close();
		}
	});
});
