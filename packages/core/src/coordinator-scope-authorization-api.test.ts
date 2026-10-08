import { describe, expect, vi } from "vitest";
import { review, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { contractHarness } from "./coordinator-identity-group-grant-test-harness.js";
import {
	registerScopeApiQueryBudget,
	registerScopeAuthorizationApi,
	scopeApiNowMs,
} from "./coordinator-scope-authorization-api-test-harness.js";

describe.each(["SQLite", "D1"] as const)("%s public scope authorization API", (backend) => {
	const databases = new WeakMap<object, ReturnType<typeof sqliteD1>>();
	const test = contractHarness(async (use) => {
		const f = setupStore(backend);
		databases.set(f.store, sqliteD1(f.db));
		const close = f.store.close.bind(f.store);
		vi.spyOn(f.store, "close").mockResolvedValue(undefined);
		vi.spyOn(Date, "now").mockReturnValue(scopeApiNowMs);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store: f.store,
				review: review(),
				exec: async (sql, ...values) => {
					f.db.prepare(sql).run(...values);
				},
				rows: async () => [],
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			await close();
			if (f.db.open) f.db.close();
		}
	});
	registerScopeAuthorizationApi(test);
	if (backend === "D1")
		registerScopeApiQueryBudget(test, (f) => {
			const db = databases.get(f.store);
			if (!db) throw new Error("Missing fixture database");
			return db;
		});
});
