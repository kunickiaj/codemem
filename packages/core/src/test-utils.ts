/**
 * Test utilities for the codemem TS backend.
 */

import type { Database } from "./db.js";
import { SCHEMA_VERSION } from "./db.js";
import { TEST_SCHEMA_BASE_DDL } from "./test-schema.generated.js";

const TEST_SCHEMA_AUX_DDL = `
CREATE INDEX IF NOT EXISTS idx_sync_peers_actor_id ON sync_peers(actor_id);

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

/**
 * Create the full schema for test databases.
 */
export function initTestSchema(db: Database): void {
	db.exec(TEST_SCHEMA_BASE_DDL);
	db.exec(TEST_SCHEMA_AUX_DDL);
	db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/**
 * Insert a minimal test session and return its ID.
 */
export function insertTestSession(db: Database): number {
	const now = new Date().toISOString();
	const info = db
		.prepare(
			"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, ?, ?, ?, ?)",
		)
		.run(now, "/tmp/test", "test-project", "test-user", "test");
	return Number(info.lastInsertRowid);
}

// Re-export for test convenience
export { MemoryStore } from "./store.js";
