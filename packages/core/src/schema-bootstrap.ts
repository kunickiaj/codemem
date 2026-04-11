import type { Database } from "./db.js";
import { getSchemaVersion, isEmbeddingDisabled, loadSqliteVec, SCHEMA_VERSION } from "./db.js";
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
	db.exec(TEST_SCHEMA_BASE_DDL);
	db.exec(SCHEMA_AUX_DDL);
	ensureVectorSchema(db);
	db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/**
 * Run `bootstrapSchema` on a database only if it's still at the unbootstrapped
 * state (`user_version === 0`). `connect()` now calls this by default for
 * writable handles, but explicit callers may still use it directly. Idempotent:
 * already-initialized databases are left untouched.
 */
export function ensureSchemaBootstrapped(db: Database): void {
	if (getSchemaVersion(db) === 0) {
		bootstrapSchema(db);
	}
}
