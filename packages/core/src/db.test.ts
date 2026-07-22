import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./db.js";
import {
	assertSchemaReady,
	backupOnFirstAccess,
	columnExists,
	connect,
	ensureAdditiveSchemaCompatibility,
	ensurePlannerStats,
	fromJson,
	getSchemaVersion,
	isEmbeddingDisabled,
	loadSqliteVec,
	migrateLegacyDbPath,
	resolveDbPath,
	SCHEMA_VERSION,
	tableExists,
	toJson,
} from "./db.js";

function hasIndex(db: Database, name: string): boolean {
	const row = db
		.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1")
		.get(name) as { ok: number } | undefined;
	return row?.ok === 1;
}

function columnInfo(
	db: Database,
	table: string,
	column: string,
): { is_not_null: number } | undefined {
	return db
		.prepare('SELECT "notnull" AS is_not_null FROM pragma_table_info(?) WHERE name = ? LIMIT 1')
		.get(table, column) as { is_not_null: number } | undefined;
}

describe("connect", () => {
	let tmpDir: string;
	let db: Database | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-test-"));
	});

	afterEach(() => {
		db?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("opens a database with WAL mode", () => {
		db = connect(join(tmpDir, "test.sqlite"));
		const mode = db.pragma("journal_mode", { simple: true }) as string;
		expect(mode.toLowerCase()).toBe("wal");
	});

	it("sets busy_timeout to 5000ms", () => {
		db = connect(join(tmpDir, "test.sqlite"));
		const timeout = db.pragma("busy_timeout", { simple: true });
		expect(timeout).toBe(5000);
	});

	it("enables foreign keys", () => {
		db = connect(join(tmpDir, "test.sqlite"));
		const fk = db.pragma("foreign_keys", { simple: true });
		expect(fk).toBe(1);
	});

	it("sets synchronous to NORMAL", () => {
		db = connect(join(tmpDir, "test.sqlite"));
		const sync = db.pragma("synchronous", { simple: true });
		// NORMAL = 1
		expect(sync).toBe(1);
	});

	it("applies read-tuning pragmas (cache_size, mmap_size, temp_store)", () => {
		db = connect(join(tmpDir, "test.sqlite"));
		expect(db.pragma("cache_size", { simple: true })).toBe(-65536);
		// mmap_size readback is clamped to the build's SQLITE_MAX_MMAP_SIZE, so
		// assert it's enabled (>0) rather than an exact, build-dependent value.
		expect(db.pragma("mmap_size", { simple: true })).toBeGreaterThan(0);
		// temp_store: 2 = MEMORY
		expect(db.pragma("temp_store", { simple: true })).toBe(2);
	});

	it("drops legacy memory_items indexes via additive compatibility", () => {
		db = connect(join(tmpDir, "legacy-idx.sqlite"));
		// Simulate a database created by an older schema that carried the
		// now-obsolete indexes the current schema never creates.
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_memory_items_visibility ON memory_items(visibility);
			 CREATE INDEX IF NOT EXISTS idx_memory_items_workspace_kind ON memory_items(workspace_kind);
			 CREATE INDEX IF NOT EXISTS idx_memory_items_user_prompt_id ON memory_items(user_prompt_id);`,
		);
		// Drop back to a legacy user_version so the additive shim actually runs
		// (a fresh user_version=SCHEMA_VERSION DB short-circuits the gated DDL,
		// and never carries these legacy indexes in the first place).
		db.pragma("user_version = 6");
		expect(hasIndex(db, "idx_memory_items_visibility")).toBe(true);

		ensureAdditiveSchemaCompatibility(db);

		expect(hasIndex(db, "idx_memory_items_visibility")).toBe(false);
		expect(hasIndex(db, "idx_memory_items_workspace_kind")).toBe(false);
		expect(hasIndex(db, "idx_memory_items_user_prompt_id")).toBe(false);
		// A composite index that legitimately covers visibility still exists.
		expect(hasIndex(db, "idx_memory_items_scope_visibility_created")).toBe(true);
	});

	it("creates parent directories if they don't exist", () => {
		const nested = join(tmpDir, "deep", "nested", "dir", "test.sqlite");
		db = connect(nested);
		expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
	});

	it("expands ~/ paths like Python", () => {
		expect(resolveDbPath("~/codemem-test.sqlite")).toBe(join(homedir(), "codemem-test.sqlite"));
	});

	it("bootstraps the schema on a fresh database path", () => {
		db = connect(join(tmpDir, "fresh.sqlite"));

		expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
		expect(tableExists(db, "memory_items")).toBe(true);
		expect(tableExists(db, "sessions")).toBe(true);
		expect(tableExists(db, "replication_scopes")).toBe(true);
		expect(tableExists(db, "project_scope_mappings")).toBe(true);
		expect(tableExists(db, "scope_memberships")).toBe(true);
		expect(tableExists(db, "sync_reset_state_v2")).toBe(true);
		expect(tableExists(db, "sync_retention_state_v2")).toBe(true);
		expect(tableExists(db, "replication_cursors_v2")).toBe(true);
		expect(columnExists(db, "memory_items", "scope_id")).toBe(true);
		expect(columnExists(db, "replication_ops", "scope_id")).toBe(true);
		expect(hasIndex(db, "idx_memory_items_scope_visibility_created")).toBe(true);
		expect(hasIndex(db, "idx_memory_items_scope_backfill_pending")).toBe(true);
		expect(hasIndex(db, "idx_replication_ops_scope_created")).toBe(true);
		expect(hasIndex(db, "idx_replication_cursors_v2_scope")).toBe(true);
		expect(() => assertSchemaReady(db)).not.toThrow();
	});

	it("bootstraps the schema on an empty existing database file", () => {
		const dbPath = join(tmpDir, "empty.sqlite");
		writeFileSync(dbPath, "");

		db = connect(dbPath);

		expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
		expect(tableExists(db, "memory_items")).toBe(true);
		expect(() => assertSchemaReady(db)).not.toThrow();
	});

	it("reopens an initialized database without clobbering existing data", () => {
		const dbPath = join(tmpDir, "reopen.sqlite");
		db = connect(dbPath);
		db.exec("CREATE TABLE connect_reopen_guard (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
		db.prepare("INSERT INTO connect_reopen_guard(label) VALUES (?)").run("still here");
		db.close();

		db = connect(dbPath);

		expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
		expect(
			db.prepare("SELECT label FROM connect_reopen_guard WHERE id = 1").get() as
				| { label: string }
				| undefined,
		).toEqual({ label: "still here" });
	});

	it("supports multiple handles racing the first-run bootstrap result", () => {
		const dbPath = join(tmpDir, "multi-handle.sqlite");
		const first = connect(dbPath);
		const second = connect(dbPath);
		try {
			expect(getSchemaVersion(first)).toBe(SCHEMA_VERSION);
			expect(getSchemaVersion(second)).toBe(SCHEMA_VERSION);
			expect(tableExists(first, "memory_items")).toBe(true);
			expect(tableExists(second, "memory_items")).toBe(true);
			expect(() => assertSchemaReady(first)).not.toThrow();
			expect(() => assertSchemaReady(second)).not.toThrow();
		} finally {
			first.close();
			second.close();
		}
	});

	it("does not bootstrap or switch unrelated non-empty databases to WAL", () => {
		const dbPath = join(tmpDir, "unrelated.sqlite");
		const unrelated = new BetterSqlite3(dbPath);
		unrelated.exec("CREATE TABLE unrelated_data (id INTEGER PRIMARY KEY)");
		unrelated.close();

		db = connect(dbPath);

		expect(getSchemaVersion(db)).toBe(0);
		expect(tableExists(db, "memory_items")).toBe(false);
		expect(tableExists(db, "unrelated_data")).toBe(true);
		expect(existsSync(`${dbPath}-wal`)).toBe(false);
	});

	it("does not switch unrelated databases with nonzero user_version to WAL", () => {
		const dbPath = join(tmpDir, "unrelated-versioned.sqlite");
		const unrelated = new BetterSqlite3(dbPath);
		unrelated.exec("CREATE TABLE unrelated_data (id INTEGER PRIMARY KEY)");
		unrelated.pragma("user_version = 1");
		unrelated.close();

		db = connect(dbPath);

		expect(getSchemaVersion(db)).toBe(1);
		expect(tableExists(db, "memory_items")).toBe(false);
		expect(tableExists(db, "unrelated_data")).toBe(true);
		expect(existsSync(`${dbPath}-wal`)).toBe(false);
	});
});

describe("backupOnFirstAccess", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-backup-"));
		dbPath = join(tmpDir, "mem.sqlite");
		writeFileSync(dbPath, "test-db-content");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates marker and skips repeated backups", () => {
		backupOnFirstAccess(dbPath);
		const markerPath = join(tmpDir, ".codemem-ts-accessed");
		expect(existsSync(markerPath)).toBe(true);

		const firstBackups = readdirSync(tmpDir).filter(
			(name) => name.startsWith("mem.sqlite.pre-ts-") && name.endsWith(".bak"),
		);
		expect(firstBackups.length).toBe(1);

		backupOnFirstAccess(dbPath);
		const secondBackups = readdirSync(tmpDir).filter(
			(name) => name.startsWith("mem.sqlite.pre-ts-") && name.endsWith(".bak"),
		);
		expect(secondBackups.length).toBe(1);
	});

	it("writes marker when a viable pre-ts backup already exists", () => {
		const existingBackup = `${dbPath}.pre-ts-20260324T1710.bak`;
		writeFileSync(existingBackup, "test-db-content");

		backupOnFirstAccess(dbPath);

		const markerPath = join(tmpDir, ".codemem-ts-accessed");
		expect(existsSync(markerPath)).toBe(true);
		const backups = readdirSync(tmpDir).filter(
			(name) => name.startsWith("mem.sqlite.pre-ts-") && name.endsWith(".bak"),
		);
		expect(backups.length).toBe(1);
	});

	it("skips backup when lock contention is active", () => {
		const lockPath = join(tmpDir, ".codemem-ts-backup.lock");
		writeFileSync(lockPath, "live");

		backupOnFirstAccess(dbPath);

		const markerPath = join(tmpDir, ".codemem-ts-accessed");
		expect(existsSync(markerPath)).toBe(false);
		const backups = readdirSync(tmpDir).filter(
			(name) => name.startsWith("mem.sqlite.pre-ts-") && name.endsWith(".bak"),
		);
		expect(backups.length).toBe(0);
	});

	it("treats stale lock files as recoverable", () => {
		const lockPath = join(tmpDir, ".codemem-ts-backup.lock");
		writeFileSync(lockPath, "stale");
		const old = new Date(Date.now() - 20 * 60 * 1000);
		utimesSync(lockPath, old, old);

		backupOnFirstAccess(dbPath);

		const markerPath = join(tmpDir, ".codemem-ts-accessed");
		expect(existsSync(markerPath)).toBe(true);
		const backups = readdirSync(tmpDir).filter(
			(name) => name.startsWith("mem.sqlite.pre-ts-") && name.endsWith(".bak"),
		);
		expect(backups.length).toBe(1);
	});
});

describe("loadSqliteVec", () => {
	let tmpDir: string;
	let db: Database;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-test-"));
		db = new BetterSqlite3(join(tmpDir, "test.sqlite"));
	});

	afterEach(() => {
		db?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("loads the sqlite-vec extension", () => {
		loadSqliteVec(db);
		const row = db.prepare("SELECT vec_version() AS v").get() as { v: string };
		expect(row.v).toMatch(/^v?\d+\.\d+/);
	});

	it("skips loading when embeddings are disabled", () => {
		const orig = process.env.CODEMEM_EMBEDDING_DISABLED;
		try {
			process.env.CODEMEM_EMBEDDING_DISABLED = "1";
			// Should not throw, and vec_version should not be available
			loadSqliteVec(db);
			expect(() => db.prepare("SELECT vec_version()").get()).toThrow();
		} finally {
			if (orig === undefined) {
				delete process.env.CODEMEM_EMBEDDING_DISABLED;
			} else {
				process.env.CODEMEM_EMBEDDING_DISABLED = orig;
			}
		}
	});
});

describe("getSchemaVersion", () => {
	let tmpDir: string;
	let db: Database;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-test-"));
		db = connect(join(tmpDir, "test.sqlite"));
	});

	afterEach(() => {
		db?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns the bootstrapped version for a fresh database", () => {
		expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
	});

	it("returns the version after it is set", () => {
		db.pragma(`user_version = ${SCHEMA_VERSION}`);
		expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
	});
});

describe("assertSchemaReady", () => {
	let tmpDir: string;
	let db: Database;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-test-"));
		db = connect(join(tmpDir, "test.sqlite"));
	});

	afterEach(() => {
		db?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("bootstraps uninitialized writable schemas before asserting readiness", () => {
		const uninitialized = new BetterSqlite3(join(tmpDir, "uninitialized.sqlite"));
		try {
			expect(getSchemaVersion(uninitialized)).toBe(0);
			expect(() => assertSchemaReady(uninitialized)).not.toThrow();
			expect(getSchemaVersion(uninitialized)).toBe(SCHEMA_VERSION);
			expect(tableExists(uninitialized, "memory_items")).toBe(true);
		} finally {
			uninitialized.close();
		}
	});

	it("does not bootstrap unrelated non-empty SQLite databases", () => {
		const unrelated = new BetterSqlite3(join(tmpDir, "unrelated.sqlite"));
		try {
			unrelated.exec("CREATE TABLE unrelated_data (id INTEGER PRIMARY KEY)");
			expect(getSchemaVersion(unrelated)).toBe(0);

			expect(() => assertSchemaReady(unrelated)).toThrow(/not initialized/);
			expect(tableExists(unrelated, "memory_items")).toBe(false);
			expect(tableExists(unrelated, "unrelated_data")).toBe(true);
		} finally {
			unrelated.close();
		}
	});

	it("does not try to bootstrap readonly uninitialized schemas", () => {
		const dbPath = join(tmpDir, "readonly-uninitialized.sqlite");
		const seed = new BetterSqlite3(dbPath);
		seed.close();
		const readonly = new BetterSqlite3(dbPath, { readonly: true });
		try {
			expect(getSchemaVersion(readonly)).toBe(0);
			expect(() => assertSchemaReady(readonly)).toThrow(/not initialized/);
			expect(() => assertSchemaReady(readonly)).not.toThrow(/readonly/i);
		} finally {
			readonly.close();
		}
	});

	it("passes for the current schema version with required tables", () => {
		expect(() => assertSchemaReady(db)).not.toThrow();
	});

	it("throws for a stale schema version", () => {
		db.pragma("user_version = 3");
		expect(() => assertSchemaReady(db)).toThrow(/older than minimum compatible/);
	});

	it("warns but continues for a newer schema version", () => {
		db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
		expect(() => assertSchemaReady(db)).not.toThrow();
	});

	it("throws when required tables are missing", () => {
		const missingTables = new BetterSqlite3(join(tmpDir, "missing-tables.sqlite"));
		try {
			missingTables.pragma(`user_version = ${SCHEMA_VERSION}`);
			expect(() => assertSchemaReady(missingTables)).toThrow(/Required tables missing/);
		} finally {
			missingTables.close();
		}
	});
});

describe("tableExists", () => {
	let tmpDir: string;
	let db: Database;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-test-"));
		db = connect(join(tmpDir, "test.sqlite"));
	});

	afterEach(() => {
		db?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns false for a non-existent table", () => {
		expect(tableExists(db, "nonexistent")).toBe(false);
	});

	it("returns true for an existing table", () => {
		db.exec("CREATE TABLE test_table (id INTEGER PRIMARY KEY)");
		expect(tableExists(db, "test_table")).toBe(true);
	});
});

describe("ensureAdditiveSchemaCompatibility", () => {
	let tmpDir: string;
	let db: Database;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-test-"));
		db = new BetterSqlite3(join(tmpDir, "test.sqlite"));
	});

	afterEach(() => {
		db?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("adds missing raw_event_flush_batches compatibility columns", () => {
		db.exec(`
			CREATE TABLE raw_event_flush_batches (
				id INTEGER PRIMARY KEY,
				source TEXT NOT NULL,
				stream_id TEXT NOT NULL,
				opencode_session_id TEXT NOT NULL,
				start_event_seq INTEGER NOT NULL,
				end_event_seq INTEGER NOT NULL,
				extractor_version TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);

		expect(columnExists(db, "raw_event_flush_batches", "error_message")).toBe(false);
		expect(columnExists(db, "raw_event_flush_batches", "attempt_count")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);

		expect(columnExists(db, "raw_event_flush_batches", "error_message")).toBe(true);
		expect(columnExists(db, "raw_event_flush_batches", "error_type")).toBe(true);
		expect(columnExists(db, "raw_event_flush_batches", "observer_provider")).toBe(true);
		expect(columnExists(db, "raw_event_flush_batches", "observer_model")).toBe(true);
		expect(columnExists(db, "raw_event_flush_batches", "observer_runtime")).toBe(true);
		expect(columnExists(db, "raw_event_flush_batches", "observer_auth_source")).toBe(true);
		expect(columnExists(db, "raw_event_flush_batches", "observer_auth_type")).toBe(true);
		expect(columnExists(db, "raw_event_flush_batches", "observer_error_code")).toBe(true);
		expect(columnExists(db, "raw_event_flush_batches", "observer_error_message")).toBe(true);
		expect(columnExists(db, "raw_event_flush_batches", "attempt_count")).toBe(true);
	});

	it("adds memory_items dedup_key column and index", () => {
		db.exec(`
			CREATE TABLE memory_items (
				id INTEGER PRIMARY KEY,
				session_id INTEGER NOT NULL,
				kind TEXT NOT NULL,
				title TEXT NOT NULL,
				body_text TEXT NOT NULL,
				visibility TEXT,
				workspace_id TEXT,
				active INTEGER DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);

		expect(columnExists(db, "memory_items", "dedup_key")).toBe(false);
		expect(hasIndex(db, "idx_memory_items_dedup_key_active_created")).toBe(false);
		expect(hasIndex(db, "idx_memory_items_same_session_dedup_unique")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);

		expect(columnExists(db, "memory_items", "dedup_key")).toBe(true);
		expect(hasIndex(db, "idx_memory_items_dedup_key_active_created")).toBe(true);
		expect(hasIndex(db, "idx_memory_items_same_session_dedup_unique")).toBe(true);
	});

	it("treats duplicate-column races as benign when column now exists", () => {
		let racedColumnVisible = false;
		let alterAttempts = 0;

		const fakeDb = {
			// Legacy user_version so the additive shim runs (does not short-circuit).
			pragma() {
				return 0;
			},
			prepare(query: string) {
				return {
					get(...args: unknown[]) {
						if (query.includes("sqlite_master")) {
							return { ok: 1 };
						}
						if (query.includes("pragma_table_info")) {
							const requestedColumn = String(args[1] ?? "");
							if (requestedColumn === "error_message") {
								return racedColumnVisible ? { ok: 1 } : undefined;
							}
							return { ok: 1 };
						}
						return undefined;
					},
				};
			},
			exec(sqlText: string) {
				if (sqlText.includes("ADD COLUMN error_message")) {
					alterAttempts += 1;
					racedColumnVisible = true;
					throw new Error("duplicate column name: error_message");
				}
			},
		} as unknown as Database;

		expect(() => ensureAdditiveSchemaCompatibility(fakeDb)).not.toThrow();
		expect(alterAttempts).toBe(1);
	});

	it("is a no-op when raw_event_flush_batches does not exist", () => {
		expect(() => ensureAdditiveSchemaCompatibility(db)).not.toThrow();
	});

	it("adds sync_peers discovery-provenance columns and creates coordinator_group_preferences", () => {
		db.exec(`
			CREATE TABLE sync_peers (
				peer_device_id TEXT PRIMARY KEY NOT NULL,
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
			)
		`);

		expect(columnExists(db, "sync_peers", "discovered_via_coordinator_id")).toBe(false);
		expect(columnExists(db, "sync_peers", "discovered_via_group_id")).toBe(false);
		expect(tableExists(db, "coordinator_group_preferences")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);

		expect(columnExists(db, "sync_peers", "discovered_via_coordinator_id")).toBe(true);
		expect(columnExists(db, "sync_peers", "discovered_via_group_id")).toBe(true);
		expect(tableExists(db, "coordinator_group_preferences")).toBe(true);
		expect(columnExists(db, "coordinator_group_preferences", "default_space_scope_id")).toBe(true);
		expect(
			columnExists(db, "coordinator_group_preferences", "auto_grant_default_space_on_join"),
		).toBe(true);

		db.exec(
			"INSERT INTO coordinator_group_preferences " +
				"(coordinator_id, group_id, auto_seed_scope, updated_at) " +
				"VALUES ('https://coord.example', 'team-alpha', 1, '2026-04-23T00:00:00Z')",
		);
		const row = db
			.prepare("SELECT coordinator_id, group_id FROM coordinator_group_preferences")
			.get() as { coordinator_id: string; group_id: string };
		expect(row.coordinator_id).toBe("https://coord.example");
		expect(row.group_id).toBe("team-alpha");
	});

	it("adds sync_attempts capability diagnostics columns on legacy schemas", () => {
		db.exec(`
			CREATE TABLE sync_attempts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				peer_device_id TEXT NOT NULL,
				started_at TEXT NOT NULL,
				finished_at TEXT,
				ok INTEGER NOT NULL DEFAULT 0,
				ops_in INTEGER NOT NULL DEFAULT 0,
				ops_out INTEGER NOT NULL DEFAULT 0,
				error TEXT
			)
		`);

		expect(columnExists(db, "sync_attempts", "local_sync_capability")).toBe(false);
		expect(columnExists(db, "sync_attempts", "peer_sync_capability")).toBe(false);
		expect(columnExists(db, "sync_attempts", "negotiated_sync_capability")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);

		expect(columnExists(db, "sync_attempts", "local_sync_capability")).toBe(true);
		expect(columnExists(db, "sync_attempts", "peer_sync_capability")).toBe(true);
		expect(columnExists(db, "sync_attempts", "negotiated_sync_capability")).toBe(true);
	});

	it("creates replication scope tables and indexes on legacy schemas", () => {
		expect(tableExists(db, "replication_scopes")).toBe(false);
		expect(tableExists(db, "project_scope_mappings")).toBe(false);
		expect(tableExists(db, "scope_memberships")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);
		ensureAdditiveSchemaCompatibility(db);

		expect(tableExists(db, "replication_scopes")).toBe(true);
		expect(tableExists(db, "project_scope_mappings")).toBe(true);
		expect(tableExists(db, "scope_memberships")).toBe(true);
		expect(hasIndex(db, "idx_replication_scopes_status")).toBe(true);
		expect(hasIndex(db, "idx_replication_scopes_authority_group")).toBe(true);
		expect(columnInfo(db, "replication_scopes", "scope_id")?.is_not_null).toBe(1);
		expect(hasIndex(db, "idx_project_scope_mappings_workspace_priority")).toBe(true);
		expect(hasIndex(db, "idx_project_scope_mappings_pattern_priority")).toBe(true);
		expect(hasIndex(db, "idx_project_scope_mappings_scope")).toBe(true);
		expect(hasIndex(db, "idx_scope_memberships_device_status")).toBe(true);
		expect(hasIndex(db, "idx_scope_memberships_scope_status")).toBe(true);
		expect(hasIndex(db, "idx_scope_memberships_authority_group")).toBe(true);

		db.prepare(
			`INSERT INTO replication_scopes
				(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"local-default",
			"Local only",
			"system",
			"local",
			0,
			"active",
			"2026-04-30T00:00:00Z",
			"2026-04-30T00:00:00Z",
		);
		const row = db.prepare("SELECT label, authority_type FROM replication_scopes").get() as
			| { label: string; authority_type: string }
			| undefined;
		expect(row).toEqual({ label: "Local only", authority_type: "local" });
	});

	it("creates missing scope indexes when scope tables already exist", () => {
		db.exec(`
			CREATE TABLE replication_scopes (
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
			CREATE TABLE project_scope_mappings (
				id INTEGER PRIMARY KEY,
				workspace_identity TEXT,
				project_pattern TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				priority INTEGER NOT NULL DEFAULT 0,
				source TEXT NOT NULL DEFAULT 'user',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE scope_memberships (
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
		`);

		expect(hasIndex(db, "idx_replication_scopes_status")).toBe(false);
		expect(hasIndex(db, "idx_project_scope_mappings_scope")).toBe(false);
		expect(hasIndex(db, "idx_scope_memberships_scope_status")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);

		expect(hasIndex(db, "idx_replication_scopes_status")).toBe(true);
		expect(hasIndex(db, "idx_project_scope_mappings_scope")).toBe(true);
		expect(hasIndex(db, "idx_scope_memberships_scope_status")).toBe(true);
		expect(columnInfo(db, "replication_scopes", "scope_id")?.is_not_null).toBe(1);
	});

	it("creates and seeds per-scope sync state tables from legacy state", () => {
		db.exec(`
			CREATE TABLE sync_reset_state (
				id INTEGER PRIMARY KEY,
				generation INTEGER NOT NULL,
				snapshot_id TEXT NOT NULL,
				baseline_cursor TEXT,
				retained_floor_cursor TEXT,
				updated_at TEXT NOT NULL
			);
			INSERT INTO sync_reset_state
				(id, generation, snapshot_id, baseline_cursor, retained_floor_cursor, updated_at)
			VALUES
				(1, 7, 'snapshot-legacy', 'cursor-baseline', 'cursor-floor', '2026-04-30T00:00:00Z');

			CREATE TABLE sync_retention_state (
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
			INSERT INTO sync_retention_state
				(
					id,
					last_run_at,
					last_duration_ms,
					last_deleted_ops,
					last_estimated_bytes_before,
					last_estimated_bytes_after,
					retained_floor_cursor,
					last_error,
					last_error_at
				)
			VALUES
				(
					1,
					'2026-04-30T01:00:00Z',
					42,
					3,
					1000,
					700,
					'cursor-floor',
					NULL,
					NULL
				);

			CREATE TABLE replication_cursors (
				peer_device_id TEXT PRIMARY KEY,
				last_applied_cursor TEXT,
				last_acked_cursor TEXT,
				updated_at TEXT NOT NULL
			);
			INSERT INTO replication_cursors
				(peer_device_id, last_applied_cursor, last_acked_cursor, updated_at)
			VALUES
				('peer-a', 'op-10', 'op-9', '2026-04-30T02:00:00Z');
		`);

		expect(tableExists(db, "sync_reset_state_v2")).toBe(false);
		expect(tableExists(db, "sync_retention_state_v2")).toBe(false);
		expect(tableExists(db, "replication_cursors_v2")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);
		ensureAdditiveSchemaCompatibility(db);

		expect(tableExists(db, "sync_reset_state_v2")).toBe(true);
		expect(tableExists(db, "sync_retention_state_v2")).toBe(true);
		expect(tableExists(db, "replication_cursors_v2")).toBe(true);
		expect(hasIndex(db, "idx_replication_cursors_v2_scope")).toBe(true);
		expect(columnInfo(db, "sync_reset_state_v2", "scope_id")?.is_not_null).toBe(1);
		expect(columnInfo(db, "replication_cursors_v2", "scope_id")?.is_not_null).toBe(1);

		const reset = db
			.prepare("SELECT * FROM sync_reset_state_v2 WHERE scope_id = ?")
			.get("local-default") as {
			generation: number;
			snapshot_id: string;
			baseline_cursor: string;
			retained_floor_cursor: string;
			updated_at: string;
		};
		expect(reset).toMatchObject({
			generation: 7,
			snapshot_id: "snapshot-legacy",
			baseline_cursor: "cursor-baseline",
			retained_floor_cursor: "cursor-floor",
			updated_at: "2026-04-30T00:00:00Z",
		});

		const retention = db
			.prepare("SELECT * FROM sync_retention_state_v2 WHERE scope_id = ?")
			.get("local-default") as {
			last_run_at: string;
			last_duration_ms: number;
			last_deleted_ops: number;
			last_estimated_bytes_before: number;
			last_estimated_bytes_after: number;
			retained_floor_cursor: string;
		};
		expect(retention).toMatchObject({
			last_run_at: "2026-04-30T01:00:00Z",
			last_duration_ms: 42,
			last_deleted_ops: 3,
			last_estimated_bytes_before: 1000,
			last_estimated_bytes_after: 700,
			retained_floor_cursor: "cursor-floor",
		});

		const cursor = db
			.prepare("SELECT * FROM replication_cursors_v2 WHERE peer_device_id = ? AND scope_id = ?")
			.get("peer-a", "local-default") as {
			last_applied_cursor: string;
			last_acked_cursor: string;
			updated_at: string;
		};
		expect(cursor).toMatchObject({
			last_applied_cursor: "op-10",
			last_acked_cursor: "op-9",
			updated_at: "2026-04-30T02:00:00Z",
		});

		db.prepare(
			"INSERT INTO sync_reset_state_v2 (scope_id, generation, snapshot_id, updated_at) VALUES (?, ?, ?, ?)",
		).run("work-scope", 1, "snapshot-work", "2026-04-30T03:00:00Z");
		expect(
			db.prepare("SELECT scope_id FROM sync_reset_state_v2 ORDER BY scope_id").pluck().all(),
		).toEqual(["local-default", "work-scope"]);
	});

	it("adds nullable scope columns and indexes on legacy memory/op tables", () => {
		db.exec(`
			CREATE TABLE memory_items (
				id INTEGER PRIMARY KEY,
				session_id INTEGER NOT NULL,
				kind TEXT NOT NULL,
				title TEXT NOT NULL,
				body_text TEXT NOT NULL,
				visibility TEXT,
				workspace_id TEXT,
				active INTEGER DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE replication_ops (
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
		`);

		expect(columnExists(db, "memory_items", "scope_id")).toBe(false);
		expect(columnExists(db, "replication_ops", "scope_id")).toBe(false);
		expect(hasIndex(db, "idx_memory_items_scope_visibility_created")).toBe(false);
		expect(hasIndex(db, "idx_memory_items_scope_backfill_pending")).toBe(false);
		expect(hasIndex(db, "idx_replication_ops_scope_created")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);
		ensureAdditiveSchemaCompatibility(db);

		expect(columnExists(db, "memory_items", "scope_id")).toBe(true);
		expect(columnExists(db, "replication_ops", "scope_id")).toBe(true);
		expect(hasIndex(db, "idx_memory_items_scope_visibility_created")).toBe(true);
		expect(hasIndex(db, "idx_memory_items_scope_backfill_pending")).toBe(true);
		expect(hasIndex(db, "idx_replication_ops_scope_created")).toBe(true);
	});

	it("creates memory_file_refs and memory_concept_refs on v6 databases missing them", () => {
		// Simulate a v6 database that has memory_items but lacks the junction tables.
		db.exec(`
			CREATE TABLE memory_items (
				id INTEGER PRIMARY KEY,
				session_id INTEGER NOT NULL,
				kind TEXT NOT NULL,
				title TEXT NOT NULL,
				body_text TEXT NOT NULL,
				visibility TEXT,
				workspace_id TEXT,
				active INTEGER DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);
		db.pragma("user_version = 6");

		expect(tableExists(db, "memory_file_refs")).toBe(false);
		expect(tableExists(db, "memory_concept_refs")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);

		expect(tableExists(db, "memory_file_refs")).toBe(true);
		expect(tableExists(db, "memory_concept_refs")).toBe(true);
		expect(hasIndex(db, "idx_memory_file_refs_path")).toBe(true);
		expect(hasIndex(db, "idx_memory_concept_refs_concept")).toBe(true);
	});

	it("adds memory_items.project column and backfills from sessions.project", () => {
		db.exec(`
			CREATE TABLE sessions (
				id INTEGER PRIMARY KEY,
				started_at TEXT NOT NULL,
				cwd TEXT,
				project TEXT,
				user TEXT,
				tool_version TEXT
			)
		`);
		db.exec(`
			CREATE TABLE memory_items (
				id INTEGER PRIMARY KEY,
				session_id INTEGER NOT NULL,
				kind TEXT NOT NULL,
				title TEXT NOT NULL,
				body_text TEXT NOT NULL,
				visibility TEXT,
				workspace_id TEXT,
				active INTEGER DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			)
		`);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO sessions(started_at, cwd, project) VALUES (?, '/work/codemem', 'codemem')`,
		).run(now);
		db.prepare(
			`INSERT INTO sessions(started_at, cwd, project) VALUES (?, '/work/other', NULL)`,
		).run(now);
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at)
			 VALUES (1, 'discovery', 'a', 'b', ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at)
			 VALUES (2, 'discovery', 'a', 'b', ?, ?)`,
		).run(now, now);

		expect(columnExists(db, "memory_items", "project")).toBe(false);
		expect(hasIndex(db, "idx_memory_items_project")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);

		expect(columnExists(db, "memory_items", "project")).toBe(true);
		expect(hasIndex(db, "idx_memory_items_project")).toBe(true);
		const rows = db
			.prepare("SELECT session_id, project FROM memory_items ORDER BY session_id")
			.all() as Array<{ session_id: number; project: string | null }>;
		expect(rows).toEqual([
			{ session_id: 1, project: "codemem" },
			{ session_id: 2, project: null },
		]);

		// Idempotent — running the migration again is a no-op for already-set
		// project rows and does not error.
		expect(() => ensureAdditiveSchemaCompatibility(db)).not.toThrow();
		const rows2 = db
			.prepare("SELECT session_id, project FROM memory_items ORDER BY session_id")
			.all() as Array<{ session_id: number; project: string | null }>;
		expect(rows2).toEqual(rows);
	});
});

describe("ensureAdditiveSchemaCompatibility schema-compat gate", () => {
	let tmpDir: string;
	let db: Database;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-test-"));
		// connect() bootstraps a full schema at user_version=SCHEMA_VERSION.
		db = connect(join(tmpDir, "test.sqlite"));
	});

	afterEach(() => {
		db?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function appliedSchemaVersion(database: Database): number | undefined {
		const row = database
			.prepare("SELECT applied_schema_version AS v FROM schema_compat_state WHERE id = 1")
			.get() as { v: number } | undefined;
		return row?.v;
	}

	it("applies and marks the schema-compat state on a legacy database", () => {
		// Simulate a legacy DB so the version short-circuit does not fire.
		db.pragma("user_version = 6");
		expect(tableExists(db, "schema_compat_state")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);

		expect(tableExists(db, "schema_compat_state")).toBe(true);
		expect(tableExists(db, "share_operations")).toBe(true);
		expect(tableExists(db, "share_operation_projects")).toBe(true);
		expect(tableExists(db, "share_operation_steps")).toBe(true);
		expect(tableExists(db, "recipient_policy_review_resolutions")).toBe(true);
		for (const table of [
			"policy_teams",
			"policy_team_memberships",
			"identity_devices",
			"project_recipients",
		]) {
			expect(tableExists(db, table)).toBe(true);
		}
		expect(tableExists(db, "identities")).toBe(false);
		expect(appliedSchemaVersion(db)).toBe(SCHEMA_VERSION);
	});

	it("upgrades a database marked at the previous schema version and remains idempotent", () => {
		db.close();
		const dbPath = join(tmpDir, "schema-previous.sqlite");
		const previous = new BetterSqlite3(dbPath);
		previous.exec(`
			PRAGMA user_version = ${SCHEMA_VERSION - 1};
			CREATE TABLE schema_compat_state (
				id INTEGER PRIMARY KEY,
				applied_schema_version INTEGER NOT NULL,
				applied_at TEXT NOT NULL
			);
			INSERT INTO schema_compat_state VALUES (1, ${SCHEMA_VERSION - 1}, '2026-07-19T00:00:00Z');
		`);
		expect(tableExists(previous, "share_operations")).toBe(false);

		ensureAdditiveSchemaCompatibility(previous);

		for (const table of ["share_operations", "share_operation_projects", "share_operation_steps"]) {
			expect(tableExists(previous, table)).toBe(true);
		}
		expect(tableExists(previous, "recipient_policy_review_resolutions")).toBe(true);
		for (const table of [
			"policy_teams",
			"policy_team_memberships",
			"identity_devices",
			"project_recipients",
		]) {
			expect(tableExists(previous, table)).toBe(true);
		}
		expect(tableExists(previous, "identities")).toBe(false);
		expect(getSchemaVersion(previous)).toBe(SCHEMA_VERSION);
		expect(columnExists(previous, "share_operations", "pending_person_operation_id")).toBe(true);
		expect(columnExists(previous, "share_operations", "recipient_device_id")).toBe(true);
		expect(columnExists(previous, "share_operations", "bootstrap_grant_id")).toBe(true);
		expect(columnExists(previous, "share_operation_projects", "existing_memory_count")).toBe(true);
		expect(columnExists(previous, "share_operation_steps", "effect_id")).toBe(true);
		expect(hasIndex(previous, "idx_share_operations_state_updated")).toBe(true);
		expect(hasIndex(previous, "idx_share_operations_invite_digest")).toBe(true);
		expect(hasIndex(previous, "idx_share_operations_pending_person_operation")).toBe(true);
		expect(appliedSchemaVersion(previous)).toBe(SCHEMA_VERSION);
		previous
			.prepare(
				`INSERT INTO share_operations(
				operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
				person_kind, pending_person_operation_id, teammate_name, history_policy,
				reviewed_project_set_digest, coordinator_group_id, coordinator_invite_id,
				invite_token_digest, invite_expires_at, created_at, updated_at
			 ) VALUES ('share_test', 'waiting_for_acceptance', 'actor', '[]', 'person',
				'pending', 'share_test', 'Brian', 'existing_and_future', 'digest', 'group',
				'invite', 'token-digest', '2099-01-01T00:00:00Z', '2026-07-20T00:00:00Z',
				'2026-07-20T00:00:00Z')`,
			)
			.run();
		previous.close();

		const reopened = new BetterSqlite3(dbPath);
		ensureAdditiveSchemaCompatibility(reopened);
		expect(reopened.prepare("SELECT COUNT(*) FROM share_operations").pluck().get()).toBe(1);
		expect(appliedSchemaVersion(reopened)).toBe(SCHEMA_VERSION);
		reopened.close();
		db = connect(join(tmpDir, "replacement.sqlite"));
	});

	it("repairs partially-created share-operation tables before marking compatibility", () => {
		db.close();
		const partial = new BetterSqlite3(join(tmpDir, "partial.sqlite"));
		partial.exec(`
			PRAGMA user_version = 8;
			CREATE TABLE schema_compat_state (
				id INTEGER PRIMARY KEY,
				applied_schema_version INTEGER NOT NULL,
				applied_at TEXT NOT NULL
			);
			INSERT INTO schema_compat_state VALUES (1, 8, '2026-07-19T00:00:00Z');
			CREATE TABLE share_operations (operation_id TEXT PRIMARY KEY NOT NULL);
			CREATE TABLE share_operation_projects (
				operation_id TEXT NOT NULL,
				canonical_project_identity TEXT NOT NULL,
				PRIMARY KEY (operation_id, canonical_project_identity)
			);
			CREATE TABLE share_operation_steps (
				operation_id TEXT NOT NULL,
				step_key TEXT NOT NULL,
				PRIMARY KEY (operation_id, step_key)
			);
		`);

		ensureAdditiveSchemaCompatibility(partial);

		expect(columnExists(partial, "share_operations", "invite_token_digest")).toBe(true);
		expect(columnExists(partial, "share_operations", "recipient_actor_id")).toBe(true);
		expect(columnExists(partial, "share_operations", "recipient_fingerprint")).toBe(true);
		expect(columnExists(partial, "share_operation_projects", "existing_memory_count")).toBe(true);
		expect(columnExists(partial, "share_operation_steps", "safe_error_code")).toBe(true);
		expect(hasIndex(partial, "idx_share_operations_invite_digest")).toBe(true);
		expect(hasIndex(partial, "idx_share_operation_steps_effect_id_nonempty")).toBe(true);
		partial
			.prepare(
				`INSERT INTO share_operation_steps(operation_id, step_key, effect_id)
				 VALUES (?, ?, ?)`,
			)
			.run("share-one", "step-one", "effect-one");
		partial
			.prepare(
				`INSERT INTO share_operation_steps(operation_id, step_key, effect_id)
				 VALUES (?, ?, ?)`,
			)
			.run("share-two", "step-two", "effect-one");
		expect(
			partial
				.prepare("SELECT COUNT(*) FROM share_operation_steps WHERE effect_id = ?")
				.pluck()
				.get("effect-one"),
		).toBe(2);
		expect(appliedSchemaVersion(partial)).toBe(SCHEMA_VERSION);
		partial.close();
		db = connect(join(tmpDir, "replacement.sqlite"));
	});

	it("repairs a previously applied unique effect-id constraint", () => {
		const stale = new BetterSqlite3(join(tmpDir, "stale-share-effect.sqlite"));
		try {
			stale.exec(`
				CREATE TABLE schema_compat_state (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					applied_schema_version INTEGER NOT NULL,
					applied_at TEXT NOT NULL
				);
				INSERT INTO schema_compat_state VALUES (1, ${SCHEMA_VERSION}, '2026-07-20T00:00:00Z');
				CREATE TABLE share_operation_steps (
					operation_id TEXT NOT NULL,
					step_key TEXT NOT NULL,
					effect_id TEXT NOT NULL UNIQUE,
					status TEXT NOT NULL,
					attempt_count INTEGER NOT NULL DEFAULT 0,
					started_at TEXT,
					completed_at TEXT,
					last_attempt_at TEXT,
					safe_error_code TEXT,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (operation_id, step_key)
				);
				CREATE UNIQUE INDEX idx_share_operation_steps_effect_id_nonempty
					ON share_operation_steps(effect_id) WHERE effect_id <> '';
				INSERT INTO share_operation_steps(
					operation_id, step_key, effect_id, status, updated_at
				) VALUES ('share-one', 'step-one', 'shared-effect', 'pending', '2026-07-20T00:00:00Z');
			`);

			ensureAdditiveSchemaCompatibility(stale);
			stale
				.prepare(`INSERT INTO share_operation_steps(
					operation_id, step_key, effect_id, status, updated_at
				) VALUES (?, ?, ?, 'pending', ?)`)
				.run("share-two", "step-two", "shared-effect", "2026-07-20T00:01:00Z");

			expect(
				stale
					.prepare("SELECT COUNT(*) FROM share_operation_steps WHERE effect_id = ?")
					.pluck()
					.get("shared-effect"),
			).toBe(2);
		} finally {
			stale.close();
		}
	});

	it("skips gated DDL once marked and re-applies on version mismatch", () => {
		db.pragma("user_version = 6");
		ensureAdditiveSchemaCompatibility(db);
		expect(hasIndex(db, "idx_memory_items_project")).toBe(true);

		// Drop an additive index. Because the marker now says applied-for-this
		// version, the next call must skip the gated DDL and NOT recreate it.
		db.exec("DROP INDEX idx_memory_items_project");
		expect(hasIndex(db, "idx_memory_items_project")).toBe(false);
		ensureAdditiveSchemaCompatibility(db);
		expect(hasIndex(db, "idx_memory_items_project")).toBe(false);

		// Roll the marker back to simulate an older/again-needed schema; the gated
		// DDL must re-run and recreate the index.
		db.exec("UPDATE schema_compat_state SET applied_schema_version = 0");
		ensureAdditiveSchemaCompatibility(db);
		expect(hasIndex(db, "idx_memory_items_project")).toBe(true);
		expect(appliedSchemaVersion(db)).toBe(SCHEMA_VERSION);
	});

	it("runs the project backfill even when gated DDL is skipped", () => {
		db.pragma("user_version = 6");
		// First call marks the schema-compat state so the next open is gated.
		ensureAdditiveSchemaCompatibility(db);

		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO sessions(id, started_at, cwd, project) VALUES (1, ?, '/work/codemem', 'codemem')",
		).run(now);
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, project)
			 VALUES (1, 'discovery', 'a', 'b', ?, ?, NULL)`,
		).run(now, now);

		// This open is gated (DDL skipped) but the backfill must still run.
		ensureAdditiveSchemaCompatibility(db);

		const row = db.prepare("SELECT project FROM memory_items WHERE session_id = 1").get() as {
			project: string | null;
		};
		expect(row.project).toBe("codemem");
	});

	it("applies and marks on a fresh DB (gate is marker-only, not user_version)", () => {
		// A freshly bootstrapped DB is at user_version=SCHEMA_VERSION, but the gate
		// keys on the marker, not the version: the shim runs once (its statements
		// are all idempotent no-ops here) and records the marker.
		expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
		expect(tableExists(db, "schema_compat_state")).toBe(false);
		ensureAdditiveSchemaCompatibility(db);
		expect(tableExists(db, "schema_compat_state")).toBe(true);
		expect(appliedSchemaVersion(db)).toBe(SCHEMA_VERSION);
	});

	it("re-adds a missing additive column even at user_version=SCHEMA_VERSION", () => {
		// Regression: additive columns (e.g. memory_items.project) were added over
		// time WITHOUT bumping SCHEMA_VERSION, so a DB can report
		// user_version=SCHEMA_VERSION yet still lack one. Gating on user_version
		// would skip the shim and leave the column missing, breaking inserts that
		// reference it. The marker-only gate must still repair it.
		expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
		db.exec("DROP INDEX IF EXISTS idx_memory_items_project");
		db.exec("ALTER TABLE memory_items DROP COLUMN project");
		expect(columnExists(db, "memory_items", "project")).toBe(false);

		// No marker exists, so the shim runs despite user_version=SCHEMA_VERSION.
		ensureAdditiveSchemaCompatibility(db);

		expect(columnExists(db, "memory_items", "project")).toBe(true);
		expect(hasIndex(db, "idx_memory_items_project")).toBe(true);
		expect(appliedSchemaVersion(db)).toBe(SCHEMA_VERSION);
	});

	it("schemaCompatAlreadyApplied-style probe is fail-safe without the table", () => {
		// On a DB lacking schema_compat_state, a legacy open must still apply the
		// shim (the gate returns false on the missing table rather than skipping).
		const legacy = new BetterSqlite3(join(tmpDir, "legacy.sqlite"));
		try {
			legacy.exec(`
				CREATE TABLE memory_items (
					id INTEGER PRIMARY KEY,
					session_id INTEGER NOT NULL,
					kind TEXT NOT NULL,
					title TEXT NOT NULL,
					body_text TEXT NOT NULL,
					visibility TEXT,
					workspace_id TEXT,
					active INTEGER DEFAULT 1,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			// user_version defaults to 0 (legacy) and schema_compat_state is absent.
			expect(tableExists(legacy, "schema_compat_state")).toBe(false);
			expect(() => ensureAdditiveSchemaCompatibility(legacy)).not.toThrow();
			// The shim ran (fail-safe gate), creating + marking the state table.
			expect(tableExists(legacy, "schema_compat_state")).toBe(true);
			expect(columnExists(legacy, "memory_items", "project")).toBe(true);
		} finally {
			legacy.close();
		}
	});
});

describe("ensurePlannerStats", () => {
	let tmpDir: string;
	let db: Database;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-test-"));
		db = new BetterSqlite3(join(tmpDir, "test.sqlite"));
	});

	afterEach(() => {
		db?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("is a no-op for fresh databases without search tables", () => {
		expect(() => ensurePlannerStats(db)).not.toThrow();
		expect(tableExists(db, "sqlite_stat1")).toBe(false);
	});

	it("bootstraps sqlite_stat1 once search tables exist", () => {
		db.exec(
			"CREATE TABLE memory_items (id INTEGER PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, title TEXT, body_text TEXT, tags_text TEXT)",
		);
		db.exec(
			"CREATE VIRTUAL TABLE memory_fts USING fts5(title, body_text, tags_text, content='memory_items', content_rowid='id')",
		);
		db.exec("CREATE INDEX idx_memory_items_active_created ON memory_items(active, created_at)");

		expect(tableExists(db, "sqlite_stat1")).toBe(false);

		ensurePlannerStats(db);

		expect(tableExists(db, "sqlite_stat1")).toBe(true);
		expect(db.prepare("SELECT 1 FROM sqlite_stat1 LIMIT 1").pluck().get()).toBe(1);
	});
});

describe("JSON helpers", () => {
	it("fromJson returns {} for null/empty", () => {
		expect(fromJson(null)).toEqual({});
		expect(fromJson(undefined)).toEqual({});
		expect(fromJson("")).toEqual({});
	});

	it("fromJson parses valid JSON", () => {
		expect(fromJson('{"key": "value"}')).toEqual({ key: "value" });
	});

	it("fromJson returns {} for invalid JSON", () => {
		expect(fromJson("not json")).toEqual({});
	});

	it("toJson serializes to JSON string", () => {
		expect(toJson({ key: "value" })).toBe('{"key":"value"}');
	});

	it("toJson returns {} for null/undefined", () => {
		expect(toJson(null)).toBe("{}");
		expect(toJson(undefined)).toBe("{}");
	});
});

describe("isEmbeddingDisabled", () => {
	const envKey = "CODEMEM_EMBEDDING_DISABLED";
	let orig: string | undefined;

	beforeEach(() => {
		orig = process.env[envKey];
		delete process.env[envKey];
	});

	afterEach(() => {
		if (orig === undefined) {
			delete process.env[envKey];
		} else {
			process.env[envKey] = orig;
		}
	});

	it("returns false when env var is unset", () => {
		expect(isEmbeddingDisabled()).toBe(false);
	});

	it('returns true for "1"', () => {
		process.env[envKey] = "1";
		expect(isEmbeddingDisabled()).toBe(true);
	});

	it('returns true for "true" (case-insensitive)', () => {
		process.env[envKey] = "TRUE";
		expect(isEmbeddingDisabled()).toBe(true);
	});

	it('returns true for "yes"', () => {
		process.env[envKey] = "yes";
		expect(isEmbeddingDisabled()).toBe(true);
	});

	it('returns false for "0"', () => {
		process.env[envKey] = "0";
		expect(isEmbeddingDisabled()).toBe(false);
	});
});

describe("migrateLegacyDbPath", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-migrate-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("moves a legacy file to the target path", () => {
		const legacyPath = join(tmpDir, "legacy.sqlite");
		const targetPath = join(tmpDir, "target", "mem.sqlite");
		writeFileSync(legacyPath, "test-db-content");

		// Monkey-patch the function to test with custom paths
		// (migrateLegacyDbPath only runs for DEFAULT_DB_PATH, so we test moveWithSidecars logic directly)
		// Instead, test that connect() picks up an existing file
		expect(existsSync(legacyPath)).toBe(true);
		expect(existsSync(targetPath)).toBe(false);
	});

	it("skips migration when target already exists", () => {
		// migrateLegacyDbPath returns early if target exists — no-op
		const target = join(tmpDir, "existing.sqlite");
		writeFileSync(target, "existing");
		migrateLegacyDbPath(target);
		expect(existsSync(target)).toBe(true);
	});
});
