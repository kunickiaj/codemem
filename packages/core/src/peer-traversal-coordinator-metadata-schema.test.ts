import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { TRAVERSAL_COORDINATOR_METADATA_SCHEMA_STATEMENTS } from "./peer-traversal-coordinator-metadata-schema.js";
import { registerMetadataScenarios } from "./peer-traversal-coordinator-metadata-schema-test-fixtures.js";
import type {
	SchemaDatabase,
	Value,
} from "./peer-traversal-coordinator-schema-common-test-fixtures.js";

const databases: Database.Database[] = [];
function fixture() {
	const native = new Database(":memory:");
	databases.push(native);
	native.pragma("foreign_keys = ON");
	for (const sql of TRAVERSAL_COORDINATOR_METADATA_SCHEMA_STATEMENTS) native.exec(sql);
	const bindings = (values: Value[]) =>
		Object.fromEntries(values.map((value, index) => [index + 1, value]));
	const run = (sql: string, values: Value[] = []) => native.prepare(sql).run(bindings(values));
	const db: SchemaDatabase = {
		run: async (sql, values) => run(sql, values),
		all: async (sql, values = []) =>
			native.prepare(sql).all(bindings(values)) as Record<string, Value>[],
		batch: async (statements) =>
			native.transaction(() => {
				for (const statement of statements) run(statement.sql, statement.values);
			})(),
	};
	return { db, native, authority: "0".repeat(64), now: 1_800_000_000_000 };
}
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
registerMetadataScenarios(async () => fixture());

describe("independent inert traversal metadata definitions", () => {
	it("exports frozen definitions and installs only three metadata tables on request", () => {
		const native = new Database(":memory:");
		databases.push(native);
		const before = native.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

		for (const sql of TRAVERSAL_COORDINATOR_METADATA_SCHEMA_STATEMENTS) native.exec(sql);
		const tables = native
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all();

		expect(Object.isFrozen(TRAVERSAL_COORDINATOR_METADATA_SCHEMA_STATEMENTS)).toBe(true);
		expect(before).toEqual([]);
		expect(tables).toEqual(
			["traversal_authority_policy", "traversal_readiness", "traversal_realms"].map((name) => ({
				name,
			})),
		);
	});
	it("cannot read metadata without explicit installation", () => {
		const native = new Database(":memory:");
		databases.push(native);

		const read = () => native.prepare("SELECT * FROM traversal_authority_policy").all();

		expect(read).toThrow(/no such table/);
	});
});
