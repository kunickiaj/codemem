import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import {
	NOW,
	qualifiedFixture,
	qualifiedTest,
} from "../../core/src/owner-qualified-consumer-test-harness.js";
import { pendingKey } from "./owner-authority-test-fixture.js";

const db = env.COORDINATOR_DB;
const inventory =
	"SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name<>'d1_migrations'";
const baseline = (
	await db
		.prepare(`${inventory} ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`)
		.all<{ type: string; name: string; sql: string }>()
).results;
export const test = qualifiedTest(async (use) => {
	const objects = (
		await db
			.prepare(
				`${inventory} ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`,
			)
			.all<{ type: string; name: string }>()
	).results;
	await db.batch(objects.map((o) => db.prepare(`DROP ${o.type.toUpperCase()} "${o.name}"`)));
	await db.batch(baseline.map((o) => db.prepare(o.sql)));
	const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	const prepare = (s: { sql: string; values: unknown[] }) => db.prepare(s.sql).bind(...s.values);
	try {
		await use(
			await qualifiedFixture({
				explain: async ({ sql, values }) =>
					(
						await db
							.prepare(`EXPLAIN QUERY PLAN ${sql}`)
							.bind(...values)
							.all<{ id: number; parent: number; detail: string }>()
					).results,
				store: new D1CoordinatorStore(db, { authClock: () => NOW }),
				key: pendingKey,
				rows: async (table) =>
					(await db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>()).results,
				backend: {
					first: (s) => prepare(s).first(),
					run: async (s) => (await prepare(s).run()).meta.changes,
					batch: (s) => db.batch(s.map(prepare)),
				},
			}),
		);
		expect(network).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
	}
});
