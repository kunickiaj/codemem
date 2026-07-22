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
export const SCHEMA_VERSION = 13;

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

		// Read tuning for large (multi-GB) databases. The SQLite defaults — a
		// ~2 MiB page cache and no mmap — force repeated disk/page-cache reads of
		// B-tree interior pages on every non-trivial query. A 64 MiB cache, 1 GiB
		// memory-mapped I/O, and in-memory temp B-trees cut that cost. These are
		// per-connection and must be set here (they do not persist in the file).
		db.pragma("cache_size = -65536");
		db.pragma("mmap_size = 1073741824");
		db.pragma("temp_store = MEMORY");

		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

/**
 * Open an EXISTING database read-only.
 *
 * Unlike {@link connect}, this never creates the parent directory, never opens
 * for writing, and never enables WAL or runs schema bootstrap — so it works on
 * read-only snapshots and read-only directories (e.g. a copied audit snapshot).
 * Read-tuning pragmas are still applied because they are per-connection and do
 * not write to the file. Schema readiness is validated read-only.
 */
export function connectReadOnly(dbPath: string = DEFAULT_DB_PATH): DatabaseType {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		db.pragma("foreign_keys = ON");
		db.pragma("busy_timeout = 5000");
		// Read tuning only — safe on a read-only connection (per-connection state).
		db.pragma("cache_size = -65536");
		db.pragma("mmap_size = 1073741824");
		db.pragma("temp_store = MEMORY");
		assertSchemaReadyReadOnly(db);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

/**
 * Validate schema readiness without any writes (no bootstrap, no migration).
 * Mirrors {@link assertSchemaReady} but is safe on read-only connections.
 */
export function assertSchemaReadyReadOnly(db: DatabaseType): void {
	const version = getSchemaVersion(db);
	if (version === 0) {
		throw new Error(
			"Database schema is not initialized (read-only open). " +
				"Point at an initialized codemem database.",
		);
	}
	if (version < MIN_COMPATIBLE_SCHEMA) {
		throw new Error(
			`Database schema version ${version} is older than minimum compatible (${MIN_COMPATIBLE_SCHEMA}).`,
		);
	}
	if (version > SCHEMA_VERSION) {
		console.warn(
			`Database schema version ${version} is newer than this TS runtime (${SCHEMA_VERSION}). ` +
				"Running in read-only compatibility mode.",
		);
	}
	const missing = REQUIRED_TABLES.filter((t) => !tableExists(db, t));
	if (missing.length > 0) {
		throw new Error(
			`Required tables missing: ${missing.join(", ")}. ` +
				"The database may be corrupt or from an incompatible version.",
		);
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
 * Has the additive compatibility shim already run for the current SCHEMA_VERSION?
 *
 * Fail-safe: returns false on any error (including a missing
 * `schema_compat_state` table) so the shim re-runs rather than skipping needed
 * additive DDL on uncertainty. Keyed on SCHEMA_VERSION so a future runtime with
 * a higher SCHEMA_VERSION (and new additive DDL) sees the older marker and
 * re-applies.
 */
function schemaCompatAlreadyApplied(db: DatabaseType): boolean {
	try {
		const row = db
			.prepare("SELECT applied_schema_version AS v FROM schema_compat_state WHERE id = 1 LIMIT 1")
			.get() as { v: number } | undefined;
		return typeof row?.v === "number" && row.v >= SCHEMA_VERSION;
	} catch {
		return false;
	}
}

/**
 * Record that the additive compatibility shim has been applied for the current
 * SCHEMA_VERSION. Fail-open: a failed mark just means the shim re-runs on the
 * next open, which is harmless because the DDL is idempotent.
 */
function markSchemaCompatApplied(db: DatabaseType): void {
	try {
		db.prepare(
			`INSERT INTO schema_compat_state(id, applied_schema_version, applied_at)
			 VALUES (1, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				 applied_schema_version = excluded.applied_schema_version,
				 applied_at = excluded.applied_at`,
		).run(SCHEMA_VERSION, new Date().toISOString());
	} catch {
		// Fail-open: a missed mark only costs one extra idempotent re-run.
	}
}

/**
 * Backfill the denormalized memory_items.project column from sessions.project.
 *
 * Runs on EVERY store open (not gated behind the schema-compat marker) because
 * moveMemoryProject edits sessions.project and relies on this backfill plus a
 * reader-fallback to propagate the new project to legacy rows whose project is
 * still NULL. Idempotent — only touches rows where project IS NULL.
 */
function backfillMemoryItemProject(db: DatabaseType): void {
	try {
		db.exec(`UPDATE memory_items
			 SET project = (
				 SELECT s.project FROM sessions s
				 WHERE s.id = memory_items.session_id
			 )
			 WHERE project IS NULL`);
	} catch {
		// Best-effort backfill — readers fall back to sessions.project
		// when memory_items.project is null.
	}
}

/**
 * Apply additive compatibility fixes for legacy TS-era schemas.
 *
 * These are safe, one-way `ALTER TABLE ... ADD COLUMN` updates used to
 * prevent runtime failures when older local databases are missing columns
 * introduced in later releases.
 *
 * The ~39 idempotent DDL statements are gated behind a `schema_compat_state`
 * marker so steady-state opens skip them: each database runs the shim once
 * (idempotent — a fresh DB's statements are all no-ops), records the marker,
 * and skips thereafter. We deliberately do NOT short-circuit on
 * `user_version >= SCHEMA_VERSION`: additive columns (e.g. memory_items.project)
 * have been added over time WITHOUT bumping SCHEMA_VERSION, so a database can
 * report user_version=SCHEMA_VERSION yet still lack a column the shim adds —
 * the version is not proof the shim ran. Only the marker is. The project
 * backfill still runs on every open regardless of the gate.
 */
function indexColumns(db: DatabaseType, indexName: string): string[] {
	const quoted = indexName.replaceAll('"', '""');
	return (db.prepare(`PRAGMA index_info("${quoted}")`).all() as Array<{ name?: string }>)
		.map((row) => String(row.name ?? ""))
		.filter(Boolean);
}

function repairShareOperationEffectIdIndex(db: DatabaseType): void {
	if (
		!tableExists(db, "share_operation_steps") ||
		!columnExists(db, "share_operation_steps", "effect_id")
	) {
		return;
	}
	const indexes = db.prepare("PRAGMA index_list('share_operation_steps')").all() as Array<{
		name: string;
		unique: number;
	}>;
	const hasInlineUniqueEffectId = indexes.some(
		(index) =>
			index.unique === 1 &&
			index.name !== "idx_share_operation_steps_effect_id_nonempty" &&
			indexColumns(db, index.name).join(",") === "effect_id",
	);
	if (hasInlineUniqueEffectId) {
		db.transaction(() => {
			db.exec(`
				DROP INDEX IF EXISTS idx_share_operation_steps_effect_id_nonempty;
				ALTER TABLE share_operation_steps RENAME TO share_operation_steps_unique_legacy;
				CREATE TABLE share_operation_steps (
					operation_id TEXT NOT NULL,
					step_key TEXT NOT NULL,
					effect_id TEXT NOT NULL,
					status TEXT NOT NULL,
					attempt_count INTEGER NOT NULL DEFAULT 0,
					started_at TEXT,
					completed_at TEXT,
					last_attempt_at TEXT,
					safe_error_code TEXT,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (operation_id, step_key)
				);
				INSERT INTO share_operation_steps(
					operation_id, step_key, effect_id, status, attempt_count, started_at,
					completed_at, last_attempt_at, safe_error_code, updated_at
				) SELECT operation_id, step_key, effect_id, status, attempt_count, started_at,
					completed_at, last_attempt_at, safe_error_code, updated_at
				FROM share_operation_steps_unique_legacy;
				DROP TABLE share_operation_steps_unique_legacy;
			`);
		})();
	}
	db.exec(`
		DROP INDEX IF EXISTS idx_share_operation_steps_effect_id_nonempty;
		CREATE INDEX IF NOT EXISTS idx_share_operation_steps_effect_id_nonempty
			ON share_operation_steps(effect_id)
			WHERE effect_id <> '';
	`);
}

export function ensureAdditiveSchemaCompatibility(db: DatabaseType): void {
	const compatAlreadyApplied = schemaCompatAlreadyApplied(db);
	if (!compatAlreadyApplied) {
		// IMPORTANT: any NEW DDL added to this gated block REQUIRES bumping
		// SCHEMA_VERSION. The "already applied" marker keys on SCHEMA_VERSION, so
		// without a bump, legacy DBs already marked at the current version would
		// skip the new DDL forever.
		// Marker table must exist before we can mark; create it first.
		try {
			db.exec(`
				CREATE TABLE IF NOT EXISTS schema_compat_state (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					applied_schema_version INTEGER NOT NULL,
					applied_at TEXT NOT NULL
				)
			`);
		} catch {
			// Keep compatibility shim fail-open for the marker table.
		}

		try {
			db.exec(`
			CREATE TABLE IF NOT EXISTS recipient_policy_review_resolutions (
				review_item_id TEXT NOT NULL,
				source_fingerprint TEXT NOT NULL,
				decision TEXT NOT NULL,
				decision_input_json TEXT NOT NULL,
				preview_json TEXT NOT NULL,
				decided_by_identity_id TEXT NOT NULL,
				decided_by_device_id TEXT NOT NULL,
				resolved_at TEXT NOT NULL,
				PRIMARY KEY (review_item_id, source_fingerprint)
			);
			CREATE TABLE IF NOT EXISTS policy_teams (
				team_id TEXT PRIMARY KEY NOT NULL,
				display_name TEXT NOT NULL,
				status TEXT NOT NULL,
				provenance TEXT NOT NULL,
				revision TEXT NOT NULL,
				migration_state TEXT NOT NULL,
				source_fingerprint TEXT,
				idempotency_key TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS policy_team_memberships (
				team_id TEXT NOT NULL,
				identity_id TEXT NOT NULL,
				role TEXT NOT NULL,
				status TEXT NOT NULL,
				provenance TEXT NOT NULL,
				revision TEXT NOT NULL,
				migration_state TEXT NOT NULL,
				source_fingerprint TEXT,
				idempotency_key TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (team_id, identity_id)
			);
			CREATE TABLE IF NOT EXISTS identity_devices (
				device_id TEXT PRIMARY KEY NOT NULL,
				identity_id TEXT NOT NULL,
				display_name TEXT NOT NULL,
				status TEXT NOT NULL,
				provenance TEXT NOT NULL,
				revision TEXT NOT NULL,
				migration_state TEXT NOT NULL,
				source_fingerprint TEXT,
				idempotency_key TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS project_recipients (
				canonical_project_identity TEXT NOT NULL,
				recipient_kind TEXT NOT NULL,
				recipient_id TEXT NOT NULL,
				status TEXT NOT NULL,
				provenance TEXT NOT NULL,
				policy_revision TEXT NOT NULL,
				migration_state TEXT NOT NULL,
				source_fingerprint TEXT,
				idempotency_key TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (canonical_project_identity, recipient_kind, recipient_id)
			);
			CREATE TABLE IF NOT EXISTS recipient_policy_authority_states (
				canonical_project_identity TEXT PRIMARY KEY NOT NULL,
				authority_state TEXT NOT NULL DEFAULT 'legacy',
				generation INTEGER NOT NULL DEFAULT 0,
				desired_devices_digest TEXT,
				current_devices_digest TEXT,
				stable_parity_evidence_digest TEXT,
				stable_parity_passed_at TEXT,
				fresh_snapshot_fingerprint TEXT,
				fresh_snapshot_observed_at TEXT,
				safe_error_code TEXT,
				state_changed_at TEXT NOT NULL,
				last_error_at TEXT,
				attempt_count INTEGER NOT NULL DEFAULT 0,
				last_attempt_at TEXT,
				last_completed_at TEXT,
				lease_owner TEXT,
				lease_acquired_at TEXT,
				lease_expires_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS recipient_policy_reconciliation_steps (
				canonical_project_identity TEXT NOT NULL,
				generation INTEGER NOT NULL,
				step_key TEXT NOT NULL,
				effect_id TEXT NOT NULL,
				payload_digest TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				attempt_count INTEGER NOT NULL DEFAULT 0,
				started_at TEXT,
				completed_at TEXT,
				last_attempt_at TEXT,
				safe_error_code TEXT,
				error_at TEXT,
				lease_owner TEXT,
				lease_acquired_at TEXT,
				lease_expires_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (canonical_project_identity, generation, step_key)
			);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_recipient_policy_reconciliation_steps_effect
				ON recipient_policy_reconciliation_steps(effect_id);
			CREATE INDEX IF NOT EXISTS idx_recipient_policy_reconciliation_steps_status
				ON recipient_policy_reconciliation_steps(canonical_project_identity, status);
			CREATE TABLE IF NOT EXISTS recipient_policy_deny_overlays (
				canonical_project_identity TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				reason_code TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (canonical_project_identity, scope_id, device_id)
			);
			CREATE INDEX IF NOT EXISTS idx_recipient_policy_deny_overlays_scope_device
				ON recipient_policy_deny_overlays(scope_id, device_id);
			CREATE INDEX IF NOT EXISTS idx_policy_team_memberships_identity_status
				ON policy_team_memberships(identity_id, status);
			CREATE INDEX IF NOT EXISTS idx_identity_devices_identity_status
				ON identity_devices(identity_id, status);
			CREATE INDEX IF NOT EXISTS idx_project_recipients_project_status
				ON project_recipients(canonical_project_identity, status);
			CREATE TABLE IF NOT EXISTS share_operations (
				operation_id TEXT PRIMARY KEY NOT NULL,
				state TEXT NOT NULL,
				inviter_actor_id TEXT NOT NULL,
				inviter_device_ids_json TEXT NOT NULL,
				person_id TEXT NOT NULL,
				person_kind TEXT NOT NULL,
				pending_person_operation_id TEXT,
				teammate_name TEXT NOT NULL,
				history_policy TEXT NOT NULL,
				reviewed_project_set_digest TEXT NOT NULL,
				coordinator_group_id TEXT NOT NULL,
				coordinator_invite_id TEXT,
				invite_token_digest TEXT NOT NULL,
				invite_expires_at TEXT NOT NULL,
				recipient_actor_id TEXT,
				recipient_display_name TEXT,
				recipient_device_id TEXT,
				recipient_device_display_name TEXT,
				recipient_public_key TEXT,
				recipient_fingerprint TEXT,
				acceptance_consumed_at TEXT,
				trust_state TEXT,
				bootstrap_grant_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS share_operation_projects (
				operation_id TEXT NOT NULL,
				canonical_project_identity TEXT NOT NULL,
				display_name TEXT NOT NULL,
				identity_source TEXT NOT NULL,
				existing_memory_count INTEGER NOT NULL,
				ordinal INTEGER NOT NULL,
				PRIMARY KEY (operation_id, canonical_project_identity)
			);
			CREATE TABLE IF NOT EXISTS share_operation_steps (
				operation_id TEXT NOT NULL,
				step_key TEXT NOT NULL,
				effect_id TEXT NOT NULL,
				status TEXT NOT NULL,
				attempt_count INTEGER NOT NULL DEFAULT 0,
				started_at TEXT,
				completed_at TEXT,
				last_attempt_at TEXT,
				safe_error_code TEXT,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (operation_id, step_key)
			);
		`);
		} catch {
			// Keep compatibility shim fail-open for additive share-operation state.
		}
		const shareOperationColumns = [
			["state", "TEXT NOT NULL DEFAULT 'waiting_for_acceptance'"],
			["inviter_actor_id", "TEXT NOT NULL DEFAULT ''"],
			["inviter_device_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
			["person_id", "TEXT NOT NULL DEFAULT ''"],
			["person_kind", "TEXT NOT NULL DEFAULT 'pending'"],
			["pending_person_operation_id", "TEXT"],
			["teammate_name", "TEXT NOT NULL DEFAULT ''"],
			["history_policy", "TEXT NOT NULL DEFAULT 'existing_and_future'"],
			["reviewed_project_set_digest", "TEXT NOT NULL DEFAULT ''"],
			["coordinator_group_id", "TEXT NOT NULL DEFAULT ''"],
			["coordinator_invite_id", "TEXT"],
			["invite_token_digest", "TEXT NOT NULL DEFAULT ''"],
			["invite_expires_at", "TEXT NOT NULL DEFAULT ''"],
			["recipient_actor_id", "TEXT"],
			["recipient_display_name", "TEXT"],
			["recipient_device_id", "TEXT"],
			["recipient_device_display_name", "TEXT"],
			["recipient_public_key", "TEXT"],
			["recipient_fingerprint", "TEXT"],
			["acceptance_consumed_at", "TEXT"],
			["trust_state", "TEXT"],
			["bootstrap_grant_id", "TEXT"],
			["created_at", "TEXT NOT NULL DEFAULT ''"],
			["updated_at", "TEXT NOT NULL DEFAULT ''"],
		] as const;
		for (const [name, definition] of shareOperationColumns) {
			try {
				addColumnIfMissing(db, "share_operations", name, definition);
			} catch {
				// Continue repairing independent additive columns.
			}
		}
		for (const [table, columns] of [
			[
				"share_operation_projects",
				[
					["display_name", "TEXT NOT NULL DEFAULT ''"],
					["identity_source", "TEXT NOT NULL DEFAULT ''"],
					["existing_memory_count", "INTEGER NOT NULL DEFAULT 0"],
					["ordinal", "INTEGER NOT NULL DEFAULT 0"],
				],
			],
			[
				"share_operation_steps",
				[
					["effect_id", "TEXT NOT NULL DEFAULT ''"],
					["status", "TEXT NOT NULL DEFAULT 'pending'"],
					["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
					["started_at", "TEXT"],
					["completed_at", "TEXT"],
					["last_attempt_at", "TEXT"],
					["safe_error_code", "TEXT"],
					["updated_at", "TEXT NOT NULL DEFAULT ''"],
				],
			],
		] as const) {
			for (const [name, definition] of columns) {
				try {
					addColumnIfMissing(db, table, name, definition);
				} catch {
					// Continue repairing independent additive columns.
				}
			}
		}
		try {
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_share_operations_state_updated
					ON share_operations(state, updated_at);
				CREATE UNIQUE INDEX IF NOT EXISTS idx_share_operations_invite_digest
					ON share_operations(invite_token_digest);
				CREATE UNIQUE INDEX IF NOT EXISTS idx_share_operations_pending_person_operation
					ON share_operations(pending_person_operation_id)
					WHERE pending_person_operation_id IS NOT NULL;
			`);
		} catch {
			// Keep compatibility shim fail-open for additive share-operation indexes.
		}
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
		`);
		} catch {
			// Keep compatibility shim fail-open for optional additive diagnostics.
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
			try {
				db.exec(
					"CREATE INDEX IF NOT EXISTS idx_memory_items_scope_backfill_pending ON memory_items(id) WHERE scope_id IS NULL OR scope_id = ''",
				);
			} catch {
				// Keep additive compatibility best-effort for index creation.
			}

			// Denormalized project column: created here so the Projects read model can
			// read directly from memory_items without joining through sessions (which
			// carry device-local cwd and don't replicate). The actual NULL backfill
			// runs unconditionally via backfillMemoryItemProject() on every open below.
			addColumnIfMissing(db, "memory_items", "project", "TEXT");
			try {
				db.exec("CREATE INDEX IF NOT EXISTS idx_memory_items_project ON memory_items(project)");
			} catch {
				// Keep additive compatibility best-effort for index creation.
			}

			// Drop legacy memory_items indexes that no longer back any query, only
			// adding write amplification on databases created by older schemas. The
			// current schema never creates these. `visibility`/`workspace_kind` are
			// low-cardinality and only ever appear as secondary predicates already
			// covered by composite indexes (e.g. idx_memory_items_scope_visibility_created,
			// idx_memory_items_same_session_dedup_unique); `user_prompt_id` is unused
			// as a filter (and is all-NULL in practice).
			try {
				db.exec(
					`DROP INDEX IF EXISTS idx_memory_items_visibility;
				 DROP INDEX IF EXISTS idx_memory_items_workspace_kind;
				 DROP INDEX IF EXISTS idx_memory_items_user_prompt_id;`,
				);
			} catch {
				// Best-effort cleanup of legacy indexes.
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
			for (const name of [
				"discovered_via_coordinator_id",
				"discovered_via_group_id",
				"pending_bootstrap_grant_id",
			]) {
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
					if (
						message.includes("duplicate column name") &&
						columnExists(db, "sync_attempts", name)
					) {
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
				default_space_scope_id TEXT,
				auto_grant_default_space_on_join INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (coordinator_id, group_id)
			)
		`);
		} catch {
			// Keep compatibility shim fail-open for optional additive tables.
		}
		for (const { name, ddl } of [
			{ name: "default_space_scope_id", ddl: "TEXT" },
			{ name: "auto_grant_default_space_on_join", ddl: "INTEGER NOT NULL DEFAULT 0" },
		]) {
			if (columnExists(db, "coordinator_group_preferences", name)) continue;
			try {
				db.exec(`ALTER TABLE coordinator_group_preferences ADD COLUMN ${name} ${ddl}`);
			} catch (err) {
				const message = err instanceof Error ? err.message.toLowerCase() : "";
				if (message.includes("duplicate column name")) continue;
				throw err;
			}
		}

		if (tableExists(db, "raw_event_flush_batches")) {
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

		const recipientPolicyTablesReady = [
			"policy_teams",
			"policy_team_memberships",
			"identity_devices",
			"project_recipients",
			"recipient_policy_authority_states",
			"recipient_policy_reconciliation_steps",
			"recipient_policy_deny_overlays",
		].every((table) => tableExists(db, table));
		const currentVersion = getSchemaVersion(db);
		if (recipientPolicyTablesReady && currentVersion > 0 && currentVersion < SCHEMA_VERSION) {
			db.pragma(`user_version = ${SCHEMA_VERSION}`);
		}
		markSchemaCompatApplied(db);
	}
	try {
		repairShareOperationEffectIdIndex(db);
	} catch {
		// Keep compatibility shim fail-open for interrupted or partial legacy schemas.
	}

	// Always runs (not gated): moveMemoryProject relies on this backfill +
	// reader-fallback to propagate sessions.project edits to legacy NULL rows.
	backfillMemoryItemProject(db);
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
