import { describe } from "vitest";
import * as proof from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { registerRejoinFinalizeTests } from "./coordinator-device-rejoin-finalize-test-harness.js";

describe("SQLite rejoin finalize", () => {
	registerRejoinFinalizeTests(async (use) => {
		const { db, store } = setupStore("SQLite");
		try {
			await use({
				proof,
				first: async <T>({ sql, values }: AuthLinkStatement) =>
					(db.prepare(sql).get(...values) as T | undefined) ?? null,
				run: async (sql, ...values) => db.prepare(sql).run(...values),
				changed: async ({ sql, values }) => db.prepare(sql).run(...values).changes,
				batch: async (statements) =>
					db
						.transaction(() =>
							statements.map(({ sql, values }) => {
								const statement = db.prepare(sql);
								return statement.reader ? statement.all(...values) : statement.run(...values);
							}),
						)
						.immediate(),
			});
		} finally {
			await store.close();
		}
	});
});
