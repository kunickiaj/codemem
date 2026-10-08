import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { readOwnerFixtureMigrations } from "../../cloudflare-coordinator-worker/test/owner-enrollment-migrations-fixture.js";
import { upgradeAuthBrowserOwnerPurposeSchema } from "./coordinator-auth-browser-schema-upgrade.js";
import { AUTH_BROWSER_TXN_SCHEMA_SQL } from "./coordinator-auth-browser-transaction-contract.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	assertBrowserUniqueness,
	browserDefinitions,
	browserSnapshot,
	normalizeDefinitions,
	type SchemaFixture,
	seedOldBrowserRows,
} from "./coordinator-owner-enrollment-migration-test-harness.js";
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
		// Arrange
		const reference = new Database(":memory:");
		try {
			reference.exec(COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL);
			// Act
			const actual = normalizeDefinitions(await f.query(ownerDefinitions));
			// Assert
			expect(actual).toEqual(
				normalizeDefinitions(await sqliteFixture(reference).query(ownerDefinitions)),
			);
		} finally {
			reference.close();
		}
	});
}

async function oldMigrationDatabase() {
	const db = new Database(":memory:");
	const migrations = await readOwnerFixtureMigrations();
	for (const migration of migrations.filter((m) => m.name < "0029"))
		db.transaction(() => {
			for (const sql of migration.queries) db.exec(sql);
		})();
	return { db, migrations, fixture: sqliteFixture(db) };
}
it("official source migration creates the same owner table, indexes and immutable triggers as fresh SQLite", async () => {
	// Arrange
	const { db, migrations, fixture: f } = await oldMigrationDatabase();
	const fresh = setupStore("SQLite");
	try {
		const migration = migrations.find((m) => m.name === "0029_add_owner_enrollment_attempts.sql");
		if (!migration) throw new Error("Missing owner fixture migration");
		// Act
		db.transaction(() => {
			for (const sql of migration.queries) db.exec(sql);
		})();
		// Assert
		expect(normalizeDefinitions(await f.query(ownerDefinitions))).toEqual(
			normalizeDefinitions(await sqliteFixture(fresh.db).query(ownerDefinitions)),
		);
	} finally {
		db.close();
		fresh.db.close();
	}
});
it("SQLite upgrades all six old browser state/purpose rows twice without losing counters, indexes or triggers", async () => {
	// Arrange
	const { db, fixture: f } = await oldMigrationDatabase();
	const reference = new Database(":memory:");
	try {
		await seedOldBrowserRows(f);
		db.exec(
			"CREATE INDEX fixture_browser_revision ON coordinator_auth_browser_transactions(auth_config_revision); CREATE TRIGGER fixture_browser_update AFTER UPDATE ON coordinator_auth_browser_transactions BEGIN SELECT 1; END;",
		);
		const before = await browserSnapshot(f);
		const custom = await f.query(
			"SELECT name,sql FROM sqlite_master WHERE name LIKE 'fixture_browser_%' ORDER BY name",
		);
		// ALTER TABLE RENAME records a quoted table identifier in sqlite_master.
		reference.exec(
			AUTH_BROWSER_TXN_SCHEMA_SQL.replace(
				"CREATE TABLE IF NOT EXISTS coordinator_auth_browser_transactions",
				'CREATE TABLE IF NOT EXISTS "coordinator_auth_browser_transactions"',
			),
		);
		// Act
		upgradeAuthBrowserOwnerPurposeSchema(db);
		upgradeAuthBrowserOwnerPurposeSchema(db);
		// Assert
		expect(await browserSnapshot(f)).toEqual(before);
		expect(
			await f.query(
				"SELECT name,sql FROM sqlite_master WHERE name LIKE 'fixture_browser_%' ORDER BY name",
			),
		).toEqual(custom);
		const definitions = normalizeDefinitions(await f.query(browserDefinitions)).filter(
			(row) => !String(row.name).startsWith("fixture_"),
		);
		expect(definitions).toEqual(
			normalizeDefinitions(await sqliteFixture(reference).query(browserDefinitions)),
		);
		await assertBrowserUniqueness(f);
	} finally {
		db.close();
		reference.close();
	}
});
it("SQLite owner-purpose upgrade transacts only for a legacy browser schema", async () => {
	// Arrange: old fixture migrations finish before observing the upgrade helper.
	const { db } = await oldMigrationDatabase();
	const transaction = vi.spyOn(db, "transaction");
	try {
		// Act: the legacy rebuild still uses the atomic transaction path.
		upgradeAuthBrowserOwnerPurposeSchema(db);
		// Assert
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(db.inTransaction).toBe(false);
		// Arrange: the owner-purpose schema is now current.
		transaction.mockClear();
		// Act
		upgradeAuthBrowserOwnerPurposeSchema(db);
		// Assert: warm preflight must not even invoke the transaction API.
		expect(transaction).not.toHaveBeenCalled();
		expect(db.inTransaction).toBe(false);
	} finally {
		transaction.mockRestore();
		db.close();
	}
});
it("SQLite copy failure inside the real upgrade transaction retains the entire old schema and rows", async () => {
	// Arrange
	const { db, fixture: f } = await oldMigrationDatabase();
	try {
		await seedOldBrowserRows(f);
		const before = await browserSnapshot(f);
		const definitions = await f.query(browserDefinitions);
		const exec = db.exec.bind(db);
		const fault = vi
			.spyOn(db, "exec")
			.mockImplementation((sql) =>
				exec(
					sql.replace(
						"INSERT INTO coordinator_auth_browser_transactions_owner_upgrade SELECT *",
						"INSERT INTO coordinator_auth_browser_transactions_owner_upgrade SELECT absent_fixture_column",
					),
				),
			);
		// Act
		const upgrade = () => upgradeAuthBrowserOwnerPurposeSchema(db);
		// Assert
		expect(upgrade).toThrow(/absent_fixture_column/);
		fault.mockRestore();
		expect(await browserSnapshot(f)).toEqual(before);
		expect(await f.query(browserDefinitions)).toEqual(definitions);
		expect(
			await f.query(
				"SELECT name FROM sqlite_master WHERE name = 'coordinator_auth_browser_transactions_owner_upgrade'",
			),
		).toEqual([]);
	} finally {
		vi.restoreAllMocks();
		db.close();
	}
});
it("finalized commitments and exact outcome survive a real SQLite file close and reopen", async () => {
	// Arrange
	const directory = mkdtempSync(join(tmpdir(), "owner-schema-test-"));
	const path = join(directory, "fixture.sqlite");
	let db: Database.Database | undefined;
	try {
		const initial = setupStore("SQLite", { databasePath: path });
		db = initial.db;
		await insertOwner(sqliteFixture(db), finalizedOwner);
		const before = await ownerRows(sqliteFixture(db));
		db.close();
		db = undefined;
		// Act
		db = setupStore("SQLite", { databasePath: path }).db;
		// Assert
		expect(await ownerRows(sqliteFixture(db))).toEqual(before);
	} finally {
		db?.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
