import { describe } from "vitest";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { registerStatusLiveTests } from "./coordinator-device-rejoin-status-live-test-harness.js";

describe.each(["SQLite", "D1"] as const)("%s live status projection", (kind) => {
	registerStatusLiveTests(async (use) => {
		const { db, store } = setupStore(kind);
		const d1 = sqliteD1(db);
		try {
			await use({
				first: async <T>({ sql, values }: { sql: string; values: (string | number | null)[] }) => {
					db.pragma("query_only = ON");
					try {
						if (kind === "D1")
							return await d1
								.prepare(sql)
								.bind(...values)
								.first<T>();
						return (db.prepare(sql).get(...values) as T | undefined) ?? null;
					} finally {
						db.pragma("query_only = OFF");
					}
				},
				run: async (sql, ...values) => db.prepare(sql).run(...values),
			});
		} finally {
			await store.close();
			if (db.open) db.close();
		}
	});
});
