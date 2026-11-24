import { describe } from "vitest";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	registerRejoinStartEvidenceTests,
	registerRejoinStartWriteTests,
} from "./coordinator-device-rejoin-start-evidence-test-harness.js";

describe.each(["SQLite", "D1"] as const)("%s rejoin start evidence", (backend) => {
	const withFixture: Parameters<typeof registerRejoinStartEvidenceTests>[0] = async (run) => {
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
				batch: async (statements) => {
					if (backend === "D1") {
						return d1.batch(statements.map(({ sql, values }) => d1.prepare(sql).bind(...values)));
					}
					return db
						.transaction(() =>
							statements.map(({ sql, values }) => {
								const statement = db.prepare(sql);
								if (statement.reader) return statement.all(...values);
								return statement.run(...values);
							}),
						)
						.immediate();
				},
			});
		} finally {
			await store.close();
			if (db.open) db.close();
		}
	};
	registerRejoinStartEvidenceTests(withFixture);
	registerRejoinStartWriteTests(withFixture);
});
