import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { readBrowserFixtureMigrations } from "../../cloudflare-coordinator-worker/test/browser-purpose-migrations-fixture.js";
import {
	normalizeDefinitions,
	type SchemaFixture,
} from "./coordinator-auth-browser-migration-test-harness.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_SQL } from "./coordinator-owner-enrollment-qualification-schema.js";
import {
	QUALIFICATION_TABLE,
	qualificationDefinitions,
	qualificationHarness,
	registerQualificationSchemaTests,
} from "./coordinator-owner-enrollment-qualification-test-harness.js";

function fixture(db: Database.Database): SchemaFixture {
	return {
		exec: async (sql, ...values) => {
			db.prepare(sql).run(...values);
		},
		query: async (sql) => db.prepare(sql).all() as Record<string, unknown>[],
	};
}
const test = qualificationHarness(async (use) => {
	const db = new Database(":memory:");
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	try {
		db.pragma("foreign_keys = ON");
		db.exec(COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_SQL);
		await use(fixture(db));
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		db.close();
		fetch.mockRestore();
	}
});
registerQualificationSchemaTests(test);

test("source DDL is idempotent, installs only empty qualification storage, and matches migration 0035", async ({
	fixture: f,
}) => {
	// Arrange
	const migrations = await readBrowserFixtureMigrations();
	const migration = migrations.find(
		(m) => m.name === "0035_add_owner_enrollment_qualifications.sql",
	);
	if (!migration) throw new Error("Missing qualification migration");
	const reference = new Database(":memory:");
	try {
		// Act: neither path requires or rebuilds owner-attempt or authority tables.
		for (const sql of migration.queries) reference.exec(sql);
		for (const sql of migration.queries) reference.exec(sql);
		// Assert
		expect(normalizeDefinitions(await f.query(qualificationDefinitions))).toEqual(
			normalizeDefinitions(await fixture(reference).query(qualificationDefinitions)),
		);
		expect(await f.query("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([
			{ name: QUALIFICATION_TABLE },
		]);
		expect(reference.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
			{ name: QUALIFICATION_TABLE },
		]);
		expect(await f.query(`SELECT * FROM ${QUALIFICATION_TABLE}`)).toEqual([]);
		expect(reference.prepare(`SELECT * FROM ${QUALIFICATION_TABLE}`).all()).toEqual([]);
	} finally {
		reference.close();
	}
});
it("ordinary SQLite store startup does not install the inert qualification schema", () => {
	// Arrange
	const f = setupStore("SQLite");
	try {
		// Act
		const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
		// Assert: existing owner storage still opens without opting into qualification storage.
		expect(tables).toContainEqual({ name: "coordinator_owner_enrollment_attempts" });
		expect(tables).not.toContainEqual({ name: QUALIFICATION_TABLE });
	} finally {
		f.db.close();
	}
});
