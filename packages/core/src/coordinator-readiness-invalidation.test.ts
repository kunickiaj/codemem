import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
	hasReadinessGeneration,
	hasReadinessGenerationByAll,
	hasReadinessGenerationSync,
	READINESS_PREPARATIONS_SCHEMA,
	readinessInvalidation,
} from "./coordinator-readiness-invalidation.js";

const opened: Database.Database[] = [];
afterEach(() => {
	for (const db of opened.splice(0)) db.close();
});

/** A coordinator database from before migration 0056. */
function beforeMigration() {
	const db = new Database(":memory:");
	opened.push(db);
	db.exec("CREATE TABLE groups (group_id TEXT PRIMARY KEY, archived_at TEXT)");
	return db;
}

it("finds the column once the migration runs, after reporting it missing", async () => {
	const db = beforeMigration();
	const reader = {
		reads: 0,
		async first<T>(statement: { sql: string; values: unknown[] }) {
			this.reads += 1;
			return db.prepare(statement.sql).get(...statement.values) as T;
		},
	};
	expect(await hasReadinessGeneration(reader)).toBe(false);
	// A Worker deployed before its D1 migration keeps checking until the column exists.
	db.exec(READINESS_PREPARATIONS_SCHEMA);
	expect(await hasReadinessGeneration(reader)).toBe(true);
	expect(await hasReadinessGeneration(reader)).toBe(true);
	expect(reader.reads).toBe(2);
});

it("answers the same for synchronous and `all` backends", async () => {
	const db = beforeMigration();
	const backend = {
		all: async (statement: { sql: string; values: [] }) => ({
			results: db.prepare(statement.sql).all(),
		}),
	};
	expect(hasReadinessGenerationSync(db)).toBe(false);
	expect(await hasReadinessGenerationByAll(backend)).toBe(false);
	db.exec(READINESS_PREPARATIONS_SCHEMA);
	expect(hasReadinessGenerationSync(db)).toBe(true);
	expect(await hasReadinessGenerationByAll(backend)).toBe(true);
});

it("keeps the invalidation statements only where the column exists", () => {
	expect(readinessInvalidation(true, "a", "b")).toEqual(["a", "b"]);
	expect(readinessInvalidation(false, "a", "b")).toEqual([]);
});
