import assert from "node:assert/strict";
import test from "node:test";
import {
	compareWithBaseline,
	limitKind,
	orderSchema,
	readCapture,
	toCompileOnly,
} from "./classify.mjs";

test("toCompileOnly prefixes EXPLAIN and replaces anonymous and numbered placeholders", () => {
	assert.equal(toCompileOnly("  SELECT ? , ?2"), "EXPLAIN SELECT 'x' , 'x'");
});

test("toCompileOnly keeps a statement that already explains itself", () => {
	assert.equal(toCompileOnly("EXPLAIN QUERY PLAN SELECT 1"), "EXPLAIN QUERY PLAN SELECT 1");
});

test("limitKind names the WITH table limit and the expression depth limit", () => {
	assert.equal(limitKind("D1_ERROR: VIEWs and/or subqueries nested too deep"), "with_table_limit");
	assert.equal(limitKind("Expression tree is too large (maximum depth 100)"), "expression_depth");
});

test("limitKind ignores success and unrelated errors", () => {
	assert.equal(limitKind(null), null);
	assert.equal(limitKind("no such table: fixture_only"), null);
});

test("readCapture dedupes statements and keeps the longest definition of a schema object", () => {
	const lines = [
		JSON.stringify({ kind: "statement", hash: "a", value: "SELECT 1" }),
		JSON.stringify({ kind: "statement", hash: "a", value: "SELECT 1" }),
		JSON.stringify({ kind: "schema", hash: "b", value: { type: "table", name: "t", sql: "CREATE TABLE t (a)" } }),
		JSON.stringify({ kind: "schema", hash: "c", value: { type: "table", name: "t", sql: "CREATE TABLE t (a, b)" } }),
		"",
	];
	const capture = readCapture(lines);
	assert.deepEqual(capture.statements, ["SELECT 1"]);
	assert.deepEqual(capture.schema.map((object) => object.sql), ["CREATE TABLE t (a, b)"]);
});

test("orderSchema puts tables before their triggers and drops internal objects", () => {
	const ordered = orderSchema([
		{ type: "trigger", name: "t_guard", sql: "" },
		{ type: "table", name: "sqlite_sequence", sql: "" },
		{ type: "table", name: "t", sql: "" },
	]);
	assert.deepEqual(ordered.map((object) => object.name), ["t", "t_guard"]);
});

test("compareWithBaseline passes only when the count matches the baseline", () => {
	assert.equal(compareWithBaseline(3, { overLimit: 3 }).ok, true);
	assert.equal(compareWithBaseline(4, { overLimit: 3 }).ok, false);
	assert.match(compareWithBaseline(2, { overLimit: 3 }).message, /Lower overLimit in baseline.json to 2/);
});
