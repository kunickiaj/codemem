/**
 * Test utilities for the codemem TS backend.
 *
 * During Phase 1, Python owns DDL. For tests, we create a minimal schema
 * that matches the Python-created tables so the TS store can operate
 * against an in-memory or temp-file database.
 */

import type { Database } from "./db.js";
import { SCHEMA_VERSION } from "./db.js";

/**
 * Create the minimal schema needed for MemoryStore tests.
 *
 * This mirrors the Python DDL from codemem/db.py but only includes
 * the tables needed for the CRUD methods under test. Sets user_version
 * to SCHEMA_VERSION so assertSchemaReady() passes.
 */
export function initTestSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id INTEGER PRIMARY KEY,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			cwd TEXT,
			project TEXT,
			git_remote TEXT,
			git_branch TEXT,
			user TEXT,
			tool_version TEXT,
			metadata_json TEXT,
			import_key TEXT
		);

		CREATE TABLE IF NOT EXISTS memory_items (
			id INTEGER PRIMARY KEY,
			session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			title TEXT NOT NULL,
			subtitle TEXT,
			body_text TEXT NOT NULL,
			confidence REAL DEFAULT 0.5,
			tags_text TEXT DEFAULT '',
			active INTEGER DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			metadata_json TEXT,
			actor_id TEXT,
			actor_display_name TEXT,
			visibility TEXT,
			workspace_id TEXT,
			workspace_kind TEXT,
			origin_device_id TEXT,
			origin_source TEXT,
			trust_state TEXT,
			facts TEXT,
			narrative TEXT,
			concepts TEXT,
			files_read TEXT,
			files_modified TEXT,
			user_prompt_id INTEGER,
			prompt_number INTEGER,
			deleted_at TEXT,
			rev INTEGER DEFAULT 0,
			import_key TEXT
		);

		CREATE TABLE IF NOT EXISTS artifacts (
			id INTEGER PRIMARY KEY,
			session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			path TEXT,
			content_text TEXT,
			content_hash TEXT,
			content_encoding TEXT,
			content_blob BLOB,
			created_at TEXT NOT NULL,
			metadata_json TEXT
		);

		CREATE TABLE IF NOT EXISTS usage_events (
			id INTEGER PRIMARY KEY,
			session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
			event TEXT NOT NULL,
			tokens_read INTEGER DEFAULT 0,
			tokens_written INTEGER DEFAULT 0,
			tokens_saved INTEGER DEFAULT 0,
			created_at TEXT NOT NULL,
			metadata_json TEXT
		);

		CREATE TABLE IF NOT EXISTS raw_events (
			id INTEGER PRIMARY KEY,
			source TEXT NOT NULL DEFAULT 'opencode',
			stream_id TEXT NOT NULL DEFAULT '',
			opencode_session_id TEXT NOT NULL,
			event_id TEXT,
			event_seq INTEGER NOT NULL,
			event_type TEXT NOT NULL,
			ts_wall_ms INTEGER,
			ts_mono_ms REAL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE(source, stream_id, event_seq),
			UNIQUE(source, stream_id, event_id)
		);

		CREATE TABLE IF NOT EXISTS sync_device (
			device_id TEXT PRIMARY KEY,
			public_key TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS sync_nonces (
			nonce TEXT PRIMARY KEY,
			device_id TEXT NOT NULL,
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS replication_cursors (
			peer_device_id TEXT PRIMARY KEY,
			last_applied_cursor TEXT,
			last_acked_cursor TEXT,
			updated_at TEXT NOT NULL
		);

		-- FTS5 full-text index on memory_items
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
			title, body_text, tags_text,
			content='memory_items', content_rowid='id'
		);

		CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
			INSERT INTO memory_fts(rowid, title, body_text, tags_text)
			VALUES (new.id, new.title, new.body_text, new.tags_text);
		END;

		CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
			INSERT INTO memory_fts(memory_fts, rowid, title, body_text, tags_text)
			VALUES('delete', old.id, old.title, old.body_text, old.tags_text);
			INSERT INTO memory_fts(rowid, title, body_text, tags_text)
			VALUES (new.id, new.title, new.body_text, new.tags_text);
		END;

		CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
			INSERT INTO memory_fts(memory_fts, rowid, title, body_text, tags_text)
			VALUES('delete', old.id, old.title, old.body_text, old.tags_text);
		END;

		PRAGMA user_version = ${SCHEMA_VERSION};
	`);
}

/**
 * Insert a minimal session row and return its ID.
 * Useful for tests that need a valid session_id for memory_items FK.
 */
export function insertTestSession(db: Database): number {
	const now = new Date().toISOString();
	const info = db
		.prepare(
			`INSERT INTO sessions (started_at, cwd, user, tool_version)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(now, "/tmp/test", "testuser", "test-1.0");
	return Number(info.lastInsertRowid);
}
