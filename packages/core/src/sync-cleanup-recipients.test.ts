import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toJson } from "./db.js";
import {
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

	it("from the local default scope go only to devices the Project sharing rules would have sent the memory to", () => {
		insertMovedMemory();
		pairPeer("peer-api", ["api"]);
		pairPeer("peer-docs", ["docs"]);
		const op = cleanup(DEFAULT_SYNC_SCOPE_ID);

		expect(sent(op, "peer-api")).toBe(true);
		expect(sent(op, "peer-docs")).toBe(false);
	});

	it("leave a cleanup addressed to one device for that device", () => {
		pairPeer("peer-new");

		expect(sent(cleanup(OLD_SCOPE, "peer-new"), "peer-new")).toBe(true);
	});
});
