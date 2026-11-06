import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecretScanner } from "./secret-scanner.js";
import * as syncAuth from "./sync-auth.js";
import {
	saveSyncChannelCompletedBoundary,
	saveSyncChannelOutboundAck,
} from "./sync-channel-progress.js";
import type { RequestJsonExecutor } from "./sync-http-client.js";
import * as http from "./sync-http-client.js";
import * as identity from "./sync-identity.js";
import { syncOnce } from "./sync-pass.js";
import { getReplicationCursor, setReplicationCursor } from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

// The direct legacy push carries scoped ops with one interleaved cursor, while the
// relay channel acknowledges per scope. These tests cover a switch from relay back
// to direct: ops the peer already holds must not be sent again.

const localId = "switch-source";
const peerId = "switch-receiver";
const scopeId = "switch-scope";
const timestamp = "2026-01-01T00:00:00Z";
const baseline = `${timestamp}|baseline`;
const baseUrl = "http://switch.example.test:47337";
const scanner = new SecretScanner();
const boundary = { generation: 1, snapshot_id: "switch-snapshot", baseline_cursor: baseline };

let source: InstanceType<typeof Database>;

beforeEach(() => {
	source = new Database(":memory:");
	initTestSchema(source);
	vi.spyOn(identity, "ensureDeviceIdentity").mockReturnValue([localId, "ed25519 fixture"]);
	vi.spyOn(identity, "loadPrivateKey").mockImplementation(() => {
		throw new Error("unexpected_key_load");
	});
	vi.spyOn(syncAuth, "buildDirectPeerAuthHeaders").mockReturnValue({
		"X-Opencode-Device": localId,
		"X-Opencode-Timestamp": timestamp,
		"X-Opencode-Nonce": "fixture-nonce",
		"X-Opencode-Signature": "fixture-signature",
		"X-Codemem-Recipient": peerId,
		"X-Codemem-Signature": "v3:fixture-signature",
	});
	vi.spyOn(http, "requestJson").mockImplementation(async () => {
		throw new Error("unexpected_default_http");
	});
	source
		.prepare(
			"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		)
		.run(peerId, "switch-fingerprint", timestamp);
	source
		.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type,
		membership_epoch, status, created_at, updated_at)
		VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)`)
		.run(scopeId, scopeId, timestamp, timestamp);
	for (const deviceId of [localId, peerId]) {
		source
			.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status,
			membership_epoch, updated_at) VALUES (?, ?, 'member', 'active', 1, ?)`)
			.run(scopeId, deviceId, timestamp);
	}
	setReplicationCursor(source, peerId, { lastApplied: baseline, lastAcked: baseline }, scopeId);
	setReplicationCursor(source, peerId, { lastApplied: baseline, lastAcked: baseline });
});

afterEach(() => {
	vi.restoreAllMocks();
	source.close();
});

function seedOps(count: number): ReplicationOp[] {
	return Array.from({ length: count }, (_, index) => {
		const time = `2026-01-01T00:00:0${index + 1}Z`;
		const op: ReplicationOp = {
			op_id: `switch-op-${index + 1}`,
			entity_type: "memory_item",
			entity_id: `switch-memory-${index + 1}`,
			op_type: "upsert",
			payload_json: JSON.stringify({
				kind: "discovery",
				title: "Fixture memory",
				body_text: "fixture content",
				visibility: "shared",
				scope_id: scopeId,
			}),
			clock_rev: 1,
			clock_updated_at: time,
			clock_device_id: localId,
			device_id: localId,
			created_at: time,
			scope_id: scopeId,
		};
		source
			.prepare(`INSERT INTO replication_ops(op_id, entity_type, entity_id, op_type,
			payload_json, clock_rev, clock_updated_at, clock_device_id, device_id, created_at, scope_id)
			VALUES (@op_id, @entity_type, @entity_id, @op_type, @payload_json, @clock_rev,
			@clock_updated_at, @clock_device_id, @device_id, @created_at, @scope_id)`)
			.run(op);
		return op;
	});
}

function cursorOf(op: ReplicationOp | undefined): string {
	if (!op) throw new Error("missing_fixture_op");
	return `${op.created_at}|${op.op_id}`;
}

/** A scoped peer whose status may report a pull cursor for our ops in the scope. */
function run(options: { appliedCursor?: string | null } = {}) {
	const pushed: string[][] = [];
	const executor = vi.fn<RequestJsonExecutor>(async (method, url, request) => {
		if (url === `${baseUrl}/v1/status`) {
			return [
				200,
				{
					fingerprint: "switch-fingerprint",
					protocol_version: "2",
					sync_capability: "scoped",
					sync_reset: { ...boundary, retained_floor_cursor: null, scope_id: scopeId },
					authorized_scopes: [
						{
							scope_id: scopeId,
							label: "Switch scope",
							membership_epoch: 1,
							authority_type: "coordinator",
							sync_reset: { ...boundary, retained_floor_cursor: null, scope_id: scopeId },
							applied_cursor: options.appliedCursor ?? null,
						},
					],
				},
			];
		}
		if (method === "GET") {
			return [200, { ...boundary, reset_required: false, ops: [], next_cursor: null, skipped: 0 }];
		}
		if (method !== "POST" || url !== `${baseUrl}/v1/ops`) throw new Error("unexpected_request");
		const ops = request?.body?.ops as ReplicationOp[];
		pushed.push(ops.map((op) => op.op_id));
		return [200, { errors: [], sync_capability: "scoped", scope_id: null }];
	});
	return {
		pushed,
		result: syncOnce(source, peerId, [baseUrl], { requestExecutor: executor, scanner }),
	};
}

function channelAck(cursor: string, override: Partial<typeof boundary> = {}): void {
	const target = { peerDeviceId: peerId, scopeId, boundary: { ...boundary, ...override } };
	saveSyncChannelCompletedBoundary(source, target);
	saveSyncChannelOutboundAck(source, { ...target, cursor });
}

it("skips ops the relay channel already delivered for the scope", async () => {
	// Arrange: relay delivered the first two ops; the third is new.
	const ops = seedOps(3);
	channelAck(cursorOf(ops[1]));
	// Act
	const { pushed, result } = run();
	// Assert: only the third op goes over direct, and the legacy ACK still covers all three.
	expect((await result).ok).toBe(true);
	expect(pushed).toEqual([["switch-op-3"]]);
	expect(getReplicationCursor(source, peerId)[1]).toBe(cursorOf(ops[2]));
});

it("skips ops the peer reports as applied in status", async () => {
	const ops = seedOps(3);
	const { pushed, result } = run({ appliedCursor: cursorOf(ops[1]) });
	expect((await result).ok).toBe(true);
	expect(pushed).toEqual([["switch-op-3"]]);
});

it("ignores a channel ACK from a stale boundary and malformed reported cursors", async () => {
	seedOps(2);
	channelAck(`${timestamp}|switch-op-2`, { generation: 0 });
	// A bare separator would sort after every real cursor, so it must not count either.
	for (const appliedCursor of ["no-separator", "|", "|op-only", "time-only|"]) {
		setReplicationCursor(source, peerId, { lastAcked: baseline });
		const { pushed, result } = run({ appliedCursor });
		expect((await result).ok).toBe(true);
		expect(pushed).toEqual([["switch-op-1", "switch-op-2"]]);
	}
});
