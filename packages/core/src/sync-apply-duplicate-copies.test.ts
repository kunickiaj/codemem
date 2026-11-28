import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { repairAmbiguousMemoryCopy } from "./memory-copy-ambiguity.js";
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

it("applies nothing to the copy left after a duplicate is removed, until a repair confirms it", () => {
	// Arrange: one of two copies goes away.
	const kept = insertCopy(1, "Revision 1");
	const removed = insertCopy(1, "Revision 1, again");
	db.prepare("DELETE FROM memory_items WHERE id = ?").run(removed);

	// Act + Assert: still skipped while the key is recorded as stored twice.
	expect(applyReplicationOps(db, [incomingUpsert(3)], "local")).toMatchObject({
		applied: 0,
		skipped: 1,
	});
	expect(db.prepare("SELECT rev FROM memory_items WHERE id = ?").pluck().get(kept)).toBe(1);

	// Act + Assert: after the repair, the next revision applies.
	expect(repairAmbiguousMemoryCopy(db, kept)).toMatchObject({ status: "repaired" });
	expect(applyReplicationOps(db, [incomingUpsert(4)], "local")).toMatchObject({ applied: 1 });
	expect(db.prepare("SELECT rev, body_text FROM memory_items WHERE id = ?").get(kept)).toEqual({
		rev: 4,
		body_text: "Revision 4",
	});
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

	// Assert: both copies stay as they were, and the op is not recorded as applied.
	expect(result).toMatchObject({ applied: 0, skipped: 1 });
	expect(db.prepare("SELECT id, rev, body_text FROM memory_items ORDER BY id").all()).toEqual([
		{ id: older, rev: 1, body_text: "Revision 1" },
		{ id: newer, rev: 5, body_text: "Revision 5" },
	]);
	expect(db.prepare("SELECT COUNT(*) FROM replication_ops").pluck().get()).toBe(0);
});
