import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ADMISSION_BUDGET_ALLOCATION_SCHEMA_STATEMENTS } from "./admission-budget-allocation-schema.js";
import {
	allocationFixture,
	registerAllocationScenarios,
} from "./admission-budget-allocation-schema-test-fixtures.js";
import type {
	SchemaDatabase,
	Value,
} from "./peer-traversal-coordinator-schema-common-test-fixtures.js";

const databases: Database.Database[] = [];
let sequence = 0;
async function create() {
	const native = new Database(":memory:");
	databases.push(native);
	native.pragma("foreign_keys=ON");
	for (const sql of ADMISSION_BUDGET_ALLOCATION_SCHEMA_STATEMENTS) native.exec(sql);
	const bind = (values: readonly Value[]) =>
		Object.fromEntries(values.map((value, index) => [index + 1, value]));
	const run = (sql: string, values: Value[] = []) => native.prepare(sql).run(bind(values));
	const db: SchemaDatabase = {
		run: async (sql, values) => run(sql, values),
		all: async (sql, values = []) =>
			native.prepare(sql).all(bind(values)) as Record<string, Value>[],
		batch: async (statements) =>
			native.transaction(() => {
				for (const entry of statements) run(entry.sql, entry.values);
			})(),
	};
	return allocationFixture(db, ++sequence, "b6a2");
}
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
registerAllocationScenarios(create);

describe("independent inert allocation definitions", () => {
	it("exports frozen SQL and installs only one empty WITHOUT ROWID allocation table on request", () => {
		const native = new Database(":memory:");
		databases.push(native);
		const before = native.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

		for (const sql of ADMISSION_BUDGET_ALLOCATION_SCHEMA_STATEMENTS) native.exec(sql);
		const tables = native
			.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'")
			.all() as { name: string; sql: string }[];

		expect(Object.isFrozen(ADMISSION_BUDGET_ALLOCATION_SCHEMA_STATEMENTS)).toBe(true);
		expect(before).toEqual([]);
		expect(tables.map((row) => row.name)).toEqual(["admission_budget_allocations"]);
		for (const table of tables) expect(table.sql).toMatch(/WITHOUT\s+ROWID/i);
		expect(native.prepare("SELECT * FROM admission_budget_allocations").all()).toEqual([]);
	});
	it("cannot query policy without explicit installation", () => {
		const native = new Database(":memory:");
		databases.push(native);

		const read = () => native.prepare("SELECT * FROM admission_budget_allocations").all();

		expect(read).toThrow(/no such table/);
	});
});
