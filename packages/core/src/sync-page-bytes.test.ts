import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toJson } from "./db.js";
import {
	loadMemorySnapshotPageForPeer,
	loadReplicationOpsForPeer,
	SYNC_PAGE_MAX_BYTES,
	setSyncResetState,
} from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

const SCOPE = "work-scope";
const boundary = {
	generation: 2,
	snapshot_id: "snapshot-2",
	baseline_cursor: "2026-01-01T00:00:01Z|base-op",
	retained_floor_cursor: "2026-01-01T00:00:02Z|floor-op",
};
const request = {
	scopeId: SCOPE,
	generation: 2,
	snapshotId: "snapshot-2",
	baselineCursor: "2026-01-01T00:00:01Z|base-op",
} as const;

let db: InstanceType<typeof Database>;
let sessionId: number;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	sessionId = insertTestSession(db);
	setSyncResetState(db, boundary);
	setSyncResetState(db, boundary, SCOPE);
});

afterEach(() => {
	db.close();
});

function insertOp(index: number, payloadBytes: number, scopeId: string = SCOPE) {
	const opId = `op-${index}`;
	const createdAt = `2026-01-01T00:00:${String(index + 2).padStart(2, "0")}Z`;
	db.prepare(
		`INSERT INTO replication_ops(op_id, entity_type, entity_id, op_type, payload_json, clock_rev, clock_updated_at, clock_device_id, device_id, created_at, scope_id)
		 VALUES (?, 'memory_item', ?, 'upsert', ?, 1, ?, 'dev-a', 'dev-a', ?, ?)`,
	).run(
		opId,
		`ent-${opId}`,
		toJson({ body_text: "x".repeat(payloadBytes) }),
		createdAt,
		createdAt,
		scopeId,
	);
}

/** Follows `next_cursor` the way a client does and returns the op IDs of each page. */
function opPages(maxBytes?: number): string[][] {
	const pages: string[][] = [];
	let since = boundary.retained_floor_cursor;
	for (let guard = 0; guard < 20; guard++) {
		const result = loadReplicationOpsForPeer(db, {
			...request,
			since,
			deviceId: "dev-a",
			maxBytes,
		});
		if (result.reset_required) throw new Error("unexpected reset");
		if (result.ops.length === 0) return pages;
		pages.push(result.ops.map((op) => op.op_id));
		since = result.nextCursor ?? since;
	}
	throw new Error("paging did not finish");
}

function insertMemory(importKey: string, bodyBytes = 4, visibility = "shared") {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_items(
			session_id, kind, title, body_text, created_at, updated_at, import_key, rev,
			active, visibility, scope_id, metadata_json
		 ) VALUES (?, 'discovery', ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
	).run(
		sessionId,
		importKey,
		"y".repeat(bodyBytes),
		now,
		now,
		importKey,
		visibility,
		SCOPE,
		toJson({ clock_device_id: "dev-a" }),
	);
}

function snapshotPage(options: { pageToken?: string | null; maxBytes?: number; limit?: number }) {
	return loadMemorySnapshotPageForPeer(db, { limit: 2000, ...request, ...options });
}

/** Follows `has_more` and `next_page_token` the way a client does. */
function snapshotPages(maxBytes?: number, limit?: number): string[][] {
	const pages: string[][] = [];
	let pageToken: string | null = null;
	for (let guard = 0; guard < 20; guard++) {
		const result = snapshotPage({ pageToken, maxBytes, limit });
		pages.push(result.items.map((item) => item.entity_id));
		if (!result.hasMore) return pages;
		pageToken = result.nextPageToken;
	}
	throw new Error("paging did not finish");
}

describe("pull page byte cap", () => {
	it("splits a page by serialized size and pages through every op once", () => {
		// Arrange: five ops of about 400 bytes and a 1000-byte cap that fits two.
		for (let i = 1; i <= 5; i++) insertOp(i, 150);
		// Act / Assert.
		expect(opPages(1000)).toEqual([["op-1", "op-2"], ["op-3", "op-4"], ["op-5"]]);
	});

	it("returns an op larger than the cap alone so paging still advances", () => {
		insertOp(1, 5000);
		insertOp(2, 10);
		expect(opPages(1000)).toEqual([["op-1"], ["op-2"]]);
	});

	it("resumes after the last op returned when a filtered op sits between capped ones", () => {
		// Arrange: an unscoped pull drops default-scope ops after loading them.
		insertOp(1, 3000);
		insertOp(2, 10, "shared:default");
		insertOp(3, 3000);
		// Act / Assert: the dropped op is scanned again and dropped again, never served.
		expect(opPages(4000, { scoped: false })).toEqual([["op-1"], ["op-3"]]);
	});

	it("caps default pages at SYNC_PAGE_MAX_BYTES", () => {
		// Arrange: four 300 KB payloads, the size of large real memories.
		for (let i = 1; i <= 4; i++) insertOp(i, 300_000);
		// Act / Assert: three fit under 1 MiB, so the fourth starts the next page.
		expect(SYNC_PAGE_MAX_BYTES).toBe(1_048_576);
		expect(opPages()).toEqual([["op-1", "op-2", "op-3"], ["op-4"]]);
	});
});

describe("snapshot page byte cap", () => {
	it("splits pages by serialized size and resumes at the first item left out", () => {
		// Arrange: five same-size items and a cap that fits two of them.
		for (const key of ["key-a", "key-b", "key-c", "key-d", "key-e"]) insertMemory(key);
		const itemBytes = Buffer.byteLength(JSON.stringify(snapshotPage({}).items[0])) + 1;
		// Act / Assert: every item exactly once, in order, two per page.
		expect(snapshotPages(Math.floor(itemBytes * 2.5))).toEqual([
			["key-a", "key-b"],
			["key-c", "key-d"],
			["key-e"],
		]);
	});

	it("caps default pages at SYNC_PAGE_MAX_BYTES even when the limit allows more", () => {
		for (const key of ["key-a", "key-b", "key-c", "key-d"]) insertMemory(key, 300_000);
		expect(snapshotPages()).toEqual([["key-a", "key-b", "key-c"], ["key-d"]]);
	});

	it("resumes at the right row when the cap trips on the first row of a later scan batch", () => {
		// Arrange: limit 2 scans six rows a batch. The first batch holds one eligible
		// item and five private rows the peer may not receive; the large item opens batch two.
		insertMemory("key-a");
		for (const key of ["key-b", "key-c", "key-d", "key-e", "key-f"])
			insertMemory(key, 4, "private");
		insertMemory("key-g", 20_000);
		const smallBytes = Buffer.byteLength(JSON.stringify(snapshotPage({}).items[0])) + 1;
		// Act / Assert: the private rows are passed once and never served, and key-g is not skipped.
		expect(snapshotPages(smallBytes + 1000, 2)).toEqual([["key-a"], ["key-g"]]);
	});

	it("keeps the item limit when items are small", () => {
		for (const key of ["key-a", "key-b", "key-c"]) insertMemory(key);
		const first = snapshotPage({ limit: 2 });
		expect(first.items.map((item) => item.entity_id)).toEqual(["key-a", "key-b"]);
		expect(first.hasMore).toBe(true);
	});
});
