import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toJson } from "./db.js";
import {
	applyReplicationOps,
	backfillReplicationOps,
	chunkOpsBySize,
	clockTuple,
	extractReplicationOps,
	filterReplicationOpsForSync,
	filterReplicationOpsForSyncWithStatus,
	getReplicationCursor,
	isNewerClock,
	loadReplicationOpsSince,
	migrateLegacyImportKeys,
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

		expect(row.payload_json).not.toBeNull();
		const payload = JSON.parse(row.payload_json!) as Record<string, unknown>;
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

		const db2 = new Database(":memory:");
		initTestSchema(db2);
		try {
			const result = applyReplicationOps(db2, [op!], "dev-local");
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
