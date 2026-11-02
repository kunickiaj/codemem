import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";
import {
	type WriteDatabase,
	type WriteSeedOptions,
	writeFixture,
} from "../../core/src/peer-traversal-coordinator-attempt-write-test-fixtures.js";
import { registerDecisionScenarios } from "../../core/src/peer-traversal-coordinator-decision-test-fixtures.js";
import { TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS } from "../../core/src/peer-traversal-coordinator-schema.js";
import type { Value } from "../../core/src/peer-traversal-coordinator-schema-common-test-fixtures.js";
import { RELAY_ADMISSION_CLOCK_SQL } from "../../core/src/relay-admission-clock.js";

// Existing migrated native LOCAL D1 binding. No remote calls or protected metadata cleanup.
const native = (env as { COORDINATOR_DB: D1Database }).COORDINATOR_DB;
let sequence = 0x790000;
const db: WriteDatabase = {
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
	returning: async (statement) =>
		native
			.prepare(statement.sql)
			.bind(...statement.bindings)
			.first(),
};
beforeAll(async () => {
	for (const sql of TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS) await native.prepare(sql).run();
});
registerDecisionScenarios(async (options: WriteSeedOptions = {}) => {
	const clock = await native
		.prepare(`SELECT ${RELAY_ADMISSION_CLOCK_SQL} AS now`)
		.first<{ now: number }>();
	if (!clock || !Number.isSafeInteger(clock.now)) throw new Error("local SQL clock unavailable");
	return writeFixture(db, clock.now, ++sequence, options);
});
