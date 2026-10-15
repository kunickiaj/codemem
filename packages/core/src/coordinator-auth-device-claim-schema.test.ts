import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL } from "./coordinator-auth-device-claim-schema.js";

const TABLE = "coordinator_auth_device_claims";
const worker = join(import.meta.dirname, "../../cloudflare-coordinator-worker");
const row = {
	coordinator_id: "coordinator-a",
	claim_id: "claim-a",
	identity_id: "identity-a",
	group_id: "group-a",
	device_id: "device-a",
	public_key: "-----BEGIN PUBLIC KEY-----\nfixture-only-not-a-real-key\n-----END PUBLIC KEY-----\n",
	fingerprint: "a".repeat(64),
	key_id: "b".repeat(64),
	attempt_id: "dummy-attempt-a",
	issuer: "https://accounts.google.com",
	auth_config_revision: "d".repeat(64),
	created_at_ms: 0,
};
const columns = Object.keys(row);
const insertSql = `INSERT INTO ${TABLE} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`;
const migrationNames = readdirSync(join(worker, "migrations")).filter((name) =>
	name.startsWith("0032_"),
);
const databases: SqliteDatabase[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function setup(source: "constant" | "migration" | "Worker") {
	const db = new Database(":memory:");
	databases.push(db);
	db.pragma("recursive_triggers = OFF");
	if (source === "constant") db.exec(COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL);
	if (source === "Worker") db.exec(readFileSync(join(worker, "schema.sql"), "utf8"));
	if (source === "migration") {
		expect(migrationNames).toHaveLength(1);
		db.exec(readFileSync(join(worker, "migrations", migrationNames[0] as string), "utf8"));
	}
	return db;
}

function insert(db: SqliteDatabase, changes: Record<string, unknown> = {}, sql = insertSql) {
	const record = { ...row, ...changes } as Record<string, unknown>;
	db.prepare(sql).run(...columns.map((column) => record[column]));
}

function definition(db: SqliteDatabase) {
	return db
		.prepare(
			"SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type, name",
		)
		.all(TABLE)
		.map((entry) => {
			const value = entry as { type: string; name: string; sql: string };
			return { ...value, sql: value.sql.replace(/\s+/gu, " ").trim() };
		});
}

it("constant, actual fresh Worker schema and actual migration have identical table/index/trigger definitions", () => {
	// Arrange
	const sources = ["constant", "migration", "Worker"] as const;
	const dbs = sources.map(setup);
	// Act
	const definitions = dbs.map(definition);
	// Assert
	for (const actual of definitions) expect(actual).toEqual(definitions[0]);
	expect(definitions[0]?.filter((entry) => entry.type === "trigger")).toHaveLength(3);
	for (const db of dbs) {
		expect(db.pragma(`foreign_key_list(${TABLE})`)).toEqual([]);
		expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual([]);
	}
});

describe.each(["constant", "migration", "Worker"] as const)("%s claim storage", (source) => {
	it("stores exact bytes without inventing logical references or proving ownership", () => {
		// Arrange: dummy IDs are not Google proof; future finalizers must authorize writes.
		const db = setup(source);
		// Act
		insert(db);
		// Assert
		expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual([row]);
	});

	it("allows independent claims and coordinator namespaces", () => {
		// Arrange
		const db = setup(source);
		const independent = {
			claim_id: "claim-b",
			identity_id: "identity-b",
			device_id: "device-b",
			key_id: "c".repeat(64),
			attempt_id: "dummy-attempt-b",
		};
		// Act
		insert(db);
		insert(db, independent);
		insert(db, { coordinator_id: "coordinator-b", claim_id: "claim-c" });
		// Assert
		expect(db.prepare(`SELECT * FROM ${TABLE} ORDER BY claim_id`).all()).toEqual([
			row,
			{ ...row, ...independent },
			{ ...row, coordinator_id: "coordinator-b", claim_id: "claim-c" },
		]);
	});
	it("accepts identifier/key/time upper bounds and preserves CRLF PEM bytes", () => {
		// Arrange
		const db = setup(source);
		const maximum = {
			coordinator_id: "c".repeat(256),
			claim_id: "l".repeat(256),
			identity_id: "i".repeat(256),
			group_id: "g".repeat(256),
			device_id: "d".repeat(256),
			attempt_id: "t".repeat(256),
			public_key: `${"p".repeat(4094)}\r\n`,
			created_at_ms: Number.MAX_SAFE_INTEGER,
		};
		// Act
		insert(db, maximum);
		// Assert
		expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual([{ ...row, ...maximum }]);
	});
	it.each([
		"coordinator_id",
		"claim_id",
		"identity_id",
		"group_id",
		"device_id",
		"attempt_id",
		"public_key",
	])("rejects overlong %s", (column) => {
		// Arrange
		const db = setup(source);
		const value = "x".repeat(column === "public_key" ? 4097 : 257);
		// Act
		const invalid = () => insert(db, { [column]: value });
		// Assert
		expect(invalid).toThrow(/CHECK constraint failed/);
		expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual([]);
	});

	it.each(["claim_id", "identity_id", "device_id", "key_id", "attempt_id"])(
		"rejects only-%s collisions including REPLACE with recursive triggers off",
		(field) => {
			// Arrange: every other unique value differs, so each constraint is causal.
			const db = setup(source);
			insert(db);
			const changes: Record<string, unknown> = {
				claim_id: "claim-b",
				identity_id: "identity-b",
				device_id: "device-b",
				key_id: "c".repeat(64),
				attempt_id: "dummy-attempt-b",
			};
			changes[field] = row[field as keyof typeof row];
			if (field === "claim_id") changes.coordinator_id = "coordinator-b";
			const before = db.prepare(`SELECT * FROM ${TABLE}`).all();
			// Act
			const ordinary = () => insert(db, changes);
			const replace = () =>
				insert(db, changes, insertSql.replace("INSERT INTO", "INSERT OR REPLACE INTO"));
			// Assert
			expect(db.pragma("recursive_triggers", { simple: true })).toBe(0);
			expect(ordinary).toThrow(/auth_device_claim_collision/);
			expect(replace).toThrow(/auth_device_claim_collision/);
			expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual(before);
		},
	);

	it.each([
		`UPDATE ${TABLE} SET public_key = 'changed'`,
		`UPDATE ${TABLE} SET claim_id = claim_id`,
		`DELETE FROM ${TABLE}`,
		`${insertSql} ON CONFLICT DO UPDATE SET public_key = excluded.public_key`,
	])("rejects immutable mutation: %s", (sql) => {
		// Arrange
		const db = setup(source);
		insert(db);
		// Act
		const mutate = () => {
			if (sql.includes("ON CONFLICT")) insert(db, { public_key: "changed" }, sql);
			else db.exec(sql);
		};
		// Assert
		expect(mutate).toThrow(/auth_device_claim_(immutable|collision)/);
		expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual([row]);
	});
});

describe.each(["constant", "migration", "Worker"] as const)(
	"%s hidden-row replacement",
	(source) => {
		it("rejects every hidden row identifier with fresh logical values", () => {
			// Arrange
			const db = setup(source);
			insert(db);
			const fresh = {
				coordinator_id: "fresh-coordinator",
				claim_id: "fresh-claim",
				identity_id: "fresh-identity",
				device_id: "fresh-device",
				key_id: "e".repeat(64),
				attempt_id: "fresh-attempt",
			};
			// Act
			const replace = (alias: string) =>
				insert(
					db,
					fresh,
					insertSql
						.replace("INSERT INTO", "INSERT OR REPLACE INTO")
						.replace("(", `(${alias},`)
						.replace("VALUES (", "VALUES (1,"),
				);
			// Assert
			expect(db.pragma("recursive_triggers", { simple: true })).toBe(0);
			for (const alias of ["rowid", "_rowid_", "oid"]) {
				expect(() => replace(alias)).toThrow(/no column named/);
				expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual([row]);
			}
		});
	},
);

describe.each(["constant", "migration", "Worker"] as const)("%s claim CHECKs", (source) => {
	it.each(columns)("rejects missing/null required %s", (column) => {
		// Arrange
		const db = setup(source);
		const present = columns.filter((name) => name !== column);
		const missingSql = `INSERT INTO ${TABLE} (${present.join(",")}) VALUES (${present.map(() => "?").join(",")})`;
		// Act
		const missing = () =>
			db.prepare(missingSql).run(...present.map((name) => row[name as keyof typeof row]));
		const nullValue = () => insert(db, { [column]: null });
		// Assert
		expect(missing).toThrow(/NOT NULL/);
		expect(nullValue).toThrow(/NOT NULL/);
		expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual([]);
	});

	it.each(columns.filter((column) => column !== "created_at_ms"))(
		"rejects blank, NUL and blob %s",
		(column) => {
			// Arrange
			const db = setup(source);
			// Act
			const attempts = ["", "   ", "bad\0value", Buffer.from("blob")].map(
				(value) => () => insert(db, { [column]: value }),
			);
			// Assert
			for (const attempt of attempts) expect(attempt).toThrow(/CHECK constraint failed/);
			expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual([]);
		},
	);

	it.each([
		{ fingerprint: "g".repeat(64) },
		{ fingerprint: "A".repeat(64) },
		{ fingerprint: "a".repeat(63) },
		{ key_id: "g".repeat(64) },
		{ key_id: "B".repeat(64) },
		{ key_id: "b".repeat(65) },
		{ created_at_ms: -1 },
		{ created_at_ms: 0.5 },
		{ created_at_ms: "not-a-time" },
		{ created_at_ms: Number.MAX_SAFE_INTEGER + 1 },
		{ auth_config_revision: "opaque-config-revision-v1" },
		{ created_at_ms: Buffer.from("0") },
	])("rejects invalid digest/time %j", (changes) => {
		// Arrange
		const db = setup(source);
		// Act
		const invalid = () => insert(db, changes);
		// Assert
		expect(invalid).toThrow(/CHECK constraint failed/);
		expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual([]);
	});
});

it("reapplying the migration preserves claims and every existing coordinator table", () => {
	// Arrange
	const db = setup("Worker");
	db.exec(
		"INSERT INTO groups (group_id, created_at) VALUES ('fixture-group', '2026-10-01T00:00:00.000Z')",
	);
	insert(db);
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as { name: string }[];
	const snapshot = () =>
		tables.map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name}"`).all() }));
	const before = snapshot();
	const migration = readFileSync(join(worker, "migrations", migrationNames[0] as string), "utf8");
	// Act
	db.exec(migration);
	db.exec(migration);
	// Assert
	expect(snapshot()).toEqual(before);
	expect(
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all(),
	).toEqual(tables);
});
