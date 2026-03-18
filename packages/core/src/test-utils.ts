/**
 * Test utilities for the codemem TS backend.
 *
 * Schema DDL is derived from the canonical Python DDL in codemem/db.py
 * but maintained here as a single string constant. When we complete the
 * Drizzle query migration, Drizzle's `migrate()` or `push` will replace
 * this — but the important thing is there's ONE place to update, not
 * separate DDL in test-utils AND the Python file.
 *
 * The Drizzle schema in schema.ts defines types and query builders.
 * This file defines the DDL that creates the tables those types target.
 */

import type { Database } from "./db.js";
import { SCHEMA_VERSION } from "./db.js";

/**
 * Canonical DDL for all codemem tables.
 *
 * This MUST match the production schema created by Python's db.py.
 * When Drizzle owns DDL (post-migration), this will be replaced by
 * Drizzle's migration/push mechanism.
 */
const DDL = `
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

	CREATE TABLE IF NOT EXISTS artifacts (
		id INTEGER PRIMARY KEY,
		session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		path TEXT,
		content_text TEXT,
		content_hash TEXT,
		created_at TEXT NOT NULL,
		metadata_json TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_artifacts_session_kind ON artifacts(session_id, kind);

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
	CREATE INDEX IF NOT EXISTS idx_memory_items_active_created ON memory_items(active, created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_memory_items_session ON memory_items(session_id);

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
	CREATE INDEX IF NOT EXISTS idx_usage_events_event_created ON usage_events(event, created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id);

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
	CREATE INDEX IF NOT EXISTS idx_raw_events_session_seq ON raw_events(opencode_session_id, event_seq);
	CREATE INDEX IF NOT EXISTS idx_raw_events_created_at ON raw_events(created_at DESC);

	CREATE TABLE IF NOT EXISTS raw_event_sessions (
		source TEXT NOT NULL DEFAULT 'opencode',
		stream_id TEXT NOT NULL DEFAULT '',
		opencode_session_id TEXT NOT NULL,
		cwd TEXT,
		project TEXT,
		started_at TEXT,
		last_seen_ts_wall_ms INTEGER,
		last_received_event_seq INTEGER NOT NULL DEFAULT -1,
		last_flushed_event_seq INTEGER NOT NULL DEFAULT -1,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (source, stream_id)
	);

	CREATE TABLE IF NOT EXISTS opencode_sessions (
		source TEXT NOT NULL DEFAULT 'opencode',
		stream_id TEXT NOT NULL DEFAULT '',
		opencode_session_id TEXT NOT NULL,
		session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
		created_at TEXT NOT NULL,
		PRIMARY KEY (source, stream_id)
	);
	CREATE INDEX IF NOT EXISTS idx_opencode_sessions_session_id ON opencode_sessions(session_id);

	CREATE TABLE IF NOT EXISTS raw_event_flush_batches (
		id INTEGER PRIMARY KEY,
		source TEXT NOT NULL DEFAULT 'opencode',
		stream_id TEXT NOT NULL DEFAULT '',
		opencode_session_id TEXT NOT NULL,
		start_event_seq INTEGER NOT NULL,
		end_event_seq INTEGER NOT NULL,
		extractor_version TEXT NOT NULL,
		status TEXT NOT NULL,
		error_message TEXT,
		error_type TEXT,
		observer_provider TEXT,
		observer_model TEXT,
		observer_runtime TEXT,
		attempt_count INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		UNIQUE(source, stream_id, start_event_seq, end_event_seq, extractor_version)
	);
	CREATE INDEX IF NOT EXISTS idx_raw_event_flush_batches_session ON raw_event_flush_batches(opencode_session_id, created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_raw_event_flush_batches_status ON raw_event_flush_batches(status, updated_at DESC);

	CREATE TABLE IF NOT EXISTS user_prompts (
		id INTEGER PRIMARY KEY,
		session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
		project TEXT,
		prompt_text TEXT NOT NULL,
		prompt_number INTEGER,
		created_at TEXT NOT NULL,
		created_at_epoch INTEGER NOT NULL,
		metadata_json TEXT,
		import_key TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_id);
	CREATE INDEX IF NOT EXISTS idx_user_prompts_project ON user_prompts(project);
	CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC);

	CREATE TABLE IF NOT EXISTS session_summaries (
		id INTEGER PRIMARY KEY,
		session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
		project TEXT,
		request TEXT,
		investigated TEXT,
		learned TEXT,
		completed TEXT,
		next_steps TEXT,
		notes TEXT,
		files_read TEXT,
		files_edited TEXT,
		prompt_number INTEGER,
		created_at TEXT NOT NULL,
		created_at_epoch INTEGER NOT NULL,
		metadata_json TEXT,
		import_key TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id);
	CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
	CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);

	CREATE TABLE IF NOT EXISTS replication_ops (
		op_id TEXT PRIMARY KEY,
		entity_type TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		op_type TEXT NOT NULL,
		payload_json TEXT,
		clock_rev INTEGER NOT NULL,
		clock_updated_at TEXT NOT NULL,
		clock_device_id TEXT NOT NULL,
		device_id TEXT NOT NULL,
		created_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_replication_ops_created ON replication_ops(created_at, op_id);
	CREATE INDEX IF NOT EXISTS idx_replication_ops_entity ON replication_ops(entity_type, entity_id);

	CREATE TABLE IF NOT EXISTS replication_cursors (
		peer_device_id TEXT PRIMARY KEY,
		last_applied_cursor TEXT,
		last_acked_cursor TEXT,
		updated_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS sync_peers (
		peer_device_id TEXT PRIMARY KEY,
		name TEXT,
		pinned_fingerprint TEXT,
		public_key TEXT,
		addresses_json TEXT,
		claimed_local_actor INTEGER NOT NULL DEFAULT 0,
		actor_id TEXT,
		projects_include_json TEXT,
		projects_exclude_json TEXT,
		created_at TEXT NOT NULL,
		last_seen_at TEXT,
		last_sync_at TEXT,
		last_error TEXT
	);

	CREATE TABLE IF NOT EXISTS sync_nonces (
		nonce TEXT PRIMARY KEY,
		device_id TEXT NOT NULL,
		created_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS sync_device (
		device_id TEXT PRIMARY KEY,
		public_key TEXT NOT NULL,
		fingerprint TEXT NOT NULL,
		created_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS sync_attempts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		peer_device_id TEXT NOT NULL,
		started_at TEXT NOT NULL,
		finished_at TEXT,
		ok INTEGER NOT NULL,
		ops_in INTEGER NOT NULL,
		ops_out INTEGER NOT NULL,
		error TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_sync_attempts_peer_started ON sync_attempts(peer_device_id, started_at);

	CREATE TABLE IF NOT EXISTS sync_daemon_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		last_error TEXT,
		last_traceback TEXT,
		last_error_at TEXT,
		last_ok_at TEXT
	);

	CREATE TABLE IF NOT EXISTS raw_event_ingest_samples (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		inserted_events INTEGER NOT NULL DEFAULT 0,
		skipped_invalid INTEGER NOT NULL DEFAULT 0,
		skipped_duplicate INTEGER NOT NULL DEFAULT 0,
		skipped_conflict INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS raw_event_ingest_stats (
		id INTEGER PRIMARY KEY,
		inserted_events INTEGER NOT NULL DEFAULT 0,
		skipped_events INTEGER NOT NULL DEFAULT 0,
		skipped_invalid INTEGER NOT NULL DEFAULT 0,
		skipped_duplicate INTEGER NOT NULL DEFAULT 0,
		skipped_conflict INTEGER NOT NULL DEFAULT 0,
		updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);

	CREATE TABLE IF NOT EXISTS actors (
		actor_id TEXT PRIMARY KEY,
		display_name TEXT NOT NULL,
		is_local INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'active',
		merged_into_actor_id TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_actors_is_local ON actors(is_local);
	CREATE INDEX IF NOT EXISTS idx_actors_status ON actors(status);
	CREATE INDEX IF NOT EXISTS idx_sync_peers_actor_id ON sync_peers(actor_id);
`;

/**
 * Create the full schema for test databases.
 *
 * This DDL matches the production schema from Python's codemem/db.py
 * exactly — same column names, types, constraints, indexes, and triggers.
 * Sets user_version to SCHEMA_VERSION so assertSchemaReady() passes.
 */
export function initTestSchema(db: Database): void {
	db.exec(DDL);
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
