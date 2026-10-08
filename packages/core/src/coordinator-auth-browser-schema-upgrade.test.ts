import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { readBrowserFixtureMigrations } from "../../cloudflare-coordinator-worker/test/browser-purpose-migrations-fixture.js";
import {
	assertBrowserUniqueness,
	browserDefinitions,
	browserSnapshot,
	normalizeDefinitions,
	type SchemaFixture,
	seedOldBrowserRows,
} from "./coordinator-auth-browser-migration-test-harness.js";
import { upgradeAuthBrowserOwnerPurposeSchema } from "./coordinator-auth-browser-schema-upgrade.js";
import { AUTH_BROWSER_TXN_SCHEMA_SQL } from "./coordinator-auth-browser-transaction-contract.js";

function sqliteFixture(db: Database.Database): SchemaFixture {
	return {
		exec: async (sql, ...values) => {
			db.prepare(sql).run(...values);
		},
		query: async (sql) => db.prepare(sql).all() as Record<string, unknown>[],
	};
}

async function oldMigrationDatabase() {
	const db = new Database(":memory:");
	const migrations = await readBrowserFixtureMigrations();
	for (const migration of migrations.filter((m) => m.name < "0029"))
		db.transaction(() => {
			for (const sql of migration.queries) db.exec(sql);
		})();
	return { db, migrations, fixture: sqliteFixture(db) };
}
it("official source migration preserves old browser rows and matches the fresh browser schema", async () => {
	// Arrange
	const { db, migrations, fixture: f } = await oldMigrationDatabase();
	const reference = new Database(":memory:");
	try {
		const migration = migrations.find((m) => m.name === "0029_add_owner_enrollment_attempts.sql");
		if (!migration) throw new Error("Missing browser-purpose fixture migration");
		await seedOldBrowserRows(f);
		const before = await browserSnapshot(f);
		reference.exec(
			AUTH_BROWSER_TXN_SCHEMA_SQL.replace(
				"CREATE TABLE IF NOT EXISTS coordinator_auth_browser_transactions",
				'CREATE TABLE IF NOT EXISTS "coordinator_auth_browser_transactions"',
			),
		);
		// Act
		db.transaction(() => {
			for (const sql of migration.queries) db.exec(sql);
		})();
		// Assert
		expect(await browserSnapshot(f)).toEqual(before);
		expect(normalizeDefinitions(await f.query(browserDefinitions))).toEqual(
			normalizeDefinitions(await sqliteFixture(reference).query(browserDefinitions)),
		);
		await assertBrowserUniqueness(f);
	} finally {
		db.close();
		reference.close();
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
it("SQLite warm owner-purpose preflight works on a read-only connection without invoking a transaction", () => {
	// Arrange
	const directory = mkdtempSync(join(tmpdir(), "browser-schema-test-"));
	const path = join(directory, "fixture.sqlite");
	let db: Database.Database | undefined;
	try {
		db = new Database(path);
		db.exec(AUTH_BROWSER_TXN_SCHEMA_SQL);
		db.close();
		db = undefined;
		// Act
		db = new Database(path, { readonly: true, fileMustExist: true });
		const transaction = vi.spyOn(db, "transaction");
		upgradeAuthBrowserOwnerPurposeSchema(db);
		// Assert
		expect(transaction).not.toHaveBeenCalled();
		expect(db.inTransaction).toBe(false);
	} finally {
		db?.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
