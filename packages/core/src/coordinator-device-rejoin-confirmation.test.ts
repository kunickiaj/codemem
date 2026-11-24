import { describe } from "vitest";
import * as proof from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { registerRejoinConfirmationTests } from "./coordinator-device-rejoin-confirmation-test-harness.js";

describe("SQLite rejoin confirmation", () => {
	registerRejoinConfirmationTests(async (use) => {
		const { db, store } = setupStore("SQLite");
		try {
			await use({
				proof,
				first: async <T>({ sql, values }: AuthLinkStatement) =>
					(db.prepare(sql).get(...values) as T | undefined) ?? null,
				run: async (sql, ...values) => db.prepare(sql).run(...values),
				changed: async ({ sql, values }) => db.prepare(sql).run(...values).changes,
			});
		} finally {
			await store.close();
		}
	});
});
