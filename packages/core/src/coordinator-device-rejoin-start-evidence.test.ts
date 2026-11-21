import { describe } from "vitest";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { registerRejoinStartEvidenceTests } from "./coordinator-device-rejoin-start-evidence-test-harness.js";

describe.each(["SQLite", "D1"] as const)("%s rejoin start evidence", (backend) => {
	registerRejoinStartEvidenceTests(async (run) => {
		const { db, store } = setupStore(backend);
		const d1 = sqliteD1(db);
		try {
			await run({
				first: <T>({ sql, values }: { sql: string; values: (string | number | null)[] }) =>
					backend === "D1"
						? d1
								.prepare(sql)
								.bind(...values)
								.first<T>()
						: Promise.resolve((db.prepare(sql).get(...values) as T | undefined) ?? null),
				run: async (sql, ...values) => db.prepare(sql).run(...values),
			});
		} finally {
			await store.close();
			if (db.open) db.close();
		}
	});
});
