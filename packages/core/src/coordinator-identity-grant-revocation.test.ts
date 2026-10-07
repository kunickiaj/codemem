import { describe, expect, vi } from "vitest";
import { review, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	guardedGrantD1,
	registerIdentityGrantRevocationContract,
	registerIdentityGrantStatementGuards,
} from "./coordinator-identity-grant-revocation-test-harness.js";
import { contractHarness } from "./coordinator-identity-group-grant-test-harness.js";

describe.each(["SQLite", "D1"] as const)("%s identity grant source revocation", (backend) => {
	const test = contractHarness(async (use) => {
		const f = setupStore(backend, { authClock: () => 1791028800000 });
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store: f.store,
				review: review(),
				exec: async (sql, ...values) => {
					f.db.prepare(sql).run(...values);
				},
				rows: async (table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerIdentityGrantRevocationContract(test);
});

describe("D1 identity grant statement races", () => {
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
				rows: async (table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerIdentityGrantStatementGuards(test, (f, hook) => {
		const db = databases.get(f.store);
		if (!db) throw new Error("Fixture database unavailable");
		return guardedGrantD1(db, hook);
	});
});
