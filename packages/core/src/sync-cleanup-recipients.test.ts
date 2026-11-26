import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toJson } from "./db.js";
import {
	applyReplicationOps,
	DEFAULT_SYNC_SCOPE_ID,
	filterReplicationOpsForSyncWithStatus,
} from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

const NOW = "2026-11-26T12:00:00.000Z";
const OLD_SCOPE = "acme-old";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});

afterEach(() => db.close());

function pairPeer(peerDeviceId: string, projectsInclude: string[] = []) {
	db.prepare(
		"INSERT INTO sync_peers(peer_device_id, projects_include_json, projects_exclude_json, created_at) VALUES (?, ?, ?, ?)",
	).run(peerDeviceId, toJson(projectsInclude), toJson([]), NOW);
}

function recordMembership(deviceId: string, status: "active" | "revoked") {
	db.prepare(
		`INSERT OR IGNORE INTO replication_scopes(
		 scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)`,
	).run(OLD_SCOPE, OLD_SCOPE, NOW, NOW);
	db.prepare(
		`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
		 VALUES (?, ?, 'member', ?, 1, ?)`,
	).run(OLD_SCOPE, deviceId, status, NOW);
}

/** The memory, now in another Space, as it was before the move: shared in Project `api`. */
function insertMovedMemory() {
	const session = db
		.prepare("INSERT INTO sessions(started_at, cwd, project) VALUES (?, '/work/api', 'api')")
		.run(NOW);
	db.prepare(
		`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
		 import_key, origin_device_id, rev, visibility, scope_id)
		 VALUES (?, 'discovery', 'Moved', 'Moved body', ?, ?, 'key:moved', 'local-device', 2, 'shared', 'acme-new')`,
	).run(session.lastInsertRowid, NOW, NOW);
}

function cleanup(cleanupScopeId: string, targetPeerDeviceId?: string): ReplicationOp {
	return {
		op_id: `cleanup-${cleanupScopeId}-${targetPeerDeviceId ?? "all"}`,
		entity_type: "memory_item",
		entity_id: "key:moved",
		op_type: "access_cleanup",
		payload_json: toJson({
			cleanup_scope_id: cleanupScopeId,
			reason: "project_scope_reassignment",
			...(targetPeerDeviceId ? { target_peer_device_id: targetPeerDeviceId } : {}),
		}),
		clock_rev: 1,
		clock_updated_at: NOW,
		clock_device_id: "local-device",
		device_id: "local-device",
		created_at: NOW,
		scope_id: DEFAULT_SYNC_SCOPE_ID,
	};
}

function sent(op: ReplicationOp, peerDeviceId: string) {
	const [allowed, cursor, skipped] = filterReplicationOpsForSyncWithStatus(db, [op], peerDeviceId, {
		localDeviceId: "local-device",
	});
	// A withheld cleanup is passed over like any filtered op, so the cursor still moves.
	expect(cursor).toBe(`${NOW}|${op.op_id}`);
	if (allowed.length === 0) expect(skipped).toMatchObject({ reason: "scope_filter" });
	return allowed.length === 1;
}

describe("untargeted cleanup records", () => {
	it("go only to devices with a membership record in the scope the memory left", () => {
		// Arrange: a current member, a member whose access was revoked, and a device
		// paired later that never belonged to the scope.
		for (const peer of ["peer-member", "peer-revoked", "peer-new"]) pairPeer(peer);
		recordMembership("peer-member", "active");
		recordMembership("peer-revoked", "revoked");
		const op = cleanup(OLD_SCOPE);

		// Act and assert
		expect(sent(op, "peer-member")).toBe(true);
		expect(sent(op, "peer-revoked")).toBe(true);
		expect(sent(op, "peer-new")).toBe(false);
	});

	it("from the local default scope still reach a device whose Project filters changed since", () => {
		// Nothing records who received a local default memory, and this notice is the
		// only way an old copy is removed, so current filters cannot withhold it.
		insertMovedMemory();
		pairPeer("peer-api", ["api"]);
		pairPeer("peer-docs", ["docs"]);
		const op = cleanup(DEFAULT_SYNC_SCOPE_ID);

		expect(sent(op, "peer-api")).toBe(true);
		expect(sent(op, "peer-docs")).toBe(true);
	});

	it("leave a cleanup addressed to one device for that device", () => {
		pairPeer("peer-new");

		expect(sent(cleanup(OLD_SCOPE, "peer-new"), "peer-new")).toBe(true);
	});
});

describe("a memory's move out of the local default scope", () => {
	const NEW_SCOPE = "acme-new";
	const move: ReplicationOp = {
		op_id: "move-old-side",
		entity_type: "memory_item",
		entity_id: "key:moved",
		op_type: "reassign_scope",
		payload_json: toJson({
			operation_id: "share-op",
			memory_id: "key:moved",
			old_scope_id: DEFAULT_SYNC_SCOPE_ID,
			new_scope_id: NEW_SCOPE,
			side: "old",
			revision: 2,
		}),
		clock_rev: 2,
		clock_updated_at: NOW,
		clock_device_id: "local-device",
		device_id: "local-device",
		created_at: NOW,
		scope_id: DEFAULT_SYNC_SCOPE_ID,
	};

	function outbound(peerDeviceId: string): ReplicationOp[] {
		const [allowed] = filterReplicationOpsForSyncWithStatus(db, [move], peerDeviceId, {
			localDeviceId: "local-device",
			supportsReassignScope: true,
		});
		return allowed;
	}

	beforeEach(() => {
		// Arrange: this device created the memory and moved it into the new Space.
		insertMovedMemory();
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)`,
		).run(NEW_SCOPE, NEW_SCOPE, NOW, NOW);
		for (const deviceId of ["local-device", "peer-inside"]) {
			db.prepare(
				`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
				 VALUES (?, ?, 'member', 'active', 1, ?)`,
			).run(NEW_SCOPE, deviceId, NOW);
		}
		for (const peer of ["peer-inside", "peer-outside"]) pairPeer(peer);
		pairPeer("peer-other-project", ["docs"]);
	});

	it("still reaches a device in the new Space as the move", () => {
		expect(outbound("peer-inside")).toEqual([move]);
	});

	it("reaches a device outside the new Space as a cleanup notice that names no destination", () => {
		// Act
		const [notice, ...rest] = outbound("peer-outside");

		// Assert
		expect(rest).toEqual([]);
		expect(notice).toMatchObject({
			op_id: "move-old-side:cleanup:peer-outside",
			op_type: "access_cleanup",
			entity_id: "key:moved",
			scope_id: DEFAULT_SYNC_SCOPE_ID,
			device_id: "local-device",
			clock_device_id: "local-device",
		});
		expect(JSON.parse(notice?.payload_json ?? "{}")).toEqual({
			cleanup_scope_id: DEFAULT_SYNC_SCOPE_ID,
			reason: "scope_reassignment",
			target_peer_device_id: "peer-outside",
		});
		expect(JSON.stringify(notice)).not.toContain(NEW_SCOPE);
	});

	it("goes to no device the Project sharing rules would not have sent the memory to", () => {
		expect(outbound("peer-other-project")).toEqual([]);
	});

	it("removes the outside device's copy, by the cleanup rules beta.2 receivers apply", () => {
		// Arrange: the outside device's database holds the shared local default copy.
		const [notice] = outbound("peer-outside");
		if (!notice) throw new Error("missing notice");
		const receiver = new Database(":memory:");
		initTestSchema(receiver);
		try {
			const session = receiver
				.prepare("INSERT INTO sessions(started_at, project) VALUES (?, 'api')")
				.run(NOW);
			receiver
				.prepare(
					`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
					 import_key, origin_device_id, rev, visibility, scope_id)
					 VALUES (?, 'discovery', 'Moved', 'Moved body', ?, ?, 'key:moved', 'local-device', 1, 'shared', ?)`,
				)
				.run(session.lastInsertRowid, NOW, NOW, DEFAULT_SYNC_SCOPE_ID);

			// Act: the receiver applies it as an authenticated push from this device.
			const result = applyReplicationOps(receiver, [notice], "peer-outside", undefined, {
				peerDeviceId: "local-device",
			});

			// Assert: the copy is gone, and nothing stored names the new Space.
			expect(result).toMatchObject({ applied: 1, errors: [], rejected: 0 });
			expect(receiver.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(0);
			const stored = receiver.prepare("SELECT * FROM replication_ops").all();
			expect(stored).toHaveLength(1);
			expect(JSON.stringify(stored)).not.toContain(NEW_SCOPE);

			// A move that reaches it later, after it joined the Space, finds no copy and no error.
			const later = applyReplicationOps(receiver, [move], "peer-outside", undefined, {
				peerDeviceId: "local-device",
			});
			expect(later).toMatchObject({ errors: [], rejected: 0 });
			expect(receiver.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(0);
		} finally {
			receiver.close();
		}
	});
});
