import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";
import {
	type WriteDatabase,
	type WriteSeedOptions,
	writeFixture,
} from "../../core/src/peer-traversal-coordinator-attempt-write-test-fixtures.js";
import { registerPhaseScenarios } from "../../core/src/peer-traversal-coordinator-phase-write-test-fixtures.js";
import { TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS } from "../../core/src/peer-traversal-coordinator-schema.js";
import type { Value } from "../../core/src/peer-traversal-coordinator-schema-common-test-fixtures.js";
import { RELAY_ADMISSION_CLOCK_SQL } from "../../core/src/relay-admission-clock.js";

// Native local D1 only. Unique fixture IDs do not rely on storage isolation or protected-row cleanup.
const native = (env as { COORDINATOR_DB: D1Database }).COORDINATOR_DB;
let sequence = 0x770000;
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
registerPhaseScenarios(async (options: WriteSeedOptions = {}) => {
	const clock = await native
		.prepare(`SELECT ${RELAY_ADMISSION_CLOCK_SQL} AS now`)
		.first<{ now: number }>();
	if (!clock || !Number.isSafeInteger(clock.now)) throw new Error("missing local SQL clock");
	return writeFixture(db, clock.now, ++sequence, options);
});
