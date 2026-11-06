import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	connect,
	type Database,
	ensureAdditiveSchemaCompatibility,
	getSchemaVersion,
	SCHEMA_VERSION,
	tableExists,
} from "./db.js";
import { initDatabase } from "./maintenance/init-vacuum.js";
import { MemoryStore } from "./store.js";

const directories: string[] = [];
const connections: Database[] = [];
const timestamp = "2026-09-01T00:00:00.000Z";
const referenceTables = ["memory_file_refs", "memory_concept_refs"] as const;

afterEach(() => {
	vi.restoreAllMocks();
	for (const db of connections.splice(0)) if (db.open) db.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "codemem-readiness-"));
	directories.push(directory);
	return join(directory, "memory.sqlite");
}

function track(db: Database): Database {
	connections.push(db);
	return db;
}

function seedMemory(db: Database): void {
	db.prepare(
		"INSERT INTO sessions(id, started_at, cwd, project) VALUES (1, ?, '/synthetic', 'sample')",
	).run(timestamp);
	db.prepare(`INSERT INTO memory_items
		(id, session_id, kind, title, body_text, created_at, updated_at, project)
		VALUES (1, 1, 'discovery', 'Preserved title', 'Preserved body', ?, ?, 'sample')`).run(
		timestamp,
		timestamp,
	);
}

function markVersion(db: Database, version: number): void {
	db.pragma(`user_version = ${version}`);
	db.exec(`CREATE TABLE IF NOT EXISTS schema_compat_state (
		id INTEGER PRIMARY KEY, applied_schema_version INTEGER NOT NULL, applied_at TEXT NOT NULL
	)`);
	db.prepare("INSERT OR REPLACE INTO schema_compat_state VALUES (1, ?, ?)").run(version, timestamp);
}

function appliedVersion(db: Database): number | undefined {
	if (!tableExists(db, "schema_compat_state")) return undefined;
	return db
		.prepare("SELECT applied_schema_version FROM schema_compat_state WHERE id = 1")
		.pluck()
		.get() as number | undefined;
}

function seededDatabase(options: { version: number }): { path: string; db: Database } {
	const path = databasePath();
	const db = track(connect(path));
	seedMemory(db);
	markVersion(db, options.version);
	return { path, db };
}

function expectPreservedMemory(db: Database): void {
	expect(db.prepare("SELECT id, title, body_text, project FROM memory_items").all()).toEqual([
		{ id: 1, title: "Preserved title", body_text: "Preserved body", project: "sample" },
	]);
	expect(db.prepare("SELECT id, project FROM sessions").all()).toEqual([
		{ id: 1, project: "sample" },
	]);
}

function expectReady(db: Database): void {
	expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
	expect(appliedVersion(db)).toBe(SCHEMA_VERSION);
	for (const table of [...referenceTables, "sync_transfer_observations", "sync_transfer_receipts"])
		expect(tableExists(db, table), table).toBe(true);
	// Preparing the runtime projections also detects missing columns in pre-existing tables.
	expect(() =>
		db.prepare("SELECT memory_id, file_path, relation FROM memory_file_refs"),
	).not.toThrow();
	expect(() => db.prepare("SELECT memory_id, concept FROM memory_concept_refs")).not.toThrow();
}

function failTableCreation(db: Database, table: string) {
	const exec = db.exec.bind(db);
	const statement = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`, "i");
	return vi.spyOn(db, "exec").mockImplementation((sql: string) => {
		const match = statement.exec(sql);
		if (!match) return exec(sql);
		// SQLite exec can commit earlier statements before a later DDL statement fails.
		const prefix = sql.slice(0, match.index);
		if (prefix.trim()) exec(prefix);
		throw new Error(`synthetic DDL failure: ${table}`);
	});
}

describe("required schema completion after interrupted DDL", () => {
	it.each(["memory_file_refs", "memory_concept_refs", "sync_transfer_observations"])(
		"does not advance completion after %s fails and repairs on reopen",
		(table) => {
			// Arrange: a synthetic legacy file with real data and incomplete required tables.
			const { path, db } = seededDatabase({ version: 6 });
			db.exec("DROP TABLE memory_file_refs; DROP TABLE memory_concept_refs");
			db.exec(
				"DROP TABLE IF EXISTS sync_transfer_receipts; DROP TABLE IF EXISTS sync_transfer_observations",
			);
			const fault = failTableCreation(db, table);

			// Act: run the real compatibility path with just one DDL stage unavailable.
			const attempt = () => ensureAdditiveSchemaCompatibility(db);

			// Assert: neither completion signal may claim success after required work failed.
			expect(attempt).toThrow();
			expect(fault).toHaveBeenCalled();
			expect(tableExists(db, table)).toBe(false);
			expect(appliedVersion(db)).toBe(6);
			expect(getSchemaVersion(db)).toBe(6);
			expectPreservedMemory(db);
			fault.mockRestore();
			db.close();

			// Act: a subsequent runtime open must recover without replacing the database.
			const store = new MemoryStore(path);
			try {
				// Assert: all required stages finish before the completion signals advance.
				expectReady(store.db);
				expectPreservedMemory(store.db);
			} finally {
				store.close();
			}
		},
	);

	it("completes a partial reference migration without losing existing file references", () => {
		// Arrange: the first junction table already contains data when the second is absent.
		const { db } = seededDatabase({ version: 6 });
		db.exec("INSERT INTO memory_file_refs VALUES (1, 'src/example.ts', 'modified')");
		db.exec("DROP TABLE memory_concept_refs");

		// Act.
		ensureAdditiveSchemaCompatibility(db);
		ensureAdditiveSchemaCompatibility(db);

		// Assert: retries preserve earlier successful writes and finish the second table.
		expectReady(db);
		expectPreservedMemory(db);
		expect(db.prepare("SELECT * FROM memory_file_refs").all()).toEqual([
			{ memory_id: 1, file_path: "src/example.ts", relation: "modified" },
		]);
	});

	it("preserves a newer user_version through compatibility, init, and store opens", () => {
		// Arrange: an older completion marker still requires work on a newer additive schema.
		const newerVersion = SCHEMA_VERSION + 1;
		const { path, db } = seededDatabase({ version: newerVersion });
		db.prepare("UPDATE schema_compat_state SET applied_schema_version = ? WHERE id = 1").run(
			SCHEMA_VERSION - 1,
		);
		db.exec("DROP TABLE memory_concept_refs");

		// Act / Assert: completing this runtime's work must never downgrade the file version.
		ensureAdditiveSchemaCompatibility(db);
		expect(getSchemaVersion(db)).toBe(newerVersion);
		expect(appliedVersion(db)).toBe(SCHEMA_VERSION);
		expect(tableExists(db, "memory_concept_refs")).toBe(true);
		db.close();
		initDatabase(path);
		const initialized = track(new BetterSqlite3(path));
		expect(getSchemaVersion(initialized)).toBe(newerVersion);
		expectPreservedMemory(initialized);
		initialized.close();
		const store = new MemoryStore(path);
		try {
			expect(getSchemaVersion(store.db)).toBe(newerVersion);
			expectPreservedMemory(store.db);
		} finally {
			store.close();
		}
	});

	it("checks ready reference tables without writing references or completion signals", () => {
		// Arrange: trace actual SQLite statements on a completed, reopened database.
		const { path, db } = seededDatabase({ version: SCHEMA_VERSION });
		ensureAdditiveSchemaCompatibility(db);
		db.close();
		const statements: string[] = [];
		const ready = track(new BetterSqlite3(path, { verbose: (sql) => statements.push(sql) }));

		// Act.
		ensureAdditiveSchemaCompatibility(ready);
		const traced = [...statements];

		// Assert: optional discovery writes are outside the reference/completion contract.
		for (const table of referenceTables) {
			expect(
				traced.some((sql) => /\bSELECT\b/i.test(sql) && sql.includes(table)),
				table,
			).toBe(true);
		}
		const relevant = traced.filter((sql) =>
			/\b(memory_file_refs|memory_concept_refs|schema_compat_state|user_version)\b/i.test(sql),
		);
		expect(
			relevant.filter(
				(sql) =>
					/\b(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|REPLACE)\b/i.test(sql) ||
					/\bPRAGMA\s+user_version\s*(?:=|\()/i.test(sql),
			),
		).toEqual([]);
		expectReady(ready);
		expectPreservedMemory(ready);
	});
});

const entrypoints = [
	{
		name: "initDatabase",
		open: (path: string) => {
			initDatabase(path);
		},
	},
	{
		name: "MemoryStore",
		open: (path: string) => {
			new MemoryStore(path).close();
		},
	},
];
const histories = [
	{ name: "fresh", version: undefined },
	{ name: "legacy v6", version: 6 },
	{ name: "previous version", version: SCHEMA_VERSION - 1 },
	{ name: "current but incorrectly marked complete", version: SCHEMA_VERSION },
];

describe.each(entrypoints)("$name readiness parity", ({ open }) => {
	it.each(histories)("opens $name and preserves rows across repeated opens", ({ version }) => {
		// Arrange: model version/marker history independently from absent required references.
		let path: string;
		if (version === undefined) {
			path = databasePath();
		} else {
			const fixture = seededDatabase({ version });
			path = fixture.path;
			fixture.db.exec("DROP TABLE memory_file_refs; DROP TABLE memory_concept_refs");
			fixture.db.close();
		}

		// Act.
		open(path);
		const db = track(new BetterSqlite3(path));
		if (version === undefined) seedMemory(db);
		db.exec("INSERT INTO memory_file_refs VALUES (1, 'src/example.ts', 'read')");
		db.exec("INSERT INTO memory_concept_refs VALUES (1, 'schema-readiness')");
		db.close();
		open(path);
		const reopened = track(new BetterSqlite3(path));

		// Assert: both entrypoints expose usable required tables and retain user data.
		expectReady(reopened);
		expectPreservedMemory(reopened);
		expect(reopened.prepare("SELECT * FROM memory_file_refs").all()).toEqual([
			{ memory_id: 1, file_path: "src/example.ts", relation: "read" },
		]);
		expect(reopened.prepare("SELECT * FROM memory_concept_refs").all()).toEqual([
			{ memory_id: 1, concept: "schema-readiness" },
		]);
	});

	it.each(referenceTables)("rejects malformed %s without rebuilding or deleting rows", (table) => {
		// Arrange: a current marker cannot make a malformed required table safe to use.
		const { path, db } = seededDatabase({ version: SCHEMA_VERSION });
		db.exec(`DROP TABLE ${table}; CREATE TABLE ${table} (memory_id INTEGER, preserved_text TEXT)`);
		db.prepare(`INSERT INTO ${table} VALUES (1, ?)`).run("Keep this malformed row");
		const originalSql = db
			.prepare("SELECT sql FROM sqlite_master WHERE name = ?")
			.pluck()
			.get(table);
		db.close();

		// Act: repeating an open must continue to reject rather than destroy data to repair it.
		const attempt = () => open(path);

		// Assert: the error identifies the unusable table and both row sets survive.
		expect(attempt).toThrow(new RegExp(table));
		expect(attempt).toThrow(new RegExp(table));
		const reopened = track(new BetterSqlite3(path));
		expectPreservedMemory(reopened);
		expect(reopened.prepare(`SELECT * FROM ${table}`).all()).toEqual([
			{ memory_id: 1, preserved_text: "Keep this malformed row" },
		]);
		expect(
			reopened.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(table),
		).toBe(originalSql);
	});
});
