import Database from "better-sqlite3";
import { expect, it } from "vitest";
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
