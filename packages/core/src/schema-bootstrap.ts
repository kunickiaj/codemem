import type { Database } from "./db.js";
import {
	getSchemaVersion,
	isEmbeddingDisabled,
	loadSqliteVec,
	REQUIRED_BOOTSTRAPPED_TABLES,
	SCHEMA_VERSION,
} from "./db.js";
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

CREATE TABLE IF NOT EXISTS sync_scope_rejections (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	peer_device_id TEXT,
	op_id TEXT NOT NULL,
	entity_type TEXT NOT NULL,
	entity_id TEXT NOT NULL,
	scope_id TEXT,
	reason TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_scope_rejections_peer_created
	ON sync_scope_rejections(peer_device_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sync_scope_rejections_scope_created
	ON sync_scope_rejections(scope_id, created_at);

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

CREATE TABLE IF NOT EXISTS memory_file_refs (
	memory_id INTEGER NOT NULL,
	file_path TEXT NOT NULL,
	relation TEXT NOT NULL CHECK(relation IN ('read', 'modified')),
	PRIMARY KEY (memory_id, file_path, relation),
	FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_file_refs_path
	ON memory_file_refs(file_path);

CREATE TABLE IF NOT EXISTS memory_concept_refs (
	memory_id INTEGER NOT NULL,
	concept TEXT NOT NULL,
	PRIMARY KEY (memory_id, concept),
	FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_concept_refs_concept
	ON memory_concept_refs(concept);

CREATE TABLE IF NOT EXISTS coordinator_group_preferences (
	coordinator_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	projects_include_json TEXT,
	projects_exclude_json TEXT,
	auto_seed_scope INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (coordinator_id, group_id)
);

CREATE TABLE IF NOT EXISTS scope_membership_cache_state (
	coordinator_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	last_refresh_at TEXT NOT NULL,
	last_success_at TEXT,
	last_error TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (coordinator_id, group_id)
);
`;

/**
 * DDL for the sqlite-vec `memory_vectors` virtual table. Drizzle cannot model
 * virtual tables driven by a loadable extension, so this lives alongside the
 * other aux DDL and is executed through `ensureVectorSchema` (which first
 * makes sure the `vec0` module is actually loaded on the connection).
 *
 * Columns mirror the Python `_ensure_vector_schema` helper in `codemem/db.py`.
 * The embedding width (384) matches the default BAAI/bge-small-en-v1.5 model
 * and the existing vectors tests; changing it requires rebuilding existing
 * vector rows via the migration helper.
 */
const MEMORY_VECTORS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
	embedding float[384],
	memory_id INTEGER,
	chunk_index INTEGER,
	content_hash TEXT,
	model TEXT
);
`;

/**
 * Create the `memory_vectors` sqlite-vec virtual table on `db` if it does not
 * already exist. No-op when embeddings are disabled via
 * `CODEMEM_EMBEDDING_DISABLED`, matching the Python backend's behavior.
 *
 * This function is safe to call from any bootstrap path — it probes for
 * `vec_version()` first and only attempts to load the sqlite-vec extension if
 * it is not already present on the connection. That avoids double-loading when
 * callers (like `MemoryStore`) have already called `loadSqliteVec` directly.
 */
export function ensureVectorSchema(db: Database): void {
	if (isEmbeddingDisabled()) return;
	try {
		if (!isSqliteVecLoaded(db)) {
			loadSqliteVec(db);
		}
		db.exec(MEMORY_VECTORS_DDL);
	} catch {
		return;
	}
}

function isSqliteVecLoaded(db: Database): boolean {
	try {
		const row = db.prepare("SELECT vec_version() AS v").get() as { v?: string } | undefined;
		return typeof row?.v === "string" && row.v.length > 0;
	} catch {
		return false;
	}
}

export function bootstrapSchema(db: Database): void {
	db.transaction(() => {
		db.exec(TEST_SCHEMA_BASE_DDL);
		db.exec(SCHEMA_AUX_DDL);
		assertBootstrapTablesCreated(db);
		db.pragma(`user_version = ${SCHEMA_VERSION}`);
	}).immediate();

	// sqlite-vec support is optional/best-effort. Keep it outside the core
	// bootstrap transaction so an unavailable extension cannot produce a
	// half-successful core schema, and cannot prevent first-run stats/setup.
	ensureVectorSchema(db);
}

function assertBootstrapTablesCreated(db: Database): void {
	const missing = REQUIRED_BOOTSTRAPPED_TABLES.filter((table) => !tableExists(db, table));
	if (missing.length > 0) {
		throw new Error(`Schema bootstrap failed; missing required tables: ${missing.join(", ")}`);
	}
}

function isSafeEmptyDatabase(db: Database): boolean {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM sqlite_master
			 WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
		)
		.get() as { count?: number } | undefined;
	return (row?.count ?? 0) === 0;
}

function tableExists(db: Database, table: string): boolean {
	const row = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get(table);
	return row !== undefined;
}

/**
 * Run `bootstrapSchema` on a database only if it's still at the unbootstrapped
 * state (`user_version === 0`). `connect()` now calls this by default for
 * writable handles, but explicit callers may still use it directly. Idempotent:
 * already-initialized databases are left untouched.
 */
export function ensureSchemaBootstrapped(db: Database): void {
	if (!isReadonlyDatabase(db) && canAutoBootstrapSchema(db)) {
		bootstrapSchema(db);
	}
}

export function canAutoBootstrapSchema(db: Database): boolean {
	return getSchemaVersion(db) === 0 && isSafeEmptyDatabase(db);
}

function isReadonlyDatabase(db: Database): boolean {
	return (db as { readonly?: boolean }).readonly === true;
}
