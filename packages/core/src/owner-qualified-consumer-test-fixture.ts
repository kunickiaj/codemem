import { expect, vi } from "vitest";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { commitPendingKey } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import { COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS } from "./coordinator-owner-enrollment-qualification-schema.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { NOW, qualifiedFixture, qualifiedTest } from "./owner-qualified-consumer-test-harness.js";

export const test = qualifiedTest(async (use) => {
	const { db, store } = setupStore("D1", { authClock: () => NOW });
	const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	try {
		for (const sql of COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS) db.exec(sql);
		await use(
			await qualifiedFixture({
				explain: async ({ sql, values }) =>
					db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as {
						id: number;
						parent: number;
						detail: string;
					}[],
				store,
				backend: nativeBackend(db),
				rows: async (table) =>
					db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[],
				key: async () => {
					const key = commitPendingKey();
					return { publicKey: key.publicKey, sign: async (message) => key.sign(message) };
				},
			}),
		);
		expect(network).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		db.close();
	}
});
