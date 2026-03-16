import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	chunkOpsBySize,
	extractReplicationOps,
	getReplicationCursor,
	setReplicationCursor,
} from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
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
