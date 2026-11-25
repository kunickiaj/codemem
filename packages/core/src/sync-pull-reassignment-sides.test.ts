import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { SecretScanner } from "./secret-scanner.js";
import * as syncAuth from "./sync-auth.js";
import type { RequestJsonExecutor } from "./sync-http-client.js";
import * as http from "./sync-http-client.js";
import * as identity from "./sync-identity.js";
import { syncOnce } from "./sync-pass.js";
import { getReplicationCursor, setReplicationCursor } from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

/*
 * The new side of a move between Projects reaches a device in the destination
 * that may not know the older Project at all. The older scope needs the
 * sender's authorization only for a copy this device actually holds there.
 */

const LOCAL = "move-local";
const PEER = "move-peer";
const FINGERPRINT = "move-fingerprint";
const DESTINATION = "move-destination";
const KEY = "moved-memory";
const T = "2026-01-01T00:00:00Z";
const BASELINE = `${T}|baseline`;
const BOUNDARY = { generation: 1, snapshot_id: "move-snapshot", baseline_cursor: BASELINE };

let db: InstanceType<typeof Database>;

function grant(scopeId: string, deviceIds: string[]) {
	db.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id,
		group_id, membership_epoch, status, created_at, updated_at)
		VALUES (?, ?, 'team', 'coordinator', 'coordinator-1', 'group-1', 1, 'active', ?, ?)`).run(
		scopeId,
		scopeId,
		T,
		T,
	);
	for (const deviceId of deviceIds) {
		db.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch,
			updated_at) VALUES (?, ?, 'member', 'active', 1, ?)`).run(scopeId, deviceId, T);
	}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
	db = new Database(":memory:");
	initTestSchema(db);
	vi.spyOn(identity, "ensureDeviceIdentity").mockReturnValue([LOCAL, "ed25519 fixture"]);
	vi.spyOn(syncAuth, "buildDirectPeerAuthHeaders").mockReturnValue({});
	vi.spyOn(http, "requestJson").mockImplementation(async () => {
		throw new Error("unexpected_default_http");
	});
	db.prepare(`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at)
		VALUES (?, ?, ?, ?)`).run(PEER, CANONICAL_PUBLIC_KEY, FINGERPRINT, T);
	grant(DESTINATION, [LOCAL, PEER]);
	setReplicationCursor(db, PEER, { lastApplied: BASELINE, lastAcked: BASELINE });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	db.close();
});

function newSide(oldScopeId: string): ReplicationOp {
	return {
		op_id: "move-new-side",
		entity_type: "memory_item",
		entity_id: KEY,
		op_type: "reassign_scope",
		payload_json: JSON.stringify({
			operation_id: "move-1",
			memory_id: KEY,
			old_scope_id: oldScopeId,
			new_scope_id: DESTINATION,
			revision: 5,
			side: "new",
			kind: "discovery",
			title: "Moved",
			body_text: "Moved body",
			visibility: "shared",
			scope_id: DESTINATION,
		}),
		clock_rev: 5,
		clock_updated_at: "2026-01-02T00:00:00Z",
		clock_device_id: PEER,
		device_id: PEER,
		created_at: "2026-01-02T00:00:00Z",
		scope_id: DESTINATION,
	};
}

function holdOldCopy(scopeId: string) {
	const session = db
		.prepare("INSERT INTO sessions(started_at, project) VALUES (?, 'fixture')")
		.run(T).lastInsertRowid;
	db.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text,
		active, created_at, updated_at, metadata_json, import_key, origin_device_id, rev, visibility,
		scope_id) VALUES (?, 'discovery', 'Older', 'Older body', 0.5, '', 1, ?, ?, '{}', ?, ?, 1,
		'shared', ?)`).run(session, T, T, KEY, PEER, scopeId);
}

function peer(op: ReplicationOp): RequestJsonExecutor {
	return async (method, url) => {
		const { pathname, searchParams } = new URL(url);
		if (pathname === "/v1/status")
			return [
				200,
				{
					fingerprint: FINGERPRINT,
					protocol_version: "2",
					sync_capability: "scoped",
					sync_features: ["reassign_scope"],
					sync_reset: { ...BOUNDARY, scope_id: null },
					authorized_scopes: [],
				},
			];
		if (method === "POST") return [200, { applied: 0, skipped: 0, errors: [] }];
		const ops = searchParams.get("scope_id") ? [] : [op];
		const next = `${op.created_at}|${op.op_id}`;
		return [
			200,
			{ ...BOUNDARY, scope_id: null, reset_required: false, skipped: 0, ops, next_cursor: next },
		];
	};
}

async function pull(op: ReplicationOp) {
	const result = await syncOnce(db, PEER, ["http://move.example.test:47337"], {
		requestExecutor: peer(op),
		scanner: new SecretScanner(),
	});
	const copies = db
		.prepare("SELECT title, scope_id FROM memory_items WHERE import_key = ?")
		.all(KEY);
	return { result, copies, cursor: getReplicationCursor(db, PEER)[0] };
}

describe("the new side of a move between Projects", () => {
	it("reaches a device in the destination that does not know the older Project", async () => {
		await refreshTestScopeRows(db);

		const { result, copies, cursor } = await pull(newSide("move-older-unknown"));

		expect(result.ok).toBe(true);
		expect(copies).toEqual([{ title: "Moved", scope_id: DESTINATION }]);
		expect(cursor).toBe("2026-01-02T00:00:00Z|move-new-side");
	});

	it("does not move a copy held in an older Project the sender is not proven in", async () => {
		grant("move-older", [LOCAL]);
		await refreshTestScopeRows(db);
		holdOldCopy("move-older");

		const { result, copies, cursor } = await pull(newSide("move-older"));

		expect(result.ok).toBe(false);
		expect(copies).toEqual([{ title: "Older", scope_id: "move-older" }]);
		expect(cursor).toBe(BASELINE);
	});

	it("moves a copy held in an older Project the sender is proven in", async () => {
		grant("move-older", [LOCAL, PEER]);
		await refreshTestScopeRows(db);
		holdOldCopy("move-older");

		const { result, copies } = await pull(newSide("move-older"));

		expect(result.ok).toBe(true);
		expect(copies).toEqual([{ title: "Moved", scope_id: DESTINATION }]);
	});
});
