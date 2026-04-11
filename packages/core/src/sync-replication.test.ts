import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toJson } from "./db.js";
import {
	applyReplicationOps,
	backfillReplicationOps,
	bulkPruneReplicationOpsByAgeCutoff,
	chunkOpsBySize,
	clockTuple,
	extractReplicationOps,
	filterReplicationOpsForSync,
	filterReplicationOpsForSyncWithStatus,
	getReplicationCursor,
	getSyncResetState,
	hasUnsyncedSharedMemoryChanges,
	isNewerClock,
	loadMemorySnapshotPageForPeer,
	loadReplicationOpsForPeer,
	loadReplicationOpsSince,
	migrateLegacyImportKeys,
	planReplicationOpsAgePrune,
	pruneReplicationOps,
	pruneReplicationOpsUntilCaughtUp,
	recordReplicationOp,
	setReplicationCursor,
	setSyncResetState,
} from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOp(id: string, payloadSize = 10): ReplicationOp {
	return {
		op_id: id,
		entity_type: "memory",
		entity_id: `ent-${id}`,
		op_type: "upsert",
		payload_json: "x".repeat(payloadSize),
		clock_rev: 1,
		clock_updated_at: "2026-01-01T00:00:00Z",
		clock_device_id: "dev-a",
		device_id: "dev-a",
		created_at: "2026-01-01T00:00:00Z",
	};
}

// ---------------------------------------------------------------------------
// chunkOpsBySize
// ---------------------------------------------------------------------------

describe("chunkOpsBySize", () => {
	it("returns a single batch when all ops fit", () => {
		const ops = [makeOp("1"), makeOp("2")];
		const batches = chunkOpsBySize(ops, 100_000);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(2);
	});

	it("splits into multiple batches when ops exceed limit", () => {
		const ops = [makeOp("1", 200), makeOp("2", 200), makeOp("3", 200)];
		// Choose a limit that fits ~1-2 ops but not all 3
		const singleSize = new TextEncoder().encode(JSON.stringify({ ops: [ops[0]] })).byteLength;
		const batches = chunkOpsBySize(ops, singleSize * 2);
		expect(batches.length).toBeGreaterThan(1);
		// All ops should be present across batches
		const allOps = batches.flat();
		expect(allOps).toHaveLength(3);
	});

	it("throws when a single op exceeds the limit", () => {
		const ops = [makeOp("big", 10_000)];
		expect(() => chunkOpsBySize(ops, 100)).toThrow("single op exceeds size limit");
	});

	it("returns empty array for empty input", () => {
		expect(chunkOpsBySize([], 1000)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Cursor operations (require DB)
// ---------------------------------------------------------------------------

describe("replication cursors", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns [null, null] for unknown peer", () => {
		const [applied, acked] = getReplicationCursor(db, "unknown-peer");
		expect(applied).toBeNull();
		expect(acked).toBeNull();
	});

	it("round-trips cursor values after set", () => {
		setReplicationCursor(db, "peer-1", {
			lastApplied: "cursor-a",
			lastAcked: "cursor-b",
		});
		const [applied, acked] = getReplicationCursor(db, "peer-1");
		expect(applied).toBe("cursor-a");
		expect(acked).toBe("cursor-b");
	});

	it("updates only the specified cursor field via COALESCE", () => {
		setReplicationCursor(db, "peer-2", { lastApplied: "v1" });
		setReplicationCursor(db, "peer-2", { lastAcked: "ack-1" });

		const [applied, acked] = getReplicationCursor(db, "peer-2");
		expect(applied).toBe("v1"); // preserved via COALESCE
		expect(acked).toBe("ack-1");
	});

	it("overwrites cursor on subsequent set", () => {
		setReplicationCursor(db, "peer-3", { lastApplied: "old" });
		setReplicationCursor(db, "peer-3", { lastApplied: "new" });
		const [applied] = getReplicationCursor(db, "peer-3");
		expect(applied).toBe("new");
	});
});

// ---------------------------------------------------------------------------
// extractReplicationOps
// ---------------------------------------------------------------------------

describe("extractReplicationOps", () => {
	it("extracts ops from a valid payload", () => {
		const ops = [makeOp("1"), makeOp("2")];
		const result = extractReplicationOps({ ops });
		expect(result).toEqual(ops);
	});

	it("returns empty array for non-object payload", () => {
		expect(extractReplicationOps("not-an-object")).toEqual([]);
		expect(extractReplicationOps(null)).toEqual([]);
		expect(extractReplicationOps(42)).toEqual([]);
	});

	it("returns empty array when ops is missing", () => {
		expect(extractReplicationOps({ other: "data" })).toEqual([]);
	});

	it("returns empty array when ops is not an array", () => {
		expect(extractReplicationOps({ ops: "not-array" })).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// clockTuple
// ---------------------------------------------------------------------------

describe("clockTuple", () => {
	it("builds a 3-element tuple", () => {
		const t = clockTuple(3, "2026-01-01T00:00:00Z", "dev-a");
		expect(t).toEqual([3, "2026-01-01T00:00:00Z", "dev-a"]);
	});
});

// ---------------------------------------------------------------------------
// isNewerClock
// ---------------------------------------------------------------------------

describe("isNewerClock", () => {
	it("higher rev wins", () => {
		expect(isNewerClock([2, "a", "a"], [1, "z", "z"])).toBe(true);
		expect(isNewerClock([1, "z", "z"], [2, "a", "a"])).toBe(false);
	});

	it("same rev — tiebreaks on updated_at", () => {
		expect(isNewerClock([1, "b", "a"], [1, "a", "z"])).toBe(true);
		expect(isNewerClock([1, "a", "z"], [1, "b", "a"])).toBe(false);
	});

	it("same rev and updated_at — tiebreaks on device_id", () => {
		expect(isNewerClock([1, "a", "dev-b"], [1, "a", "dev-a"])).toBe(true);
		expect(isNewerClock([1, "a", "dev-a"], [1, "a", "dev-b"])).toBe(false);
	});

	it("identical clocks are not newer", () => {
		expect(isNewerClock([1, "a", "a"], [1, "a", "a"])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// recordReplicationOp
// ---------------------------------------------------------------------------

describe("recordReplicationOp", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("inserts an op and returns a UUID op_id", () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			sessionId,
			"discovery",
			"Test",
			"body",
			now,
			now,
			"key:1",
			3,
			toJson({ clock_device_id: "dev-a" }),
		);

		const memId = (
			db.prepare("SELECT id FROM memory_items WHERE import_key = ?").get("key:1") as { id: number }
		).id;

		const opId = recordReplicationOp(db, {
			memoryId: memId,
			opType: "upsert",
			deviceId: "dev-a",
		});

		expect(opId).toMatch(/^[0-9a-f-]{36}$/);

		const row = db.prepare("SELECT * FROM replication_ops WHERE op_id = ?").get(opId) as Record<
			string,
			unknown
		>;
		expect(row.entity_type).toBe("memory_item");
		expect(row.entity_id).toBe("key:1");
		expect(row.op_type).toBe("upsert");
		expect(row.clock_rev).toBe(3);
		expect(row.clock_device_id).toBe("dev-a");
	});

	it("includes full memory payload in upsert ops and round-trips all columns", () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		const meta = { clock_device_id: "dev-a", custom_field: "preserved" };
		db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, subtitle, body_text, confidence, tags_text,
				created_at, updated_at, import_key, rev, metadata_json, active,
				actor_id, actor_display_name, visibility, workspace_id, workspace_kind,
				origin_device_id, origin_source, trust_state, narrative,
				facts, concepts, files_read, files_modified
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			sessionId,
			"feature",
			"Ship TS port",
			"The big one",
			"Ported all the things",
			0.95,
			"ts port",
			now,
			now,
			"key:payload",
			2,
			toJson(meta),
			1,
			"actor-1",
			"Adam",
			"shared",
			"shared:team",
			"shared",
			"dev-a",
			"manual",
			"verified",
			"Full narrative text",
			toJson(["fact-1"]),
			toJson(["concept-1"]),
			toJson(["src/a.ts"]),
			toJson(["src/b.ts"]),
		);

		const memId = (
			db.prepare("SELECT id FROM memory_items WHERE import_key = ?").get("key:payload") as {
				id: number;
			}
		).id;

		const opId = recordReplicationOp(db, { memoryId: memId, opType: "upsert", deviceId: "dev-a" });
		const row = db
			.prepare("SELECT payload_json FROM replication_ops WHERE op_id = ?")
			.get(opId) as { payload_json: string | null };

		const payloadJson = row.payload_json;
		if (payloadJson === null) throw new Error("expected row.payload_json to be non-null");
		const payload = JSON.parse(payloadJson) as Record<string, unknown>;
		// Core fields
		expect(payload.kind).toBe("feature");
		expect(payload.title).toBe("Ship TS port");
		expect(payload.subtitle).toBe("The big one");
		expect(payload.body_text).toBe("Ported all the things");
		expect(payload.confidence).toBe(0.95);
		expect(payload.tags_text).toBe("ts port");
		// Provenance fields
		expect(payload.actor_id).toBe("actor-1");
		expect(payload.visibility).toBe("shared");
		expect(payload.workspace_id).toBe("shared:team");
		expect(payload.origin_device_id).toBe("dev-a");
		expect(payload.trust_state).toBe("verified");
		// metadata_json should be an object, not a double-encoded string
		expect(payload.metadata_json).toEqual({ clock_device_id: "dev-a", custom_field: "preserved" });
		// JSON array fields should be arrays, not strings
		expect(payload.facts).toEqual(["fact-1"]);
		expect(payload.files_read).toEqual(["src/a.ts"]);

		// Full round-trip: load op → apply to a second DB → verify all columns
		const [ops] = loadReplicationOpsSince(db, null);
		const op = ops.find((o) => o.op_id === opId);
		expect(op).toBeDefined();
		if (!op) throw new Error("expected op to be found");

		const db2 = new Database(":memory:");
		initTestSchema(db2);
		try {
			const result = applyReplicationOps(db2, [op], "dev-local");
			expect(result.applied).toBe(1);

			const applied = db2
				.prepare("SELECT * FROM memory_items WHERE import_key = ?")
				.get("key:payload") as Record<string, unknown>;
			// Core fields
			expect(applied.kind).toBe("feature");
			expect(applied.title).toBe("Ship TS port");
			expect(applied.subtitle).toBe("The big one");
			expect(applied.body_text).toBe("Ported all the things");
			expect(applied.confidence).toBe(0.95);
			expect(applied.tags_text).toBe("ts port");
			// Provenance fields survive
			expect(applied.actor_id).toBe("actor-1");
			expect(applied.actor_display_name).toBe("Adam");
			expect(applied.visibility).toBe("shared");
			expect(applied.workspace_id).toBe("shared:team");
			expect(applied.workspace_kind).toBe("shared");
			expect(applied.origin_device_id).toBe("dev-a");
			expect(applied.origin_source).toBe("manual");
			expect(applied.trust_state).toBe("verified");
			expect(applied.narrative).toBe("Full narrative text");
			// metadata_json round-trips as proper JSON with clock_device_id added
			const appliedMeta = JSON.parse(applied.metadata_json as string);
			expect(appliedMeta.custom_field).toBe("preserved");
			expect(appliedMeta.clock_device_id).toBe("dev-a");
			// JSON array columns round-trip
			expect(JSON.parse(applied.facts as string)).toEqual(["fact-1"]);
			expect(JSON.parse(applied.concepts as string)).toEqual(["concept-1"]);
			expect(JSON.parse(applied.files_read as string)).toEqual(["src/a.ts"]);
			expect(JSON.parse(applied.files_modified as string)).toEqual(["src/b.ts"]);
		} finally {
			db2.close();
		}
	});

	it("stores null payload for delete ops", () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(sessionId, "discovery", "Will delete", "gone", now, now, "key:del", 1);

		const memId = (
			db.prepare("SELECT id FROM memory_items WHERE import_key = ?").get("key:del") as {
				id: number;
			}
		).id;

		const opId = recordReplicationOp(db, { memoryId: memId, opType: "delete", deviceId: "dev-a" });
		const row = db
			.prepare("SELECT payload_json FROM replication_ops WHERE op_id = ?")
			.get(opId) as { payload_json: string | null };
		expect(row.payload_json).toBeNull();
	});

	it("falls back to memoryId as entity_id when import_key is null", () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, rev)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(sessionId, "discovery", "Test", "body", now, now, 0);

		const memId = Number(
			(db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id,
		);

		const opId = recordReplicationOp(db, {
			memoryId: memId,
			opType: "delete",
			deviceId: "dev-b",
		});

		const row = db.prepare("SELECT * FROM replication_ops WHERE op_id = ?").get(opId) as Record<
			string,
			unknown
		>;
		expect(row.entity_id).toBe(String(memId));
	});
});

// ---------------------------------------------------------------------------
// loadReplicationOpsSince
// ---------------------------------------------------------------------------

describe("loadReplicationOpsSince", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	function insertOp(opId: string, createdAt: string, deviceId = "dev-a") {
		db.prepare(
			`INSERT INTO replication_ops(op_id, entity_type, entity_id, op_type, payload_json, clock_rev, clock_updated_at, clock_device_id, device_id, created_at)
			 VALUES (?, 'memory_item', ?, 'upsert', NULL, 1, ?, ?, ?, ?)`,
		).run(opId, `ent-${opId}`, createdAt, deviceId, deviceId, createdAt);
	}

	it("returns all ops when cursor is null", () => {
		insertOp("op-1", "2026-01-01T00:00:00Z");
		insertOp("op-2", "2026-01-01T00:00:01Z");

		const [ops, cursor] = loadReplicationOpsSince(db, null);
		expect(ops).toHaveLength(2);
		expect(ops[0].op_id).toBe("op-1");
		expect(ops[1].op_id).toBe("op-2");
		expect(cursor).toBe("2026-01-01T00:00:01Z|op-2");
	});

	it("returns ops after cursor", () => {
		insertOp("op-1", "2026-01-01T00:00:00Z");
		insertOp("op-2", "2026-01-01T00:00:01Z");
		insertOp("op-3", "2026-01-01T00:00:02Z");

		const [ops, cursor] = loadReplicationOpsSince(db, "2026-01-01T00:00:00Z|op-1");
		expect(ops).toHaveLength(2);
		expect(ops[0].op_id).toBe("op-2");
		expect(cursor).toBe("2026-01-01T00:00:02Z|op-3");
	});

	it("respects limit", () => {
		insertOp("op-1", "2026-01-01T00:00:00Z");
		insertOp("op-2", "2026-01-01T00:00:01Z");
		insertOp("op-3", "2026-01-01T00:00:02Z");

		const [ops, cursor] = loadReplicationOpsSince(db, null, 2);
		expect(ops).toHaveLength(2);
		expect(cursor).toBe("2026-01-01T00:00:01Z|op-2");
	});

	it("filters by deviceId", () => {
		insertOp("op-1", "2026-01-01T00:00:00Z", "dev-a");
		insertOp("op-2", "2026-01-01T00:00:01Z", "dev-b");

		const [ops] = loadReplicationOpsSince(db, null, 100, "dev-a");
		expect(ops).toHaveLength(1);
		expect(ops[0].op_id).toBe("op-1");
	});

	it("returns [[], null] when no ops match", () => {
		const [ops, cursor] = loadReplicationOpsSince(db, null);
		expect(ops).toEqual([]);
		expect(cursor).toBeNull();
	});
});

describe("sync reset state", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("creates and persists a default reset boundary", () => {
		const first = getSyncResetState(db);
		const second = getSyncResetState(db);
		expect(first.generation).toBe(1);
		expect(first.snapshot_id).toBeTruthy();
		expect(first.baseline_cursor).toBeNull();
		expect(first.retained_floor_cursor).toBeNull();
		expect(second).toEqual(first);
	});

	it("updates retained floor and baseline metadata", () => {
		const updated = setSyncResetState(db, {
			generation: 3,
			snapshot_id: "snapshot-3",
			baseline_cursor: "2026-01-01T00:00:03Z|base-op",
			retained_floor_cursor: "2026-01-01T00:00:04Z|floor-op",
		});
		expect(updated).toEqual({
			generation: 3,
			snapshot_id: "snapshot-3",
			baseline_cursor: "2026-01-01T00:00:03Z|base-op",
			retained_floor_cursor: "2026-01-01T00:00:04Z|floor-op",
		});
		expect(getSyncResetState(db)).toEqual(updated);
	});
});

describe("loadReplicationOpsForPeer", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		setSyncResetState(db, {
			generation: 2,
			snapshot_id: "snapshot-2",
			baseline_cursor: "2026-01-01T00:00:01Z|base-op",
			retained_floor_cursor: "2026-01-01T00:00:02Z|floor-op",
		});
	});

	afterEach(() => {
		db.close();
	});

	function insertOp(opId: string, createdAt: string, deviceId = "dev-a") {
		db.prepare(
			`INSERT INTO replication_ops(op_id, entity_type, entity_id, op_type, payload_json, clock_rev, clock_updated_at, clock_device_id, device_id, created_at)
			 VALUES (?, 'memory_item', ?, 'upsert', NULL, 1, ?, ?, ?, ?)`,
		).run(opId, `ent-${opId}`, createdAt, deviceId, deviceId, createdAt);
	}

	it("returns reset_required when the cursor is older than the retained floor", () => {
		const result = loadReplicationOpsForPeer(db, {
			since: "2026-01-01T00:00:00Z|too-old",
			generation: 2,
			snapshotId: "snapshot-2",
			baselineCursor: "2026-01-01T00:00:01Z|base-op",
		});
		expect(result.reset_required).toBe(true);
		if (result.reset_required) {
			expect(result.reset.reason).toBe("stale_cursor");
			expect(result.reset.retained_floor_cursor).toBe("2026-01-01T00:00:02Z|floor-op");
		}
	});

	it("returns reset_required when the requested generation mismatches", () => {
		const result = loadReplicationOpsForPeer(db, {
			since: null,
			generation: 1,
			snapshotId: "snapshot-1",
		});
		expect(result.reset_required).toBe(true);
		if (result.reset_required) {
			expect(result.reset.reason).toBe("generation_mismatch");
			expect(result.reset.generation).toBe(2);
		}
	});

	it("requires an explicit reset boundary on incremental requests", () => {
		const result = loadReplicationOpsForPeer(db, {
			since: "2026-01-01T00:00:02Z|floor-op",
		});
		expect(result.reset_required).toBe(true);
		if (result.reset_required) {
			expect(result.reset.reason).toBe("boundary_mismatch");
			expect(result.reset.snapshot_id).toBe("snapshot-2");
		}
	});

	it("returns reset_required when snapshot metadata is omitted for the current generation", () => {
		const result = loadReplicationOpsForPeer(db, {
			since: "2026-01-01T00:00:02Z|floor-op",
			generation: 2,
		});
		expect(result.reset_required).toBe(true);
		if (result.reset_required) {
			expect(result.reset.reason).toBe("boundary_mismatch");
			expect(result.reset.baseline_cursor).toBe("2026-01-01T00:00:01Z|base-op");
		}
	});

	it("returns reset_required when only part of the boundary tuple is provided", () => {
		const result = loadReplicationOpsForPeer(db, {
			since: "2026-01-01T00:00:02Z|floor-op",
			snapshotId: "snapshot-2",
		});
		expect(result.reset_required).toBe(true);
		if (result.reset_required) {
			expect(result.reset.reason).toBe("boundary_mismatch");
		}
	});

	it("returns incremental ops when the request matches the current boundary", () => {
		insertOp("op-1", "2026-01-01T00:00:03Z");
		const result = loadReplicationOpsForPeer(db, {
			since: "2026-01-01T00:00:02Z|floor-op",
			generation: 2,
			snapshotId: "snapshot-2",
			baselineCursor: "2026-01-01T00:00:01Z|base-op",
		});
		expect(result.reset_required).toBe(false);
		if (!result.reset_required) {
			expect(result.boundary.generation).toBe(2);
			expect(result.ops.map((op) => op.op_id)).toEqual(["op-1"]);
			expect(result.nextCursor).toBe("2026-01-01T00:00:03Z|op-1");
		}
	});
});

describe("loadMemorySnapshotPageForPeer", () => {
	let db: InstanceType<typeof Database>;
	let sessionId: number;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		sessionId = insertTestSession(db);
		setSyncResetState(db, {
			generation: 4,
			snapshot_id: "snapshot-4",
			baseline_cursor: "2026-01-01T00:00:01Z|base-op",
			retained_floor_cursor: "2026-01-01T00:00:02Z|floor-op",
		});
	});

	afterEach(() => {
		db.close();
	});

	function insertMemory(importKey: string, opts?: { deleted?: boolean; visibility?: string }) {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, active, deleted_at, visibility, metadata_json)
			 VALUES (?, 'discovery', ?, 'body', ?, ?, ?, 1, ?, ?, ?, ?)`,
		).run(
			sessionId,
			importKey,
			now,
			now,
			importKey,
			opts?.deleted ? 0 : 1,
			opts?.deleted ? now : null,
			opts?.visibility ?? "shared",
			toJson({ clock_device_id: "dev-a" }),
		);
	}

	function insertSessionWithProject(project: string): number {
		const now = new Date().toISOString();
		const info = db
			.prepare(
				"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, ?, ?, ?, ?)",
			)
			.run(now, "/tmp/test", project, "test-user", "test");
		return Number(info.lastInsertRowid);
	}

	it("returns deterministic memory snapshot pages with tombstones included", () => {
		insertMemory("key-a");
		insertMemory("key-b", { deleted: true });
		insertMemory("key-c");

		const first = loadMemorySnapshotPageForPeer(db, {
			limit: 2,
			generation: 4,
			snapshotId: "snapshot-4",
			baselineCursor: "2026-01-01T00:00:01Z|base-op",
		});

		expect(first.boundary.generation).toBe(4);
		expect(first.items.map((item) => item.entity_id)).toEqual(["key-a", "key-b"]);
		expect(first.items[1]?.op_type).toBe("delete");
		expect(first.hasMore).toBe(true);
		expect(first.nextPageToken).toBeTruthy();

		const second = loadMemorySnapshotPageForPeer(db, {
			limit: 2,
			pageToken: first.nextPageToken,
			generation: 4,
			snapshotId: "snapshot-4",
			baselineCursor: "2026-01-01T00:00:01Z|base-op",
		});
		expect(second.items.map((item) => item.entity_id)).toEqual(["key-c"]);
		expect(second.hasMore).toBe(false);
		expect(second.nextPageToken).toBeNull();
	});

	it("filters out private memories from snapshot pages", () => {
		insertMemory("key-private", { visibility: "private" });
		insertMemory("key-shared", { visibility: "shared" });

		const page = loadMemorySnapshotPageForPeer(db, {
			generation: 4,
			snapshotId: "snapshot-4",
			baselineCursor: "2026-01-01T00:00:01Z|base-op",
		});

		expect(page.items.map((item) => item.entity_id)).toEqual(["key-shared"]);
	});

	it("does not return has_more without a next page token when only skipped rows remain", () => {
		insertMemory("key-a-shared", { visibility: "shared" });
		insertMemory("key-z-private-a", { visibility: "private" });
		insertMemory("key-z-private-b", { visibility: "private" });

		const first = loadMemorySnapshotPageForPeer(db, {
			limit: 1,
			generation: 4,
			snapshotId: "snapshot-4",
			baselineCursor: "2026-01-01T00:00:01Z|base-op",
		});
		expect(first.items.map((item) => item.entity_id)).toEqual(["key-a-shared"]);
		expect(first.hasMore).toBe(true);
		expect(first.nextPageToken).toBeTruthy();

		const second = loadMemorySnapshotPageForPeer(db, {
			limit: 1,
			pageToken: first.nextPageToken,
			generation: 4,
			snapshotId: "snapshot-4",
			baselineCursor: "2026-01-01T00:00:01Z|base-op",
		});
		expect(second.items).toHaveLength(0);
		expect(second.hasMore).toBe(false);
		expect(second.nextPageToken).toBeNull();
	});

	it("uses the memory session project when applying project filters to snapshot pages", () => {
		db.prepare("UPDATE sessions SET project = 'proj-a' WHERE id = ?").run(sessionId);
		insertMemory("key-a", { visibility: "shared" });
		process.env.CODEMEM_SYNC_PROJECTS_INCLUDE = "proj-a";
		const page = loadMemorySnapshotPageForPeer(db, {
			generation: 4,
			snapshotId: "snapshot-4",
			baselineCursor: "2026-01-01T00:00:01Z|base-op",
		});
		expect(page.items.map((item) => item.entity_id)).toEqual(["key-a"]);
		delete process.env.CODEMEM_SYNC_PROJECTS_INCLUDE;
	});

	it("rejects boundary mismatches for snapshot pages", () => {
		expect(() =>
			loadMemorySnapshotPageForPeer(db, {
				generation: 4,
				snapshotId: "wrong-snapshot",
				baselineCursor: "2026-01-01T00:00:01Z|base-op",
			}),
		).toThrow("boundary_mismatch");
	});

	it("does not report hasMore when only skipped rows remain", () => {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, projects_include_json, projects_exclude_json, created_at) VALUES (?, ?, ?, ?)",
		).run("peer-1", toJson(["allowed-project"]), toJson([]), "2026-01-01T00:00:00Z");
		db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("allowed-project", sessionId);

		insertMemory("key-allowed");

		const blockedSessionId = insertSessionWithProject("blocked-project");
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, active, visibility, metadata_json)
			 VALUES (?, 'discovery', ?, 'body', ?, ?, ?, 1, 1, 'shared', ?)`,
		).run(
			blockedSessionId,
			"key-blocked-1",
			now,
			now,
			"key-blocked-1",
			toJson({ clock_device_id: "dev-a" }),
		);
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, active, visibility, metadata_json)
			 VALUES (?, 'discovery', ?, 'body', ?, ?, ?, 1, 1, 'shared', ?)`,
		).run(
			blockedSessionId,
			"key-blocked-2",
			now,
			now,
			"key-blocked-2",
			toJson({ clock_device_id: "dev-a" }),
		);

		const first = loadMemorySnapshotPageForPeer(db, {
			limit: 1,
			generation: 4,
			snapshotId: "snapshot-4",
			baselineCursor: "2026-01-01T00:00:01Z|base-op",
			peerDeviceId: "peer-1",
		});
		expect(first.items.map((item) => item.entity_id)).toEqual(["key-allowed"]);
		expect(first.hasMore).toBe(true);
		expect(first.nextPageToken).toBeTruthy();

		const second = loadMemorySnapshotPageForPeer(db, {
			limit: 1,
			pageToken: first.nextPageToken,
			generation: 4,
			snapshotId: "snapshot-4",
			baselineCursor: "2026-01-01T00:00:01Z|base-op",
			peerDeviceId: "peer-1",
		});
		expect(second.items).toEqual([]);
		expect(second.hasMore).toBe(false);
		expect(second.nextPageToken).toBeNull();
	});

	it("filters snapshot pages by the memory session project", () => {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, projects_include_json, projects_exclude_json, created_at) VALUES (?, ?, ?, ?)",
		).run("peer-1", toJson(["allowed-project"]), toJson([]), "2026-01-01T00:00:00Z");
		db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("allowed-project", sessionId);

		insertMemory("key-allowed");

		const blockedSessionId = insertSessionWithProject("blocked-project");
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, active, visibility, metadata_json)
			 VALUES (?, 'discovery', ?, 'body', ?, ?, ?, 1, 1, 'shared', ?)`,
		).run(
			blockedSessionId,
			"key-blocked",
			now,
			now,
			"key-blocked",
			toJson({ clock_device_id: "dev-a" }),
		);

		const page = loadMemorySnapshotPageForPeer(db, {
			generation: 4,
			snapshotId: "snapshot-4",
			baselineCursor: "2026-01-01T00:00:01Z|base-op",
			peerDeviceId: "peer-1",
		});

		expect(page.items.map((item) => item.entity_id)).toEqual(["key-allowed"]);
	});
});

describe("hasUnsyncedSharedMemoryChanges", () => {
	let db: InstanceType<typeof Database>;
	let sessionId: number;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		sessionId = insertTestSession(db);
	});

	afterEach(() => {
		db.close();
	});

	it("reports missing shared-memory replication ops as dirty", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, metadata_json)
			 VALUES (?, 'discovery', 'shared', 'body', ?, ?, 'shared-key', 2, 'shared', ?)`,
		).run(sessionId, now, now, toJson({ clock_device_id: "dev-a" }));

		const result = hasUnsyncedSharedMemoryChanges(db);
		expect(result.dirty).toBe(true);
		expect(result.count).toBe(1);
	});

	it("ignores private-only rows when checking dirty shared-memory state", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, metadata_json)
			 VALUES (?, 'discovery', 'private', 'body', ?, ?, 'private-key', 1, 'private', ?)`,
		).run(sessionId, now, now, toJson({ clock_device_id: "dev-a" }));

		const result = hasUnsyncedSharedMemoryChanges(db);
		expect(result).toEqual({ dirty: false, count: 0 });
	});

	it("treats rows with matching replication ops as clean", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, visibility, metadata_json)
			 VALUES (?, 'discovery', 'shared', 'body', ?, ?, 'shared-key', 2, 'shared', ?)`,
		).run(sessionId, now, now, toJson({ clock_device_id: "dev-a" }));
		db.prepare(
			`INSERT INTO replication_ops(op_id, entity_type, entity_id, op_type, payload_json, clock_rev, clock_updated_at, clock_device_id, device_id, created_at)
			 VALUES ('op-1', 'memory_item', 'shared-key', 'upsert', NULL, 2, ?, 'dev-a', 'dev-a', ?)`,
		).run(now, now);

		const result = hasUnsyncedSharedMemoryChanges(db);
		expect(result).toEqual({ dirty: false, count: 0 });
	});
});

describe("pruneReplicationOps", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		setSyncResetState(db, {
			generation: 5,
			snapshot_id: "snapshot-5",
			baseline_cursor: "2026-01-01T00:00:01Z|base-op",
			retained_floor_cursor: null,
		});
	});

	afterEach(() => {
		db.close();
	});

	function insertOp(opId: string, createdAt: string) {
		db.prepare(
			`INSERT INTO replication_ops(op_id, entity_type, entity_id, op_type, payload_json, clock_rev, clock_updated_at, clock_device_id, device_id, created_at)
			 VALUES (?, 'memory_item', ?, 'upsert', NULL, 1, ?, 'dev-a', 'dev-a', ?)`,
		).run(opId, `ent-${opId}`, createdAt, createdAt);
	}

	it("prunes oldest ops beyond size budget and updates retained floor", () => {
		insertOp("op-1", "2026-01-01T00:00:01Z");
		insertOp("op-2", "2026-01-01T00:00:02Z");
		insertOp("op-3", "2026-01-01T00:00:03Z");

		const estimatedBytes = Number(
			(
				db
					.prepare(
						`SELECT COALESCE(SUM(pgsize), 0) AS total_bytes
						 FROM dbstat
						 WHERE name = 'replication_ops'
						    OR name LIKE 'idx_replication_ops_%'
						    OR name LIKE 'sqlite_autoindex_replication_ops_%'`,
					)
					.get() as { total_bytes: number }
			).total_bytes,
		);

		const result = pruneReplicationOps(db, {
			maxAgeDays: 3650,
			maxSizeBytes: Math.max(1, estimatedBytes - 1),
		});
		expect(result.deleted).toBeGreaterThanOrEqual(1);
		expect(result.retained_floor_cursor).toMatch(/^2026-01-01T00:00:0[1-3]Z\|op-[1-3]$/);
		const remaining = db
			.prepare("SELECT op_id FROM replication_ops ORDER BY created_at, op_id")
			.all() as Array<{ op_id: string }>;
		expect(remaining.length).toBeLessThan(3);
		expect(getSyncResetState(db).retained_floor_cursor).toBe(result.retained_floor_cursor);
	});

	it("does not advance retained floor when nothing is pruned", () => {
		setSyncResetState(db, { retained_floor_cursor: "2026-01-01T00:00:09Z|existing-floor" });
		insertOp("op-1", "2026-01-01T00:00:10Z");

		const result = pruneReplicationOps(db, {
			maxAgeDays: 3650,
			maxSizeBytes: 1_000_000,
		});
		expect(result.deleted).toBe(0);
		expect(result.retained_floor_cursor).toBe("2026-01-01T00:00:09Z|existing-floor");
		expect(getSyncResetState(db).retained_floor_cursor).toBe("2026-01-01T00:00:09Z|existing-floor");
	});

	it("accepts a cursor equal to the retained floor as still replayable", () => {
		insertOp("op-1", "2026-01-01T00:00:01Z");
		insertOp("op-2", "2026-01-01T00:00:02Z");
		insertOp("op-3", "2026-01-01T00:00:03Z");
		const estimatedBytes = Number(
			(
				db
					.prepare(
						`SELECT COALESCE(SUM(pgsize), 0) AS total_bytes
						 FROM dbstat
						 WHERE name = 'replication_ops'
						    OR name LIKE 'idx_replication_ops_%'
						    OR name LIKE 'sqlite_autoindex_replication_ops_%'`,
					)
					.get() as { total_bytes: number }
			).total_bytes,
		);
		pruneReplicationOps(db, { maxAgeDays: 3650, maxSizeBytes: Math.max(1, estimatedBytes - 1) });

		const result = loadReplicationOpsForPeer(db, {
			since: getSyncResetState(db).retained_floor_cursor,
			generation: 5,
			snapshotId: "snapshot-5",
			baselineCursor: "2026-01-01T00:00:01Z|base-op",
		});
		expect(result.reset_required).toBe(false);
	});

	it("respects maxDeleteOps budget during pruning", () => {
		insertOp("op-1", "2026-01-01T00:00:01Z");
		insertOp("op-2", "2026-01-01T00:00:02Z");
		insertOp("op-3", "2026-01-01T00:00:03Z");

		const result = pruneReplicationOps(db, {
			maxAgeDays: 1,
			maxSizeBytes: 1,
			maxDeleteOps: 1,
			maxRuntimeMs: 60_000,
		});

		expect(result.deleted).toBe(1);
		expect(result.stopped_by_budget).toBe(true);
	});

	it("bulk deletes an oldest-first age cutoff chunk and updates retained floor to its boundary cursor", () => {
		insertOp("op-1", "2026-01-01T00:00:01Z");
		insertOp("op-2", "2026-01-01T00:00:02Z");
		insertOp("op-3", "2026-01-01T00:00:03Z");
		insertOp("op-4", "2026-03-26T00:00:00Z");

		const result = pruneReplicationOps(db, {
			maxAgeDays: 30,
			maxSizeBytes: 1_000_000,
			maxDeleteOps: 3,
			maxRuntimeMs: 60_000,
		});

		expect(result.deleted).toBe(3);
		expect(result.retained_floor_cursor).toBe("2026-01-01T00:00:03Z|op-3");
		const remaining = db
			.prepare("SELECT op_id FROM replication_ops ORDER BY created_at, op_id")
			.all() as Array<{ op_id: string }>;
		expect(remaining.map((row) => row.op_id)).toEqual(["op-4"]);
		expect(getSyncResetState(db).retained_floor_cursor).toBe("2026-01-01T00:00:03Z|op-3");
	});

	it("bulkPruneReplicationOpsByAgeCutoff deletes the full oldest prefix before the cutoff", () => {
		insertOp("op-1", "2026-01-01T00:00:01Z");
		insertOp("op-2", "2026-01-01T00:00:02Z");
		insertOp("op-3", "2026-03-26T00:00:00Z");

		const result = bulkPruneReplicationOpsByAgeCutoff(db, 30);
		expect(result.deleted).toBe(2);
		expect(result.retained_floor_cursor).toBe("2026-01-01T00:00:02Z|op-2");
		const remaining = db
			.prepare("SELECT op_id FROM replication_ops ORDER BY created_at, op_id")
			.all() as Array<{ op_id: string }>;
		expect(remaining.map((row) => row.op_id)).toEqual(["op-3"]);
	});

	it("bulkPruneReplicationOpsByAgeCutoff respects the requested maxDeleteOps chunk size", () => {
		insertOp("op-1", "2026-01-01T00:00:01Z");
		insertOp("op-2", "2026-01-01T00:00:02Z");
		insertOp("op-3", "2026-01-01T00:00:03Z");
		insertOp("op-4", "2026-03-26T00:00:00Z");

		const result = bulkPruneReplicationOpsByAgeCutoff(db, 30, 2);
		expect(result.deleted).toBe(2);
		expect(result.retained_floor_cursor).toBe("2026-01-01T00:00:02Z|op-2");
		const remaining = db
			.prepare("SELECT op_id FROM replication_ops ORDER BY created_at, op_id")
			.all() as Array<{ op_id: string }>;
		expect(remaining.map((row) => row.op_id)).toEqual(["op-3", "op-4"]);
	});

	it("plans age-pass candidate ops, bytes, cutoff cursor, and estimated batches", () => {
		insertOp("op-1", "2026-01-01T00:00:01Z");
		insertOp("op-2", "2026-01-01T00:00:02Z");
		insertOp("op-3", "2026-03-26T00:00:00Z");

		const plan = planReplicationOpsAgePrune(db, 30, 1);
		expect(plan.candidate_ops).toBe(2);
		expect(plan.cutoff_cursor).toBe("2026-01-01T00:00:02Z|op-2");
		expect(plan.estimated_batches).toBe(2);
		expect(plan.estimated_candidate_bytes).toBeGreaterThanOrEqual(0);
	});

	it("does not overshoot the remaining delete budget during bulk age pruning", () => {
		insertOp("op-1", "2026-01-01T00:00:01Z");
		insertOp("op-2", "2026-01-01T00:00:02Z");
		insertOp("op-3", "2026-01-01T00:00:03Z");
		insertOp("op-4", "2026-01-01T00:00:04Z");
		insertOp("op-5", "2026-01-01T00:00:05Z");

		const result = pruneReplicationOps(db, {
			maxAgeDays: 30,
			maxSizeBytes: 1,
			maxDeleteOps: 4,
			maxRuntimeMs: 60_000,
		});

		expect(result.deleted).toBe(4);
		expect(result.retained_floor_cursor).toBe("2026-01-01T00:00:04Z|op-4");
	});

	it("bulk deletes oldest-prefix chunks during size trimming and remeasures between chunks", () => {
		insertOp("op-1", "2026-03-20T00:00:01Z");
		insertOp("op-2", "2026-03-20T00:00:02Z");
		insertOp("op-3", "2026-03-20T00:00:03Z");
		insertOp("op-4", "2026-03-20T00:00:04Z");

		const estimatedBytes = Number(
			(
				db
					.prepare(
						`SELECT COALESCE(SUM(pgsize), 0) AS total_bytes
						 FROM dbstat
						 WHERE name = 'replication_ops'
						    OR name LIKE 'idx_replication_ops_%'
						    OR name LIKE 'sqlite_autoindex_replication_ops_%'`,
					)
					.get() as { total_bytes: number }
			).total_bytes,
		);

		const result = pruneReplicationOps(db, {
			maxAgeDays: 3650,
			maxSizeBytes: Math.max(1, estimatedBytes - 1),
			maxDeleteOps: 2,
			maxRuntimeMs: 60_000,
		});

		expect(result.deleted).toBe(2);
		expect(result.retained_floor_cursor).toBe("2026-03-20T00:00:02Z|op-2");
		expect(result.stopped_by_budget).toBe(true);
		const remaining = db
			.prepare("SELECT op_id FROM replication_ops ORDER BY created_at, op_id")
			.all() as Array<{ op_id: string }>;
		expect(remaining.map((row) => row.op_id)).toEqual(["op-3", "op-4"]);
	});

	it("does not overshoot the remaining delete budget during size trimming", () => {
		insertOp("op-1", "2026-03-20T00:00:01Z");
		insertOp("op-2", "2026-03-20T00:00:02Z");
		insertOp("op-3", "2026-03-20T00:00:03Z");
		insertOp("op-4", "2026-03-20T00:00:04Z");
		insertOp("op-5", "2026-03-20T00:00:05Z");

		const estimatedBytes = Number(
			(
				db
					.prepare(
						`SELECT COALESCE(SUM(pgsize), 0) AS total_bytes
						 FROM dbstat
						 WHERE name = 'replication_ops'
						    OR name LIKE 'idx_replication_ops_%'
						    OR name LIKE 'sqlite_autoindex_replication_ops_%'`,
					)
					.get() as { total_bytes: number }
			).total_bytes,
		);

		const result = pruneReplicationOps(db, {
			maxAgeDays: 3650,
			maxSizeBytes: Math.max(1, estimatedBytes - 1),
			maxDeleteOps: 4,
			maxRuntimeMs: 60_000,
		});

		expect(result.deleted).toBe(4);
		expect(result.retained_floor_cursor).toBe("2026-03-20T00:00:04Z|op-4");
	});

	it("keeps applying prune passes until retention is no longer budget-limited", () => {
		insertOp("op-1", "2026-01-01T00:00:01Z");
		insertOp("op-2", "2026-01-01T00:00:02Z");
		insertOp("op-3", "2026-01-01T00:00:03Z");
		insertOp("op-4", "2026-01-01T00:00:04Z");
		insertOp("op-5", "2026-03-26T00:00:00Z");

		const result = pruneReplicationOpsUntilCaughtUp(db, {
			maxAgeDays: 30,
			maxSizeBytes: 1024 * 1024 * 1024,
			maxDeleteOps: 2,
			maxRuntimeMs: 60_000,
		});

		expect(result.totalDeleted).toBe(4);
		expect(result.passes).toBe(3);
		expect(result.stoppedByBudget).toBe(false);
		expect(result.lastFloor).toBe("2026-01-01T00:00:04Z|op-4");
		const remaining = db
			.prepare("SELECT op_id FROM replication_ops ORDER BY created_at, op_id")
			.all() as Array<{ op_id: string }>;
		expect(remaining.map((row) => row.op_id)).toEqual(["op-5"]);
	});

	it("stops multi-pass catch-up after the configured pass cap", () => {
		insertOp("op-1", "2026-01-01T00:00:01Z");
		insertOp("op-2", "2026-01-01T00:00:02Z");
		insertOp("op-3", "2026-01-01T00:00:03Z");
		insertOp("op-4", "2026-01-01T00:00:04Z");
		insertOp("op-5", "2026-01-01T00:00:05Z");
		insertOp("op-6", "2026-03-26T00:00:00Z");

		const result = pruneReplicationOpsUntilCaughtUp(db, {
			maxAgeDays: 30,
			maxSizeBytes: 1024 * 1024 * 1024,
			maxDeleteOps: 2,
			maxRuntimeMs: 60_000,
			maxPasses: 2,
		});

		expect(result.totalDeleted).toBe(4);
		expect(result.passes).toBe(2);
		expect(result.stoppedByBudget).toBe(true);
		const remaining = db
			.prepare("SELECT op_id FROM replication_ops ORDER BY created_at, op_id")
			.all() as Array<{ op_id: string }>;
		expect(remaining.map((row) => row.op_id)).toEqual(["op-5", "op-6"]);
	});
});

// ---------------------------------------------------------------------------
// migrateLegacyImportKeys / backfillReplicationOps
// ---------------------------------------------------------------------------

describe("legacy key migration + replication backfill", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("rewrites old-format legacy import keys to device-scoped keys", () => {
		db.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		).run("dev-local", "pub", "fp", "2026-01-01T00:00:00Z");

		const sessionId = insertTestSession(db);
		const now = "2026-01-01T00:00:00Z";

		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, metadata_json, rev)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(sessionId, "discovery", "A", "a", now, now, null, toJson({}), 1);

		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, metadata_json, rev)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(sessionId, "discovery", "B", "b", now, now, "legacy:memory_item:42", toJson({}), 2);

		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, metadata_json, rev)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			sessionId,
			"discovery",
			"C",
			"c",
			now,
			now,
			"legacy:memory_item:99",
			toJson({ clock_device_id: "peer-9" }),
			3,
		);

		const changed = migrateLegacyImportKeys(db, 100);
		expect(changed).toBe(3);

		const rows = db.prepare("SELECT id, import_key FROM memory_items ORDER BY id").all() as Array<{
			id: number;
			import_key: string;
		}>;
		expect(rows[0]?.import_key).toBe(`legacy:dev-local:memory_item:${rows[0]?.id}`);
		expect(rows[1]?.import_key).toBe("legacy:dev-local:memory_item:42");
		expect(rows[2]?.import_key).toBe("legacy:peer-9:memory_item:99");
	});

	it("backfills missing delete/upsert ops once and remains idempotent", () => {
		db.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		).run("dev-local", "pub", "fp", "2026-01-01T00:00:00Z");
		const sessionId = insertTestSession(db);
		const now = "2026-01-02T00:00:00Z";

		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, active, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(sessionId, "feature", "Live row", "live", now, now, "key:live", 1, 1, toJson({}));

		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, active, deleted_at, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(sessionId, "bugfix", "Deleted row", "gone", now, now, "key:gone", 2, 0, now, toJson({}));

		const first = backfillReplicationOps(db, 10);
		expect(first).toBe(2);

		const ops = db
			.prepare(
				"SELECT op_id, entity_id, op_type, clock_rev FROM replication_ops ORDER BY op_type, entity_id",
			)
			.all() as Array<{ op_id: string; entity_id: string; op_type: string; clock_rev: number }>;
		expect(ops).toHaveLength(2);
		expect(ops.map((op) => op.op_type).sort()).toEqual(["delete", "upsert"]);
		expect(ops[0]?.op_id).toContain("backfill:memory_item:");

		const second = backfillReplicationOps(db, 10);
		expect(second).toBe(0);
		const count = db.prepare("SELECT COUNT(*) AS n FROM replication_ops").get() as { n: number };
		expect(count.n).toBe(2);
	});

	it("does not mint legacy:local import keys before device identity exists", () => {
		const sessionId = insertTestSession(db);
		const now = "2026-01-02T00:00:00Z";

		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, active, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(sessionId, "feature", "Live row", "live", now, now, null, 1, 1, toJson({}));

		const inserted = backfillReplicationOps(db, 10);
		expect(inserted).toBe(0);

		const row = db.prepare("SELECT import_key FROM memory_items LIMIT 1").get() as {
			import_key: string | null;
		};
		expect(row.import_key).toBeNull();

		const localLegacyCount = db
			.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE import_key LIKE 'legacy:local:%'")
			.get() as { n: number };
		expect(localLegacyCount.n).toBe(0);
	});
});

describe("filterReplicationOpsForSyncWithStatus", () => {
	let db: InstanceType<typeof Database>;
	let prevInclude: string | undefined;
	let prevExclude: string | undefined;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		prevInclude = process.env.CODEMEM_SYNC_PROJECTS_INCLUDE;
		prevExclude = process.env.CODEMEM_SYNC_PROJECTS_EXCLUDE;
	});

	afterEach(() => {
		db.close();
		if (prevInclude === undefined) delete process.env.CODEMEM_SYNC_PROJECTS_INCLUDE;
		else process.env.CODEMEM_SYNC_PROJECTS_INCLUDE = prevInclude;
		if (prevExclude === undefined) delete process.env.CODEMEM_SYNC_PROJECTS_EXCLUDE;
		else process.env.CODEMEM_SYNC_PROJECTS_EXCLUDE = prevExclude;
		vi.unstubAllEnvs();
	});

	function makeOp(overrides: Partial<ReplicationOp> = {}): ReplicationOp {
		return {
			op_id: "op-1",
			entity_type: "memory_item",
			entity_id: "key-1",
			op_type: "upsert",
			payload_json: toJson({ project: "proj-a", visibility: "shared" }),
			clock_rev: 1,
			clock_updated_at: "2026-01-01T00:00:00Z",
			clock_device_id: "peer-1",
			device_id: "peer-1",
			created_at: "2026-01-01T00:00:00Z",
			...overrides,
		};
	}

	it("filters by peer include scope and advances cursor past skipped ops", () => {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, projects_include_json, projects_exclude_json, created_at) VALUES (?, ?, ?, ?)",
		).run("peer-1", toJson(["proj-a"]), toJson([]), "2026-01-01T00:00:00Z");

		const op1 = makeOp({
			op_id: "op-1",
			payload_json: toJson({ project: "proj-b", visibility: "shared" }),
			created_at: "2026-01-01T00:00:01Z",
		});
		const op2 = makeOp({
			op_id: "op-2",
			payload_json: toJson({ project: "proj-a", visibility: "shared" }),
			created_at: "2026-01-01T00:00:02Z",
		});

		const [allowed, nextCursor, skipped] = filterReplicationOpsForSyncWithStatus(
			db,
			[op1, op2],
			"peer-1",
		);
		expect(allowed.map((op) => op.op_id)).toEqual(["op-2"]);
		expect(nextCursor).toBe("2026-01-01T00:00:02Z|op-2");
		expect(skipped?.reason).toBe("project_filter");
		expect(skipped?.skipped_count).toBe(1);

		const [allowedOnly, nextOnly] = filterReplicationOpsForSync(db, [op1, op2], "peer-1");
		expect(allowedOnly.map((op) => op.op_id)).toEqual(["op-2"]);
		expect(nextOnly).toBe("2026-01-01T00:00:02Z|op-2");
	});

	it("filters private visibility unless peer is claimed local actor", () => {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, projects_include_json, projects_exclude_json, claimed_local_actor, created_at) VALUES (?, ?, ?, ?, ?)",
		).run("peer-1", toJson([]), toJson([]), 0, "2026-01-01T00:00:00Z");

		const privateOp = makeOp({
			op_id: "op-private",
			payload_json: toJson({ project: "proj-a", visibility: "private" }),
		});

		const [blockedOps, blockedCursor, blockedMeta] = filterReplicationOpsForSyncWithStatus(
			db,
			[privateOp],
			"peer-1",
		);
		expect(blockedOps).toEqual([]);
		expect(blockedCursor).toBe("2026-01-01T00:00:00Z|op-private");
		expect(blockedMeta?.reason).toBe("visibility_filter");

		db.prepare("UPDATE sync_peers SET claimed_local_actor = 1 WHERE peer_device_id = ?").run(
			"peer-1",
		);
		const [allowedOps, allowedCursor, allowedMeta] = filterReplicationOpsForSyncWithStatus(
			db,
			[privateOp],
			"peer-1",
		);
		expect(allowedOps.map((op) => op.op_id)).toEqual(["op-private"]);
		expect(allowedCursor).toBe("2026-01-01T00:00:00Z|op-private");
		expect(allowedMeta).toBeNull();
	});

	it("keeps delete tombstones with null payload_json", () => {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, projects_include_json, projects_exclude_json, claimed_local_actor, created_at) VALUES (?, ?, ?, ?, ?)",
		).run("peer-1", toJson(["proj-a"]), toJson([]), 0, "2026-01-01T00:00:00Z");

		const tombstone = makeOp({
			op_id: "op-del",
			op_type: "delete",
			payload_json: null,
			created_at: "2026-01-01T00:00:05Z",
		});

		const [allowed, cursor, skipped] = filterReplicationOpsForSyncWithStatus(
			db,
			[tombstone],
			"peer-1",
		);
		expect(allowed.map((op) => op.op_id)).toEqual(["op-del"]);
		expect(cursor).toBe("2026-01-01T00:00:05Z|op-del");
		expect(skipped).toBeNull();
	});

	it("respects CODEMEM_SYNC_PROJECTS_* env overrides", () => {
		vi.stubEnv("CODEMEM_SYNC_PROJECTS_INCLUDE", "proj-env");
		vi.stubEnv("CODEMEM_SYNC_PROJECTS_EXCLUDE", "proj-blocked");

		const allowedOp = makeOp({
			op_id: "op-env-allow",
			payload_json: toJson({ project: "proj-env", visibility: "shared" }),
			created_at: "2026-01-01T00:00:10Z",
		});
		const blockedOp = makeOp({
			op_id: "op-env-block",
			payload_json: toJson({ project: "proj-other", visibility: "shared" }),
			created_at: "2026-01-01T00:00:11Z",
		});

		const [allowed, cursor, skipped] = filterReplicationOpsForSyncWithStatus(
			db,
			[allowedOp, blockedOp],
			null,
		);
		expect(allowed.map((op) => op.op_id)).toEqual(["op-env-allow"]);
		expect(cursor).toBe("2026-01-01T00:00:11Z|op-env-block");
		expect(skipped?.reason).toBe("project_filter");
	});
});

// ---------------------------------------------------------------------------
// applyReplicationOps
// ---------------------------------------------------------------------------

describe("applyReplicationOps", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	function makeReplicationOp(overrides: Partial<ReplicationOp> = {}): ReplicationOp {
		return {
			op_id: `op-${Math.random().toString(36).slice(2, 8)}`,
			entity_type: "memory_item",
			entity_id: "key:test-1",
			op_type: "upsert",
			payload_json: toJson({
				kind: "discovery",
				title: "Remote memory",
				body_text: "Remote body",
				confidence: 0.8,
				tags_text: "test",
				active: 1,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
			}),
			clock_rev: 1,
			clock_updated_at: "2026-01-01T00:00:00Z",
			clock_device_id: "dev-remote",
			device_id: "dev-remote",
			created_at: "2026-01-01T00:00:00Z",
			...overrides,
		};
	}

	it("skips ops from the local device", () => {
		const op = makeReplicationOp({ device_id: "dev-local" });
		const result = applyReplicationOps(db, [op], "dev-local");
		expect(result.skipped).toBe(1);
		expect(result.applied).toBe(0);
	});

	it("preserves project on newly replicated memories", () => {
		const op = makeReplicationOp({
			payload_json: toJson({
				kind: "discovery",
				title: "Remote memory",
				body_text: "Remote body",
				visibility: "shared",
				project: "proj-replicated",
			}),
		});

		const result = applyReplicationOps(db, [op], "dev-local");
		expect(result.applied).toBe(1);

		const row = db
			.prepare(
				`SELECT s.project
				   FROM memory_items m
				   JOIN sessions s ON s.id = m.session_id
				  WHERE m.import_key = ?
				  LIMIT 1`,
			)
			.get(op.entity_id) as { project: string | null } | undefined;

		expect(row?.project).toBe("proj-replicated");
	});

	it("skips duplicate op_ids (idempotent)", () => {
		const op = makeReplicationOp({ op_id: "fixed-op-id" });
		const r1 = applyReplicationOps(db, [op], "dev-local");
		expect(r1.applied).toBe(1);

		const r2 = applyReplicationOps(db, [op], "dev-local");
		expect(r2.skipped).toBe(1);
		expect(r2.applied).toBe(0);
	});

	it("inserts a new memory item on upsert", () => {
		const op = makeReplicationOp();
		const result = applyReplicationOps(db, [op], "dev-local");
		expect(result.applied).toBe(1);

		const mem = db
			.prepare("SELECT * FROM memory_items WHERE import_key = ?")
			.get("key:test-1") as Record<string, unknown>;
		expect(mem).toBeDefined();
		expect(mem.title).toBe("Remote memory");
		expect(mem.rev).toBe(1);
		expect(result.vectorWork.upsertMemoryIds).toEqual([Number(mem.id)]);
		expect(result.vectorWork.deleteMemoryIds).toEqual([]);
	});

	it("updates existing memory when op clock is newer", () => {
		// Insert initial memory
		const sessionId = insertTestSession(db);
		const now = "2026-01-01T00:00:00Z";
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			sessionId,
			"discovery",
			"Old title",
			"old body",
			now,
			now,
			"key:test-1",
			1,
			toJson({ clock_device_id: "dev-remote" }),
		);

		const op = makeReplicationOp({
			clock_rev: 2,
			clock_updated_at: "2026-01-02T00:00:00Z",
			payload_json: toJson({
				kind: "discovery",
				title: "Updated title",
				body_text: "updated body",
				updated_at: "2026-01-02T00:00:00Z",
			}),
		});

		const result = applyReplicationOps(db, [op], "dev-local");
		expect(result.applied).toBe(1);

		const mem = db
			.prepare("SELECT * FROM memory_items WHERE import_key = ?")
			.get("key:test-1") as Record<string, unknown>;
		expect(mem.title).toBe("Updated title");
		expect(mem.rev).toBe(2);
		expect(result.vectorWork.upsertMemoryIds).toEqual([Number(mem.id)]);
	});

	it("counts conflict when existing memory has newer clock", () => {
		const sessionId = insertTestSession(db);
		const now = "2026-01-02T00:00:00Z";
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			sessionId,
			"discovery",
			"Newer title",
			"newer body",
			now,
			now,
			"key:test-1",
			5,
			toJson({ clock_device_id: "dev-remote" }),
		);

		const op = makeReplicationOp({ clock_rev: 1 });
		const result = applyReplicationOps(db, [op], "dev-local");
		expect(result.conflicts).toBe(1);
		expect(result.applied).toBe(0);

		// Original memory unchanged
		const mem = db
			.prepare("SELECT title FROM memory_items WHERE import_key = ?")
			.get("key:test-1") as { title: string };
		expect(mem.title).toBe("Newer title");
	});

	it("soft-deletes on delete op_type", () => {
		const sessionId = insertTestSession(db);
		const now = "2026-01-01T00:00:00Z";
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, active)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(sessionId, "discovery", "To delete", "body", now, now, "key:del-1", 1, 1);

		const op = makeReplicationOp({
			entity_id: "key:del-1",
			op_type: "delete",
		});

		const result = applyReplicationOps(db, [op], "dev-local");
		expect(result.applied).toBe(1);

		const mem = db
			.prepare("SELECT active, deleted_at FROM memory_items WHERE import_key = ?")
			.get("key:del-1") as { active: number; deleted_at: string | null };
		expect(mem.active).toBe(0);
		expect(mem.deleted_at).not.toBeNull();
		const memoryId = Number(
			(
				db.prepare("SELECT id FROM memory_items WHERE import_key = ?").get("key:del-1") as {
					id: number;
				}
			).id,
		);
		expect(result.vectorWork.upsertMemoryIds).toEqual([]);
		expect(result.vectorWork.deleteMemoryIds).toEqual([memoryId]);
	});

	it("records applied ops in replication_ops table", () => {
		const op = makeReplicationOp({ op_id: "track-me" });
		applyReplicationOps(db, [op], "dev-local");

		const row = db.prepare("SELECT op_id FROM replication_ops WHERE op_id = ?").get("track-me");
		expect(row).toBeDefined();
	});

	it("derives tags for inserted memories arriving with empty tags_text", () => {
		const op = makeReplicationOp({
			entity_id: "key:no-tags",
			payload_json: toJson({
				kind: "feature",
				title: "Add authentication flow",
				body_text: "Implements login and signup",
				tags_text: "",
				active: 1,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
				concepts: ["authentication", "login"],
				files_modified: ["src/auth/login.ts"],
			}),
		});

		const result = applyReplicationOps(db, [op], "dev-local");
		expect(result.applied).toBe(1);

		const mem = db
			.prepare("SELECT tags_text FROM memory_items WHERE import_key = ?")
			.get("key:no-tags") as { tags_text: string };
		expect(mem.tags_text).toBeTruthy();
		expect(mem.tags_text).toContain("feature");
		expect(mem.tags_text).toContain("authentication");
	});

	it("preserves incoming tags when source provides non-empty tags_text", () => {
		const op = makeReplicationOp({
			entity_id: "key:has-tags",
			payload_json: toJson({
				kind: "bugfix",
				title: "Fix crash",
				body_text: "Null check",
				tags_text: "custom-tag-1 custom-tag-2",
				active: 1,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
			}),
		});

		const result = applyReplicationOps(db, [op], "dev-local");
		expect(result.applied).toBe(1);

		const mem = db
			.prepare("SELECT tags_text FROM memory_items WHERE import_key = ?")
			.get("key:has-tags") as { tags_text: string };
		expect(mem.tags_text).toBe("custom-tag-1 custom-tag-2");
	});

	it("does not overwrite existing tags with empty incoming tags on update", () => {
		// Insert initial memory with tags
		const sessionId = insertTestSession(db);
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, tags_text, created_at, updated_at, import_key, rev, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			sessionId,
			"discovery",
			"Original",
			"body",
			"existing-tag",
			"2026-01-01T00:00:00Z",
			"2026-01-01T00:00:00Z",
			"key:keep-tags",
			1,
			toJson({ clock_device_id: "dev-remote" }),
		);

		// Update with empty tags_text
		const op = makeReplicationOp({
			entity_id: "key:keep-tags",
			clock_rev: 2,
			clock_updated_at: "2026-01-02T00:00:00Z",
			payload_json: toJson({
				kind: "discovery",
				title: "Updated title",
				body_text: "updated body",
				tags_text: "",
				updated_at: "2026-01-02T00:00:00Z",
			}),
		});

		const result = applyReplicationOps(db, [op], "dev-local");
		expect(result.applied).toBe(1);

		const mem = db
			.prepare("SELECT title, tags_text FROM memory_items WHERE import_key = ?")
			.get("key:keep-tags") as { title: string; tags_text: string };
		expect(mem.title).toBe("Updated title");
		expect(mem.tags_text).toBe("existing-tag");
	});

	it("does not queue vector re-embed for metadata-only updates", () => {
		const sessionId = insertTestSession(db);
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, visibility, created_at, updated_at, import_key, rev, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			sessionId,
			"discovery",
			"Stable title",
			"stable body",
			"private",
			"2026-01-01T00:00:00Z",
			"2026-01-01T00:00:00Z",
			"key:metadata-only",
			1,
			toJson({ clock_device_id: "dev-remote" }),
		);

		const op = makeReplicationOp({
			entity_id: "key:metadata-only",
			clock_rev: 2,
			clock_updated_at: "2026-01-02T00:00:00Z",
			payload_json: toJson({
				kind: "discovery",
				title: "Stable title",
				body_text: "stable body",
				visibility: "shared",
				updated_at: "2026-01-02T00:00:00Z",
			}),
		});

		const result = applyReplicationOps(db, [op], "dev-local");
		expect(result.applied).toBe(1);
		expect(result.vectorWork.upsertMemoryIds).toEqual([]);
		expect(result.vectorWork.deleteMemoryIds).toEqual([]);

		const mem = db
			.prepare("SELECT visibility FROM memory_items WHERE import_key = ?")
			.get("key:metadata-only") as { visibility: string };
		expect(mem.visibility).toBe("shared");
	});

	it("queues vector re-embed when a metadata-only update reactivates a deleted memory", () => {
		const sessionId = insertTestSession(db);
		const deletedAt = "2026-01-01T00:00:00Z";
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, active, deleted_at, created_at, updated_at, import_key, rev, metadata_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				sessionId,
				"discovery",
				"Stable title",
				"stable body",
				0,
				deletedAt,
				deletedAt,
				deletedAt,
				"key:undelete",
				1,
				toJson({ clock_device_id: "dev-remote" }),
			);
		const memoryId = Number(info.lastInsertRowid);

		const op = makeReplicationOp({
			entity_id: "key:undelete",
			clock_rev: 2,
			clock_updated_at: "2026-01-02T00:00:00Z",
			payload_json: toJson({
				kind: "discovery",
				title: "Stable title",
				body_text: "stable body",
				active: 1,
				deleted_at: null,
				updated_at: "2026-01-02T00:00:00Z",
			}),
		});

		const result = applyReplicationOps(db, [op], "dev-local");
		expect(result.applied).toBe(1);
		expect(result.vectorWork.upsertMemoryIds).toEqual([memoryId]);
		expect(result.vectorWork.deleteMemoryIds).toEqual([]);

		const mem = db
			.prepare("SELECT active, deleted_at FROM memory_items WHERE import_key = ?")
			.get("key:undelete") as { active: number; deleted_at: string | null };
		expect(mem.active).toBe(1);
		expect(mem.deleted_at).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Payload round-trip parity — ensures recordReplicationOp, parseMemoryPayload,
// and applyReplicationOps all agree on which fields are carried through the
// replication pipeline.  If you add a field to one and not the others, this
// test will catch the drift.
// ---------------------------------------------------------------------------

describe("replication payload round-trip parity", () => {
	let db: InstanceType<typeof Database>;
	let sessionId: number;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		sessionId = insertTestSession(db);
		setSyncResetState(db, { generation: 1, snapshot_id: "snap-rt", baseline_cursor: null });
	});

	afterEach(() => db.close());

	it("round-trips all payload fields through record → parse → apply", () => {
		const now = new Date().toISOString();

		// Insert a memory with every field populated
		db.prepare(`
			INSERT INTO memory_items (
				session_id, kind, title, subtitle, body_text, confidence,
				tags_text, active, created_at, updated_at, metadata_json,
				actor_id, actor_display_name, visibility, workspace_id,
				workspace_kind, origin_device_id, origin_source, trust_state,
				narrative, facts, concepts, files_read, files_modified,
				user_prompt_id, prompt_number, import_key, rev
			) VALUES (
				?, 'decision', 'Round Trip Title', 'Sub', 'Body text here', 0.85,
				'tag-a tag-b', 1, ?, ?, '{"custom_key":"custom_val"}',
				'actor-rt', 'Actor Name', 'shared', 'ws-1',
				'shared', 'device-origin', 'test', 'trusted',
				'A narrative', '["fact-1"]', '["concept-1"]', '["file-a"]', '["file-b"]',
				42, 7, 'roundtrip-key-1', 1
			)
		`).run(sessionId, now, now);

		// Also set the session project so it flows through
		db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("test-project", sessionId);

		const memoryId = (
			db.prepare("SELECT id FROM memory_items WHERE import_key = 'roundtrip-key-1'").get() as {
				id: number;
			}
		).id;

		// Record a replication op (source side)
		const opId = recordReplicationOp(db, {
			memoryId,
			opType: "upsert",
			deviceId: "source-device",
		});

		// Read the op back
		const op = db.prepare("SELECT * FROM replication_ops WHERE op_id = ?").get(opId) as {
			payload_json: string;
		};
		const payload = JSON.parse(op.payload_json) as Record<string, unknown>;

		// Verify the payload includes all the fields we care about
		expect(payload.project).toBe("test-project");
		expect(payload.kind).toBe("decision");
		expect(payload.title).toBe("Round Trip Title");
		expect(payload.subtitle).toBe("Sub");
		expect(payload.body_text).toBe("Body text here");
		expect(payload.confidence).toBe(0.85);
		expect(payload.actor_id).toBe("actor-rt");
		expect(payload.actor_display_name).toBe("Actor Name");
		expect(payload.visibility).toBe("shared");
		expect(payload.workspace_id).toBe("ws-1");
		expect(payload.workspace_kind).toBe("shared");
		expect(payload.origin_device_id).toBe("device-origin");
		expect(payload.origin_source).toBe("test");
		expect(payload.trust_state).toBe("trusted");
		expect(payload.narrative).toBe("A narrative");
		expect(payload.user_prompt_id).toBe(42);
		expect(payload.prompt_number).toBe(7);

		// Now apply this op on a "target" DB (same DB, different import key scenario)
		// Delete the original memory AND the recorded op so the apply treats this as new
		db.prepare("DELETE FROM memory_items WHERE id = ?").run(memoryId);
		db.prepare("DELETE FROM replication_ops WHERE op_id = ?").run(opId);

		const replicationOp: ReplicationOp = {
			op_id: "roundtrip-apply-op",
			entity_type: "memory_item",
			entity_id: "roundtrip-key-1",
			op_type: "upsert",
			payload_json: op.payload_json,
			clock_rev: op.clock_rev,
			clock_updated_at: op.clock_updated_at,
			clock_device_id: "remote-device",
			device_id: "remote-device",
			created_at: op.created_at,
		};

		const result = applyReplicationOps(db, [replicationOp], "target-device");
		expect(result.applied).toBe(1);

		// Verify the round-tripped memory has the right fields
		const applied = db
			.prepare(
				"SELECT m.*, s.project as session_project FROM memory_items m JOIN sessions s ON s.id = m.session_id WHERE m.import_key = 'roundtrip-key-1'",
			)
			.get() as Record<string, unknown>;

		expect(applied).toBeTruthy();
		expect(applied.session_project).toBe("test-project");
		expect(applied.kind).toBe("decision");
		expect(applied.title).toBe("Round Trip Title");
		expect(applied.subtitle).toBe("Sub");
		expect(applied.body_text).toBe("Body text here");
		expect(applied.confidence).toBe(0.85);
		expect(applied.actor_id).toBe("actor-rt");
		expect(applied.actor_display_name).toBe("Actor Name");
		expect(applied.visibility).toBe("shared");
		expect(applied.workspace_id).toBe("ws-1");
		expect(applied.workspace_kind).toBe("shared");
		expect(applied.origin_device_id).toBe("device-origin");
		expect(applied.origin_source).toBe("test");
		expect(applied.trust_state).toBe("trusted");
		expect(applied.narrative).toBe("A narrative");
		expect(applied.user_prompt_id).toBe(42);
		expect(applied.prompt_number).toBe(7);
	});
});

// ---------------------------------------------------------------------------
// Bootstrap snapshot round-trip parity — ensures the snapshot page builder
// (loadMemorySnapshotPageForPeer) and applyBootstrapSnapshot agree on which
// fields survive a full snapshot transfer.  If you add a field to one side
// and not the other, this test will catch the drift.
// ---------------------------------------------------------------------------

describe("bootstrap snapshot round-trip parity", () => {
	let db: InstanceType<typeof Database>;
	let sessionId: number;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		sessionId = insertTestSession(db);
		setSyncResetState(db, { generation: 1, snapshot_id: "snap-bs", baseline_cursor: null });
	});

	afterEach(() => db.close());

	it("round-trips all fields through snapshot page → applyBootstrapSnapshot", async () => {
		const now = new Date().toISOString();

		// Set the session project
		db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("bootstrap-project", sessionId);

		// Insert a fully-populated shared memory
		db.prepare(`
			INSERT INTO memory_items (
				session_id, kind, title, subtitle, body_text, confidence,
				tags_text, active, created_at, updated_at, metadata_json,
				actor_id, actor_display_name, visibility, workspace_id,
				workspace_kind, origin_device_id, origin_source, trust_state,
				narrative, facts, concepts, files_read, files_modified,
				user_prompt_id, prompt_number, import_key, rev
			) VALUES (
				?, 'feature', 'Bootstrap Title', 'BSub', 'Bootstrap body', 0.9,
				'btag-a btag-b', 1, ?, ?, '{"bs_key":"bs_val"}',
				'actor-bs', 'Bootstrap Actor', 'shared', 'ws-bs',
				'shared', 'device-bs-origin', 'bootstrap-test', 'trusted',
				'Bootstrap narrative', '["bs-fact"]', '["bs-concept"]', '["bs-file-r"]', '["bs-file-w"]',
				99, 3, 'bootstrap-roundtrip-key', 2
			)
		`).run(sessionId, now, now);

		// Build a snapshot page from the source DB (simulates the serving side)
		const { applyBootstrapSnapshot } = await import("./sync-bootstrap.js");

		const page = loadMemorySnapshotPageForPeer(db, {
			generation: 1,
			snapshotId: "snap-bs",
			baselineCursor: null,
			limit: 100,
		});

		expect(page.items.length).toBeGreaterThanOrEqual(1);
		const snapshotItem = page.items.find((i) => i.entity_id === "bootstrap-roundtrip-key");
		expect(snapshotItem).toBeTruthy();

		// Now apply the snapshot on a "target" DB (same DB after wiping source data)
		db.prepare("DELETE FROM memory_items").run();
		db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);

		const resetInfo = {
			generation: 1,
			snapshot_id: "snap-bs",
			baseline_cursor: null,
			retained_floor_cursor: null,
			reset_required: true as const,
			reason: "initial_bootstrap" as const,
		};

		const result = applyBootstrapSnapshot(db, "target-peer", page.items, resetInfo);
		expect(result.ok).toBe(true);
		expect(result.applied).toBeGreaterThanOrEqual(1);

		// Verify every field round-tripped through the bootstrap pipeline
		const applied = db
			.prepare(
				"SELECT m.*, s.project as session_project FROM memory_items m JOIN sessions s ON s.id = m.session_id WHERE m.import_key = 'bootstrap-roundtrip-key'",
			)
			.get() as Record<string, unknown>;

		expect(applied).toBeTruthy();
		expect(applied.session_project).toBe("bootstrap-project");
		expect(applied.kind).toBe("feature");
		expect(applied.title).toBe("Bootstrap Title");
		expect(applied.subtitle).toBe("BSub");
		expect(applied.body_text).toBe("Bootstrap body");
		expect(applied.confidence).toBe(0.9);
		expect(applied.actor_id).toBe("actor-bs");
		expect(applied.actor_display_name).toBe("Bootstrap Actor");
		expect(applied.visibility).toBe("shared");
		expect(applied.workspace_id).toBe("ws-bs");
		expect(applied.workspace_kind).toBe("shared");
		expect(applied.origin_device_id).toBe("device-bs-origin");
		expect(applied.origin_source).toBe("bootstrap-test");
		expect(applied.trust_state).toBe("trusted");
		expect(applied.narrative).toBe("Bootstrap narrative");
		expect(applied.user_prompt_id).toBe(99);
		expect(applied.prompt_number).toBe(3);
	});
});
