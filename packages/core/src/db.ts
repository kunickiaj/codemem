/**
 * Database connection and schema initialization for the codemem TS backend.
 *
 * Mirrors codemem/db.py — same pragmas, same WAL mode, same sqlite-vec loading.
 * During Phase 1 of the migration, Python owns DDL (schema migrations).
 * The TS runtime validates the schema version but does NOT run migrations.
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

// Re-export the Database type for consumers
export type { DatabaseType as Database };

/** Current schema version this TS runtime was built against. */
export const SCHEMA_VERSION = 6;

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

/** Marker file written after the first successful TS access to a DB. */
const TS_MARKER = ".codemem-ts-accessed";

/** Default database path — matches Python's DEFAULT_DB_PATH. */
export const DEFAULT_DB_PATH = join(homedir(), ".codemem", "mem.sqlite");

/**
 * Resolve the database path from explicit arg → CODEMEM_DB env → default.
 * All TS entry points should use this instead of hardcoding fallback logic.
 */
export function resolveDbPath(explicit?: string): string {
	if (explicit) return explicit;
	const envPath = process.env.CODEMEM_DB;
	if (envPath) return envPath;
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
 * sets WAL mode, busy timeout, foreign keys.
 * Does NOT initialize or migrate the schema — during Phase 1, Python owns DDL.
 */
export function connect(dbPath: string = DEFAULT_DB_PATH): DatabaseType {
	migrateLegacyDbPath(dbPath);
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);

	// Match Python's connect() pragmas exactly
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");

	const journalMode = db.pragma("journal_mode = WAL", { simple: true }) as string;
	if (journalMode.toLowerCase() !== "wal") {
		console.warn(
			`Failed to enable WAL mode (got ${journalMode}). Concurrent access may not work correctly.`,
		);
	}

	db.pragma("synchronous = NORMAL");

	return db;
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
 * Read the schema user_version from the database.
 *
 * During Phase 1, the TS runtime uses this to verify the schema is initialized
 * (by Python) before operating. It does NOT set or bump the version.
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

	const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
	const backupPath = `${sourceDbPath}.pre-ts-${ts}.bak`;
	let backupSucceeded = false;
	try {
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
	}

	// Only write marker after backup succeeds — a transient failure should
	// retry on next access, not permanently suppress the safety net.
	if (backupSucceeded) {
		try {
			mkdirSync(dirname(markerPath), { recursive: true });
			writeFileSync(markerPath, new Date().toISOString(), "utf-8");
		} catch {
			// Non-fatal — worst case we back up again next time
		}
	}
}

/**
 * Verify the database schema is initialized and compatible.
 *
 * Per the coexistence contract: TS tolerates additive newer schemas (Python may
 * have run migrations that add tables/columns the TS runtime doesn't know about).
 * TS only hard-fails if:
 *   - Schema is uninitialized (version 0)
 *   - Schema is too old (below MIN_COMPATIBLE_SCHEMA)
 *   - Required tables are missing
 *   - FTS5 index is missing (needed for search)
 *
 * Warns (but continues) if schema is newer than SCHEMA_VERSION — the additive
 * changes are assumed safe per the coexistence contract.
 */
export function assertSchemaReady(db: DatabaseType): void {
	const version = getSchemaVersion(db);
	if (version === 0) {
		throw new Error(
			"Database schema is not initialized. " +
				"Run the Python runtime to initialize: uv run codemem stats",
		);
	}
	if (version < MIN_COMPATIBLE_SCHEMA) {
		throw new Error(
			`Database schema version ${version} is older than minimum compatible (${MIN_COMPATIBLE_SCHEMA}). ` +
				"Run the Python runtime to complete migrations: uv run codemem stats",
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
				"Run the Python runtime to rebuild: uv run codemem stats",
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

/** Safely parse a JSON string, returning {} on failure. */
export function fromJson(text: string | null | undefined): Record<string, unknown> {
	if (!text) return {};
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch (err) {
		console.warn("fromJson: failed to parse metadata_json", err);
		return {};
	}
}

/** Serialize a value to JSON, defaulting null/undefined to "{}". */
export function toJson(data: unknown): string {
	if (data == null) return "{}";
	return JSON.stringify(data);
}
