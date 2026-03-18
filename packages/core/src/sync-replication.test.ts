import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toJson } from "./db.js";
import {
	applyReplicationOps,
	chunkOpsBySize,
	clockTuple,
	extractReplicationOps,
	getReplicationCursor,
	isNewerClock,
	loadReplicationOpsSince,
	recordReplicationOp,
	setReplicationCursor,
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
	});

	it("records applied ops in replication_ops table", () => {
		const op = makeReplicationOp({ op_id: "track-me" });
		applyReplicationOps(db, [op], "dev-local");

		const row = db.prepare("SELECT op_id FROM replication_ops WHERE op_id = ?").get("track-me");
		expect(row).toBeDefined();
	});
});
