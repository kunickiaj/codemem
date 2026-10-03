import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import {
	AUTH_LINK_REDEEM_WINDOW_MS,
	AUTH_SESSION_SCHEMA_SQL,
	AUTH_SESSION_TTL_MS,
} from "./coordinator-auth-session-contract.js";

const SESSION_TABLES = ["coordinator_auth_session_receipts", "coordinator_auth_sessions"] as const;
const SESSION_TTL = AUTH_SESSION_TTL_MS;

type Backend = "SQLite" | "D1";
function setup(backend: Backend) {
	if (backend === "SQLite") return connectCoordinator(":memory:");
	const db = new Database(":memory:");
	db.exec(
		readFileSync(
			join(import.meta.dirname, "../../cloudflare-coordinator-worker/schema.sql"),
			"utf8",
		),
	);
	return db;
}
function schema(db: SqliteDatabase, table: (typeof SESSION_TABLES)[number]) {
	const indexes = db.pragma(`index_list(${table})`) as {
		name: string;
		unique: number;
		partial: number;
	}[];
	return {
		ddl: (
			db
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
				.pluck()
				.get(table) as string
		)
			.replace(/\s+/gu, " ")
			.trim(),
		columns: db.pragma(`table_info(${table})`),
		indexes: indexes
			.map((index) => ({
				columns: db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name),
				unique: index.unique,
				sql:
					(
						db
							.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
							.pluck()
							.get(index.name) as string | null
					)
						?.replace(/\s+/gu, " ")
						.trim() ?? null,
				partial: index.partial,
			}))
			.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
	};
}
function insertSession(db: SqliteDatabase, changes: Record<string, unknown> = {}) {
	const row = {
		coordinator_id: "coord-a",
		session_id: "session-a",
		credential_hash: "a".repeat(64),
		browser_transaction_hash: "b".repeat(64),
		link_id: "link-a",
		identity_id: "identity-a",
		issuer: "https://accounts.example.test",
		subject: "opaque-subject",
		auth_config_revision: "c".repeat(64),
		created_at_ms: 0,
		expires_at_ms: SESSION_TTL,
		revoked_at_ms: null,
		...changes,
	};
	db.prepare(
		`INSERT INTO coordinator_auth_sessions (${Object.keys(row).join(",")}) VALUES (${Object.keys(
			row,
		)
			.map(() => "?")
			.join(",")})`,
	).run(...Object.values(row));
}
function insertReceipt(db: SqliteDatabase, changes: Record<string, unknown> = {}) {
	const row = {
		coordinator_id: "coord-a",
		browser_transaction_hash: "b".repeat(64),
		source: "signin",
		attempt_id: null,
		link_id: "link-a",
		session_id: "session-a",
		auth_config_revision: "c".repeat(64),
		created_at_ms: 0,
		...changes,
	};
	db.prepare(
		`INSERT INTO coordinator_auth_session_receipts (${Object.keys(row).join(",")}) VALUES (${Object.keys(
			row,
		)
			.map(() => "?")
			.join(",")})`,
	).run(...Object.values(row));
}
function registerParity(backend: Backend) {
	it("fresh schemas, migration and exported SQL agree on only the two additive empty tables", () => {
		// Arrange
		const db = setup(backend);
		const peer = setup(backend === "SQLite" ? "D1" : "SQLite");
		try {
			const fresh = SESSION_TABLES.map((table) => schema(db, table));
			const migration = readFileSync(
				join(
					import.meta.dirname,
					"../../cloudflare-coordinator-worker/migrations/0018_add_auth_sessions.sql",
				),
				"utf8",
			);
			const indexMigration = readFileSync(
				join(
					import.meta.dirname,
					"../../cloudflare-coordinator-worker/migrations/0022_add_auth_session_admission_index.sql",
				),
				"utf8",
			);
			for (const table of SESSION_TABLES) db.exec(`DROP TABLE ${table}`);
			// Act
			db.exec(migration);
			db.exec(migration);
			db.exec(indexMigration);
			db.exec(indexMigration);
			const migrated = SESSION_TABLES.map((table) => schema(db, table));
			for (const table of SESSION_TABLES) db.exec(`DROP TABLE ${table}`);
			db.exec(AUTH_SESSION_SCHEMA_SQL);
			// Assert
			expect(migrated).toEqual(fresh);
			expect(SESSION_TABLES.map((table) => schema(db, table))).toEqual(fresh);
			expect(SESSION_TABLES.map((table) => schema(peer, table))).toEqual(fresh);
			expect(SESSION_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual([
				[],
				[],
			]);
			expect(AUTH_SESSION_TTL_MS).toBe(SESSION_TTL);
			expect(AUTH_LINK_REDEEM_WINDOW_MS).toBe(120_000);
			for (const table of fresh)
				expect(table.indexes.every((index) => index.partial === 0)).toBe(true);
		} finally {
			db.close();
			peer.close();
		}
	});
	it("admission index migration is idempotent and leaves existing session and receipt data unchanged", () => {
		// Arrange
		const db = setup(backend);
		try {
			insertSession(db);
			insertReceipt(db);
			const before = SESSION_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
			const migration = readFileSync(
				join(
					import.meta.dirname,
					"../../cloudflare-coordinator-worker/migrations/0022_add_auth_session_admission_index.sql",
				),
				"utf8",
			);
			// Act
			db.exec(migration);
			db.exec(migration);
			// Assert
			expect(SESSION_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(
				before,
			);
			expect(
				db
					.prepare(
						"SELECT name FROM pragma_index_info('idx_auth_sessions_link_config_expiry') ORDER BY seqno",
					)
					.all(),
			).toEqual([
				{ name: "coordinator_id" },
				{ name: "link_id" },
				{ name: "auth_config_revision" },
				{ name: "expires_at_ms" },
			]);
		} finally {
			db.close();
		}
	});
	it("stores independent sessions and multiple NULL-attempt sign-in receipts without provider fields", () => {
		// Arrange
		const db = setup(backend);
		try {
			// Act
			insertSession(db);
			insertReceipt(db);
			insertSession(db, {
				session_id: "session-b",
				credential_hash: "d".repeat(64),
				browser_transaction_hash: "e".repeat(64),
			});
			insertReceipt(db, { session_id: "session-b", browser_transaction_hash: "e".repeat(64) });
			// Assert
			for (const table of SESSION_TABLES)
				expect(db.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(2);
			for (const table of SESSION_TABLES)
				expect(JSON.stringify(db.pragma(`table_info(${table})`))).not.toMatch(
					/profile|email|token|device_id|public_key/,
				);
		} finally {
			db.close();
		}
	});
}
const invalidSessions = [
	{ created_at_ms: -1, expires_at_ms: SESSION_TTL - 1 },
	{ created_at_ms: 0.5, expires_at_ms: SESSION_TTL + 0.5 },
	{
		created_at_ms: Number.MAX_SAFE_INTEGER - SESSION_TTL + 1,
		expires_at_ms: Number.MAX_SAFE_INTEGER + 1,
	},
	{ expires_at_ms: SESSION_TTL - 1 },
	{ expires_at_ms: SESSION_TTL + 0.5 },
	{ revoked_at_ms: -1 },
	{ revoked_at_ms: 0.5 },
	{ revoked_at_ms: Number.MAX_SAFE_INTEGER + 1 },
	{ credential_hash: "short" },
	{ credential_hash: "G".repeat(64) },
	{ browser_transaction_hash: "short" },
	{ auth_config_revision: "short" },
	{ subject: "" },
] as const;
function registerChecks(backend: Backend) {
	it.each(invalidSessions)("rejects invalid session storage %j", (changes) => {
		// Arrange
		const db = setup(backend);
		try {
			// Act
			const act = () => insertSession(db, changes);
			// Assert
			expect(act).toThrow(/CHECK constraint failed/);
			expect(db.prepare("SELECT * FROM coordinator_auth_sessions").all()).toEqual([]);
		} finally {
			db.close();
		}
	});
	it.each([
		{ source: "unknown" },
		{ source: "link_redeem", attempt_id: null },
		{ source: "signin", attempt_id: "attempt-a" },
		{ browser_transaction_hash: "short" },
		{ created_at_ms: -1 },
		{ created_at_ms: 0.5 },
		{ created_at_ms: Number.MAX_SAFE_INTEGER - SESSION_TTL + 1 },
	])("rejects invalid receipt storage %j", (changes) => {
		// Arrange
		const db = setup(backend);
		try {
			// Act
			const act = () => insertReceipt(db, changes);
			// Assert
			expect(act).toThrow(/CHECK constraint failed/);
			expect(db.prepare("SELECT * FROM coordinator_auth_session_receipts").all()).toEqual([]);
		} finally {
			db.close();
		}
	});
	it.each(["session-id", "credential", "browser"] as const)(
		"session uniqueness rejects duplicate %s but allows another coordinator",
		(change) => {
			// Arrange
			const db = setup(backend);
			try {
				insertSession(db);
				const row = {
					session_id: change === "session-id" ? "session-a" : "session-b",
					credential_hash: change === "credential" ? "a".repeat(64) : "d".repeat(64),
					browser_transaction_hash: change === "browser" ? "b".repeat(64) : "e".repeat(64),
				};
				// Act
				const act = () => insertSession(db, row);
				// Assert
				expect(act).toThrow(/UNIQUE constraint failed/);
				expect(() => insertSession(db, { ...row, coordinator_id: "coord-b" })).not.toThrow();
			} finally {
				db.close();
			}
		},
	);
	it.each(["browser", "session", "attempt"] as const)(
		"receipt uniqueness rejects duplicate %s but allows another coordinator",
		(change) => {
			// Arrange
			const db = setup(backend);
			try {
				insertReceipt(db, { source: "link_redeem", attempt_id: "attempt-a" });
				const row = {
					browser_transaction_hash: change === "browser" ? "b".repeat(64) : "d".repeat(64),
					session_id: change === "session" ? "session-a" : "session-b",
					source: "link_redeem",
					attempt_id: change === "attempt" ? "attempt-a" : "attempt-b",
				};
				// Act
				const act = () => insertReceipt(db, row);
				// Assert
				expect(act).toThrow(/UNIQUE constraint failed/);
				expect(() => insertReceipt(db, { ...row, coordinator_id: "coord-b" })).not.toThrow();
			} finally {
				db.close();
			}
		},
	);
}
function registerBackend(backend: Backend) {
	registerParity(backend);
	registerChecks(backend);
}
describe.each(["SQLite", "D1"] as const)(
	"%s auth-session schema (D1 is SQLite-backed)",
	registerBackend,
);
