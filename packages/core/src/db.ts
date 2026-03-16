/**
 * Database connection and schema initialization for the codemem TS backend.
 *
 * Mirrors codemem/db.py — same pragmas, same WAL mode, same sqlite-vec loading.
 * During Phase 1 of the migration, Python owns DDL (schema migrations).
 * The TS runtime validates the schema version but does NOT run migrations.
 */

import { mkdirSync } from "node:fs";
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
const REQUIRED_TABLES = ["memory_items", "sessions", "artifacts", "raw_events"] as const;

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

/**
 * Open a better-sqlite3 connection with the standard codemem pragmas.
 *
 * Creates parent directories if they don't exist (matches Python's connect()).
 * Sets WAL mode, busy timeout, foreign keys, and loads sqlite-vec.
 * Does NOT initialize or migrate the schema — during Phase 1, Python owns DDL.
 *
 * Note: Legacy path migration (~/.codemem.sqlite → ~/.codemem/mem.sqlite)
 * is handled by the Python runtime. In Phase 1, Python must run first.
 */
export function connect(dbPath: string = DEFAULT_DB_PATH): DatabaseType {
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
 * Verify the database schema is initialized and compatible.
 *
 * Per the coexistence contract: TS tolerates additive newer schemas (Python may
 * have run migrations that add tables/columns the TS runtime doesn't know about).
 * TS only hard-fails if:
 *   - Schema is uninitialized (version 0)
 *   - Schema is too old (below MIN_COMPATIBLE_SCHEMA)
 *   - Required tables are missing
 *
 * Warns (but continues) if schema is newer than SCHEMA_VERSION — the additive
 * changes are assumed safe per the coexistence contract.
 */
export function assertSchemaReady(db: DatabaseType): void {
	const version = getSchemaVersion(db);
	if (version === 0) {
		throw new Error(
			"Database schema is not initialized. " +
				"During Phase 1, the Python runtime must initialize the database first. " +
				"Run: uv run codemem stats",
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
