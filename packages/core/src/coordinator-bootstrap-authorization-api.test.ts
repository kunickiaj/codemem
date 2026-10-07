import { describe, expect, vi } from "vitest";
import { review, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { registerBootstrapAuthorizationApi } from "./coordinator-bootstrap-authorization-api-test-harness.js";
import { authorizationNowMs } from "./coordinator-bootstrap-authorization-test-harness.js";
import { contractHarness } from "./coordinator-identity-group-grant-test-harness.js";

describe.each(["SQLite", "D1"] as const)("%s versioned bootstrap API", (backend) => {
	const test = contractHarness(async (use) => {
		const f = setupStore(backend);
		const close = f.store.close.bind(f.store);
		vi.spyOn(f.store, "close").mockResolvedValue(undefined);
		vi.spyOn(Date, "now").mockReturnValue(authorizationNowMs);
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
	registerBootstrapAuthorizationApi(test);
});
