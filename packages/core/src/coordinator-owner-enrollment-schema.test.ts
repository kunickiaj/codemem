import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { readBrowserFixtureMigrations } from "../../cloudflare-coordinator-worker/test/browser-purpose-migrations-fixture.js";
import {
	normalizeDefinitions,
	type SchemaFixture,
} from "./coordinator-auth-browser-migration-test-harness.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL } from "./coordinator-owner-enrollment-schema.js";
import {
	finalizedOwner,
	insertOwner,
	ownerDefinitions,
	ownerHarness,
	ownerRows,
	registerOwnerSchemaTests,
} from "./coordinator-owner-enrollment-test-harness.js";

function sqliteFixture(db: Database.Database): SchemaFixture {
	return {
		exec: async (sql, ...values) => {
			db.prepare(sql).run(...values);
		},
		query: async (sql) => db.prepare(sql).all() as Record<string, unknown>[],
	};
}
for (const backend of ["SQLite", "D1"] as const) {
	const test = ownerHarness(async (use) => {
		const f = setupStore(backend, { authClock: () => NOW });
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({ ...sqliteFixture(f.db), store: f.store });
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			f.db.close();
		}
	});
	registerOwnerSchemaTests(test);
	test(`${backend} fresh schema matches the exact shared table/index definitions`, async ({
		fixture: f,
	}) => {
		const reference = new Database(":memory:");
		try {
			reference.exec(COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL);
			expect(normalizeDefinitions(await f.query(ownerDefinitions))).toEqual(
				normalizeDefinitions(await sqliteFixture(reference).query(ownerDefinitions)),
			);
		} finally {
			reference.close();
		}
	});
}

it("official source migration creates the same owner table, indexes and immutable triggers as fresh SQLite", async () => {
	const db = new Database(":memory:");
	const fresh = setupStore("SQLite");
	try {
		const migrations = await readBrowserFixtureMigrations();
		// Browser reservation 0029 must precede owner-only 0030.
		for (const migration of migrations.filter((m) => m.name < "0030"))
			db.transaction(() => {
				for (const sql of migration.queries) db.exec(sql);
			})();
		const migration = migrations.find((m) => m.name === "0030_add_owner_enrollment_attempts.sql");
		if (!migration) throw new Error("Missing owner fixture migration");
		db.transaction(() => {
			for (const sql of migration.queries) db.exec(sql);
		})();
		expect(normalizeDefinitions(await sqliteFixture(db).query(ownerDefinitions))).toEqual(
			normalizeDefinitions(await sqliteFixture(fresh.db).query(ownerDefinitions)),
		);
	} finally {
		db.close();
		fresh.db.close();
	}
});
it("finalized commitments and exact outcome survive a real SQLite file close and reopen", async () => {
	const directory = mkdtempSync(join(tmpdir(), "owner-schema-test-"));
	const path = join(directory, "fixture.sqlite");
	let db: Database.Database | undefined;
	try {
		db = setupStore("SQLite", { databasePath: path }).db;
		await insertOwner(sqliteFixture(db), finalizedOwner);
		const before = await ownerRows(sqliteFixture(db));
		db.close();
		db = undefined;
		db = setupStore("SQLite", { databasePath: path }).db;
		expect(await ownerRows(sqliteFixture(db))).toEqual(before);
	} finally {
		db?.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
