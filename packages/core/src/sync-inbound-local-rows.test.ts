import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMemorySourceIdentitySchema } from "./memory-source-identity.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import {
	type ApplyReplicationOpsOptions,
	applyReplicationOps,
	DEFAULT_SYNC_SCOPE_ID,
} from "./sync-replication.js";
import { initTestSchema, insertTestPeer } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

/*
 * Local-only rows never sync, and the apply matches rows by import key alone.
 * A pulled or pushed op may change such a row only when it is the sender's own
 * replica. A row this device created is never changed.
 */

const LOCAL = "local-device";
const PEER = "peer-device";
const PROJECT = "shared-project";
const LOCAL_SCOPE = "local-notes";
const KEY = "local-row-key";
const T = "2026-01-01T00:00:00Z";

let db: InstanceType<typeof Database>;

beforeEach(async () => {
	db = new Database(":memory:");
	initTestSchema(db);
	insertTestPeer(db, PEER);
	db.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id,
		group_id, membership_epoch, status, created_at, updated_at)
		VALUES (?, ?, 'team', 'coordinator', 'coordinator-1', 'group-1', 1, 'active', ?, ?),
		(?, ?, 'user', 'local', NULL, NULL, 1, 'active', ?, ?)`).run(
		PROJECT,
		PROJECT,
		T,
		T,
		LOCAL_SCOPE,
		LOCAL_SCOPE,
		T,
		T,
	);
	for (const deviceId of [LOCAL, PEER]) {
		db.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch,
			updated_at) VALUES (?, ?, 'member', 'active', 1, ?)`).run(PROJECT, deviceId, T);
	}
	await refreshTestScopeRows(db);
});

afterEach(() => db.close());

function holdRow(scopeId: string, origin: string) {
	const session = db
		.prepare("INSERT INTO sessions(started_at, project) VALUES (?, 'fixture')")
		.run(T).lastInsertRowid;
	db.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text,
		active, created_at, updated_at, metadata_json, import_key, origin_device_id, rev, visibility,
		scope_id) VALUES (?, 'discovery', 'Held', 'Held body', 0.5, '', 1, ?, ?, '{}', ?, ?, 1,
		'shared', ?)`).run(session, T, T, KEY, origin, scopeId);
}

function recordLocalCreation() {
	ensureMemorySourceIdentitySchema(db);
	db.prepare(`INSERT INTO memory_source_bindings(entity_id, source_device_id, evidence, created_at)
		VALUES (?, ?, 'local_creation', ?)`).run(KEY, LOCAL, T);
}

function peerOp(overrides: Partial<ReplicationOp>): ReplicationOp {
	return {
		op_id: "peer-op",
		entity_type: "memory_item",
		entity_id: KEY,
		op_type: "upsert",
		payload_json: JSON.stringify({
			kind: "discovery",
			title: "Overwritten",
			body_text: "Peer body",
			visibility: "shared",
			scope_id: PROJECT,
		}),
		clock_rev: 9,
		clock_updated_at: "2026-01-02T00:00:00Z",
		clock_device_id: PEER,
		device_id: PEER,
		created_at: "2026-01-02T00:00:00Z",
		scope_id: PROJECT,
		...overrides,
	};
}

function move(side: "old" | "new", oldScopeId: string): ReplicationOp {
	const payload = {
		operation_id: "move-1",
		memory_id: KEY,
		old_scope_id: oldScopeId,
		new_scope_id: PROJECT,
		revision: 9,
		side,
		...(side === "new"
			? { kind: "discovery", title: "Moved", body_text: "Peer body", scope_id: PROJECT }
			: {}),
	};
	return peerOp({
		op_id: `move-${side}`,
		op_type: "reassign_scope",
		payload_json: JSON.stringify(payload),
		scope_id: side === "old" ? oldScopeId : PROJECT,
	});
}

const OPS = {
	upsert: () => peerOp({}),
	delete: () => peerOp({ op_id: "peer-delete", op_type: "delete", payload_json: null }),
	"move, new side": (scopeId: string) => move("new", scopeId),
	"move, old side": (scopeId: string) => move("old", scopeId),
} as const;

const MODES: Array<[string, ApplyReplicationOpsOptions]> = [
	["legacy validation", { inboundScopeValidation: { peerDeviceId: PEER, enabled: false } }],
	["scoped validation", { inboundScopeValidation: { peerDeviceId: PEER } }],
	["a push with no validation", { activityPeerDeviceId: PEER }],
];

function apply(op: ReplicationOp, options: ApplyReplicationOpsOptions) {
	return applyReplicationOps(db, [op], LOCAL, undefined, options);
}

function row() {
	return db
		.prepare("SELECT title, scope_id, active FROM memory_items WHERE import_key = ?")
		.get(KEY);
}

const HELD = { title: "Held", active: 1 };

describe("a row this device created in a local-only scope", () => {
	const cases = [DEFAULT_SYNC_SCOPE_ID, LOCAL_SCOPE].flatMap((scopeId) =>
		MODES.flatMap(([mode, options]) =>
			(Object.keys(OPS) as Array<keyof typeof OPS>).map((name) => ({
				scopeId,
				mode,
				options,
				name,
			})),
		),
	);

	it.each(cases)(
		"is not changed by a $name in $scopeId under $mode",
		({ scopeId, options, name }) => {
			holdRow(scopeId, LOCAL);

			const result = apply(OPS[name](scopeId), options);

			expect(result.applied).toBe(0);
			expect(row()).toEqual({ ...HELD, scope_id: scopeId });
		},
	);

	it.each(MODES)("is not changed under %s even when it names the peer as origin", (_m, options) => {
		holdRow(LOCAL_SCOPE, PEER);
		recordLocalCreation();

		expect(apply(peerOp({}), options).applied).toBe(0);
		expect(row()).toEqual({ ...HELD, scope_id: LOCAL_SCOPE });
	});
});

describe("the peer's own replica held in the local default scope", () => {
	it.each(MODES)("is moved out by the peer's reassignment under %s", (_mode, options) => {
		holdRow(DEFAULT_SYNC_SCOPE_ID, PEER);

		expect(apply(move("old", DEFAULT_SYNC_SCOPE_ID), options)).toMatchObject({ applied: 1 });
		expect(row()).toEqual({ title: "Held", scope_id: DEFAULT_SYNC_SCOPE_ID, active: 0 });
	});

	it.each(MODES)("is brought into the Project by the peer's new side under %s", (_m, options) => {
		holdRow(DEFAULT_SYNC_SCOPE_ID, PEER);

		expect(apply(move("new", DEFAULT_SYNC_SCOPE_ID), options)).toMatchObject({ applied: 1 });
		expect(row()).toEqual({ title: "Moved", scope_id: PROJECT, active: 1 });
	});
});

describe("an op for an entity the apply does not handle", () => {
	it.each([...MODES, ["no peer", {}] as [string, ApplyReplicationOpsOptions]])(
		"writes nothing under %s",
		(_mode, options) => {
			const result = apply(peerOp({ entity_type: "session", entity_id: "session-1" }), options);

			expect(result).toMatchObject({ applied: 0, rejected: 1 });
			expect(db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(0);
			expect(db.prepare("SELECT COUNT(*) FROM replication_ops").pluck().get()).toBe(0);
		},
	);
});
