import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { ADMISSION_BUDGET_ALLOCATION_SCHEMA_STATEMENTS } from "../../core/src/admission-budget-allocation-schema.js";
import {
	allocationFixture,
	registerAllocationScenarios,
} from "../../core/src/admission-budget-allocation-schema-test-fixtures.js";
import type {
	SchemaDatabase,
	Value,
} from "../../core/src/peer-traversal-coordinator-schema-common-test-fixtures.js";

// Native LOCAL D1 only. The metadata prefix is distinct from the aggregate reservation suite.
const native = (env as { COORDINATOR_DB: D1Database }).COORDINATOR_DB;
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
	for (const sql of ADMISSION_BUDGET_ALLOCATION_SCHEMA_STATEMENTS) await native.prepare(sql).run();
});
registerAllocationScenarios(async () => allocationFixture(db, ++sequence, "b6d2"));

it("exports frozen allocation definitions independently", () => {
	const statements = ADMISSION_BUDGET_ALLOCATION_SCHEMA_STATEMENTS;

	const frozen = Object.isFrozen(statements);

	expect(frozen).toBe(true);
});
