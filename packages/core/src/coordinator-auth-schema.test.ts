import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
	legacyLinkAuthorityRowsSql,
	linkAuthorityTables,
	withoutNewAuthorityColumns,
} from "../../cloudflare-coordinator-worker/test/link-authority-upgrade-fixture.js";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { AUTH_LINK_SCHEMA_SQL } from "./coordinator-auth-link-contract.js";
import { LEGACY_INLINE_AUTH_LINK_SCHEMA_SQL } from "./coordinator-auth-link-legacy-inline-test-fixture.js";
import { attempt, cfg } from "./coordinator-auth-link-test-fixtures.js";
import { CoordinatorAuthSchemaUpgradeRequiredError } from "./coordinator-auth-schema.js";
import { upgradeCoordinatorAuthSchemaFile } from "./coordinator-auth-schema-operator.js";

const directory = mkdtempSync(join(tmpdir(), "auth-cutover-"));
afterEach(() => {
	vi.restoreAllMocks();
});
// Each fixture file is disposable; no default profile or coordinator path is opened.
it("refuses old optional auth before a new-column query, keeps ordinary operations usable, and explicitly upgrades all rows", async () => {
	const path = join(directory, "legacy.sqlite");
	const store = new BetterSqliteCoordinatorStore(path);
	try {
		store.db.exec(linkAuthorityTables.map((table) => `DROP TABLE ${table};`).join("\n"));
		store.db.exec("DROP TABLE coordinator_auth_device_claims");
		store.db.exec(LEGACY_INLINE_AUTH_LINK_SCHEMA_SQL);
		store.db.exec(legacyLinkAuthorityRowsSql);
		const before = linkAuthorityTables.map((table) =>
			store.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all(),
		);
		const queries: string[] = [];
		const prepare = store.db.prepare.bind(store.db);
		const trace = vi.spyOn(store.db, "prepare").mockImplementation((sql) => {
			queries.push(sql);
			return prepare(sql);
		});
		await expect(store.createAuthLinkAttempt(attempt(), cfg)).rejects.toBeInstanceOf(
			CoordinatorAuthSchemaUpgradeRequiredError,
		);
		expect(queries.every((sql) => sql.includes("sqlite_master"))).toBe(true);
		trace.mockRestore();
		await store.createGroup("signed-sync-group");
		expect(await store.listGroups()).toHaveLength(1);
		expect(
			store.db
				.prepare(
					"SELECT 1 FROM pragma_table_info('coordinator_auth_link_attempts') WHERE name='authority_kind'",
				)
				.get(),
		).toBeUndefined();
		upgradeCoordinatorAuthSchemaFile(path);
		await expect(store.assertAuthSchemaReady()).resolves.toBeUndefined();
		expect(
			linkAuthorityTables.map((table) =>
				withoutNewAuthorityColumns(
					store.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all() as Record<
						string,
						unknown
					>[],
				),
			),
		).toEqual(before);
		expect(await store.maintainAuthLinkAttempts(cfg)).toMatchObject({ kind: "maintained" });
		expect(
			store.db
				.prepare("SELECT sql FROM sqlite_master WHERE name='coordinator_auth_device_claims'")
				.get(),
		).toMatchObject({ sql: expect.stringContaining("WITHOUT ROWID") });
	} finally {
		await store.close();
	}
});

it("rolls back fresh link DDL together with a failed proof install, then retries", async () => {
	const path = join(directory, "fresh.sqlite");
	const exec = Database.prototype.exec;
	let failed: Database.Database | undefined;
	const fault = vi.spyOn(Database.prototype, "exec").mockImplementation(function (
		this: Database.Database,
		sql,
	) {
		if (sql.includes("CREATE TABLE IF NOT EXISTS coordinator_auth_device_claims")) {
			failed = this;
			throw new Error("fixture proof failure");
		}
		return exec.call(this, sql);
	});
	expect(() => new BetterSqliteCoordinatorStore(path)).toThrow("fixture proof failure");
	fault.mockRestore();
	failed?.close();
	const db = new Database(path);
	expect(
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE name IN ('coordinator_auth_link_attempts','coordinator_auth_account_links','coordinator_auth_link_audit_log','coordinator_auth_device_claims')",
			)
			.all(),
	).toEqual([]);
	db.close();
	const store = new BetterSqliteCoordinatorStore(path);
	try {
		await expect(store.assertAuthSchemaReady()).resolves.toBeUndefined();
	} finally {
		await store.close();
	}
});

it("finishes a partial explicit fresh bootstrap without rebuilding the existing link tables", async () => {
	const path = join(directory, "partial.sqlite");
	const db = new Database(path);
	db.exec(AUTH_LINK_SCHEMA_SQL);
	const before = db
		.prepare(
			"SELECT name,sql FROM sqlite_master WHERE name LIKE 'coordinator_auth_%' ORDER BY name",
		)
		.all();
	db.close();
	const store = new BetterSqliteCoordinatorStore(path);
	try {
		await store.assertAuthSchemaReady();
		for (const table of before)
			expect(
				store.db
					.prepare("SELECT name,sql FROM sqlite_master WHERE name = ?")
					.get((table as { name: string }).name),
			).toEqual(table);
	} finally {
		await store.close();
	}
});

it("does not create a database when an operator selects a missing file", () => {
	expect(() => upgradeCoordinatorAuthSchemaFile(join(directory, "missing.sqlite"))).toThrow(
		/does not exist|unable to open/i,
	);
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));
