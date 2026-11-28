import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { connect, connectReadOnly } from "./db.js";
import { prepareOfflineScopeServingStore } from "./offline-serving-preparation.js";
import { columnExists, tableExists } from "./schema-lookups.js";
import { MemoryStore } from "./store.js";
import { insertTestSession } from "./test-utils.js";
import { readVectorCorpusFence } from "./vector-corpus-epoch.js";

let home: string, path: string;
const prep = {
	coordinatorId: "fixture",
	groupId: "team",
	generation: "ddc460b1-6dd8-4489-ab5c-799c2319af62",
};
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "project-storage-"));
	path = join(home, "device.sqlite");
	const db = connect(path);
	try {
		const session = insertTestSession(db);
		db.prepare(`INSERT INTO memory_items(session_id,title,kind,body_text,created_at,updated_at)
		VALUES(?,'initial','discovery','orchid','now','now')`).run(session);
	} finally {
		db.close();
	}
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

it("preserves history, updates and deletes from the FTS index, and supports a second group", () => {
	prepareOfflineScopeServingStore(path, prep, []);
	prepareOfflineScopeServingStore(path, { ...prep, groupId: "second" }, []);
	const store = new MemoryStore(path);
	try {
		const db = store.db;
		expect(tableExists(db, "memory_items")).toBe(true);
		expect(columnExists(db, "sync_device", "public_key")).toBe(true);
		expect(readVectorCorpusFence(db).epoch).not.toBeNull();
		const matches = (word: string) =>
			db.prepare(`SELECT body_text FROM memory_fts WHERE memory_fts MATCH ?`).pluck().all(word);
		expect(matches("orchid")).toEqual(["orchid"]);
		db.prepare("UPDATE memory_items SET body_text=? WHERE id=1").run("lilac");
		expect(matches("orchid")).toEqual([]);
		expect(matches("lilac")).toEqual(["lilac"]);
		db.prepare("DELETE FROM memory_items WHERE id=1").run();
		expect(matches("lilac")).toEqual([]);
		expect(db.pragma("foreign_key_check")).toEqual([]);
	} finally {
		store.close();
	}
});

it("keeps literal data, comments, and named bindings unchanged on read-only opens", () => {
	prepareOfflineScopeServingStore(path, prep, []);
	const db = connectReadOnly(path);
	try {
		expect(
			db
				.prepare(`SELECT 'memory_items' AS literal,@sync_device AS value,body_text
			FROM [MEMORY_ITEMS] /* 'memory_items' */ WHERE id=1 -- sync_device`)
				.get({ sync_device: "replication_ops" }),
		).toEqual({ literal: "memory_items", value: "replication_ops", body_text: "orchid" });
	} finally {
		db.close();
	}
});

it("rolls the table changes back when proof validation fails", () => {
	expect(() =>
		prepareOfflineScopeServingStore(path, prep, [
			{ scopeId: "", deviceId: "peer", keyId: "ab".repeat(32), envelope: Buffer.from("x") },
		]),
	).toThrow("Invalid scope serving envelope");
	const db = new Database(path, { readonly: true });
	try {
		expect(
			db.prepare("SELECT body_text FROM memory_fts WHERE memory_fts MATCH 'orchid'").pluck().get(),
		).toBe("orchid");
		expect(
			db
				.prepare(
					"SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('project_memory_items','scope_serving_preparations')",
				)
				.pluck()
				.get(),
		).toBe(0);
	} finally {
		db.close();
	}
});

it("refuses mixed shapes on all current opens rather than using a restored legacy table", () => {
	prepareOfflineScopeServingStore(path, prep, []);
	const raw = new Database(path);
	try {
		raw.exec("CREATE TABLE sync_device(fake TEXT)");
	} finally {
		raw.close();
	}
	expect(() => connect(path)).toThrow("conflicting Project storage format");
	expect(() => connectReadOnly(path)).toThrow("conflicting Project storage format");
});
