import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import {
	ACCESS_CLEANUP_OP_TYPE,
	type CoordinatorFreeOutboundRules,
	filterReplicationOpsForSyncWithStatus,
	opsStillSendableToPeer,
	recordReplicationOp,
} from "./sync-replication.js";
import { GROUP_ID, insertScope } from "./team-recovery-test-fixtures.js";
import { initTestSchema, insertTestPeer } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

/*
 * The lane's rules as inputs to the shared outbound decision, each on its own: every case
 * is an op the decision would otherwise send.
 */

const NOW = "2026-11-28T12:00:00.000Z";
const LOCAL = "local-device";
const PEER = "peer-device";
const LANE: CoordinatorFreeOutboundRules = { peerEligible: () => true };

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	insertTestPeer(db, PEER);
});

afterEach(() => db.close());

interface MemoryOptions {
	key?: string;
	scopeId?: string;
	origin?: string;
	visibility?: string | null;
	workspaceKind?: string | null;
	project?: string;
}

/** A memory and the upsert op this device recorded for it. */
function memory(options: MemoryOptions = {}) {
	const key = options.key ?? "key:memory";
	const scopeId = options.scopeId ?? "local-default";
	const session = db
		.prepare(
			`INSERT INTO sessions(started_at, cwd, project, user, tool_version)
			 VALUES (?, '/workspace', ?, 'user', 'test')`,
		)
		.run(NOW, options.project ?? "lane").lastInsertRowid;
	const id = Number(
		db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
				 visibility, workspace_kind, origin_device_id, active, metadata_json, scope_id,
				 import_key, rev)
				 VALUES (?, 'discovery', 'Title', 'Body', ?, ?, ?, ?, ?, 1, '{}', ?, ?, 1)`,
			)
			.run(
				session,
				NOW,
				NOW,
				options.visibility === undefined ? "shared" : options.visibility,
				options.workspaceKind ?? null,
				options.origin ?? LOCAL,
				scopeId,
				key,
			).lastInsertRowid,
	);
	const opId = recordReplicationOp(db, {
		memoryId: id,
		opType: "upsert",
		deviceId: LOCAL,
		scopeId,
		clockRev: 1,
		createdAt: NOW,
	});
	return { id, op: opOf(opId) };
}

function opOf(opId: string): ReplicationOp {
	return db.prepare("SELECT * FROM replication_ops WHERE op_id = ?").get(opId) as ReplicationOp;
}

function sent(ops: ReplicationOp[], lane: CoordinatorFreeOutboundRules | null = LANE) {
	const [allowed] = filterReplicationOpsForSyncWithStatus(db, ops, PEER, {
		localDeviceId: LOCAL,
		coordinatorFree: lane ?? undefined,
	});
	return allowed.map((op) => op.op_id);
}

function sendableNow(ops: ReplicationOp[], lane: CoordinatorFreeOutboundRules | null = LANE) {
	return opsStillSendableToPeer(db, ops, PEER, LOCAL, { coordinatorFree: lane ?? undefined }).map(
		(op) => op.op_id,
	);
}

describe("local-default goes only to sync without a coordinator", () => {
	it("sends this device's shared memory under the lane's rules and to no other peer", () => {
		const { op } = memory();

		expect(sent([op])).toEqual([op.op_id]);
		expect(sent([op], null)).toEqual([]);
		expect(sendableNow([op], null)).toEqual([]);
	});

	it("sends nothing while the peer isn't eligible, decided for the window and each request", () => {
		const { op } = memory();
		const closed = { peerEligible: () => false };

		expect(sent([op], closed)).toEqual([]);
		expect(sendableNow([op], closed)).toEqual([]);
	});
});

describe("the lane carries only this device's own memory ops in local-default", () => {
	it.each([
		["another sending device", { device_id: "other-device" }],
		["another clock device", { clock_device_id: "other-device" }],
		["an access cleanup", { op_type: ACCESS_CLEANUP_OP_TYPE }],
		["an op for another entity", { entity_type: "session" }],
	])("withholds %s", (_case, change) => {
		const { op } = memory();

		expect(sent([{ ...op, ...change }])).toEqual([]);
		expect(sendableNow([{ ...op, ...change }])).toEqual([]);
	});

	it("withholds a scope's op from the lane, even one the peer could read", async () => {
		insertScope(db, "team-scope", GROUP_ID);
		const insert = db.prepare(
			`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
			 VALUES ('team-scope', ?, 'member', 'active', 1, ?)`,
		);
		for (const device of [LOCAL, PEER]) insert.run(device, NOW);
		await refreshTestScopeRows(db);
		const { op } = memory({ scopeId: "team-scope" });

		expect(sent([op], null)).toEqual([op.op_id]);
		expect(sent([op])).toEqual([]);
	});
});

describe("the lane carries a copy only when this device created it, it says shared, and it is the only row", () => {
	it("withholds a copy another device created", () => {
		const { op } = memory({ origin: "other-device" });

		expect(sent([op])).toEqual([]);
	});

	it.each([
		["shared only through its workspace", { visibility: null, workspaceKind: "shared" }],
		["shared spelled another way", { visibility: "Shared" }],
	])("withholds a copy %s", (_case, options) => {
		const { op } = memory(options);

		expect(sent([op])).toEqual([]);
	});

	it("withholds a copy whose key another scope also stores", () => {
		const { op } = memory();
		memory({ scopeId: "legacy-shared-review" });

		expect(sent([op])).toEqual([]);
	});
});
