import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";
import {
	adapterFixture,
	registerAdapterScenarios,
} from "../../core/src/admission-budget-adapter-test-fixtures.js";
import { ADMISSION_BUDGET_SCHEMA_STATEMENTS } from "../../core/src/admission-budget-schema.js";
import type { WriteDatabase } from "../../core/src/peer-traversal-coordinator-attempt-write-test-fixtures.js";
import { TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS } from "../../core/src/peer-traversal-coordinator-schema.js";
import type { Value } from "../../core/src/peer-traversal-coordinator-schema-common-test-fixtures.js";
import { RELAY_ADMISSION_CLOCK_SQL } from "../../core/src/relay-admission-clock.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "../../core/src/relay-admission-metadata-schema.js";

// Actual migrated LOCAL D1 binding. No remote requests, cleanup DELETEs or clock overrides.
const native = (env as { COORDINATOR_DB: D1Database }).COORDINATOR_DB;
let sequence = 0x830000;
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
	for (const sql of [
		...ADMISSION_BUDGET_SCHEMA_STATEMENTS,
		...TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS,
		...RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS,
	])
		await native.prepare(sql).run();
});
registerAdapterScenarios(async () => {
	const row = await native
		.prepare(`SELECT ${RELAY_ADMISSION_CLOCK_SQL} AS now`)
		.first<{ now: number }>();
	if (!row || !Number.isSafeInteger(row.now)) throw new Error("local SQL clock unavailable");
	return adapterFixture(db, row.now, ++sequence);
});
