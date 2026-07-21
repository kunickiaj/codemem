import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyReplicationOps,
	DEFAULT_SYNC_SCOPE_ID,
	filterReplicationOpsForSyncWithStatus,
	parseReassignScopePayload,
	recordReplicationOp,
	recordScopeReassignment,
} from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

const now = "2026-07-20T14:00:00.000Z";

function insertMemory(
	db: InstanceType<typeof Database>,
	scopeId: string | null = "source",
): number {
	const session = db
		.prepare("INSERT INTO sessions(started_at, project, git_remote) VALUES (?, 'api', ?)")
		.run(now, "https://example.invalid/acme/api.git");
	return Number(
		db
			.prepare(`INSERT INTO memory_items(
				session_id, kind, title, body_text, confidence, tags_text, active,
				created_at, updated_at, metadata_json, import_key, rev, visibility, scope_id
			) VALUES (?, 'discovery', 'title', 'body', 0.8, '', 1, ?, ?, '{}', 'memory:key', 2, 'shared', ?)`)
			.run(Number(session.lastInsertRowid), now, now, scopeId).lastInsertRowid,
	);
}

function ops(db: InstanceType<typeof Database>): ReplicationOp[] {
	return db
		.prepare("SELECT * FROM replication_ops WHERE op_type = 'reassign_scope' ORDER BY scope_id")
		.all() as ReplicationOp[];
}

describe("reassign_scope replication", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => db.close());

	it("records one logical revision as deterministic old and new scoped sides", () => {
		const memoryId = insertMemory(db);
		const first = recordScopeReassignment(db, {
			operationId: "share_operation",
			memoryId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const replay = recordScopeReassignment(db, {
			operationId: "share_operation",
			memoryId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});

		expect(replay).toEqual(first);
		expect(ops(db)).toHaveLength(2);
		expect(new Set(ops(db).map((op) => op.clock_rev))).toEqual(new Set([3]));
		expect(
			ops(db)
				.map(parseReassignScopePayload)
				.map((payload) => payload.side)
				.sort(),
		).toEqual(["new", "old"]);
		const newSide = ops(db).find((op) => parseReassignScopePayload(op).side === "new");
		expect(JSON.parse(newSide?.payload_json ?? "{}")).toMatchObject({ project: "api" });
		expect(db.prepare("SELECT scope_id, rev FROM memory_items WHERE id = ?").get(memoryId)).toEqual(
			{
				scope_id: "managed",
				rev: 3,
			},
		);
	});

	it("reassigns replicated legacy memories that use their numeric id as the entity id", () => {
		const memoryId = insertMemory(db);
		db.prepare("UPDATE memory_items SET import_key = NULL WHERE id = ?").run(memoryId);
		recordReplicationOp(db, {
			memoryId,
			opType: "upsert",
			deviceId: "owner",
			scopeId: "source",
			createdAt: now,
		});

		recordScopeReassignment(db, {
			operationId: "share_legacy",
			memoryId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});

		expect(new Set(ops(db).map((op) => op.entity_id))).toEqual(new Set([String(memoryId)]));
		expect(db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId)).toBe(
			"managed",
		);
	});

	it("applies either authorized side without needing or exposing the other side payload", () => {
		const sourceId = insertMemory(db);
		recordScopeReassignment(db, {
			operationId: "share_operation",
			memoryId: sourceId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const [newSide, oldSide] = ops(db);
		if (!newSide || !oldSide) throw new Error("missing fixture ops");

		const oldReceiver = new Database(":memory:");
		initTestSchema(oldReceiver);
		insertMemory(oldReceiver, "source");
		const oldResult = applyReplicationOps(oldReceiver, [oldSide], "old-receiver");
		expect(oldResult.errors).toEqual([]);
		expect(oldReceiver.prepare("SELECT active, scope_id FROM memory_items").get()).toEqual({
			active: 0,
			scope_id: "source",
		});

		const newReceiver = new Database(":memory:");
		initTestSchema(newReceiver);
		const newResult = applyReplicationOps(newReceiver, [newSide], "new-receiver");
		expect(newResult.errors).toEqual([]);
		expect(newReceiver.prepare("SELECT active, scope_id, title FROM memory_items").get()).toEqual({
			active: 1,
			scope_id: "managed",
			title: "title",
		});
		oldReceiver.close();
		newReceiver.close();
	});

	it("normalizes a legacy blank scope while applying a local-default reassignment", () => {
		const sourceId = insertMemory(db, DEFAULT_SYNC_SCOPE_ID);
		recordScopeReassignment(db, {
			operationId: "share_default",
			memoryId: sourceId,
			oldScopeId: DEFAULT_SYNC_SCOPE_ID,
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const receiver = new Database(":memory:");
		initTestSchema(receiver);
		insertMemory(receiver, null);

		const result = applyReplicationOps(receiver, ops(db), "receiver");

		expect(result.errors).toEqual([]);
		expect(receiver.prepare("SELECT active, scope_id, rev FROM memory_items").get()).toEqual({
			active: 1,
			scope_id: "managed",
			rev: 3,
		});
		receiver.close();
	});

	it("converges under either side ordering and rejects malformed payloads without mutation", () => {
		const sourceId = insertMemory(db);
		recordScopeReassignment(db, {
			operationId: "share_operation",
			memoryId: sourceId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const wireOps = ops(db);
		for (const ordered of [wireOps, [...wireOps].reverse()]) {
			const receiver = new Database(":memory:");
			initTestSchema(receiver);
			insertMemory(receiver, "source");
			const result = applyReplicationOps(receiver, ordered, "receiver");
			expect(result.errors).toEqual([]);
			expect(receiver.prepare("SELECT active, scope_id, rev FROM memory_items").get()).toEqual({
				active: 1,
				scope_id: "managed",
				rev: 3,
			});
			receiver.close();
		}

		const receiver = new Database(":memory:");
		initTestSchema(receiver);
		insertMemory(receiver, "source");
		const malformed = { ...wireOps[0], payload_json: "{}" } as ReplicationOp;
		const result = applyReplicationOps(receiver, [malformed], "receiver");
		expect(result.errors[0]).toContain("reassign_payload_invalid");
		expect(receiver.prepare("SELECT active, scope_id, rev FROM memory_items").get()).toEqual({
			active: 1,
			scope_id: "source",
			rev: 2,
		});
		receiver.close();
	});

	it("withholds reassignment from peers that did not negotiate the additive feature", () => {
		const memoryId = insertMemory(db);
		recordScopeReassignment(db, {
			operationId: "share_operation",
			memoryId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const wireOps = ops(db);
		const [legacy] = filterReplicationOpsForSyncWithStatus(db, wireOps, "peer", {
			applyScopeFilter: false,
		});
		const [supported] = filterReplicationOpsForSyncWithStatus(db, wireOps, "peer", {
			applyScopeFilter: false,
			supportsReassignScope: true,
		});
		expect(legacy).toEqual([]);
		expect(supported).toHaveLength(2);
	});

	it("keeps visibility filtering on new-side reassignment payloads", () => {
		const memoryId = insertMemory(db);
		db.prepare("UPDATE memory_items SET visibility = 'private' WHERE id = ?").run(memoryId);
		recordScopeReassignment(db, {
			operationId: "share_private",
			memoryId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const newSide = ops(db).find((op) => parseReassignScopePayload(op).side === "new");
		if (!newSide) throw new Error("missing new-side reassignment");

		const [allowed, cursor, skipped] = filterReplicationOpsForSyncWithStatus(
			db,
			[newSide],
			"peer",
			{ applyScopeFilter: false, supportsReassignScope: true },
		);

		expect(allowed).toEqual([]);
		expect(cursor).toContain(newSide.op_id);
		expect(skipped).toMatchObject({ reason: "visibility_filter", visibility: "private" });
	});

	it("sends local-default old-side cleanup only to peers allowed for the project", () => {
		const memoryId = insertMemory(db, DEFAULT_SYNC_SCOPE_ID);
		recordScopeReassignment(db, {
			operationId: "share_default",
			memoryId,
			oldScopeId: DEFAULT_SYNC_SCOPE_ID,
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const oldSide = ops(db).find((op) => parseReassignScopePayload(op).side === "old");
		if (!oldSide) throw new Error("missing old-side reassignment");
		for (const [peerDeviceId, projects] of [
			["allowed-peer", ["api"]],
			["blocked-peer", ["other"]],
		] as const) {
			db.prepare(
				`INSERT INTO sync_peers(peer_device_id, projects_include_json, created_at)
				 VALUES (?, ?, ?)`,
			).run(peerDeviceId, JSON.stringify(projects), now);
		}

		const [allowed, allowedCursor] = filterReplicationOpsForSyncWithStatus(
			db,
			[oldSide],
			"allowed-peer",
			{ localDeviceId: "owner", supportsReassignScope: true },
		);
		const [blocked, blockedCursor, skipped] = filterReplicationOpsForSyncWithStatus(
			db,
			[oldSide],
			"blocked-peer",
			{ localDeviceId: "owner", supportsReassignScope: true },
		);

		expect(allowed).toEqual([oldSide]);
		expect(allowedCursor).toContain(oldSide.op_id);
		expect(blocked).toEqual([]);
		expect(blockedCursor).toContain(oldSide.op_id);
		expect(skipped).toMatchObject({ reason: "scope_filter", scope_id: DEFAULT_SYNC_SCOPE_ID });
	});
});
