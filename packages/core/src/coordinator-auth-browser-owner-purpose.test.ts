import { expect, vi } from "vitest";
import { assertReservedOwnerPurposeIsolation } from "./coordinator-auth-browser-owner-purpose-test-harness.js";
import { backendTest } from "./coordinator-auth-link-test-fixtures.js";

for (const backend of ["SQLite", "D1"] as const) {
	const test = backendTest(backend);
	test(`${backend} legacy browser handlers reject reserved owner rows without burning material`, async ({
		fixture: f,
	}) => {
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await assertReservedOwnerPurposeIsolation({
				store: f.store,
				exec: async (sql, ...values) => {
					f.db.prepare(sql).run(...values);
				},
				query: async (sql) => f.db.prepare(sql).all() as Record<string, unknown>[],
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
}
