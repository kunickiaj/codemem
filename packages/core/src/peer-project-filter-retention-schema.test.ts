import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	ensureAdditiveSchemaCompatibility,
	getSchemaVersion,
	SCHEMA_VERSION,
	tableExists,
} from "./db.js";
import {
	PEER_PROJECT_FILTER_RETENTION_TRIGGER_NAMES,
	readRetainedPeerProjectFilters,
} from "./peer-project-filter-retention.js";
import { initTestSchema } from "./test-utils.js";

let db: InstanceType<typeof Database>;
beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});
afterEach(() => db.close());

function previousSchema() {
	for (const name of PEER_PROJECT_FILTER_RETENTION_TRIGGER_NAMES) {
		db.exec(`DROP TRIGGER ${name}`);
	}
	db.exec(`
		DROP TABLE peer_project_filter_retention;
		PRAGMA user_version = 24;
		CREATE TABLE IF NOT EXISTS schema_compat_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			applied_schema_version INTEGER NOT NULL,
			applied_at TEXT NOT NULL
		);
		INSERT OR REPLACE INTO schema_compat_state VALUES (1, 24, '2026-11-18T00:00:00Z');
	`);
}

it("takes schema version 26 after the reserved predecessors", () => {
	expect(SCHEMA_VERSION).toBe(26);
});

it("upgrades schema 24 and installs retention before deleting an existing pairing", () => {
	previousSchema();
	expect(getSchemaVersion(db)).toBe(24);
	expect(tableExists(db, "peer_project_filter_retention")).toBe(false);
	db.exec(`INSERT INTO sync_peers(peer_device_id, projects_exclude_json, created_at)
		VALUES ('peer-old', '["secret"]', '2026-11-18T00:00:00Z')`);

	ensureAdditiveSchemaCompatibility(db);
	db.exec("DELETE FROM sync_peers WHERE peer_device_id = 'peer-old'");

	expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
	expect(tableExists(db, "peer_project_filter_retention")).toBe(true);
	expect(readRetainedPeerProjectFilters(db, "peer-old")?.projects_exclude_json).toBe('["secret"]');
});

it("repairs a missing trigger even when compatibility was marked current", () => {
	ensureAdditiveSchemaCompatibility(db);
	db.exec(`DROP TRIGGER ${PEER_PROJECT_FILTER_RETENTION_TRIGGER_NAMES[0]}`);

	ensureAdditiveSchemaCompatibility(db);
	db.exec(`INSERT INTO sync_peers(peer_device_id, projects_exclude_json, created_at)
		VALUES ('peer-repair', '["secret"]', '2026-11-18T00:00:00Z');
		DELETE FROM sync_peers WHERE peer_device_id = 'peer-repair'`);

	expect(readRetainedPeerProjectFilters(db, "peer-repair")?.projects_exclude_json).toBe(
		'["secret"]',
	);
});
