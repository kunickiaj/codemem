import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryCopyId, opCopyId } from "./memory-copy-provenance.js";
import { recordReplicationOp, recordScopeReassignment } from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

const NOW = "2026-11-27T12:00:00.000Z";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});

afterEach(() => db.close());

function insertCopy(importKey: string, scopeId = "scope-a", id?: number): number {
	return Number(
		db
			.prepare(
				`INSERT INTO memory_items(id, session_id, kind, title, body_text, created_at, updated_at,
				 visibility, active, metadata_json, import_key, scope_id, rev)
				 VALUES (?, ?, 'discovery', 'Title', 'Body', ?, ?, 'shared', 1, '{}', ?, ?, 1)`,
			)
			.run(id ?? null, insertTestSession(db), NOW, NOW, importKey, scopeId).lastInsertRowid,
	);
}

describe("copy identity", () => {
	it("names the stored copy each recorded op was built from", () => {
		const memoryId = insertCopy("key:a");

		const opId = recordReplicationOp(db, { memoryId, opType: "upsert", deviceId: "local" });

		expect(opCopyId(db, opId)).toBe(memoryCopyId(db, memoryId));
	});

	it("names both sides of a move after the copy that moved", () => {
		const memoryId = insertCopy("key:a", "source");

		const { oldOpId, newOpId } = recordScopeReassignment(db, {
			operationId: "move",
			memoryId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "local",
			createdAt: NOW,
		});

		expect([opCopyId(db, oldOpId), opCopyId(db, newOpId)]).toEqual([
			memoryCopyId(db, memoryId),
			memoryCopyId(db, memoryId),
		]);
	});

	it("differs between copies that share an import key, scope and revision", () => {
		const first = insertCopy("key:shared");
		const second = insertCopy("key:shared");

		expect(memoryCopyId(db, first)).not.toBe(memoryCopyId(db, second));
	});

	it("is not inherited by a row that reuses a deleted row's id", () => {
		const memoryId = insertCopy("key:a");
		const original = memoryCopyId(db, memoryId);

		db.prepare("DELETE FROM memory_items WHERE id = ?").run(memoryId);
		insertCopy("key:a", "scope-a", memoryId);

		expect(memoryCopyId(db, memoryId)).not.toBe(original);
	});

	it("cannot be changed, and an op's record goes with the op", () => {
		const memoryId = insertCopy("key:a");
		const opId = recordReplicationOp(db, { memoryId, opType: "upsert", deviceId: "local" });

		expect(() =>
			db
				.prepare("UPDATE memory_copy_identities SET copy_id = 'other' WHERE memory_id = ?")
				.run(memoryId),
		).toThrow("memory_copy_identity_immutable");
		db.prepare("DELETE FROM replication_ops WHERE op_id = ?").run(opId);
		expect(opCopyId(db, opId)).toBeNull();
	});
});
