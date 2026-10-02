import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import { AUTH_ACCOUNT_PROFILE_SCHEMA_SQL } from "./coordinator-auth-account-profile-contract.js";

const TABLE = "coordinator_auth_account_profiles";
const worker = join(import.meta.dirname, "../../cloudflare-coordinator-worker");

function shape(db: SqliteDatabase) {
	const indexes = db.pragma(`index_list(${TABLE})`) as {
		name: string;
		unique: number;
		partial: number;
	}[];
	return {
		definition: (
			db
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
				.pluck()
				.get(TABLE) as string
		)
			.replace(/\s+/gu, " ")
			.trim(),
		columns: db.pragma(`table_info(${TABLE})`),
		indexes: indexes.map(({ name, unique, partial }) => ({
			unique,
			partial,
			columns: db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name),
		})),
		foreignKeys: db.pragma(`foreign_key_list(${TABLE})`),
	};
}

function insert(db: SqliteDatabase, changes: Record<string, unknown> = {}) {
	const row = {
		coordinator_id: "coordinator-a",
		link_id: "link-a",
		display_name: "Person",
		email: "person@example.test",
		email_verified: 1,
		picture_url: "https://images.example.test/a",
		source_session_id: "session-a",
		source_signed_in_at_ms: 0,
		...changes,
	};
	db.prepare(
		`INSERT INTO ${TABLE} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
			.map(() => "?")
			.join(",")})`,
	).run(...Object.values(row));
}

function setup(source: "constant" | "migration" | "Worker" | "SQLite") {
	if (source === "SQLite") return connectCoordinator(":memory:");
	const db = new Database(":memory:");
	let sql = AUTH_ACCOUNT_PROFILE_SCHEMA_SQL;
	if (source !== "constant") {
		const filename =
			source === "Worker" ? "schema.sql" : "migrations/0021_add_auth_account_profiles.sql";
		sql = readFileSync(join(worker, filename), "utf8");
	}
	db.exec(sql);
	return db;
}

it("constant, SQLite, fresh Worker and migration match definitions, columns and indexes", () => {
	// Arrange
	const sources = ["constant", "migration", "Worker", "SQLite"] as const;
	const databases = sources.map(setup);
	try {
		// Act
		const shapes = databases.map(shape);
		// Assert
		for (const actual of shapes) expect(actual).toEqual(shapes[0]);
		for (const db of databases) expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual([]);
		expect(shapes[0]?.foreignKeys).toEqual([]);
		expect(shapes[0]?.indexes).toEqual([
			{ unique: 1, partial: 0, columns: [{ name: "coordinator_id" }, { name: "link_id" }] },
		]);
		expect((shapes[0]?.columns as { name: string }[] | undefined)?.map(({ name }) => name)).toEqual(
			[
				"coordinator_id",
				"link_id",
				"display_name",
				"email",
				"email_verified",
				"picture_url",
				"source_session_id",
				"source_signed_in_at_ms",
			],
		);
	} finally {
		for (const db of databases) db.close();
	}
});

it("migration applied twice preserves existing display rows and adds no other tables", () => {
	// Arrange
	const db = new Database(":memory:");
	const migration = readFileSync(
		join(worker, "migrations/0021_add_auth_account_profiles.sql"),
		"utf8",
	);
	try {
		db.exec(migration);
		insert(db);
		const before = db.prepare(`SELECT * FROM ${TABLE}`).all();
		const beforeShape = shape(db);
		// Act
		db.exec(migration);
		db.exec(migration);
		// Assert
		expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual(before);
		expect(shape(db)).toEqual(beforeShape);
		expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
			{ name: TABLE },
		]);
	} finally {
		db.close();
	}
});

function registerChecks(source: "constant" | "migration" | "Worker" | "SQLite") {
	it.each([
		{ display_name: "" },
		{ display_name: "x".repeat(257) },
		{ email: "" },
		{ email: "x".repeat(321) },
		{ email: null, email_verified: 1 },
		{ email_verified: 2 },
		{ email_verified: 0.5 },
		{ picture_url: "http://images.example.test/a" },
		{ picture_url: `https://images.example.test/${"x".repeat(2048)}` },
		{ source_signed_in_at_ms: -1 },
		{ source_signed_in_at_ms: 0.5 },
		{ source_signed_in_at_ms: Number.MAX_SAFE_INTEGER },
	])("rejects invalid stored display bounds/flags/time %j", (changes) => {
		// Arrange
		const db = setup(source);
		try {
			// Act
			const act = () => insert(db, changes);
			// Assert
			expect(act).toThrow(/CHECK constraint failed/);
			expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual([]);
		} finally {
			db.close();
		}
	});
	it("allows nullable display data and independent links/coordinators, but rejects duplicate row", () => {
		// Arrange
		const db = setup(source);
		try {
			const nullable = { display_name: null, email: null, email_verified: null, picture_url: null };
			// Act
			insert(db, nullable);
			insert(db, { coordinator_id: "coordinator-b" });
			insert(db, {
				link_id: "link-b",
				display_name: "x".repeat(256),
				email: "e".repeat(320),
				email_verified: 0,
				picture_url: `https://example.test/${"x".repeat(2048 - "https://example.test/".length)}`,
			});
			// Assert
			expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toHaveLength(3);
			expect(() => insert(db)).toThrow(/UNIQUE constraint failed/);
			expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toHaveLength(3);
		} finally {
			db.close();
		}
	});
}

describe.each(["constant", "migration", "Worker", "SQLite"] as const)(
	"%s profile schema checks",
	registerChecks,
);
