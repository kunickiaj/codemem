import { describe, vi } from "vitest";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	keyIdFillApiHarness,
	registerKeyIdFillApiContract,
} from "./coordinator-key-id-fill-api-test-harness.js";

describe.each(["SQLite", "D1"] as const)("%s key ID fill API", (backend) => {
	const test = keyIdFillApiHarness(async (use) => {
		const f = setupStore(backend);
		try {
			await use({
				store: f.store,
				exec: async (sql) => {
					f.db.exec(sql);
				},
			});
		} finally {
			vi.restoreAllMocks();
			await f.store.close();
		}
	});
	registerKeyIdFillApiContract(test);
});
