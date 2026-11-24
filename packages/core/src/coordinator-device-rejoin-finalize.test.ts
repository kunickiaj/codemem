import { describe } from "vitest";
import * as proof from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { registerRejoinBrowserTransactionTests } from "./coordinator-device-rejoin-browser-transaction-test-harness.js";
import { registerRejoinFinalizeTests } from "./coordinator-device-rejoin-finalize-test-harness.js";

describe("SQLite rejoin storage", () => {
	const withFixture: Parameters<typeof registerRejoinFinalizeTests>[0] = async (use) => {
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
	};
	registerRejoinFinalizeTests(withFixture);
	registerRejoinBrowserTransactionTests(withFixture);
});
