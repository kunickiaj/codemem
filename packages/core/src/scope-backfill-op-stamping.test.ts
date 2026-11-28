import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillScopeIds } from "./scope-backfill.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

const NOW = "2026-11-27T12:00:00.000Z";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});

afterEach(() => db.close());

function insertCopy(importKey: string, scopeId: string, rev: number): void {
	db.prepare(
		`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
		 visibility, active, metadata_json, import_key, scope_id, rev)
		 VALUES (?, 'discovery', 'Title', 'Body', ?, ?, 'shared', 1, '{}', ?, ?, ?)`,
	).run(insertTestSession(db), NOW, NOW, importKey, scopeId, rev);
}

/** An op from before ops carried a scope. */
function insertLegacyOp(opId: string, importKey: string, clockRev: number): void {
	db.prepare(
		`INSERT INTO replication_ops(op_id, entity_type, entity_id, op_type, payload_json, clock_rev,
		 clock_updated_at, clock_device_id, device_id, created_at, scope_id)
		 VALUES (?, 'memory_item', ?, 'upsert', '{"body_text":"Old body"}', ?, ?, 'local', 'local', ?, NULL)`,
	).run(opId, importKey, clockRev, NOW, NOW);
}

function opScopes(): Record<string, string | null> {
	const rows = db
		.prepare("SELECT op_id, scope_id FROM replication_ops ORDER BY op_id")
		.all() as Array<{
		op_id: string;
		scope_id: string | null;
	}>;
	return Object.fromEntries(rows.map((row) => [row.op_id, row.scope_id]));
}

describe("stamping a scope on ops from before scopes", () => {
	it("leaves an op unstamped when copies in different scopes share its import key", () => {
		insertCopy("key:reused", "scope-a", 1);
		insertCopy("key:reused", "scope-b", 1);
		insertLegacyOp("op-reused", "key:reused", 1);

		backfillScopeIds(db, { now: NOW });

		expect(opScopes()).toEqual({ "op-reused": null });
	});

	it("stamps only the op for the copy's current revision", () => {
		insertCopy("key:single", "scope-a", 3);
		insertLegacyOp("op-old", "key:single", 2);
		insertLegacyOp("op-current", "key:single", 3);

		backfillScopeIds(db, { now: NOW });

		expect(opScopes()).toEqual({ "op-current": "scope-a", "op-old": null });
	});
});
