import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { repairAmbiguousMemory } from "./memory-copy-repair.js";
import { applyReplicationOps } from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

const NOW = "2026-11-27T12:00:00.000Z";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});

afterEach(() => db.close());

function insertCopy(rev: number, body: string): number {
	return Number(
		db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
				 visibility, origin_device_id, active, metadata_json, import_key, scope_id, rev)
				 VALUES (?, 'discovery', 'Title', ?, ?, ?, 'shared', 'peer-a', 1, '{"clock_device_id":"peer-a"}',
				 'key:duplicated', 'scope-a', ?)`,
			)
			.run(insertTestSession(db), body, NOW, NOW, rev).lastInsertRowid,
	);
}

function incomingUpsert(rev: number): ReplicationOp {
	return {
		op_id: `incoming-${rev}`,
		entity_type: "memory_item",
		entity_id: "key:duplicated",
		op_type: "upsert",
		payload_json: JSON.stringify({
			kind: "discovery",
			title: "Title",
			body_text: `Revision ${rev}`,
			visibility: "shared",
			scope_id: "scope-a",
		}),
		clock_rev: rev,
		clock_updated_at: "2026-11-27T12:03:00.000Z",
		clock_device_id: "peer-a",
		device_id: "peer-a",
		created_at: "2026-11-27T12:03:00.000Z",
		scope_id: "scope-a",
	};
}

function heldOpIds(): string[] {
	return db.prepare("SELECT op_id FROM memory_ambiguous_held_ops").pluck().all() as string[];
}

function insertOther(rev: number): number {
	return Number(
		db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
				 visibility, origin_device_id, active, metadata_json, import_key, scope_id, rev)
				 VALUES (?, 'discovery', 'Other', 'Other 1', ?, ?, 'shared', 'peer-a', 1,
				 '{"clock_device_id":"peer-a"}', 'key:other', 'scope-a', ?)`,
			)
			.run(insertTestSession(db), NOW, NOW, rev).lastInsertRowid,
	);
}

function otherUpsert(rev: number): ReplicationOp {
	return { ...incomingUpsert(rev), op_id: `other-${rev}`, entity_id: "key:other" };
}

it("holds a revision for the copy left after a duplicate is removed, and repair applies it", () => {
	// Arrange: one of two copies goes away.
	const kept = insertCopy(1, "Revision 1");
	const removed = insertCopy(1, "Revision 1, again");
	db.prepare("DELETE FROM memory_items WHERE id = ?").run(removed);

	// Act + Assert: the revision is held without an error, so the sender's cursor moves on.
	expect(applyReplicationOps(db, [incomingUpsert(3)], "local")).toMatchObject({
		applied: 0,
		skipped: 1,
		errors: [],
	});
	expect(heldOpIds()).toEqual(["incoming-3"]);
	expect(db.prepare("SELECT rev FROM memory_items WHERE id = ?").pluck().get(kept)).toBe(1);

	// Act + Assert: the repair applies the held revision.
	expect(repairAmbiguousMemory(db, kept, { localDeviceId: "local" })).toMatchObject({
		status: "repaired",
	});
	expect(db.prepare("SELECT rev, body_text FROM memory_items WHERE id = ?").get(kept)).toEqual({
		rev: 3,
		body_text: "Revision 3",
	});
	expect(heldOpIds()).toEqual([]);
});

it("keeps applying later changes from the same peer while one memory is held", () => {
	// Arrange: a duplicated memory and an ordinary one.
	insertCopy(1, "Revision 1");
	insertCopy(1, "Revision 1, again");
	const other = insertOther(1);

	// Act: two batches, the first carrying a change for the duplicated memory.
	const first = applyReplicationOps(db, [incomingUpsert(3), otherUpsert(2)], "local");
	const second = applyReplicationOps(db, [otherUpsert(3)], "local");

	// Assert: neither batch fails, so the cursor advances, and the other memory keeps up.
	expect(first).toMatchObject({ applied: 1, skipped: 1, errors: [] });
	expect(second).toMatchObject({ applied: 1, errors: [] });
	expect(db.prepare("SELECT rev FROM memory_items WHERE id = ?").pluck().get(other)).toBe(3);
	expect(heldOpIds()).toEqual(["incoming-3"]);
});

it("applies a held change once every copy is gone", () => {
	// Arrange: a change held while two copies exist, then both copies removed.
	insertCopy(1, "Revision 1");
	insertCopy(1, "Revision 1, again");
	applyReplicationOps(db, [incomingUpsert(3)], "local");
	db.prepare("DELETE FROM memory_items").run();

	// Act: the next batch, even an empty one.
	applyReplicationOps(db, [], "local");

	// Assert: the held change is the only copy now.
	expect(db.prepare("SELECT body_text FROM memory_items").pluck().all()).toEqual(["Revision 3"]);
	expect(heldOpIds()).toEqual([]);
});

it("replays held changes in the order they arrived, so a later delete stays applied", () => {
	// Arrange: an upsert and then a delete held in the same millisecond. The delete's
	// op ID sorts first, so ordering by time and op ID would replay it first.
	insertCopy(1, "Revision 1");
	insertCopy(1, "Revision 1, again");
	const upsert = { ...incomingUpsert(3), op_id: "z-upsert" };
	const deletion: ReplicationOp = {
		...incomingUpsert(4),
		op_id: "a-delete",
		op_type: "delete",
		payload_json: null,
	};
	applyReplicationOps(db, [upsert, deletion], "local");
	db.prepare("UPDATE memory_ambiguous_held_ops SET held_at = ?").run(NOW);
	db.prepare("DELETE FROM memory_items").run();

	// Act
	applyReplicationOps(db, [], "local");

	// Assert: the upsert recreated the memory, then the delete removed it again.
	expect(db.prepare("SELECT active, rev FROM memory_items").all()).toEqual([{ active: 0, rev: 4 }]);
	expect(heldOpIds()).toEqual([]);
});

it("keeps a change held again at its first place in the order", () => {
	insertCopy(1, "Revision 1");
	insertCopy(1, "Revision 1, again");
	applyReplicationOps(db, [incomingUpsert(3), incomingUpsert(4)], "local");
	applyReplicationOps(db, [incomingUpsert(3)], "local");

	expect(
		db.prepare("SELECT op_id FROM memory_ambiguous_held_ops ORDER BY arrival").pluck().all(),
	).toEqual(["incoming-3", "incoming-4"]);
});

it("applies to none of a memory's copies when this device stores more than one", () => {
	// Arrange: two copies at different revisions; comparing against either would pick one.
	const older = insertCopy(1, "Revision 1");
	const newer = insertCopy(5, "Revision 5");
	const op: ReplicationOp = {
		op_id: "incoming-3",
		entity_type: "memory_item",
		entity_id: "key:duplicated",
		op_type: "upsert",
		payload_json: JSON.stringify({
			kind: "discovery",
			title: "Title",
			body_text: "Revision 3",
			visibility: "shared",
			scope_id: "scope-a",
		}),
		clock_rev: 3,
		clock_updated_at: "2026-11-27T12:03:00.000Z",
		clock_device_id: "peer-a",
		device_id: "peer-a",
		created_at: "2026-11-27T12:03:00.000Z",
		scope_id: "scope-a",
	};

	// Act
	const result = applyReplicationOps(db, [op], "local");

	// Assert: both copies stay as they were, and the op is held, not recorded as applied.
	expect(result).toMatchObject({ applied: 0, skipped: 1, errors: [] });
	expect(db.prepare("SELECT id, rev, body_text FROM memory_items ORDER BY id").all()).toEqual([
		{ id: older, rev: 1, body_text: "Revision 1" },
		{ id: newer, rev: 5, body_text: "Revision 5" },
	]);
	expect(db.prepare("SELECT COUNT(*) FROM replication_ops").pluck().get()).toBe(0);
});
