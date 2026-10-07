import { describe, expect, vi } from "vitest";
import {
	authLinkGuardedD1,
	linkRevocationHarness,
	linkRevocationTables,
	NOW,
	registerAuthLinkAtomicGuards,
	registerAuthLinkRevocationContract,
} from "./coordinator-auth-link-revocation-test-harness.js";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { revocationInput } from "./coordinator-device-revocation-test-harness.js";
import type { D1DatabaseLike } from "./d1-coordinator-store.js";

for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} account-link revocation`, () => {
		const databases = new WeakMap<Store, D1DatabaseLike>();
		const test = linkRevocationHarness(async (use) => {
			const clock = { now: NOW };
			const { store, db } = setupStore(backend, { authClock: () => clock.now });
			databases.set(store, sqliteD1(db));
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
			try {
				await use({
					store,
					input: revocationInput("link"),
					get now() {
						return clock.now;
					},
					set now(value) {
						clock.now = value;
					},
					exec: async (sql, ...values) => {
						db.prepare(sql).run(...values);
					},
					rows: async (table) => {
						if (!linkRevocationTables.includes(table as (typeof linkRevocationTables)[number]))
							throw new Error("Unknown account-link fixture table");
						return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
					},
				});
				expect(fetch).not.toHaveBeenCalled();
			} finally {
				fetch.mockRestore();
				db.close();
			}
		});
		registerAuthLinkRevocationContract(test);
		registerAuthLinkAtomicGuards(test, (f, gate) => {
			const db = databases.get(f.store);
			if (!db) throw new Error("Account-link fixture database unavailable");
			return authLinkGuardedD1(db, gate, () => f.now);
		});
	});
}
