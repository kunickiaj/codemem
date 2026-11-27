import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { columnExists, tableExists } from "./schema-lookups.js";

type Db = InstanceType<typeof Database>;

let db: Db;

/** How many lookup statements the connection compiles while `work` runs. */
function lookupsCompiled(target: Db, work: () => void): number {
	const prepare = vi.spyOn(target, "prepare");
	work();
	const compiled = prepare.mock.calls.filter(([sql]) =>
		/sqlite_master|pragma_table_info/u.test(String(sql)),
	).length;
	prepare.mockRestore();
	return compiled;
}

beforeEach(() => {
	db = new Database(":memory:");
	db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT)");
});

afterEach(() => {
	db.close();
});

describe("tableExists and columnExists", () => {
	it("answer for tables and columns that exist and that do not", () => {
		expect(tableExists(db, "notes")).toBe(true);
		expect(tableExists(db, "missing")).toBe(false);
		expect(columnExists(db, "notes", "title")).toBe(true);
		expect(columnExists(db, "notes", "missing")).toBe(false);
		expect(columnExists(db, "missing", "title")).toBe(false);
	});

	it("ask the database once while the schema stays the same", () => {
		const first = lookupsCompiled(db, () => {
			tableExists(db, "notes");
			tableExists(db, "missing");
			columnExists(db, "notes", "title");
		});
		const repeated = lookupsCompiled(db, () => {
			for (let index = 0; index < 100; index++) {
				tableExists(db, "notes");
				tableExists(db, "missing");
				columnExists(db, "notes", "title");
			}
		});

		expect(first).toBe(3);
		expect(repeated).toBe(0);
	});

	it("see a table created after it was found missing", () => {
		expect(tableExists(db, "later")).toBe(false);

		db.exec("CREATE TABLE later(id INTEGER PRIMARY KEY)");

		expect(tableExists(db, "later")).toBe(true);
	});

	it("see a dropped table and an added column", () => {
		expect(tableExists(db, "notes")).toBe(true);
		expect(columnExists(db, "notes", "body")).toBe(false);

		db.exec("ALTER TABLE notes ADD COLUMN body TEXT");
		const added = columnExists(db, "notes", "body");
		db.exec("DROP TABLE notes");

		expect(added).toBe(true);
		expect(tableExists(db, "notes")).toBe(false);
		expect(columnExists(db, "notes", "body")).toBe(false);
	});

	it("keep the answers of two connections apart", () => {
		const other = new Database(":memory:");
		expect(tableExists(db, "notes")).toBe(true);

		expect(tableExists(other, "notes")).toBe(false);
		other.close();
	});
});

describe("schema changes from another connection", () => {
	let dir: string;
	let viewer: Db;
	let worker: Db;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codemem-schema-lookups-"));
		const path = join(dir, "mem.sqlite");
		viewer = new Database(path);
		viewer.pragma("journal_mode = WAL");
		viewer.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY)");
		worker = new Database(path);
	});

	afterEach(() => {
		worker.close();
		viewer.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("are seen on the next lookup", () => {
		expect(tableExists(viewer, "later")).toBe(false);
		expect(columnExists(viewer, "notes", "title")).toBe(false);

		worker.exec("CREATE TABLE later(id INTEGER PRIMARY KEY)");
		worker.exec("ALTER TABLE notes ADD COLUMN title TEXT");

		expect(tableExists(viewer, "later")).toBe(true);
		expect(columnExists(viewer, "notes", "title")).toBe(true);
	});

	it("do not bring back an answer from a rolled-back transaction", () => {
		tableExists(viewer, "notes");
		viewer.exec("BEGIN");
		viewer.exec("CREATE TABLE rolled_back(id INTEGER PRIMARY KEY)");
		const insideTransaction = tableExists(viewer, "rolled_back");
		viewer.exec("ROLLBACK");
		// The schema counter reaches the value the rolled-back transaction had given it.
		worker.exec("CREATE TABLE committed(id INTEGER PRIMARY KEY)");

		expect(insideTransaction).toBe(true);
		expect(tableExists(viewer, "rolled_back")).toBe(false);
		expect(tableExists(viewer, "committed")).toBe(true);
	});
});
