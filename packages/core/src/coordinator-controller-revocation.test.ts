import { describe, expect, vi } from "vitest";
import { type Store, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	controllerGuardedD1,
	controllerTables,
	registerControllerReadWriteGuards,
	registerControllerRevocationContract,
} from "./coordinator-controller-revocation-test-harness.js";
import {
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";
import type { D1DatabaseLike } from "./d1-coordinator-store.js";

for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} controller revocation`, () => {
		const databases = new WeakMap<Store, D1DatabaseLike>();
		const test = revocationHarness(async (use) => {
			const { store, db } = setupStore(backend);
			databases.set(store, sqliteD1(db));
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
			try {
				await use({
					store,
					input: revocationInput("controller"),
					exec: async (sql, ...values) => {
						db.prepare(sql).run(...values);
					},
					rows: async (table) => {
						if (!controllerTables.includes(table))
							throw new Error("Unknown controller fixture table");
						return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
					},
				});
				expect(fetch).not.toHaveBeenCalled();
			} finally {
				fetch.mockRestore();
				db.close();
			}
		});
		registerControllerRevocationContract(test);
		if (backend === "D1")
			registerControllerReadWriteGuards(test, (f, gate) => {
				const db = databases.get(f.store);
				if (!db) throw new Error("Fixture database unavailable");
				// Fixture adapter uses the same in-memory SQLite database behind the D1 store.
				return controllerGuardedD1(db, gate);
			});
	});
}
