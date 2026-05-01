/**
 * Database connection and schema primitives for the codemem store.
 *
 * Owns the `connect()` helper (pragmas, WAL mode, sqlite-vec loading, legacy
 * path migration) and the schema-version introspection helpers
 * (`getSchemaVersion`, `assertSchemaReady`, `ensureAdditiveSchemaCompatibility`,
 * `ensurePlannerStats`). Schema bootstrap DDL lives in `schema-bootstrap.ts`;
 * `connect()` now enforces the fresh-database bootstrap invariant.
 */

import {
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { expandUserPath } from "./observer-config.js";
import { canAutoBootstrapSchema, ensureSchemaBootstrapped } from "./schema-bootstrap.js";

// Re-export the Database type for consumers
export type { DatabaseType as Database };

/** Current schema version this TS runtime was built against. */
export const SCHEMA_VERSION = 8;

/**
 * Minimum schema version the TS runtime can operate with.
 * Per the coexistence contract (docs/plans/2026-03-15-db-coexistence-contract.md),
 * TS must tolerate additive newer schemas. It only hard-fails if the schema is
 * too old to have the tables/columns it needs.
 */
export const MIN_COMPATIBLE_SCHEMA = 6;

/** Required tables the TS runtime needs to function. */
const REQUIRED_TABLES = [
	"memory_items",
	"sessions",
	"artifacts",
	"raw_events",
	"raw_event_sessions",
	"usage_events",
] as const;

export const REQUIRED_BOOTSTRAPPED_TABLES = [...REQUIRED_TABLES, "memory_fts"] as const;

/** Marker file written after the first successful TS access to a DB. */
const TS_MARKER = ".codemem-ts-accessed";

/** Lock file to avoid concurrent first-access backups. */
const TS_BACKUP_LOCK = ".codemem-ts-backup.lock";

/** Consider a backup lock stale after 15 minutes. */
const TS_BACKUP_LOCK_STALE_MS = 15 * 60 * 1000;

interface BackupLockAcquireResult {
	fd: number | null;
	contention: boolean;
}

function acquireBackupLock(lockPath: string): BackupLockAcquireResult {
	mkdirSync(dirname(lockPath), { recursive: true });
	try {
		return { fd: openSync(lockPath, "wx"), contention: false };
	} catch (err) {
		const code = err && typeof err === "object" ? (err as NodeJS.ErrnoException).code : undefined;
		if (code === "EEXIST") {
			let stale = false;
			try {
				const ageMs = Date.now() - statSync(lockPath).mtimeMs;
				stale = Number.isFinite(ageMs) && ageMs > TS_BACKUP_LOCK_STALE_MS;
			} catch {
				// If we can't read lock metadata, treat as live contention.
			}

			if (!stale) {
				return { fd: null, contention: true };
			}

			try {
				unlinkSync(lockPath);
			} catch (unlinkErr) {
				console.error(
					`[codemem] Warning: failed to clear stale backup lock at ${lockPath}:`,
					unlinkErr,
				);
				return { fd: null, contention: false };
			}

			try {
				return { fd: openSync(lockPath, "wx"), contention: false };
			} catch (retryErr) {
				const retryCode =
					retryErr && typeof retryErr === "object"
						? (retryErr as NodeJS.ErrnoException).code
						: undefined;
				if (retryCode === "EEXIST") {
					return { fd: null, contention: true };
				}
				console.error(`[codemem] Warning: failed to acquire backup lock at ${lockPath}:`, retryErr);
				return { fd: null, contention: false };
			}
		}

		console.error(`[codemem] Warning: failed to acquire backup lock at ${lockPath}:`, err);
		return { fd: null, contention: false };
	}
}

/** Default database path — matches Python's DEFAULT_DB_PATH. */
export const DEFAULT_DB_PATH = join(homedir(), ".codemem", "mem.sqlite");

/**
 * Resolve the database path from explicit arg → CODEMEM_DB env → default.
 * All TS entry points should use this instead of hardcoding fallback logic.
 */
export function resolveDbPath(explicit?: string): string {
	if (explicit) return expandUserPath(explicit);
	const envPath = process.env.CODEMEM_DB;
	if (envPath) return expandUserPath(envPath);
	return DEFAULT_DB_PATH;
}

/** Legacy database paths that may exist from older installs. */
const LEGACY_DB_PATHS = [
	join(homedir(), ".codemem.sqlite"),
	join(homedir(), ".opencode-mem.sqlite"),
];

/** WAL sidecar extensions for a SQLite database file. */
const SIDECAR_EXTENSIONS = ["-wal", "-shm"];

/**
 * Move a file and its WAL sidecars to a new location.
 * Falls back to copy+delete if rename fails (cross-device).
 */
function moveWithSidecars(src: string, dst: string): void {
	mkdirSync(dirname(dst), { recursive: true });
	const pairs: [string, string][] = [
		[src, dst],
		...SIDECAR_EXTENSIONS.map((ext): [string, string] => [src + ext, dst + ext]),
	];
	for (const [srcPath, dstPath] of pairs) {
		if (!existsSync(srcPath)) continue;
		try {
			renameSync(srcPath, dstPath);
		} catch {
			try {
				copyFileSync(srcPath, dstPath);
				try {
					unlinkSync(srcPath);
				} catch {
					// Best effort — original left in place
				}
			} catch (copyErr) {
				// TOCTOU: source vanished between existsSync and copy (concurrent migration).
				// If target now exists, another process already migrated — that's fine.
				if (existsSync(dstPath)) continue;
				throw copyErr;
			}
		}
	}
}

/**
 * Migrate legacy database paths to the current default location.
 *
 * Only runs when dbPath is the DEFAULT_DB_PATH and doesn't already exist.
 * Matches Python's migrate_legacy_default_db in db.py.
 */
export function migrateLegacyDbPath(dbPath: string): void {
	if (dbPath !== DEFAULT_DB_PATH) return;
	if (existsSync(dbPath)) return;

	for (const legacyPath of LEGACY_DB_PATHS) {
		if (!existsSync(legacyPath)) continue;
		moveWithSidecars(legacyPath, dbPath);
		return;
	}
}

/**
 * Open a better-sqlite3 connection with the standard codemem pragmas.
 *
 * Migrates legacy DB paths if needed, creates parent directories,
 * sets WAL mode, busy timeout, foreign keys, and bootstraps the schema when
 * opening a brand-new or otherwise uninitialized writable database.
 */
export function connect(dbPath: string = DEFAULT_DB_PATH): DatabaseType {
	migrateLegacyDbPath(dbPath);
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	try {
		// Match Python's connect() pragmas exactly
		db.pragma("foreign_keys = ON");
		db.pragma("busy_timeout = 5000");
		const configureWal = canAutoBootstrapSchema(db) || hasBootstrappedCodememSchema(db);

		ensureSchemaBootstrapped(db);
		if (!configureWal) return db;

		const journalMode = db.pragma("journal_mode = WAL", { simple: true }) as string;
		if (journalMode.toLowerCase() !== "wal") {
			console.warn(
				`Failed to enable WAL mode (got ${journalMode}). Concurrent access may not work correctly.`,
			);
		}

		db.pragma("synchronous = NORMAL");

		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function hasBootstrappedCodememSchema(db: DatabaseType): boolean {
	return REQUIRED_BOOTSTRAPPED_TABLES.every((table) => tableExists(db, table));
}

function hasPlannerStats(db: DatabaseType): boolean {
	try {
		return !!db.prepare("SELECT 1 FROM sqlite_stat1 LIMIT 1").pluck().get();
	} catch {
		return false;
	}
}

/**
 * Keep SQLite planner statistics healthy for FTS-heavy queries.
 *
 * We always run PRAGMA optimize as a cheap maintenance hint. If planner
 * statistics have never been collected and the core search tables exist,
 * bootstrap them with ANALYZE so Node SQLite picks stable FTS query plans.
 */
export function ensurePlannerStats(db: DatabaseType): void {
	db.pragma("optimize");

	if (hasPlannerStats(db)) return;
	if (!tableExists(db, "memory_items") || !tableExists(db, "memory_fts")) return;

	db.exec("ANALYZE");
	db.pragma("optimize");
}

/**
 * Load the sqlite-vec extension into an open database connection.
 *
 * Call this after connect() when vector operations are needed.
 * Skipped when CODEMEM_EMBEDDING_DISABLED=1.
 */
export function loadSqliteVec(db: DatabaseType): void {
	if (isEmbeddingDisabled()) {
		return;
	}

	sqliteVec.load(db);

	const row = db.prepare("SELECT vec_version() AS v").get() as { v: string } | undefined;
	if (!row?.v) {
		throw new Error("sqlite-vec loaded but version check failed");
	}
}

/** Check if embeddings are disabled via environment variable. */
export function isEmbeddingDisabled(): boolean {
	const val = process.env.CODEMEM_EMBEDDING_DISABLED?.toLowerCase();
	return val === "1" || val === "true" || val === "yes";
}

/**
 * Read the schema `user_version` pragma from the database.
 *
 * Returns `0` for a freshly-created or empty file, which is the signal
 * `MemoryStore` / `initDatabase` / `bootstrapSchema` use to decide whether to
 * run the initial DDL.
 */
export function getSchemaVersion(db: DatabaseType): number {
	const row = db.pragma("user_version", { simple: true });
	return typeof row === "number" ? row : 0;
}

/**
 * Create a timestamped backup of the database on first TS access.
 *
 * The backup file is named `mem.sqlite.pre-ts-YYYYMMDDTHHMMSS.bak` and placed
 * next to the original. A marker file prevents repeated backups. This ensures
 * users can recover if the TS runtime introduces bugs that corrupt the DB
 * during the migration period.
 */
export function backupOnFirstAccess(dbPath: string): void {
	const markerPath = join(dirname(dbPath), TS_MARKER);
	if (existsSync(markerPath)) return;

	// Find the actual DB file to back up. It may be at the target path already,
	// or at a legacy location that migrateLegacyDbPath() will move later.
	// Back up whichever exists BEFORE migration runs.
	let sourceDbPath = dbPath;
	if (!existsSync(dbPath)) {
		// Check legacy locations — same order as migrateLegacyDbPath()
		const legacyPaths = [
			join(dirname(dbPath), "..", ".codemem.sqlite"),
			join(dirname(dbPath), "..", ".opencode-mem.sqlite"),
		];
		const legacyPath = legacyPaths.find((p) => existsSync(p));
		if (legacyPath) {
			sourceDbPath = legacyPath;
		} else {
			return; // Fresh DB, nothing to back up
		}
	}

	const lockPath = join(dirname(dbPath), TS_BACKUP_LOCK);
	const { fd: lockFd, contention } = acquireBackupLock(lockPath);
	if (contention) {
		// Another process is handling first-access backup.
		return;
	}

	const writeMarker = (): void => {
		try {
			mkdirSync(dirname(markerPath), { recursive: true });
			writeFileSync(markerPath, new Date().toISOString(), "utf-8");
		} catch {
			// Non-fatal — worst case we attempt backup again later.
		}
	};

	const hasViableExistingBackup = (): boolean => {
		let sourceSize = 0;
		try {
			sourceSize = statSync(sourceDbPath).size;
		} catch {
			sourceSize = 0;
		}
		const minViableSize = sourceSize > 0 ? Math.floor(sourceSize * 0.9) : 1;
		const prefix = `${basename(sourceDbPath)}.pre-ts-`;
		try {
			const entries = readdirSync(dirname(sourceDbPath));
			for (const entry of entries) {
				if (!entry.startsWith(prefix) || !entry.endsWith(".bak")) continue;
				const fullPath = join(dirname(sourceDbPath), entry);
				try {
					if (statSync(fullPath).size >= minViableSize) {
						return true;
					}
				} catch {
					// Ignore races while inspecting backup candidates.
				}
			}
		} catch {
			// Ignore directory read errors — proceed with normal backup path.
		}
		return false;
	};

	const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
	const backupPath = `${sourceDbPath}.pre-ts-${ts}.bak`;
	let backupSucceeded = false;
	try {
		if (existsSync(markerPath)) return;
		if (hasViableExistingBackup()) {
			writeMarker();
			return;
		}

		copyFileSync(sourceDbPath, backupPath);
		// Also back up WAL/SHM if present (they contain uncommitted data)
		const walPath = `${sourceDbPath}-wal`;
		const shmPath = `${sourceDbPath}-shm`;
		if (existsSync(walPath)) copyFileSync(walPath, `${backupPath}-wal`);
		if (existsSync(shmPath)) copyFileSync(shmPath, `${backupPath}-shm`);
		console.error(`[codemem] First TS access — backed up database to ${backupPath}`);
		backupSucceeded = true;
	} catch (err) {
		console.error(`[codemem] Warning: failed to create backup at ${backupPath}:`, err);
		// Continue — backup failure shouldn't prevent operation, but don't write marker
	} finally {
		if (lockFd != null) {
			try {
				closeSync(lockFd);
			} catch {
				// Ignore close errors.
			}
			try {
				unlinkSync(lockPath);
			} catch {
				// Ignore lock cleanup errors.
			}
		}
	}

	// Only write marker after backup succeeds — a transient failure should
	// retry on next access, not permanently suppress the safety net.
	if (backupSucceeded) {
		writeMarker();
	}
}

/**
 * Verify the database schema is initialized and compatible.
 *
 * Empty writable first-run handles are bootstrapped here as a final safety net,
 * even though `connect()` already does the same. A few lower-level maintenance
 * and integration paths call this assertion after receiving an existing database
 * handle, so keeping the bootstrap invariant here prevents one entry point from
 * requiring a manual `codemem db init` while another works automatically.
 *
 * Per the coexistence contract: TS tolerates additive newer schemas (Python may
 * have run migrations that add tables/columns the TS runtime doesn't know about).
 * TS only hard-fails if:
 *   - Schema is still uninitialized after a bootstrap attempt (version 0)
 *   - Schema is too old (below MIN_COMPATIBLE_SCHEMA)
 *   - Required tables are missing
 *   - FTS5 index is missing (needed for search)
 *
 * Warns (but continues) if schema is newer than SCHEMA_VERSION — the additive
 * changes are assumed safe per the coexistence contract.
 */
export function assertSchemaReady(db: DatabaseType): void {
	ensureSchemaBootstrapped(db);
	const version = getSchemaVersion(db);
	if (version === 0) {
		throw new Error(
			"Database schema is not initialized. " +
				"Initialize the SQLite database with the current TypeScript runtime before retrying.",
		);
	}
	if (version < MIN_COMPATIBLE_SCHEMA) {
		throw new Error(
			`Database schema version ${version} is older than minimum compatible (${MIN_COMPATIBLE_SCHEMA}). ` +
				"Upgrade the database schema with the current TypeScript runtime before retrying.",
		);
	}
	if (version > SCHEMA_VERSION) {
		console.warn(
			`Database schema version ${version} is newer than this TS runtime (${SCHEMA_VERSION}). ` +
				"Running in compatibility mode — additive schema changes are tolerated.",
		);
	}

	// Validate required tables exist (catches corrupt or partially migrated DBs)
	const missing = REQUIRED_TABLES.filter((t) => !tableExists(db, t));
	if (missing.length > 0) {
		throw new Error(
			`Required tables missing: ${missing.join(", ")}. ` +
				"The database may be corrupt or from an incompatible version.",
		);
	}

	// FTS5 index is required for search
	if (!tableExists(db, "memory_fts")) {
		throw new Error(
			"FTS5 index (memory_fts) is missing. " +
				"Rebuild the database schema with the current TypeScript runtime before retrying.",
		);
	}
}

/** Check if a table exists in the database. */
export function tableExists(db: DatabaseType, table: string): boolean {
	const row = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table);
	return row !== undefined;
}

/** Check if a column exists in a table. */
export function columnExists(db: DatabaseType, table: string, column: string): boolean {
	if (!tableExists(db, table)) return false;
	const row = db
		.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ? LIMIT 1")
		.get(table, column);
	return row !== undefined;
}

function addColumnIfMissing(
	db: DatabaseType,
	table: string,
	name: string,
	definition: string,
): void {
	if (columnExists(db, table, name)) return;
	try {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
	} catch (err) {
		const message = err instanceof Error ? err.message.toLowerCase() : "";
		if (message.includes("duplicate column name") && columnExists(db, table, name)) {
			return;
		}
		throw err;
	}
}

/**
 * Apply additive compatibility fixes for legacy TS-era schemas.
 *
 * These are safe, one-way `ALTER TABLE ... ADD COLUMN` updates used to
 * prevent runtime failures when older local databases are missing columns
 * introduced in later releases.
 */
export function ensureAdditiveSchemaCompatibility(db: DatabaseType): void {
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS sync_reset_state (
				id INTEGER PRIMARY KEY,
				generation INTEGER NOT NULL,
				snapshot_id TEXT NOT NULL,
				baseline_cursor TEXT,
				retained_floor_cursor TEXT,
				updated_at TEXT NOT NULL
			)
		`);
	} catch {
		// Keep compatibility shim fail-open for optional additive tables.
	}

	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS sync_reset_state_v2 (
				scope_id TEXT PRIMARY KEY NOT NULL,
				generation INTEGER NOT NULL,
				snapshot_id TEXT NOT NULL,
				baseline_cursor TEXT,
				retained_floor_cursor TEXT,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS sync_retention_state_v2 (
				scope_id TEXT PRIMARY KEY NOT NULL,
				last_run_at TEXT,
				last_duration_ms INTEGER,
				last_deleted_ops INTEGER NOT NULL DEFAULT 0,
				last_estimated_bytes_before INTEGER,
				last_estimated_bytes_after INTEGER,
				retained_floor_cursor TEXT,
				last_error TEXT,
				last_error_at TEXT
			);

			CREATE TABLE IF NOT EXISTS replication_cursors_v2 (
				peer_device_id TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				last_applied_cursor TEXT,
				last_acked_cursor TEXT,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (peer_device_id, scope_id)
			);
			CREATE INDEX IF NOT EXISTS idx_replication_cursors_v2_scope
				ON replication_cursors_v2(scope_id);
		`);
	} catch {
		// Keep compatibility shim fail-open for optional additive tables.
	}

	if (tableExists(db, "sync_reset_state") && tableExists(db, "sync_reset_state_v2")) {
		try {
			db.exec(`
				INSERT OR IGNORE INTO sync_reset_state_v2
					(scope_id, generation, snapshot_id, baseline_cursor, retained_floor_cursor, updated_at)
				SELECT 'local-default', generation, snapshot_id, baseline_cursor, retained_floor_cursor, updated_at
				FROM sync_reset_state
				WHERE id = 1
			`);
		} catch {
			// Best-effort bridge from legacy singleton state.
		}
	}

	if (tableExists(db, "sync_retention_state") && tableExists(db, "sync_retention_state_v2")) {
		try {
			db.exec(`
				INSERT OR IGNORE INTO sync_retention_state_v2
					(
						scope_id,
						last_run_at,
						last_duration_ms,
						last_deleted_ops,
						last_estimated_bytes_before,
						last_estimated_bytes_after,
						retained_floor_cursor,
						last_error,
						last_error_at
					)
				SELECT
					'local-default',
					last_run_at,
					last_duration_ms,
					last_deleted_ops,
					last_estimated_bytes_before,
					last_estimated_bytes_after,
					retained_floor_cursor,
					last_error,
					last_error_at
				FROM sync_retention_state
				WHERE id = 1
			`);
		} catch {
			// Best-effort bridge from legacy singleton state.
		}
	}

	if (tableExists(db, "replication_cursors") && tableExists(db, "replication_cursors_v2")) {
		try {
			db.exec(`
				INSERT OR IGNORE INTO replication_cursors_v2
					(peer_device_id, scope_id, last_applied_cursor, last_acked_cursor, updated_at)
				SELECT peer_device_id, 'local-default', last_applied_cursor, last_acked_cursor, updated_at
				FROM replication_cursors
			`);
		} catch {
			// Best-effort bridge from legacy peer-level cursors.
		}
	}

	// Add phase column to sync_daemon_state for rebootstrap safety gate.
	if (tableExists(db, "sync_daemon_state") && !columnExists(db, "sync_daemon_state", "phase")) {
		try {
			db.exec("ALTER TABLE sync_daemon_state ADD COLUMN phase TEXT");
		} catch {
			// Race-safe: another process may have added it first.
		}
	}

	if (tableExists(db, "memory_items")) {
		if (!columnExists(db, "memory_items", "dedup_key")) {
			try {
				db.exec("ALTER TABLE memory_items ADD COLUMN dedup_key TEXT");
			} catch (err) {
				const message = err instanceof Error ? err.message.toLowerCase() : "";
				const duplicateColumn = message.includes("duplicate column name");
				if (!(duplicateColumn && columnExists(db, "memory_items", "dedup_key"))) {
					throw err;
				}
			}
		}

		try {
			db.exec(
				"CREATE INDEX IF NOT EXISTS idx_memory_items_dedup_key_active_created ON memory_items(dedup_key, active, created_at)",
			);
		} catch {
			// Keep additive compatibility best-effort for index creation.
		}

		try {
			db.exec(
				"CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_same_session_dedup_unique ON memory_items(session_id, kind, visibility, workspace_id, dedup_key) WHERE active = 1 AND dedup_key IS NOT NULL",
			);
		} catch {
			// Keep additive compatibility best-effort for index creation.
		}

		addColumnIfMissing(db, "memory_items", "scope_id", "TEXT");
		try {
			db.exec(
				"CREATE INDEX IF NOT EXISTS idx_memory_items_scope_visibility_created ON memory_items(scope_id, visibility, created_at)",
			);
		} catch {
			// Keep additive compatibility best-effort for index creation.
		}
	}

	if (tableExists(db, "replication_ops")) {
		addColumnIfMissing(db, "replication_ops", "scope_id", "TEXT");
		try {
			db.exec(
				"CREATE INDEX IF NOT EXISTS idx_replication_ops_scope_created ON replication_ops(scope_id, created_at, op_id)",
			);
		} catch {
			// Keep additive compatibility best-effort for index creation.
		}
	}

	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS replication_scopes (
				scope_id TEXT PRIMARY KEY NOT NULL,
				label TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'user',
				authority_type TEXT NOT NULL DEFAULT 'local',
				coordinator_id TEXT,
				group_id TEXT,
				manifest_issuer_device_id TEXT,
				membership_epoch INTEGER NOT NULL DEFAULT 0,
				manifest_hash TEXT,
				status TEXT NOT NULL DEFAULT 'active',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_replication_scopes_status
				ON replication_scopes(status);
			CREATE INDEX IF NOT EXISTS idx_replication_scopes_authority_group
				ON replication_scopes(coordinator_id, group_id);

			CREATE TABLE IF NOT EXISTS project_scope_mappings (
				id INTEGER PRIMARY KEY,
				workspace_identity TEXT,
				project_pattern TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				priority INTEGER NOT NULL DEFAULT 0,
				source TEXT NOT NULL DEFAULT 'user',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_project_scope_mappings_workspace_priority
				ON project_scope_mappings(workspace_identity, priority);
			CREATE INDEX IF NOT EXISTS idx_project_scope_mappings_pattern_priority
				ON project_scope_mappings(project_pattern, priority);
			CREATE INDEX IF NOT EXISTS idx_project_scope_mappings_scope
				ON project_scope_mappings(scope_id);

			CREATE TABLE IF NOT EXISTS scope_memberships (
				scope_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				role TEXT NOT NULL DEFAULT 'member',
				status TEXT NOT NULL DEFAULT 'active',
				membership_epoch INTEGER NOT NULL DEFAULT 0,
				coordinator_id TEXT,
				group_id TEXT,
				manifest_issuer_device_id TEXT,
				manifest_hash TEXT,
				signed_manifest_json TEXT,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (scope_id, device_id)
			);
			CREATE INDEX IF NOT EXISTS idx_scope_memberships_device_status
				ON scope_memberships(device_id, status);
			CREATE INDEX IF NOT EXISTS idx_scope_memberships_scope_status
				ON scope_memberships(scope_id, status);
			CREATE INDEX IF NOT EXISTS idx_scope_memberships_authority_group
				ON scope_memberships(coordinator_id, group_id);

			CREATE TABLE IF NOT EXISTS scope_membership_cache_state (
				coordinator_id TEXT NOT NULL,
				group_id TEXT NOT NULL,
				last_refresh_at TEXT NOT NULL,
				last_success_at TEXT,
				last_error TEXT,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (coordinator_id, group_id)
			);
		`);
	} catch {
		// Keep compatibility shim fail-open for optional additive scope metadata.
	}

	// Junction tables for structured file/concept references on memories.
	// Added in schema v7; existing v6 databases need these created additively.
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS memory_file_refs (
				memory_id INTEGER NOT NULL,
				file_path TEXT NOT NULL,
				relation TEXT NOT NULL CHECK(relation IN ('read', 'modified')),
				PRIMARY KEY (memory_id, file_path, relation),
				FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_memory_file_refs_path ON memory_file_refs(file_path);

			CREATE TABLE IF NOT EXISTS memory_concept_refs (
				memory_id INTEGER NOT NULL,
				concept TEXT NOT NULL,
				PRIMARY KEY (memory_id, concept),
				FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_memory_concept_refs_concept ON memory_concept_refs(concept);
		`);
	} catch {
		// Keep compatibility shim fail-open for optional additive tables.
	}

	// Multi-team coordinator groups (v1) — additive columns + preferences table.
	// Existing databases acquire these so peer enrollment can record the group
	// it came from, and so per-group scope templates can be stored locally.
	if (tableExists(db, "sync_peers")) {
		for (const name of ["discovered_via_coordinator_id", "discovered_via_group_id"]) {
			if (columnExists(db, "sync_peers", name)) continue;
			try {
				db.exec(`ALTER TABLE sync_peers ADD COLUMN ${name} TEXT`);
			} catch (err) {
				const message = err instanceof Error ? err.message.toLowerCase() : "";
				if (message.includes("duplicate column name") && columnExists(db, "sync_peers", name)) {
					continue;
				}
				throw err;
			}
		}
	}
	if (tableExists(db, "sync_attempts")) {
		for (const name of [
			"local_sync_capability",
			"peer_sync_capability",
			"negotiated_sync_capability",
		]) {
			if (columnExists(db, "sync_attempts", name)) continue;
			try {
				db.exec(`ALTER TABLE sync_attempts ADD COLUMN ${name} TEXT`);
			} catch (err) {
				const message = err instanceof Error ? err.message.toLowerCase() : "";
				if (message.includes("duplicate column name") && columnExists(db, "sync_attempts", name)) {
					continue;
				}
				throw err;
			}
		}
	}
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS coordinator_group_preferences (
				coordinator_id TEXT NOT NULL,
				group_id TEXT NOT NULL,
				projects_include_json TEXT,
				projects_exclude_json TEXT,
				auto_seed_scope INTEGER NOT NULL DEFAULT 1,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (coordinator_id, group_id)
			)
		`);
	} catch {
		// Keep compatibility shim fail-open for optional additive tables.
	}

	if (!tableExists(db, "raw_event_flush_batches")) return;

	const additiveColumns: Array<{ name: string; ddl: string }> = [
		{ name: "error_message", ddl: "TEXT" },
		{ name: "error_type", ddl: "TEXT" },
		{ name: "observer_provider", ddl: "TEXT" },
		{ name: "observer_model", ddl: "TEXT" },
		{ name: "observer_runtime", ddl: "TEXT" },
		{ name: "observer_auth_source", ddl: "TEXT" },
		{ name: "observer_auth_type", ddl: "TEXT" },
		{ name: "observer_error_code", ddl: "TEXT" },
		{ name: "observer_error_message", ddl: "TEXT" },
		{ name: "attempt_count", ddl: "INTEGER NOT NULL DEFAULT 0" },
	];

	for (const { name, ddl } of additiveColumns) {
		if (columnExists(db, "raw_event_flush_batches", name)) continue;
		try {
			db.exec(`ALTER TABLE raw_event_flush_batches ADD COLUMN ${name} ${ddl}`);
		} catch (err) {
			const message = err instanceof Error ? err.message.toLowerCase() : "";
			const duplicateColumn = message.includes("duplicate column name");
			if (duplicateColumn && columnExists(db, "raw_event_flush_batches", name)) {
				// Another process may have raced and added the column first.
				continue;
			}
			throw err;
		}
	}
}

/** Safely parse a JSON string, returning {} on failure. */
export function fromJson(text: string | null | undefined): Record<string, unknown> {
	if (!text) return {};
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return {};
		}
		return parsed as Record<string, unknown>;
	} catch {
		console.warn(`[codemem] fromJson: invalid JSON (${text.slice(0, 80)}...)`);
		return {};
	}
}

/**
 * Parse a JSON string strictly — throws on invalid input.
 *
 * Use in mutation paths (replication apply, import) where silently
 * returning {} would mask data corruption. Read paths should use
 * fromJson() which is forgiving.
 */
export function fromJsonStrict(text: string | null | undefined): Record<string, unknown> {
	if (!text) return {};
	const parsed = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(
			`fromJsonStrict: expected object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
		);
	}
	return parsed as Record<string, unknown>;
}

/** Serialize a value to JSON, defaulting null/undefined to "{}". */
export function toJson(data: unknown): string {
	if (data == null) return "{}";
	return JSON.stringify(data);
}

/**
 * Serialize a value to JSON, preserving null as SQL NULL.
 *
 * Use this for columns that store JSON arrays (facts, concepts, files_read,
 * files_modified) where NULL means "no data" and "{}" would be corruption.
 * Also normalizes empty objects ({}) to null — Python's from_json returns {}
 * for empty DB values, so imported exports carry {} instead of null.
 * Use `toJson` for metadata_json where "{}" is the correct empty default.
 */
export function toJsonNullable(data: unknown): string | null {
	if (data == null) return null;
	// Normalize empty objects to null — these are never valid array column values
	if (
		typeof data === "object" &&
		!Array.isArray(data) &&
		Object.keys(data as object).length === 0
	) {
		return null;
	}
	return JSON.stringify(data);
}
