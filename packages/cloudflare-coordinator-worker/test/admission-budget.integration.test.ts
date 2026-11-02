import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { readAdmissionBudgetReservationReceipt } from "../../core/src/admission-budget.js";
import { ADMISSION_BUDGET_SCHEMA_STATEMENTS } from "../../core/src/admission-budget-schema.js";
import {
	allocate,
	type BudgetDatabase,
	budgetFixture,
	compile,
	registerBudgetScenarios,
} from "../../core/src/admission-budget-test-fixtures.js";
import type { Value } from "../../core/src/peer-traversal-coordinator-schema-common-test-fixtures.js";

// Existing migrated LOCAL D1 binding. No remote database or protected-row cleanup.
const native = (env as { COORDINATOR_DB: D1Database }).COORDINATOR_DB;
let sequence = 0;
const db: BudgetDatabase = {
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
const create = async () => budgetFixture(db, ++sequence, "b6d1");
beforeAll(async () => {
	for (const sql of ADMISSION_BUDGET_SCHEMA_STATEMENTS) await native.prepare(sql).run();
});
registerBudgetScenarios(create);

it("parses exactly one native all().results row, using stored grant and execution fields", async () => {
	const f = await create();
	await allocate(f);
	const statement = compile(f);

	const result = await native
		.prepare(statement.sql)
		.bind(...statement.bindings)
		.all();

	expect(result.results).toHaveLength(1);
	const receipt = readAdmissionBudgetReservationReceipt(result.results[0], statement);
	expect(receipt).toMatchObject({ status: "reserved", units: 0 });
	expect(
		await native
			.prepare("SELECT exec_id FROM admission_budget_buckets WHERE authority_id=?1")
			.bind(f.authority)
			.first(),
	).toEqual({ exec_id: statement.association.execId });
});
