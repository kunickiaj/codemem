import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	ensureMemoryCopyAmbiguitySchema,
	listAmbiguousMemoryCopies,
	repairAmbiguousMemoryCopy,
} from "./memory-copy-ambiguity.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

const NOW = "2026-11-27T12:00:00.000Z";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});

afterEach(() => db.close());

function insertCopy(scopeId: string | null, importKey = "key:a"): number {
	return Number(
		db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
				 visibility, active, metadata_json, import_key, scope_id, rev)
				 VALUES (?, 'discovery', 'Title', 'Body', ?, ?, 'shared', 1, '{}', ?, ?, 1)`,
			)
			.run(insertTestSession(db), NOW, NOW, importKey, scopeId).lastInsertRowid,
	);
}

it("records a key once a second copy is stored in the same scope, and keeps it after one goes", () => {
	const first = insertCopy("scope-a");
	insertCopy("scope-b");
	expect(listAmbiguousMemoryCopies(db)).toEqual([]);

	const second = insertCopy("scope-a");
	db.prepare("DELETE FROM memory_items WHERE id = ?").run(second);

	expect(listAmbiguousMemoryCopies(db)).toEqual([{ scope_id: "scope-a", memory_ids: [first] }]);
});

it("records a key when a copy moves into a scope that already holds one", () => {
	const kept = insertCopy("scope-a");
	const moved = insertCopy("scope-b");

	db.prepare("UPDATE memory_items SET scope_id = 'scope-a' WHERE id = ?").run(moved);
	db.prepare("DELETE FROM memory_items WHERE id = ?").run(moved);

	expect(listAmbiguousMemoryCopies(db)).toEqual([{ scope_id: "scope-a", memory_ids: [kept] }]);
});

it("records duplicates that were stored before the record existed", () => {
	db.exec(`DROP TRIGGER memory_ambiguous_copies_on_insert;
		DROP TRIGGER memory_ambiguous_copies_on_move;
		DROP TABLE memory_ambiguous_copies;`);
	const first = insertCopy(null);
	const second = insertCopy(null);

	ensureMemoryCopyAmbiguitySchema(db);

	expect(listAmbiguousMemoryCopies(db)).toEqual([{ scope_id: null, memory_ids: [first, second] }]);
});

it("repairs only a recorded memory that is the only copy left in its scope", () => {
	const lone = insertCopy("scope-b", "key:lone");
	const first = insertCopy("scope-a");
	const second = insertCopy("scope-a");

	expect(repairAmbiguousMemoryCopy(db, 9_999)).toEqual({ status: "not_found" });
	expect(repairAmbiguousMemoryCopy(db, lone)).toEqual({ status: "not_ambiguous" });
	expect(repairAmbiguousMemoryCopy(db, first)).toEqual({
		status: "copies_remain",
		memory_ids: [first, second],
	});
	db.prepare("DELETE FROM memory_items WHERE id = ?").run(second);
	expect(repairAmbiguousMemoryCopy(db, first)).toEqual({ status: "repaired", scope_id: "scope-a" });
	expect(listAmbiguousMemoryCopies(db)).toEqual([]);
});

it("scans for stored duplicates only when it creates the record", () => {
	db.exec(`DROP TRIGGER memory_ambiguous_copies_on_insert;
		DROP TRIGGER memory_ambiguous_copies_on_move;`);
	insertCopy("scope-a");
	insertCopy("scope-a");

	ensureMemoryCopyAmbiguitySchema(db);
	const afterReopen = listAmbiguousMemoryCopies(db);
	const third = insertCopy("scope-b");
	insertCopy("scope-b");

	expect(afterReopen).toEqual([]);
	expect(listAmbiguousMemoryCopies(db)).toEqual([
		{ scope_id: "scope-b", memory_ids: [third, third + 1] },
	]);
});
