import assert from "node:assert/strict";
import test from "node:test";
import { verdict } from "./classify.mjs";
import { checkStatements, compileAttempts } from "./compile.mjs";

/**
 * A stand-in for the local D1. It keeps a schema, creates and drops objects, and fails a
 * compile-only statement that reads a table the schema lacks or that `failure` names. A
 * batch runs in order on a copy and commits only when every statement succeeds.
 */
function fakeD1({ failure = () => null } = {}) {
	const schema = new Map();
	const calls = { batches: 0, failedBatches: 0, alone: 0 };
	const run = (sql, state) => {
		const drop = /^DROP \w+ IF EXISTS "(\w+)"$/u.exec(sql);
		if (drop) return state.delete(drop[1]);
		if (sql.startsWith("SELECT type, name, sql FROM sqlite_master")) return [...state.values()];
		const error = failure(sql);
		if (error) throw new Error(error);
		const create = /^CREATE (TABLE|INDEX) (\w+)/u.exec(sql);
		if (create)
			return state.set(create[2], { type: create[1].toLowerCase(), name: create[2], sql });
		const table = /FROM (\w+)/u.exec(sql)?.[1];
		if (table && !state.has(table)) throw new Error(`D1_ERROR: no such table: ${table}`);
		return [];
	};
	return {
		calls,
		schema,
		prepare: (sql) => ({
			bind: (...values) => ({
				sql,
				values,
				all: async () => {
					calls.alone += 1;
					return { results: run(sql, schema) };
				},
			}),
		}),
		batch: async (statements) => {
			calls.batches += 1;
			const copy = new Map(schema);
			try {
				for (const statement of statements) run(statement.sql, copy);
			} catch (error) {
				calls.failedBatches += 1;
				throw error;
			}
			schema.clear();
			for (const [name, entry] of copy) schema.set(name, entry);
			return statements.map(() => ({ results: [] }));
		},
	};
}

const table = (name) => ({ type: "table", name, sql: `CREATE TABLE ${name} (a)` });
const statement = (sql, schema) => ({ sql, schema, origin: [] });
const outcomes = (attempts) =>
	Object.fromEntries(attempts.map(({ sql, schema, outcome }) => [`${schema}: ${sql}`, outcome]));

test("each statement's outcome on each schema matches compiling it alone", async () => {
	const capture = {
		schemas: new Map([
			["wide", [table("t"), table("u")]],
			["narrow", [table("t")]],
		]),
		statements: [
			statement("SELECT a FROM t", "narrow"),
			statement("SELECT a FROM u", "narrow"),
			statement("SELECT a FROM t", "wide"),
			statement("SELECT a FROM u", "wide"),
			statement("SELECT wide_result FROM t", "wide"),
			statement("SELECT 1", "lost"),
		],
	};
	const d1 = fakeD1({
		failure: (sql) => (sql.includes("wide_result") ? "too many columns in result set" : null),
	});
	const result = await compileAttempts(d1, capture);
	assert.deepEqual(outcomes(result.attempts), {
		"narrow: SELECT a FROM t": { kind: "compiled" },
		"narrow: SELECT a FROM u": { kind: "error", message: "D1_ERROR: no such table: u" },
		"wide: SELECT a FROM t": { kind: "compiled" },
		"wide: SELECT a FROM u": { kind: "compiled" },
		"wide: SELECT wide_result FROM t": { kind: "limit", limit: "result_columns" },
		"lost: SELECT 1": { kind: "schema_missing" },
	});
	assert.equal(result.schemasRebuilt, 2);
	assert.ok(d1.calls.failedBatches > 0, "the failing statements went through a batch first");
});

test("an object of an earlier schema is gone when the next schema's statements compile", async () => {
	const capture = {
		// Neither contains the other, so whichever comes second replaces the first.
		schemas: new Map([
			["u_only", [table("u")]],
			["t_only", [table("t")]],
		]),
		statements: [
			statement("SELECT a FROM u", "u_only"),
			statement("SELECT a FROM t", "u_only"),
			statement("SELECT a FROM u", "t_only"),
			statement("SELECT a FROM t", "t_only"),
		],
	};
	const result = await compileAttempts(fakeD1(), capture);
	assert.deepEqual(outcomes(result.attempts), {
		"u_only: SELECT a FROM u": { kind: "compiled" },
		"u_only: SELECT a FROM t": { kind: "error", message: "D1_ERROR: no such table: t" },
		"t_only: SELECT a FROM u": { kind: "error", message: "D1_ERROR: no such table: u" },
		"t_only: SELECT a FROM t": { kind: "compiled" },
	});
});

test("an object that cannot be created is reported, and the rest of its schema is still built", async () => {
	const capture = {
		schemas: new Map([["s", [table("t"), table("broken"), table("u")]]]),
		statements: [statement("SELECT a FROM u", "s")],
	};
	const d1 = fakeD1({
		failure: (sql) => (sql.startsWith("CREATE TABLE broken") ? "D1_ERROR: not allowed" : null),
	});
	const result = await checkStatements(d1, capture);
	assert.deepEqual(result.schemaFailures, [{ name: "broken", error: "D1_ERROR: not allowed" }]);
	assert.deepEqual([...d1.schema.keys()].sort(), ["t", "u"]);
	assert.equal(result.checked, 1);
	assert.equal(verdict({ ...result, unusedExclusions: [] }).ok, false);
});

test("a statement that compiles on none of its schemas still fails the check", async () => {
	const capture = {
		schemas: new Map([
			["a", [table("t")]],
			["b", [table("t"), table("u")]],
		]),
		statements: [statement("SELECT a FROM missing", "a"), statement("SELECT a FROM missing", "b")],
	};
	const result = await checkStatements(fakeD1(), capture);
	assert.deepEqual(result.unchecked, [
		{ sql: "SELECT a FROM missing", errors: ["D1_ERROR: no such table: missing"], origin: [] },
	]);
	assert.equal(verdict({ ...result, unusedExclusions: [] }).ok, false);
});
