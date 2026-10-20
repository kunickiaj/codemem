import { expect, vi } from "vitest";
import { setupStore } from "../../core/src/coordinator-auth-store-test-fixtures.js";
import { COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS } from "../../core/src/coordinator-owner-enrollment-qualification-schema.js";
import {
	qualificationOpsFixture,
	qualificationOpsTest,
} from "./owner-enrollment-qualification-ops-test-harness.js";

export const test = qualificationOpsTest(async (use) => {
	const { db } = setupStore("SQLite");
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	try {
		for (const sql of COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS) db.exec(sql);
		await use(
			await qualificationOpsFixture({
				query: async (sql) => db.prepare(sql).all() as Record<string, unknown>[],
				backend: {
					first: async <T>({ sql, values }: { sql: string; values: unknown[] }) =>
						(db.prepare(sql).get(...values) as T | undefined) ?? null,
					run: async ({ sql, values }) => db.prepare(sql).run(...values).changes,
					batch: async (statements) =>
						db.transaction(() =>
							statements.map(({ sql, values }) => db.prepare(sql).run(...values)),
						)(),
				},
			}),
		);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
		db.close();
	}
});
