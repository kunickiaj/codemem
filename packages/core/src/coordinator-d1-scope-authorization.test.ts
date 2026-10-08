import { describe, expect, vi } from "vitest";
import { review, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	registerScopeContract,
	registerScopeRaces,
	registerScopeReceipts,
	scopeTables,
} from "./coordinator-d1-scope-authorization-test-harness.js";
import { contractHarness } from "./coordinator-identity-group-grant-test-harness.js";

describe("D1 scope authorization SQLite adapter", () => {
	const databases = new WeakMap<object, ReturnType<typeof sqliteD1>>();
	const test = contractHarness(async (use) => {
		const f = setupStore("D1");
		databases.set(f.store, sqliteD1(f.db));
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store: f.store,
				review: review(),
				exec: async (sql, ...values) => {
					f.db.prepare(sql).run(...values);
				},
				rows: async (table) => {
					if (!scopeTables.includes(table)) throw new Error("Unknown fixture table");
					return f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	const database = (f: { store: object }) => {
		const db = databases.get(f.store);
		if (!db) throw new Error("Missing fixture database");
		return db;
	};
	registerScopeContract(test);
	registerScopeRaces(test, database);
	registerScopeReceipts(test, database);
});
