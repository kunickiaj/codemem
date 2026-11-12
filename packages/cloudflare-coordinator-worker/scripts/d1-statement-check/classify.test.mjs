import assert from "node:assert/strict";
import test from "node:test";
import {
	aggregateAttempts,
	EXCLUSIONS,
	exclusionFor,
	limitKind,
	orderSchema,
	readCapture,
	schemaExclusionFor,
	staticLimits,
	toCompileOnly,
	verdict,
} from "./classify.mjs";

// ---- compile-only statements ----

test("toCompileOnly prefixes EXPLAIN and binds one null per parameter, leaving the SQL as written", () => {
	assert.deepEqual(toCompileOnly("  SELECT ? , ?"), {
		sql: "EXPLAIN   SELECT ? , ?",
		values: [null, null],
	});
});

test("toCompileOnly keeps a statement that already explains itself", () => {
	assert.deepEqual(toCompileOnly("EXPLAIN QUERY PLAN SELECT ?"), {
		sql: "EXPLAIN QUERY PLAN SELECT ?",
		values: [null],
	});
});

test("toCompileOnly ignores ? inside strings, quoted identifiers and comments", () => {
	const sql = `SELECT '?', 'it''s ?', "col?", \`b?\`, [c?], x'3f' -- trailing ?
	/* block ? */ FROM t WHERE a = ?`;
	const compiled = toCompileOnly(sql);
	assert.equal(compiled.sql, `EXPLAIN ${sql}`);
	assert.deepEqual(compiled.values, [null]);
});

test("toCompileOnly numbers parameters as SQLite does: ?NNN sets the index, ? takes the next", () => {
	assert.equal(toCompileOnly("SELECT ?3, ?").values.length, 4);
	assert.equal(toCompileOnly("SELECT ?, ?1, ?").values.length, 2);
	assert.equal(toCompileOnly("SELECT ?2, ?2").values.length, 2);
});

test("toCompileOnly refuses what it cannot bind safely", () => {
	for (const sql of [
		"SELECT :name",
		"SELECT @name",
		"SELECT $name",
		"SELECT ?0",
		"SELECT 'unterminated",
		'SELECT "unterminated',
		"SELECT 1 /* unterminated",
		"SELECT [unterminated",
		"SELECT 1; SELECT 2",
	])
		assert.throws(() => toCompileOnly(sql), /cannot compile/, sql);
});

test("toCompileOnly reads a trigger body's statements as one CREATE TRIGGER", () => {
	const trigger = `CREATE TEMP TRIGGER t_guard BEFORE INSERT ON t WHEN NEW.a = ?
	BEGIN SELECT CASE WHEN NEW.b THEN RAISE(ABORT, 'x;') END; UPDATE t SET a = 1; END;`;
	assert.deepEqual(toCompileOnly(trigger).values, [null]);
	assert.throws(() => toCompileOnly(`${trigger} SELECT 1`), /more than one statement/);
});

test("toCompileOnly allows a trailing semicolon, comment or whitespace", () => {
	assert.deepEqual(toCompileOnly("SELECT ?; -- done\n").values, [null]);
});

// ---- limits ----

test("limitKind names every D1 compile limit", () => {
	for (const [message, kind] of [
		["D1_ERROR: VIEWs and/or subqueries nested too deep", "with_table_limit"],
		["Expression tree is too large (maximum depth 100)", "expression_depth"],
		["D1_ERROR: too many columns in result set: SQLITE_ERROR", "result_columns"],
		["too many columns on t", "table_columns"],
		["too many terms in compound SELECT", "compound_select"],
		["too many arguments on function json_object", "function_arguments"],
		["too many SQL variables", "bound_parameters"],
		["string or blob too big", "value_size"],
		["statement too long", "statement_length"],
		["LIKE or GLOB pattern too complex", "like_pattern"],
	])
		assert.equal(limitKind(message), kind, message);
});

test("limitKind ignores success and unrelated errors", () => {
	assert.equal(limitKind(null), null);
	assert.equal(limitKind("no such table: fixture_only"), null);
});

test("staticLimits flags more than 100 parameters and more than 100,000 bytes", () => {
	assert.deepEqual(staticLimits("SELECT ?", 1), []);
	assert.deepEqual(staticLimits("SELECT ?", 101), ["bound_parameters"]);
	assert.deepEqual(staticLimits(`SELECT '${"é".repeat(50_000)}'`, 0), ["statement_length"]);
});

// ---- per-statement verdicts ----

const attempt = (sql, schema, outcome, origin = []) => ({ sql, schema, outcome, origin });
const none = { exclusions: [] };

test("a limit on one schema fails even when another schema compiles", () => {
	const result = aggregateAttempts(
		[
			attempt("S", "a", { kind: "limit", limit: "compound_select" }),
			attempt("S", "b", { kind: "compiled" }),
		],
		none,
	);
	assert.deepEqual(result.overLimit, [{ sql: "S", limits: ["compound_select"], origin: [] }]);
	assert.equal(verdict(result).ok, false);
});

test("a statement that compiles on no schema is unchecked and fails", () => {
	const result = aggregateAttempts(
		[
			attempt("S", "a", { kind: "error", message: "no such table: t" }),
			attempt("S", "b", { kind: "error", message: "no such column: c" }),
		],
		none,
	);
	assert.deepEqual(result.unchecked, [
		{ sql: "S", errors: ["no such table: t", "no such column: c"], origin: [] },
	]);
	assert.equal(verdict(result).ok, false);
});

test("a statement whose schema was not captured is unchecked and fails", () => {
	const result = aggregateAttempts([attempt("S", "lost", { kind: "schema_missing" })], none);
	assert.equal(result.unchecked.length, 1);
	assert.equal(verdict(result).ok, false);
});

test("a statement the compiler refused to bind is unchecked and fails", () => {
	const result = aggregateAttempts(
		[attempt("S", "a", { kind: "refused", message: "named parameter" })],
		none,
	);
	assert.equal(result.unchecked.length, 1);
	assert.equal(verdict(result).ok, false);
});

test("a statement that compiles is checked, and its errors on other schemas are counted", () => {
	const result = aggregateAttempts(
		[
			attempt("S", "a", { kind: "compiled" }),
			attempt("S", "b", { kind: "error", message: "no such table: t" }),
			attempt("T", "a", { kind: "compiled" }),
		],
		none,
	);
	assert.deepEqual(
		{ total: result.total, checked: result.checked, erroredElsewhere: result.erroredElsewhere },
		{ total: 2, checked: 2, erroredElsewhere: 1 },
	);
	assert.equal(verdict(result).ok, true);
});

test("schema objects that could not be created fail the check", () => {
	const result = aggregateAttempts([attempt("S", "a", { kind: "compiled" })], none);
	assert.equal(verdict({ ...result, schemaFailures: [{ name: "t", error: "x" }] }).ok, false);
});

const oracleExclusion = EXCLUSIONS.find((entry) => entry.function === "rawAuthSnapshot");
const oracleSql =
	'SELECT s.rowid AS original_rowid,typeof(s."coordinator_id") AS "coordinator_id:type",hex(CAST(s."coordinator_id" AS BLOB)) AS "coordinator_id:bytes" FROM main."t" s ORDER BY s.rowid';
const oracleOrigin = [
	{ file: "coordinator-auth-lifecycle-upgrade-test-fixture.ts", function: "" },
	{ file: "", function: "map" },
	{ file: "coordinator-auth-lifecycle-upgrade-test-fixture.ts", function: "rawAuthSnapshot" },
];

test("the excluded test oracle is recorded separately and does not fail the check", () => {
	const result = aggregateAttempts(
		[
			attempt(oracleSql, "a", { kind: "limit", limit: "result_columns" }, oracleOrigin),
			attempt("S", "a", { kind: "compiled" }),
		],
		{ exclusions: [oracleExclusion] },
	);
	assert.equal(result.excluded.length, 1);
	assert.match(result.excluded[0].reason, /rawAuthSnapshot/);
	assert.deepEqual([result.total, result.checked, result.overLimit.length], [2, 1, 0]);
	assert.equal(verdict(result).ok, true);
});

test("an exclusion needs both its exact function and its exact SQL", () => {
	const nearFunction = [{ file: "coordinator-auth-lifecycle-upgrade-test-fixture.ts", function: "otherHelper" }];
	const otherFile = [{ file: "coordinator-auth-lifecycle-upgrade-copy.ts", function: "rawAuthSnapshot" }];
	assert.equal(exclusionFor(oracleSql, nearFunction), null);
	assert.equal(exclusionFor(oracleSql, otherFile), null);
	assert.equal(exclusionFor("SELECT * FROM coordinator_auth_account_links", oracleOrigin), null);
	assert.equal(exclusionFor(oracleSql, oracleOrigin), oracleExclusion);
	const result = aggregateAttempts(
		[attempt(oracleSql, "a", { kind: "limit", limit: "result_columns" }, otherFile)],
		{ exclusions: [oracleExclusion] },
	);
	assert.equal(verdict(result).ok, false);
});

test("an excluded statement that compiles still counts as checked", () => {
	const result = aggregateAttempts([attempt(oracleSql, "a", { kind: "compiled" }, oracleOrigin)], {
		exclusions: [oracleExclusion],
	});
	assert.deepEqual([result.checked, result.excluded.length], [1, 0]);
	assert.equal(verdict(result).ok, true);
});

test("an exclusion that matched no statement fails the check as stale", () => {
	const result = aggregateAttempts([attempt("S", "a", { kind: "compiled" })], {
		exclusions: [oracleExclusion],
	});
	assert.equal(result.unusedExclusions.length, 1);
	assert.equal(verdict(result).ok, false);
});

// ---- capture records ----

test("readCapture keeps each statement with the schema it was prepared on, and its origin", () => {
	const first = [{ type: "table", name: "t", sql: "CREATE TABLE t (a)" }];
	const second = [{ type: "table", name: "t", sql: "CREATE TABLE t (a, b)" }];
	const origin = [{ file: "x.ts", function: "f" }];
	const lines = [
		JSON.stringify({ kind: "schema", hash: "s1", value: { hash: "h1", objects: first } }),
		JSON.stringify({ kind: "schema", hash: "s2", value: { hash: "h2", objects: second } }),
		JSON.stringify({ kind: "statement", hash: "a", value: { sql: "SELECT a FROM t", schema: "h1", origin } }),
		JSON.stringify({ kind: "statement", hash: "a", value: { sql: "SELECT a FROM t", schema: "h1", origin } }),
		JSON.stringify({ kind: "statement", hash: "b", value: { sql: "SELECT b FROM t", schema: "h2", origin } }),
		"",
	];
	const capture = readCapture(lines);
	assert.deepEqual(capture.statements, [
		{ sql: "SELECT a FROM t", schema: "h1", origin },
		{ sql: "SELECT b FROM t", schema: "h2", origin },
	]);
	assert.deepEqual(capture.schemas.get("h1"), first);
	assert.deepEqual(capture.schemas.get("h2"), second);
});

test("orderSchema puts tables before their triggers and drops internal objects", () => {
	const ordered = orderSchema([
		{ type: "trigger", name: "t_guard", sql: "" },
		{ type: "table", name: "sqlite_sequence", sql: "" },
		{ type: "table", name: "t", sql: "" },
	]);
	assert.deepEqual(ordered.map((object) => object.name), ["t", "t_guard"]);
});

test("orderSchema leaves out an FTS5 table's shadow tables, which creating it creates", () => {
	const ordered = orderSchema([
		{ type: "table", name: "memory_fts", sql: "CREATE VIRTUAL TABLE memory_fts USING fts5(a)" },
		{ type: "table", name: "memory_fts_data", sql: "CREATE TABLE 'memory_fts_data'(id)" },
		{ type: "table", name: "memory_fts_config", sql: "CREATE TABLE 'memory_fts_config'(k)" },
		{ type: "table", name: "plain_data", sql: "CREATE TABLE plain_data (a)" },
	]);
	assert.deepEqual(ordered.map((object) => object.name), ["memory_fts", "plain_data"]);
});

test("only the named sqlite-vec table of the local store is a schema exclusion", () => {
	assert.ok(
		schemaExclusionFor({ name: "memory_vectors", sql: "CREATE VIRTUAL TABLE memory_vectors USING vec0(x)" }),
	);
	assert.equal(schemaExclusionFor({ name: "memory_vectors", sql: "CREATE TABLE memory_vectors (x)" }), null);
	assert.equal(schemaExclusionFor({ name: "other", sql: "CREATE VIRTUAL TABLE other USING vec0(x)" }), null);
});
