import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { isMemoryScopeRetired, recordMemoryScopeRetirement } from "./memory-scope-retirement.js";
import { getVerifiedMemorySource } from "./memory-source-identity.js";
import {
	applyReplicationOps,
	filterReplicationOpsForSyncWithStatus,
	getSyncResetState,
	loadReplicationOpsForPeer,
	recordReplicationOp,
	recordScopeReassignment,
} from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

let db: InstanceType<typeof Database>;
let memoryId: number;
const now = "2026-09-21T12:00:00.000Z";
const qualified = "memory-source-v1:c291cmNl:00000000-0000-4000-8000-000000000001";
const retirement = { entityId: qualified, sourceDeviceId: "source", retiredScopeId: "old" };

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	const session = db
		.prepare("INSERT INTO sessions(started_at, project) VALUES (?, 'fixture')")
		.run(now);
	memoryId = Number(
		db
			.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, import_key, origin_device_id, rev, visibility, scope_id)
		VALUES (?, 'discovery', 'Fixture', 'Fixture body', 0.5, '', 1, ?, ?, '{}', ?, 'source', 100, 'shared', 'old')`)
			.run(session.lastInsertRowid, now, now, qualified).lastInsertRowid,
	);
});
afterEach(() => db.close());

function retire(input = retirement, sender = "source") {
	recordMemoryScopeRetirement(db, input, { authenticatedSourceDeviceId: sender, now });
}
function queued(): ReplicationOp {
	recordReplicationOp(db, {
		memoryId,
		deviceId: "source",
		opType: "upsert",
		scopeId: "old",
		createdAt: now,
	});
	return db.prepare("SELECT * FROM replication_ops LIMIT 1").get() as ReplicationOp;
}

function grantScope(scopeId: string, devices: string[]) {
	db.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
		VALUES (?, ?, 'user', 'coordinator', 1, 'active', ?, ?)`).run(scopeId, scopeId, now, now);
	for (const device of devices) {
		db.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
			VALUES (?, ?, 'member', 'active', 1, ?)`).run(scopeId, device, now);
	}
}

it("does not transfer old recipients to the destination or suppress unrelated old-scope content", () => {
	grantScope("old", ["source", "old-only"]);
	grantScope("new", ["source", "destination-only"]);
	const old = queued();
	const options = { localDeviceId: "source", supportsReassignScope: true };
	expect(filterReplicationOpsForSyncWithStatus(db, [old], "old-only", options)[0]).toHaveLength(1);
	db.transaction(() => {
		retire();
		recordScopeReassignment(db, {
			operationId: "recipient-move",
			memoryId,
			oldScopeId: "old",
			newScopeId: "new",
			deviceId: "source",
			createdAt: now,
		});
	})();
	const ops = db
		.prepare("SELECT * FROM replication_ops ORDER BY created_at, op_id")
		.all() as ReplicationOp[];
	expect(filterReplicationOpsForSyncWithStatus(db, ops, "old-only", options)[0]).toEqual([]);
	const destinationOps = filterReplicationOpsForSyncWithStatus(
		db,
		ops,
		"destination-only",
		options,
	)[0];
	expect(destinationOps).toHaveLength(1);
	expect(destinationOps[0]?.scope_id).toBe("new");
	expect(
		filterReplicationOpsForSyncWithStatus(
			db,
			[{ ...old, entity_id: "unrelated" }],
			"old-only",
			options,
		)[0],
	).toHaveLength(1);
});

it("rejects the original peer-overwritten-origin attack on an unverified historical UUID", () => {
	db.prepare("UPDATE memory_items SET import_key = 'historical-uuid'").run();
	const original = queued();
	const payload = JSON.parse(original.payload_json ?? "{}");
	payload.origin_device_id = "attacker";
	const forged = {
		...original,
		op_id: "forged-origin",
		device_id: "attacker",
		clock_device_id: "attacker",
		clock_rev: 101,
		payload_json: JSON.stringify(payload),
	};
	expect(applyReplicationOps(db, [forged], "receiver").applied).toBe(1);
	expect(db.prepare("SELECT origin_device_id FROM memory_items").pluck().get()).toBe("attacker");
	expect(() =>
		db.transaction(() =>
			retire(
				{ ...retirement, entityId: "historical-uuid", sourceDeviceId: "attacker" },
				"attacker",
			),
		)(),
	).toThrow("memory_source_verification_required");
	expect(getVerifiedMemorySource(db, "historical-uuid")).toBeNull();
	expect(isMemoryScopeRetired(db, "historical-uuid", "old")).toBe(false);
});

it("accepts a source-authenticated absent qualified tombstone but never a forged namespace or sender", () => {
	db.prepare("DELETE FROM memory_items").run();
	expect(() => retire()).toThrow("memory_retirement_transaction_required");
	expect(() => db.transaction(() => retire(retirement, "attacker"))()).toThrow(
		"memory_retirement_sender_mismatch",
	);
	expect(() =>
		db.transaction(() => retire({ ...retirement, sourceDeviceId: "attacker" }, "attacker"))(),
	).toThrow("memory_source_sender_mismatch");
	expect(() =>
		db.transaction(() => retire({ ...retirement, entityId: "absent-historical-uuid" }))(),
	).toThrow("memory_source_verification_required");
	db.transaction(() => retire())();
	expect(isMemoryScopeRetired(db, qualified, "old")).toBe(true);
	expect(getVerifiedMemorySource(db, qualified)?.sourceDeviceId).toBe("source");
});

it("retains immutable payload-free fences through erase, compaction, restart and duplicate replay", () => {
	queued();
	db.transaction(() => retire())();
	db.prepare("DELETE FROM memory_items").run();
	db.prepare("DELETE FROM replication_ops").run();
	const bytes = db.serialize();
	db.close();
	db = new Database(bytes);
	db.transaction(() => retire())();
	expect(db.prepare("SELECT * FROM memory_scope_retirements").all()).toEqual([
		{ entity_id: qualified, source_device_id: "source", retired_scope_id: "old", retired_at: now },
	]);
	for (const sql of [
		"DELETE FROM memory_scope_retirements",
		"UPDATE memory_scope_retirements SET source_device_id = 'attacker'",
		"INSERT OR REPLACE INTO memory_scope_retirements SELECT * FROM memory_scope_retirements",
	]) {
		expect(() => db.exec(sql)).toThrow("memory_retirement_immutable");
	}
});

it("filters every queued old-content operation before payload parsing even with scope filtering disabled", () => {
	const old = queued();
	db.transaction(() => retire())();
	for (const opType of ["upsert", "delete", "reassign_scope", "access_cleanup"]) {
		const [ops, cursor, status] = filterReplicationOpsForSyncWithStatus(
			db,
			[{ ...old, op_type: opType }],
			"old-only",
			{ applyScopeFilter: false, supportsReassignScope: true },
		);
		expect(ops).toEqual([]);
		expect(cursor).not.toBeNull();
		expect(status?.skipped_count).toBe(1);
	}
	const unrelated = { ...old, entity_id: "unrelated" };
	expect(
		filterReplicationOpsForSyncWithStatus(db, [unrelated], "old-only", {
			applyScopeFilter: false,
		})[0],
	).toHaveLength(1);
});

it("filters retired content at the peer operation loader without adding destination grants", () => {
	queued();
	db.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
		VALUES ('old', 'Old', 'project', 'local', 0, 'active', ?, ?)`).run(now, now);
	const boundary = getSyncResetState(db, "old");
	const options = {
		since: null,
		deviceId: "source",
		scopeId: "old",
		generation: boundary.generation,
		snapshotId: boundary.snapshot_id,
		baselineCursor: boundary.baseline_cursor,
	};
	const before = loadReplicationOpsForPeer(db, options);
	expect(before.reset_required).toBe(false);
	if (before.reset_required) throw new Error("unexpected reset");
	expect(before.ops).toHaveLength(1);
	db.transaction(() => retire())();
	const after = loadReplicationOpsForPeer(db, options);
	expect(after.reset_required).toBe(false);
	if (after.reset_required) throw new Error("unexpected reset");
	expect(after.ops).toEqual([]);
	expect(after.nextCursor).toBe(before.nextCursor);
	expect(db.prepare("SELECT COUNT(*) FROM scope_memberships").pluck().get()).toBe(0);
});

it("rejects retired-scope replay before clocks and prevents resurrection after row deletion", () => {
	const old = queued();
	db.transaction(() => retire())();
	db.prepare("DELETE FROM replication_ops").run();
	for (const opType of ["upsert", "delete", "reassign_scope"]) {
		expect(
			applyReplicationOps(
				db,
				[
					{
						...old,
						op_id: `replay-${opType}`,
						op_type: opType,
						clock_rev: 99999,
						device_id: "attacker",
					},
				],
				"receiver",
			).skipped,
		).toBe(1);
	}
	expect(db.prepare("SELECT scope_id, active FROM memory_items").get()).toEqual({
		scope_id: "old",
		active: 1,
	});
	db.prepare("DELETE FROM memory_items").run();
	expect(applyReplicationOps(db, [{ ...old, clock_rev: 99999 }], "receiver").skipped).toBe(1);
	expect(db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(0);
});

it("rolls back bindings and fences with a failed move and prohibits reassignment into a retired scope", () => {
	expect(() =>
		db.transaction(() => {
			retire();
			throw new Error("move_failed");
		})(),
	).toThrow("move_failed");
	expect(isMemoryScopeRetired(db, qualified, "old")).toBe(false);
	expect(getVerifiedMemorySource(db, qualified)).toBeNull();
	db.transaction(() => {
		retire();
		recordScopeReassignment(db, {
			operationId: "move",
			memoryId,
			oldScopeId: "old",
			newScopeId: "new",
			deviceId: "source",
			createdAt: now,
		});
	})();
	expect(() =>
		recordScopeReassignment(db, {
			operationId: "return",
			memoryId,
			oldScopeId: "new",
			newScopeId: "old",
			deviceId: "source",
			createdAt: now,
		}),
	).toThrow("memory_scope_retired");
	expect(isMemoryScopeRetired(db, qualified, "new")).toBe(false);
});
