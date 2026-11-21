import { describe, vi } from "vitest";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { registerBlockTombstoneContract } from "./coordinator-block-tombstone-test-harness.js";
import {
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";

describe.each(["SQLite", "D1"] as const)("%s operator block from tombstone", (backend) => {
	const test = revocationHarness(async (use) => {
		const { db, store } = setupStore(backend);
		vi.spyOn(store, "close").mockResolvedValue();
		try {
			await use({
				store,
				input: revocationInput("block-tombstone"),
				exec: async (sql, ...values) => {
					db.prepare(sql).run(...values);
				},
				rows: async (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
			});
		} finally {
			vi.restoreAllMocks();
			db.close();
		}
	});
	registerBlockTombstoneContract(test);
});
