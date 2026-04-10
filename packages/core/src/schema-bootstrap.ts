import type { Database } from "./db.js";
import { getSchemaVersion, SCHEMA_VERSION } from "./db.js";
import { TEST_SCHEMA_BASE_DDL } from "./test-schema.generated.js";

const SCHEMA_AUX_DDL = `
CREATE INDEX IF NOT EXISTS idx_sync_peers_actor_id ON sync_peers(actor_id);

CREATE TABLE IF NOT EXISTS sync_retention_state (
	id INTEGER PRIMARY KEY,
	last_run_at TEXT,
	last_duration_ms INTEGER,
	last_deleted_ops INTEGER NOT NULL DEFAULT 0,
	last_estimated_bytes_before INTEGER,
	last_estimated_bytes_after INTEGER,
	retained_floor_cursor TEXT,
	last_error TEXT,
	last_error_at TEXT
);

CREATE TABLE IF NOT EXISTS maintenance_jobs (
	kind TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	status TEXT NOT NULL,
	message TEXT,
	progress_current INTEGER NOT NULL DEFAULT 0,
	progress_total INTEGER,
	progress_unit TEXT NOT NULL DEFAULT 'items',
	metadata_json TEXT,
	started_at TEXT,
	updated_at TEXT NOT NULL,
	finished_at TEXT,
	error TEXT
);

CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_status_updated
	ON maintenance_jobs(status, updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
	title, body_text, tags_text,
	content='memory_items',
	content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
	INSERT INTO memory_fts(rowid, title, body_text, tags_text)
	VALUES (new.id, new.title, new.body_text, new.tags_text);
END;

DROP TRIGGER IF EXISTS memory_items_au;
CREATE TRIGGER memory_items_au AFTER UPDATE ON memory_items BEGIN
	INSERT INTO memory_fts(memory_fts, rowid, title, body_text, tags_text)
	VALUES('delete', old.id, old.title, old.body_text, old.tags_text);
	INSERT INTO memory_fts(rowid, title, body_text, tags_text)
	VALUES (new.id, new.title, new.body_text, new.tags_text);
END;

DROP TRIGGER IF EXISTS memory_items_ad;
CREATE TRIGGER memory_items_ad AFTER DELETE ON memory_items BEGIN
	INSERT INTO memory_fts(memory_fts, rowid, title, body_text, tags_text)
	VALUES('delete', old.id, old.title, old.body_text, old.tags_text);
END;
`;

export function bootstrapSchema(db: Database): void {
	db.exec(TEST_SCHEMA_BASE_DDL);
	db.exec(SCHEMA_AUX_DDL);
	db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/**
 * Run `bootstrapSchema` on a database only if it's still at the unbootstrapped
 * state (`user_version === 0`). Safe to call from any entry point that opens
 * a raw `connect()` handle and then issues queries expecting the schema to be
 * in place. Idempotent: already-initialized databases are left untouched.
 */
export function ensureSchemaBootstrapped(db: Database): void {
	if (getSchemaVersion(db) === 0) {
		bootstrapSchema(db);
	}
}
