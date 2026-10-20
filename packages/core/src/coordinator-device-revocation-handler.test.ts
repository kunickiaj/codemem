import { describe, expect, vi } from "vitest";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { registerDeviceRevocationHandlerContract } from "./coordinator-device-revocation-handler-test-harness.js";
import {
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";

describe("SQLite inactive operator revocation handler", () => {
	const test = revocationHarness(async (use) => {
		let tick = 0;
		const f = setupStore("SQLite", { authClock: () => 1791244800000 + tick++ });
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store: f.store,
				input: revocationInput(),
				exec: async (sql, ...values) => {
					f.db.prepare(sql).run(...values);
				},
				rows: async (table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerDeviceRevocationHandlerContract(test);
});
