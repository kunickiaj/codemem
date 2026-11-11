import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { type SqlValue, sqlEq, sqlIn, sqlNe } from "./coordinator-sql-compare.js";

const db = new Database(":memory:");
afterAll(() => db.close());

const VALUES: SqlValue[] = [null, "a", "b", "", "1", 1, 0, 2];
const PAIRS = VALUES.flatMap((a) => VALUES.map((b): [SqlValue, SqlValue] => [a, b]));
const show = (value: SqlValue) => JSON.stringify(value);

/** What SQLite itself answers; a WHERE clause keeps a row only for 1. */
function sqliteSays(expression: string, ...values: SqlValue[]): boolean {
	return (
		db
			.prepare(`SELECT ${expression} AS answer`)
			.pluck()
			.get(...values) === 1
	);
}

describe("SQL comparison helpers", () => {
	it.each([
		[null, null, false],
		[null, "a", false],
		["a", null, false],
		["a", "a", true],
		["a", "b", false],
		["1", 1, false],
		[1, 1, true],
	] as [SqlValue, SqlValue, boolean][])("sqlEq(%j, %j) is %s", (a, b, expected) => {
		expect(sqlEq(a, b)).toBe(expected);
	});

	it.each([
		[null, null, false],
		[null, "a", false],
		["a", null, false],
		["a", "a", false],
		["a", "b", true],
		["1", 1, true],
		[1, 2, true],
	] as [SqlValue, SqlValue, boolean][])("sqlNe(%j, %j) is %s", (a, b, expected) => {
		expect(sqlNe(a, b)).toBe(expected);
	});

	it.each([
		[null, ["a"], false],
		["a", ["a", "b"], true],
		["c", ["a", "b"], false],
		["a", [], false],
	] as [SqlValue, string[], boolean][])("sqlIn(%j, %j) is %s", (a, list, expected) => {
		expect(sqlIn(a, list)).toBe(expected);
	});

	it.each(PAIRS)("agrees with SQLite on %j compared with %j", (a, b) => {
		// Act
		const answers = { eq: sqlEq(a, b), ne: sqlNe(a, b) };
		// Assert
		expect(answers, `${show(a)} vs ${show(b)}`).toEqual({
			eq: sqliteSays("? = ?", a, b),
			ne: sqliteSays("? <> ?", a, b),
		});
	});

	it.each(VALUES)("agrees with SQLite on %j IN a text list", (a) => {
		// Arrange
		const list = ["a", "1", ""];
		// Act
		const answer = sqlIn(a, list);
		// Assert
		expect(answer).toBe(
			sqliteSays("? IN (SELECT value FROM json_each(?))", a, JSON.stringify(list)),
		);
	});
});
