import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";

const schema = readFileSync(
	join(import.meta.dirname, "../../cloudflare-coordinator-worker/schema.sql"),
	"utf8",
);
const databases: SqliteDatabase[] = [];
const directories: string[] = [];

function databasePath() {
	const directory = mkdtempSync(join(tmpdir(), "coordinator-fixture-"));
	directories.push(directory);
	return join(directory, "coordinator.sqlite");
}

function openDatabase(path: string) {
	const db = new Database(path);
	databases.push(db);
	return db;
}

function fixtureDatabase(path: string) {
	const { db } = setupStore("D1", { databasePath: path });
	databases.push(db);
	return db;
}

function schemaObjects(db: SqliteDatabase) {
	return db
		.prepare(
			"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
		)
		.all();
}

function allRows(db: SqliteDatabase) {
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as { name: string }[];
	return tables.map(({ name }) => ({
		table: name,
		rows: db.prepare(`SELECT * FROM ${name}`).all(),
	}));
}

function settings(db: SqliteDatabase) {
	return Object.fromEntries(
		[
			"foreign_keys",
			"journal_mode",
			"synchronous",
			"busy_timeout",
			"locking_mode",
			"recursive_triggers",
			"wal_autocheckpoint",
		].map((name) => [name, db.pragma(name, { simple: true })]),
	);
}

afterEach(() => {
	for (const db of databases.splice(0)) if (db.open) db.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe.each(["memory", "file"] as const)("D1 %s fixture initialization", (storage) => {
	it("preserves the entire schema, empty tables, and default connection settings", () => {
		// Arrange: the reference applies the exact Worker schema without an enclosing transaction.
		const path = storage === "memory" ? ":memory:" : databasePath();
		const referencePath = storage === "memory" ? ":memory:" : databasePath();
		const reference = openDatabase(referencePath);
		reference.exec(schema);

		// Act
		const db = fixtureDatabase(path);

		// Assert: initialization must not omit schema objects, seed rows, or relax durability.
		expect(schemaObjects(db)).toEqual(schemaObjects(reference));
		expect(allRows(db)).toEqual(allRows(reference));
		expect(allRows(db).every(({ rows }) => rows.length === 0)).toBe(true);
		expect(settings(db)).toEqual(settings(reference));
		expect(settings(db)).toMatchObject({
			foreign_keys: 1,
			journal_mode: storage === "memory" ? "memory" : "delete",
			synchronous: 2,
		});
		expect(db.inTransaction).toBe(false);
	});

	it("accepts a valid row and rejects duplicates without changing any table", () => {
		// Arrange
		const db = fixtureDatabase(storage === "memory" ? ":memory:" : databasePath());
		const insert = db.prepare("INSERT INTO request_nonces VALUES (?, ?, ?)");

		// Act
		insert.run("device-a", "nonce-a", "2026-10-06T00:00:00.000Z");
		const before = allRows(db);

		// Assert: schema constraints remain effective after initialization commits.
		expect(db.prepare("SELECT * FROM request_nonces").all()).toEqual([
			{ device_id: "device-a", nonce: "nonce-a", created_at: "2026-10-06T00:00:00.000Z" },
		]);
		expect(() => insert.run("device-a", "nonce-a", "2026-10-07T00:00:00.000Z")).toThrow(
			/UNIQUE constraint failed/,
		);
		expect(allRows(db)).toEqual(before);
	});
});

it("retains the full schema and committed rows through a real file close and reopen", () => {
	// Arrange
	const path = databasePath();
	const db = fixtureDatabase(path);
	db.prepare("INSERT INTO request_nonces VALUES (?, ?, ?)").run(
		"device-a",
		"nonce-a",
		"2026-10-06T00:00:00.000Z",
	);
	const before = { objects: schemaObjects(db), rows: allRows(db), settings: settings(db) };

	// Act
	db.close();
	const reopened = openDatabase(path);

	// Assert: neither an uncommitted schema nor an uncommitted row may disappear.
	expect({
		objects: schemaObjects(reopened),
		rows: allRows(reopened),
		settings: settings(reopened),
	}).toEqual(before);
	expect(() =>
		reopened
			.prepare("INSERT INTO request_nonces VALUES (?, ?, ?)")
			.run("device-a", "nonce-a", "2026-10-07T00:00:00.000Z"),
	).toThrow(/UNIQUE constraint failed/);
	expect(allRows(reopened)).toEqual(before.rows);
});

it("creates independent fresh databases without carrying rows between fixtures", () => {
	// Arrange
	const first = fixtureDatabase(databasePath());
	first
		.prepare("INSERT INTO request_nonces VALUES (?, ?, ?)")
		.run("device-a", "nonce-a", "2026-10-06T00:00:00.000Z");
	const before = allRows(first);

	// Act
	const second = fixtureDatabase(databasePath());

	// Assert: creating another fixture neither inherits nor removes the first fixture's data.
	expect(schemaObjects(second)).toEqual(schemaObjects(first));
	expect(allRows(second).every(({ rows }) => rows.length === 0)).toBe(true);
	expect(allRows(first)).toEqual(before);
});
