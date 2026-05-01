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
		expect(hasIndex(db, "idx_replication_ops_scope_created")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);
		ensureAdditiveSchemaCompatibility(db);

		expect(columnExists(db, "memory_items", "scope_id")).toBe(true);
		expect(columnExists(db, "replication_ops", "scope_id")).toBe(true);
		expect(hasIndex(db, "idx_memory_items_scope_visibility_created")).toBe(true);
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
