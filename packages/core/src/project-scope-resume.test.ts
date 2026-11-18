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
	input: {
		scopeId: string;
		origin: string;
		updatedAt: string;
		active?: number;
		/** Who wrote the stored (winning) revision, as conflict resolution records it. */
		clockDeviceId?: string;
		rev?: number;
	},
) {
	const sessionId = insertTestSession(db);
	return Number(
		db
			.prepare(
				`INSERT INTO memory_items(
				 session_id, kind, title, body_text, active, created_at, updated_at,
				 import_key, scope_id, visibility, origin_device_id, rev, metadata_json
				 ) VALUES (?, 'discovery', ?, 'body', ?, ?, ?, ?, ?, 'shared', ?, ?, ?)`,
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
				input.rev ?? 1,
				JSON.stringify(input.clockDeviceId ? { clock_device_id: input.clockDeviceId } : {}),
			).lastInsertRowid,
	);
}

let opSequence = 0;

/** An op already in the log, as if recorded or applied before this undo. */
function recordOp(
	memoryKey: string,
	input: { deviceId: string; opType: "upsert" | "delete"; at: string; rev?: number },
) {
	opSequence += 1;
	db.prepare(
		`INSERT INTO replication_ops(
		 op_id, entity_type, entity_id, op_type, payload_json, clock_rev, clock_updated_at,
		 clock_device_id, device_id, created_at, scope_id
		 ) VALUES (?, 'memory_item', ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
	).run(
		`seed-op-${opSequence}`,
		memoryKey,
		input.opType,
		input.rev ?? 1,
		input.at,
		input.deviceId,
		input.deviceId,
		input.at,
		SCOPE,
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

	it("re-sends every memory this device wrote in the Project, including changes from just before it withdrew", () => {
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

		// own-before may have been held back too: a push while withdrawn moves past it.
		expect(result.resentMemoryCount).toBe(3);
		expect(opsFor("own-during")).toEqual(["upsert"]);
		expect(opsFor("own-deleted")).toEqual(["delete"]);
		expect(opsFor("own-before")).toEqual(["upsert"]);
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

describe("undoing a local withdrawal: who changed a memory last", () => {
	it("re-sends this device's own changes to memories another device created", () => {
		// Arrange: same-person memories created on the peer. This device deleted one;
		// the peer itself last changed the other.
		insertMemory("peer-deleted-here", {
			scopeId: SCOPE,
			origin: PEER,
			updatedAt: "2026-11-18T11:00:00.000Z",
			active: 0,
			clockDeviceId: LOCAL,
		});
		insertMemory("peer-changed-there", {
			scopeId: SCOPE,
			origin: PEER,
			updatedAt: "2026-11-18T11:00:00.000Z",
			clockDeviceId: PEER,
		});
		recordOp("peer-deleted-here", {
			deviceId: PEER,
			opType: "upsert",
			at: "2026-11-18T09:00:00.000Z",
		});
		recordOp("peer-deleted-here", {
			deviceId: LOCAL,
			opType: "delete",
			at: "2026-11-18T11:00:00.000Z",
		});
		recordOp("peer-changed-there", {
			deviceId: LOCAL,
			opType: "upsert",
			at: "2026-11-18T09:00:00.000Z",
		});
		recordOp("peer-changed-there", {
			deviceId: PEER,
			opType: "upsert",
			at: "2026-11-18T11:00:00.000Z",
		});

		// Act
		resumeProjectScopeSync(db, {
			scopeId: SCOPE,
			deviceId: LOCAL,
			now: "2026-11-18T12:00:00.000Z",
		});

		// Assert
		expect(opsFor("peer-deleted-here")).toEqual(["delete"]);
		expect(opsFor("peer-changed-there")).toEqual([]);
	});

	it("leaves a memory this device created alone when another device changed it last", () => {
		insertMemory("own-changed-there", {
			scopeId: SCOPE,
			origin: LOCAL,
			updatedAt: "2026-11-18T11:00:00.000Z",
			clockDeviceId: PEER,
		});
		recordOp("own-changed-there", {
			deviceId: LOCAL,
			opType: "upsert",
			at: "2026-11-18T09:00:00.000Z",
		});
		recordOp("own-changed-there", {
			deviceId: PEER,
			opType: "upsert",
			at: "2026-11-18T11:00:00.000Z",
		});

		resumeProjectScopeSync(db, {
			scopeId: SCOPE,
			deviceId: LOCAL,
			now: "2026-11-18T12:00:00.000Z",
		});

		expect(opsFor("own-changed-there")).toEqual([]);
	});

	it("re-sends a winning local delete that a lower-revision remote op was logged after", () => {
		// Arrange: this device deleted the memory at revision 3. The peer's revision-2
		// change arrived later and lost, but it was still logged.
		insertMemory("local-delete-won", {
			scopeId: SCOPE,
			origin: PEER,
			updatedAt: "2026-11-18T10:30:00.000Z",
			active: 0,
			clockDeviceId: LOCAL,
			rev: 3,
		});
		recordOp("local-delete-won", {
			deviceId: LOCAL,
			opType: "delete",
			at: "2026-11-18T10:30:00.000Z",
			rev: 3,
		});
		recordOp("local-delete-won", {
			deviceId: PEER,
			opType: "upsert",
			at: "2026-11-18T10:45:00.000Z",
			rev: 2,
		});

		// Act
		resumeProjectScopeSync(db, {
			scopeId: SCOPE,
			deviceId: LOCAL,
			now: "2026-11-18T12:00:00.000Z",
		});

		// Assert
		expect(opsFor("local-delete-won")).toEqual(["delete"]);
	});
});
