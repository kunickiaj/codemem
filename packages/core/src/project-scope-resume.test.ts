import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resumeProjectScopeSync } from "./project-scope-resume.js";
import { isProjectScopeWithdrawn } from "./project-scope-withdrawal.js";
import { getReplicationCursor, setReplicationCursor } from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

const SCOPE = "managed-project:atlas";
const OTHER_SCOPE = "managed-project:other";
const LOCAL = "dev-local";
const PEER = "dev-peer";
const WITHDRAWN_AT = "2026-11-18T10:00:00.000Z";

let db: InstanceType<typeof Database>;

function insertMemory(
	importKey: string,
	input: { scopeId: string; origin: string; updatedAt: string; active?: number },
) {
	const sessionId = insertTestSession(db);
	return Number(
		db
			.prepare(
				`INSERT INTO memory_items(
				 session_id, kind, title, body_text, active, created_at, updated_at,
				 import_key, scope_id, visibility, origin_device_id, rev
				 ) VALUES (?, 'discovery', ?, 'body', ?, ?, ?, ?, ?, 'shared', ?, 1)`,
			)
			.run(
				sessionId,
				importKey,
				input.active ?? 1,
				input.updatedAt,
				input.updatedAt,
				importKey,
				input.scopeId,
				input.origin,
			).lastInsertRowid,
	);
}

function opsFor(memoryKey: string) {
	return db
		.prepare("SELECT op_type FROM replication_ops WHERE entity_id = ? AND created_at = ?")
		.pluck()
		.all(memoryKey, "2026-11-18T12:00:00.000Z");
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	// Cursors are kept only for paired peers.
	db.prepare(
		"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, 'fp', ?)",
	).run(PEER, WITHDRAWN_AT);
	db.prepare(
		`INSERT INTO project_scope_withdrawals(scope_id, canonical_project_identity, group_id, withdrawn_at)
		 VALUES (?, 'git:atlas', 'group-a', ?)`,
	).run(SCOPE, WITHDRAWN_AT);
});

afterEach(() => db.close());

describe("undoing a local withdrawal", () => {
	it("re-pulls only that scope from every peer", () => {
		setReplicationCursor(
			db,
			PEER,
			{ lastApplied: "2026-11-18T09:00:00Z|op-1", lastAcked: "2026-11-18T09:00:00Z|op-1" },
			SCOPE,
		);
		setReplicationCursor(
			db,
			PEER,
			{ lastApplied: "2026-11-18T09:00:00Z|op-2", lastAcked: "2026-11-18T09:00:00Z|op-2" },
			OTHER_SCOPE,
		);

		const result = resumeProjectScopeSync(db, {
			scopeId: SCOPE,
			deviceId: LOCAL,
			now: "2026-11-18T12:00:00.000Z",
		});

		expect(result.resumed).toBe(true);
		expect(isProjectScopeWithdrawn(db, SCOPE)).toBe(false);
		expect(getReplicationCursor(db, PEER, SCOPE)).toEqual([null, null]);
		expect(getReplicationCursor(db, PEER, OTHER_SCOPE)).toEqual([
			"2026-11-18T09:00:00Z|op-2",
			"2026-11-18T09:00:00Z|op-2",
		]);
	});

	it("re-sends this device's own memories changed while it was withdrawn", () => {
		insertMemory("own-during", {
			scopeId: SCOPE,
			origin: LOCAL,
			updatedAt: "2026-11-18T11:00:00.000Z",
		});
		insertMemory("own-deleted", {
			scopeId: SCOPE,
			origin: LOCAL,
			updatedAt: "2026-11-18T11:30:00.000Z",
			active: 0,
		});
		insertMemory("own-before", {
			scopeId: SCOPE,
			origin: LOCAL,
			updatedAt: "2026-11-18T09:00:00.000Z",
		});
		insertMemory("peer-during", {
			scopeId: SCOPE,
			origin: PEER,
			updatedAt: "2026-11-18T11:00:00.000Z",
		});
		insertMemory("own-other-scope", {
			scopeId: OTHER_SCOPE,
			origin: LOCAL,
			updatedAt: "2026-11-18T11:00:00.000Z",
		});

		const result = resumeProjectScopeSync(db, {
			scopeId: SCOPE,
			deviceId: LOCAL,
			now: "2026-11-18T12:00:00.000Z",
		});

		expect(result.resentMemoryCount).toBe(2);
		expect(opsFor("own-during")).toEqual(["upsert"]);
		expect(opsFor("own-deleted")).toEqual(["delete"]);
		expect(opsFor("own-before")).toEqual([]);
		expect(opsFor("peer-during")).toEqual([]);
		expect(opsFor("own-other-scope")).toEqual([]);
	});

	it("does nothing for a scope that isn't withdrawn", () => {
		setReplicationCursor(
			db,
			PEER,
			{ lastApplied: "2026-11-18T09:00:00Z|op-2", lastAcked: "2026-11-18T09:00:00Z|op-2" },
			OTHER_SCOPE,
		);

		const result = resumeProjectScopeSync(db, {
			scopeId: OTHER_SCOPE,
			deviceId: LOCAL,
			now: "2026-11-18T12:00:00.000Z",
		});

		expect(result).toEqual({ resumed: false, resentMemoryCount: 0 });
		expect(getReplicationCursor(db, PEER, OTHER_SCOPE)).toEqual([
			"2026-11-18T09:00:00Z|op-2",
			"2026-11-18T09:00:00Z|op-2",
		]);
	});
});
