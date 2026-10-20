import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";
import {
	qualificationOpsFixture,
	qualificationOpsTest,
} from "./owner-enrollment-qualification-ops-test-harness.js";

const db = env.COORDINATOR_DB;
// Native tests share storage. Recreate the migrated isolated test database before
// each case, including immutable tables and schema mutations, without DELETE bypasses.
const baseline = (
	await db
		.prepare(
			"SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name<>'d1_migrations' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
		)
		.all<{ type: string; name: string; sql: string }>()
).results;
export const test = qualificationOpsTest(async (use) => {
	const objects = (
		await db
			.prepare(
				"SELECT type,name FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name<>'d1_migrations' ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'index' THEN 1 ELSE 2 END",
			)
			.all<{ type: string; name: string }>()
	).results;
	await db.batch(objects.map((o) => db.prepare(`DROP ${o.type.toUpperCase()} "${o.name}"`)));
	await db.batch(baseline.map((o) => db.prepare(o.sql)));
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	try {
		await use(
			await qualificationOpsFixture({
				query: async (sql) => (await db.prepare(sql).all<Record<string, unknown>>()).results,
				backend: {
					first: ({ sql, values }) =>
						db
							.prepare(sql)
							.bind(...values)
							.first(),
					run: async ({ sql, values }) =>
						(
							await db
								.prepare(sql)
								.bind(...values)
								.run()
						).meta.changes,
					batch: (statements) =>
						db.batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values))),
				},
			}),
		);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});
