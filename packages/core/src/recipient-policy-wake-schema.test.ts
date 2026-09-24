import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { columnExists, ensureAdditiveSchemaCompatibility, SCHEMA_VERSION } from "./db.js";
import { bootstrapSchema } from "./schema-bootstrap.js";

it("adds a wake epoch to an existing authority table from the previous schema", () => {
	const db = new Database(":memory:");
	try {
		bootstrapSchema(db);
		db.exec("ALTER TABLE recipient_policy_authority_states DROP COLUMN wake_epoch");
		db.exec(`CREATE TABLE schema_compat_state (
			id INTEGER PRIMARY KEY, applied_schema_version INTEGER NOT NULL, applied_at TEXT NOT NULL
		); INSERT INTO schema_compat_state VALUES (1, ${SCHEMA_VERSION - 1}, '2026-07-19T00:00:00Z')`);
		ensureAdditiveSchemaCompatibility(db);
		expect(columnExists(db, "recipient_policy_authority_states", "wake_epoch")).toBe(true);
		expect(
			db
				.prepare("SELECT applied_schema_version FROM schema_compat_state WHERE id = 1")
				.pluck()
				.get(),
		).toBe(SCHEMA_VERSION);
	} finally {
		db.close();
	}
});

it("does not mark schema 21 complete when the wake column cannot be added", () => {
	const db = new Database(":memory:");
	try {
		bootstrapSchema(db);
		db.exec("ALTER TABLE recipient_policy_authority_states DROP COLUMN wake_epoch");
		db.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
		db.exec(`CREATE TABLE schema_compat_state (
			id INTEGER PRIMARY KEY, applied_schema_version INTEGER NOT NULL, applied_at TEXT NOT NULL
		); INSERT INTO schema_compat_state VALUES (1, ${SCHEMA_VERSION - 1}, '2026-07-19T00:00:00Z')`);
		const exec = db.exec.bind(db);
		const blocked = vi.spyOn(db, "exec").mockImplementation((sql) => {
			if (sql.includes("ALTER TABLE recipient_policy_authority_states ADD COLUMN wake_epoch")) {
				throw new Error("simulated wake column upgrade failure");
			}
			return exec(sql);
		});
		try {
			expect(() => ensureAdditiveSchemaCompatibility(db)).toThrow(
				"simulated wake column upgrade failure",
			);
			expect(columnExists(db, "recipient_policy_authority_states", "wake_epoch")).toBe(false);
			expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION - 1);
			expect(
				db
					.prepare("SELECT applied_schema_version FROM schema_compat_state WHERE id = 1")
					.pluck()
					.get(),
			).not.toBe(SCHEMA_VERSION);
		} finally {
			blocked.mockRestore();
		}
		ensureAdditiveSchemaCompatibility(db);
		expect(columnExists(db, "recipient_policy_authority_states", "wake_epoch")).toBe(true);
		expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
	} finally {
		db.close();
	}
});

it("repairs a wake column omitted by a previously marked upgrade", () => {
	const db = new Database(":memory:");
	try {
		bootstrapSchema(db);
		db.exec("ALTER TABLE recipient_policy_authority_states DROP COLUMN wake_epoch");
		db.exec(`CREATE TABLE schema_compat_state (
			id INTEGER PRIMARY KEY, applied_schema_version INTEGER NOT NULL, applied_at TEXT NOT NULL
		); INSERT INTO schema_compat_state VALUES (1, ${SCHEMA_VERSION}, '2026-07-19T00:00:00Z')`);
		ensureAdditiveSchemaCompatibility(db);
		expect(columnExists(db, "recipient_policy_authority_states", "wake_epoch")).toBe(true);
	} finally {
		db.close();
	}
});
