import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS } from "../../core/src/peer-traversal-coordinator-schema.js";
import {
	type SchemaDatabase,
	schemaScenarios,
	type Value,
} from "../../core/src/peer-traversal-coordinator-schema-test-fixtures.js";
import { RELAY_ADMISSION_CLOCK_SQL } from "../../core/src/relay-admission-clock.js";

// Existing native LOCAL binding only. Permanent metadata uses unique authorities,
// never cleanup DELETEs, disabled triggers, remote APIs, or JavaScript time mocks.
const native = env.COORDINATOR_DB;
let sequence = 0;
const db: SchemaDatabase = {
	run: async (sql, values = []) =>
		native
			.prepare(sql)
			.bind(...values)
			.run(),
	all: async (sql, values = []) =>
		(
			await native
				.prepare(sql)
				.bind(...values)
				.all<Record<string, Value>>()
		).results,
	batch: async (statements) =>
		native.batch(statements.map(({ sql, values }) => native.prepare(sql).bind(...values))),
};
beforeAll(async () => {
	for (const sql of TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS) await native.prepare(sql).run();
});
schemaScenarios(async () => {
	const clock = await native
		.prepare(`SELECT ${RELAY_ADMISSION_CLOCK_SQL} AS now`)
		.first<{ now: number }>();
	if (!clock || !Number.isSafeInteger(clock.now)) throw new Error("local SQL clock unavailable");
	return { db, now: clock.now, authority: `d1b0${(++sequence).toString(16).padStart(60, "0")}` };
});
describe("native local D1 traversal definitions", () => {
	it("exports frozen portable statements", () => {
		const statements = TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS;

		const frozen = Object.isFrozen(statements);

		expect(frozen).toBe(true);
	});
});
