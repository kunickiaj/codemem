import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import { AUTH_LINK_SCHEMA_SQL } from "./coordinator-auth-link-contract.js";

// Foundation coverage uses only schema initialization and existing one-argument constructors.
const TABLES = [
	"coordinator_auth_link_attempts",
	"coordinator_auth_account_links",
	"coordinator_auth_link_audit_log",
] as const;
type Backend = "SQLite" | "D1";
function setupSchema(backend: Backend): SqliteDatabase {
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

function schema(db: SqliteDatabase, table: (typeof TABLES)[number]) {
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
			.filter((index) => index.unique === 1)
			.map((index) => ({
				columns: db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name),
				partial: index.partial,
			}))
			.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
	};
}

function seedReviewedEnrollment(db: SqliteDatabase) {
	const created = "2026-10-02T12:00:00.000Z";
	db.prepare("INSERT INTO groups (group_id, created_at) VALUES (?, ?)").run("group-a", created);
	db.prepare(`INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, enabled, created_at)
		VALUES (?, ?, ?, ?, 1, ?)`).run(
		"group-a",
		"device-a",
		"fixture-public-key\nexact-key-line",
		"a".repeat(64),
		created,
	);
	db.prepare(`INSERT INTO coordinator_auth_controller_attestations
		(attestation_id, coordinator_id, identity_id, group_id, device_id, public_key, fingerprint,
		review_receipt_id, evidence_digest, enrollment_identity_id, revision, created_at, revoked_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, NULL)`).run(
		"attestation-a",
		"coordinator-a",
		"identity-a",
		"group-a",
		"device-a",
		"fixture-public-key\nexact-key-line",
		"a".repeat(64),
		"receipt-a",
		"b".repeat(64),
		created,
	);
}

function registerBackend(backend: Backend) {
	it("fresh SQLite and Worker schema agree on columns, CHECKs and full unique indexes", () => {
		// Arrange
		const db = setupSchema(backend);
		const peer = setupSchema(backend === "SQLite" ? "D1" : "SQLite");
		try {
			// Act
			const actual = TABLES.map((table) => schema(db, table));
			const expected = TABLES.map((table) => schema(peer, table));
			// Assert
			expect(actual).toEqual(expected);
			for (const table of actual)
				expect(table.indexes.every((index) => index.partial === 0)).toBe(true);
			expect(actual[1].indexes).toEqual(
				expect.arrayContaining([
					{
						columns: [{ name: "coordinator_id" }, { name: "issuer" }, { name: "subject" }],
						partial: 0,
					},
					{ columns: [{ name: "coordinator_id" }, { name: "identity_id" }], partial: 0 },
					{ columns: [{ name: "coordinator_id" }, { name: "attempt_id" }], partial: 0 },
				]),
			);
		} finally {
			db.close();
			peer.close();
		}
	});
	it("migration 0017 and exported schema match the fresh-install link tables", () => {
		// Arrange: explicit SQL seeds an existing review; no account-link operations are imported.
		const db = setupSchema(backend);
		try {
			seedReviewedEnrollment(db);
			const before = TABLES.map((table) => schema(db, table));
			const controllers = db
				.prepare("SELECT * FROM coordinator_auth_controller_attestations")
				.all();
			const enrollment = db.prepare("SELECT * FROM enrolled_devices").all();
			const migration = readFileSync(
				join(
					import.meta.dirname,
					"../../cloudflare-coordinator-worker/migrations/0017_add_auth_account_links.sql",
				),
				"utf8",
			);
			for (const table of [...TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
			// Act
			db.exec(migration);
			db.exec(migration);
			const migrated = TABLES.map((table) => schema(db, table));
			for (const table of [...TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
			db.exec(AUTH_LINK_SCHEMA_SQL);
			// Assert
			expect(migrated).toEqual(before);
			expect(TABLES.map((table) => schema(db, table))).toEqual(before);
			expect(TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual([
				[],
				[],
				[],
			]);
			expect(db.prepare("SELECT * FROM coordinator_auth_controller_attestations").all()).toEqual(
				controllers,
			);
			expect(db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(enrollment);
		} finally {
			db.close();
		}
	});
}
describe.each(["SQLite", "D1"] as const)(
	"%s auth-link schema foundation (D1 is SQLite-backed)",
	registerBackend,
);
