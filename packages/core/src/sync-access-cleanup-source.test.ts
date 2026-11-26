import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyReplicationOps,
	DEFAULT_SYNC_SCOPE_ID,
	recordReplicationOp,
} from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

const NOW = "2026-11-26T12:00:00.000Z";
const SCOPE = "acme-work";
// A memory id in the creator's namespace: "creator" in base64url.
const QUALIFIED = "memory-source-v1:Y3JlYXRvcg:00000000-0000-4000-8000-000000000001";
const LEGACY = "00000000-0000-4000-8000-000000000002";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});

afterEach(() => db.close());

/** A replica this device received, with the given stored origin. */
function insertReplica(importKey: string, origin: string): number {
	const session = db
		.prepare("INSERT INTO sessions(started_at, project) VALUES (?, 'fixture')")
		.run(NOW);
	return Number(
		db
			.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text,
			active, created_at, updated_at, metadata_json, import_key, origin_device_id, rev, visibility, scope_id)
			VALUES (?, 'discovery', 'Fixture', 'Fixture body', 0.5, '', 1, ?, ?, '{}', ?, ?, 1, 'shared', ?)`)
			.run(session.lastInsertRowid, NOW, NOW, importKey, origin, SCOPE).lastInsertRowid,
	);
}

/** An update of the replica sent by `sender`, whose payload names `origin`. */
function updateFrom(memoryId: number, sender: string, origin: string): ReplicationOp {
	recordReplicationOp(db, {
		memoryId,
		deviceId: sender,
		opType: "upsert",
		scopeId: SCOPE,
		createdAt: NOW,
	});
	const recorded = db
		.prepare("SELECT * FROM replication_ops ORDER BY rowid DESC LIMIT 1")
		.get() as ReplicationOp;
	db.prepare("DELETE FROM replication_ops WHERE op_id = ?").run(recorded.op_id);
	const payload = JSON.parse(recorded.payload_json ?? "{}");
	return {
		...recorded,
		op_id: `update-${sender}-${origin}`,
		device_id: sender,
		clock_device_id: sender,
		clock_rev: 5,
		payload_json: JSON.stringify({ ...payload, origin_device_id: origin }),
	};
}

function cleanupFrom(importKey: string, sender: string): ReplicationOp {
	return {
		op_id: `cleanup-${sender}`,
		entity_type: "memory_item",
		entity_id: importKey,
		op_type: "access_cleanup",
		payload_json: JSON.stringify({ cleanup_scope_id: SCOPE, reason: "scope_revoked" }),
		clock_rev: 6,
		clock_updated_at: NOW,
		clock_device_id: sender,
		device_id: sender,
		created_at: NOW,
		scope_id: DEFAULT_SYNC_SCOPE_ID,
	};
}

const origin = (memoryId: number) =>
	db.prepare("SELECT origin_device_id FROM memory_items WHERE id = ?").pluck().get(memoryId);
const replicaCount = () => db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get();

describe("inbound cleanup of a replica", () => {
	it("keeps the creator when a member's update names itself, so the member cannot retract the replica", () => {
		// Arrange: a member with write access relabels another creator's replica.
		const memoryId = insertReplica(LEGACY, "creator");
		applyReplicationOps(db, [updateFrom(memoryId, "member", "member")], "receiver");

		// Act: the member later sends a cleanup for the scope.
		applyReplicationOps(db, [cleanupFrom(LEGACY, "member")], "receiver");

		// Assert
		expect(origin(memoryId)).toBe("creator");
		expect(replicaCount()).toBe(1);
	});

	it("lets the creator retract a replica whose id names it, whatever origin is stored", () => {
		// Arrange: an origin relabeled before updates stopped changing it.
		insertReplica(QUALIFIED, "member");

		// Act and assert: the stored origin's device is refused, the creator is not.
		applyReplicationOps(db, [cleanupFrom(QUALIFIED, "member")], "receiver");
		expect(replicaCount()).toBe(1);
		applyReplicationOps(db, [cleanupFrom(QUALIFIED, "creator")], "receiver");
		expect(replicaCount()).toBe(0);
	});

	it("still lets the creator retract a historical replica by its stored origin", () => {
		insertReplica(LEGACY, "creator");

		applyReplicationOps(db, [cleanupFrom(LEGACY, "creator")], "receiver");

		expect(replicaCount()).toBe(0);
	});

	it("lets an update fill in a missing or local origin, as a claimed origin arrives", () => {
		const local = insertReplica(LEGACY, "local");

		applyReplicationOps(db, [updateFrom(local, "creator", "creator")], "receiver");

		expect(origin(local)).toBe("creator");
	});
});
