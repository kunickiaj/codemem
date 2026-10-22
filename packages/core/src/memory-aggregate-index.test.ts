import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureAdditiveSchemaCompatibility, SCHEMA_VERSION } from "./db.js";
import { ensureMemoryAggregateIndex } from "./schema-bootstrap.js";
import { initTestSchema } from "./test-utils.js";

let db: Database.Database;
beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});
afterEach(() => {
	vi.restoreAllMocks();
	db.close();
});

function schemaState() {
	return {
		version: db.pragma("user_version", { simple: true }),
		schema: db.pragma("schema_version", { simple: true }),
		changes: db.prepare("SELECT total_changes() AS n").get(),
		marker: db.prepare("SELECT * FROM schema_compat_state").all(),
	};
}

it("installs the aggregate index on a current-marker database without a version bump", () => {
	// Arrange: emulate a database that completed compatibility before this index existed.
	ensureAdditiveSchemaCompatibility(db);
	db.exec("DROP INDEX idx_memory_items_scope_aggregates");
	const before = schemaState();
	// Act
	ensureAdditiveSchemaCompatibility(db);
	const installed = schemaState();
	const index = db
		.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_memory_items_scope_aggregates'")
		.get() as { sql: string };
	ensureMemoryAggregateIndex(db);
	ensureMemoryAggregateIndex(db);
	// Assert: installation changes schema once; subsequent ensures change neither schema nor rows.
	expect(index.sql).toContain("ON memory_items(scope_id, active, session_id");
	expect(installed).toMatchObject({ version: SCHEMA_VERSION, marker: before.marker });
	expect(installed.schema).not.toBe(before.schema);
	expect(schemaState()).toEqual(installed);
});

it("does not issue DDL when the index already exists", () => {
	// Arrange
	const exec = vi.spyOn(db, "exec");
	// Act
	ensureMemoryAggregateIndex(db);
	ensureMemoryAggregateIndex(db);
	// Assert
	expect(exec).not.toHaveBeenCalled();
});

it.each(["missing table", "partial columns", "read-only"])(
	"skips optional index DDL for %s",
	(state) => {
		// Arrange
		const partial = new Database(":memory:");
		try {
			if (state === "partial columns")
				partial.exec("CREATE TABLE memory_items(id INTEGER, scope_id TEXT)");
			const target =
				state === "read-only"
					? new Proxy(db, {
							get(original, key) {
								if (key === "readonly") return true;
								const value = Reflect.get(original, key, original);
								return typeof value === "function" ? value.bind(original) : value;
							},
						})
					: partial;
			const exec = vi.spyOn(target, "exec");
			// Act
			ensureMemoryAggregateIndex(target);
			// Assert
			expect(exec).not.toHaveBeenCalled();
		} finally {
			partial.close();
		}
	},
);

it("retains reads after optional DDL failure and retries on the next ensure", () => {
	// Arrange: inject a lock without introducing timing or concurrent writers.
	db.exec("DROP INDEX idx_memory_items_scope_aggregates");
	const exec = vi.spyOn(db, "exec").mockImplementationOnce(() => {
		throw new Error("database is locked");
	});
	// Act
	expect(() => ensureMemoryAggregateIndex(db)).not.toThrow();
	const absent = db
		.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_memory_items_scope_aggregates'")
		.get();
	exec.mockRestore();
	ensureMemoryAggregateIndex(db);
	// Assert
	expect(absent).toBeUndefined();
	expect(db.prepare("SELECT COUNT(*) AS n FROM memory_items").get()).toEqual({ n: 0 });
	expect(
		db
			.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_memory_items_scope_aggregates'")
			.get(),
	).toBeDefined();
	expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
});
