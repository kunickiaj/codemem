import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";
import { JOIN_NOW } from "./coordinator-join-revocation-test-harness.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";
import {
	type LifecycleFixture,
	registerOwnershipWriterLifecycle,
} from "./shared-ownership-writer-lifecycle-test-harness.js";

describe.each(["SQLite", "D1"] as const)(
	"%s cross-writer lifecycle with actual SQLite file reopen",
	(backend) => {
		const test = revocationHarness(async (use) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(JOIN_NOW));
			const directory = mkdtempSync(join(tmpdir(), "ownership-writer-"));
			const databasePath = join(directory, "coordinator.sqlite");
			let local = setupStore(backend, { databasePath });
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
			const f: LifecycleFixture = {
				store: local.store,
				input: revocationInput("ownership-lifecycle"),
				tables: (
					local.db
						.prepare(
							"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
						)
						.all() as { name: string }[]
				).map((row) => row.name),
				exec: async (sql, ...values) => {
					local.db.prepare(sql).run(...values);
				},
				rows: async (table) => {
					if (!f.tables.includes(table)) throw new Error("Unknown lifecycle fixture table");
					return local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
				},
				reopen: async () => {
					const before = await Promise.all(f.tables.map(f.rows));
					await local.store.close();
					if (local.db.open) local.db.close();
					if (backend === "SQLite") {
						const store = new BetterSqliteCoordinatorStore(databasePath);
						local = { store, db: store.db };
					} else {
						const db = new Database(databasePath);
						local = { db, store: new D1CoordinatorStore(sqliteD1(db)) };
					}
					f.store = local.store;
					expect(await Promise.all(f.tables.map(f.rows))).toEqual(before);
				},
			};
			try {
				await use(f);
				expect(fetch).not.toHaveBeenCalled();
			} finally {
				fetch.mockRestore();
				await local.store.close();
				if (local.db.open) local.db.close();
				rmSync(directory, { recursive: true, force: true });
				vi.useRealTimers();
			}
		});
		registerOwnershipWriterLifecycle(test);
	},
);
