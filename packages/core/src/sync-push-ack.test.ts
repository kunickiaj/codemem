import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecretScanner } from "./secret-scanner.js";
import * as syncAuth from "./sync-auth.js";
import type { RequestJsonExecutor } from "./sync-http-client.js";
import * as http from "./sync-http-client.js";
import * as identity from "./sync-identity.js";
import { syncOnce } from "./sync-pass.js";
import {
	applyReplicationOps,
	getReplicationCursor,
	setReplicationCursor,
} from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

const localId = "ack-source";
const peerId = "ack-receiver";
const scopeId = "ack-scope";
const unrelatedScopeId = "ack-other-scope";
const timestamp = "2026-01-01T00:00:00Z";
const baseline = `${timestamp}|baseline`;
const baseUrl = "http://ack.example.test:47337";
const scanner = new SecretScanner();
const boundary = {
	generation: 1,
	snapshot_id: "ack-snapshot",
	baseline_cursor: baseline,
	retained_floor_cursor: null,
};

let source: InstanceType<typeof Database>;
let receiver: InstanceType<typeof Database>;

beforeEach(() => {
	source = new Database(":memory:");
	receiver = new Database(":memory:");
	initTestSchema(source);
	initTestSchema(receiver);
	// Neither identity preparation nor signing may consult the user's key directory.
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
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("unexpected_network");
		}),
	);
	source
		.prepare(
			"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		)
		.run(peerId, "ack-fingerprint", timestamp);
	for (const id of [scopeId, unrelatedScopeId]) {
		source
			.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type,
			membership_epoch, status, created_at, updated_at)
			VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)`)
			.run(id, id, timestamp, timestamp);
		for (const deviceId of [localId, peerId]) {
			source
				.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status,
				membership_epoch, updated_at) VALUES (?, ?, 'member', 'active', 1, ?)`)
				.run(id, deviceId, timestamp);
		}
		setReplicationCursor(source, peerId, { lastApplied: baseline, lastAcked: baseline }, id);
	}
	setReplicationCursor(source, peerId, { lastApplied: baseline, lastAcked: baseline });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	source.close();
	receiver.close();
});

function seedOps(count: number, visibility = "shared"): ReplicationOp[] {
	return Array.from({ length: count }, (_, index) => {
		const time = `2026-01-01T00:00:0${index + 1}Z`;
		const op: ReplicationOp = {
			op_id: `ack-op-${index + 1}`,
			entity_type: "memory_item",
			entity_id: `ack-memory-${index + 1}`,
			op_type: "upsert",
			payload_json: JSON.stringify({
				kind: "discovery",
				title: "Fixture memory",
				body_text: "private fixture content",
				visibility,
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

function cursorOf(op: ReplicationOp): string {
	return `${op.created_at}|${op.op_id}`;
}

function opAt(ops: ReplicationOp[], index: number): ReplicationOp {
	const op = ops[index];
	if (!op) throw new Error("missing_fixture_op");
	return op;
}

function failReceiverOp(op: ReplicationOp): void {
	// Failure after the memory write proves that the receiver's per-op savepoint rolls it back.
	receiver.exec(`CREATE TRIGGER reject_ack_op AFTER INSERT ON replication_ops
		WHEN NEW.op_id = '${op.op_id}' BEGIN SELECT RAISE(ABORT, 'receiver_apply_failed'); END`);
}

function receiverPayload(ops: ReplicationOp[]) {
	return {
		...applyReplicationOps(receiver, ops, peerId, scanner),
		skipped_detail: null,
		sync_capability: "scoped",
		scope_id: null,
	};
}

function executorFor(
	push: (ops: ReplicationOp[]) => ReturnType<RequestJsonExecutor>,
	options: { scoped?: boolean } = {},
) {
	return vi.fn<RequestJsonExecutor>(async (method, url, request) => {
		if (url === `${baseUrl}/v1/status`) {
			return [
				200,
				{
					fingerprint: "ack-fingerprint",
					protocol_version: "2",
					sync_capability: options.scoped ? "scoped" : "enforcing",
					sync_reset: { ...boundary, scope_id: scopeId },
					authorized_scopes: options.scoped
						? [
								{
									scope_id: scopeId,
									label: "ACK scope",
									membership_epoch: 1,
									authority_type: "coordinator",
									sync_reset: { ...boundary, scope_id: scopeId },
								},
							]
						: [],
				},
			];
		}
		if (method === "GET") {
			return [200, { ...boundary, reset_required: false, ops: [], next_cursor: null, skipped: 0 }];
		}
		if (method !== "POST" || url !== `${baseUrl}/v1/ops`) throw new Error("unexpected_request");
		return push(request?.body?.ops as ReplicationOp[]);
	});
}

function runSync(requestExecutor: RequestJsonExecutor) {
	return syncOnce(source, peerId, [baseUrl], { requestExecutor, scanner });
}

function memoryKeys(): string[] {
	return (
		receiver.prepare("SELECT import_key FROM memory_items ORDER BY import_key").all() as {
			import_key: string;
		}[]
	).map((row) => row.import_key);
}

it.each([
	{ scoped: false, count: 1 },
	{ scoped: false, count: 2 },
	{ scoped: true, count: 1 },
	{ scoped: true, count: 2 },
])(
	"holds the default ACK on HTTP 200 apply errors ($scoped scoped, $count ops)",
	async ({ scoped, count }) => {
		// Arrange: a mixed batch commits its first operation and rolls back its last operation.
		const ops = seedOps(count);
		const failed = opAt(ops, count - 1);
		failReceiverOp(failed);
		const payloads: ReturnType<typeof receiverPayload>[] = [];
		const executor = executorFor(
			async (batch) => {
				const payload = receiverPayload(batch);
				payloads.push(payload);
				return [200, payload];
			},
			{ scoped },
		);

		// Act
		const result = await runSync(executor);

		// Assert: HTTP success cannot acknowledge work that the receiver rolled back.
		expect(payloads[0]).toMatchObject({
			applied: count - 1,
			errors: [expect.stringContaining("receiver_apply_failed")],
		});
		expect(memoryKeys()).toEqual(ops.slice(0, -1).map((op) => op.entity_id));
		expect(
			receiver.prepare("SELECT 1 FROM replication_ops WHERE op_id = ?").get(failed.op_id),
		).toBeUndefined();
		expect(
			source.prepare("SELECT 1 FROM replication_ops WHERE op_id = ?").get(failed.op_id),
		).toBeDefined();
		expect.soft(getReplicationCursor(source, peerId)[1]).toBe(baseline);
		expect.soft(result.ok).toBe(false);
		expect(result.error ?? "").not.toContain("private fixture content");
		for (const id of [scopeId, unrelatedScopeId]) {
			expect(getReplicationCursor(source, peerId, id)).toEqual([baseline, baseline]);
		}
	},
);

it.each([false, true])("retries the failed window after repair (%s scoped)", async (scoped) => {
	// Arrange
	const ops = seedOps(2);
	failReceiverOp(opAt(ops, 1));
	const batches: string[][] = [];
	const payloads: ReturnType<typeof receiverPayload>[] = [];
	const executor = executorFor(
		async (batch) => {
			batches.push(batch.map((op) => op.op_id));
			const payload = receiverPayload(batch);
			payloads.push(payload);
			return [200, payload];
		},
		{ scoped },
	);

	// Act
	const first = await runSync(executor);
	const ackAfterFailure = getReplicationCursor(source, peerId)[1];
	receiver.exec("DROP TRIGGER reject_ack_op");
	const retry = await runSync(executor);

	// Assert: replay skips the already committed op and applies the previously failed op.
	expect.soft(ackAfterFailure).toBe(baseline);
	expect.soft(first.ok).toBe(false);
	expect.soft(batches).toEqual([ops.map((op) => op.op_id), ops.map((op) => op.op_id)]);
	expect.soft(payloads[1]).toMatchObject({ applied: 1, skipped: 1, errors: [] });
	expect.soft(memoryKeys()).toEqual(ops.map((op) => op.entity_id));
	expect(retry.ok).toBe(true);
	expect(getReplicationCursor(source, peerId)[1]).toBe(cursorOf(opAt(ops, 1)));
	expect(getReplicationCursor(source, peerId, unrelatedScopeId)[1]).toBe(baseline);
});

it.each([false, true])(
	"acknowledges split batches only if every part succeeds (failure: %s)",
	async (failSecond) => {
		// Arrange
		const ops = seedOps(2);
		if (failSecond) failReceiverOp(opAt(ops, 1));
		const sizes: number[] = [];
		const executor = executorFor(async (batch) => {
			sizes.push(batch.length);
			if (batch.length > 1) return [413, { error: "too_many_ops" }];
			return [200, receiverPayload(batch)];
		});

		// Act
		const result = await runSync(executor);

		// Assert: the first successful split must not acknowledge a later failed split.
		expect(sizes).toEqual([2, 1, 1]);
		expect(memoryKeys()).toEqual(ops.slice(0, failSecond ? 1 : 2).map((op) => op.entity_id));
		expect
			.soft(getReplicationCursor(source, peerId)[1])
			.toBe(failSecond ? baseline : cursorOf(opAt(ops, 1)));
		expect.soft(result.ok).toBe(!failSecond);
	},
);

it("holds the ACK after a lost response and acknowledges an idempotent resend", async () => {
	// Arrange
	const ops = seedOps(2);
	const payloads: ReturnType<typeof receiverPayload>[] = [];
	const batches: string[][] = [];
	const executor = executorFor(async (batch) => {
		batches.push(batch.map((op) => op.op_id));
		const payload = receiverPayload(batch);
		payloads.push(payload);
		if (payloads.length === 1) throw new Error("response_lost_after_apply");
		return [200, payload];
	});

	// Act
	const first = await runSync(executor);
	const ackAfterLoss = getReplicationCursor(source, peerId)[1];
	const retry = await runSync(executor);

	// Assert
	expect(first.ok).toBe(false);
	expect(ackAfterLoss).toBe(baseline);
	expect(batches).toEqual([ops.map((op) => op.op_id), ops.map((op) => op.op_id)]);
	expect(payloads[1]).toMatchObject({ applied: 0, skipped: 2, errors: [] });
	expect(memoryKeys()).toEqual(ops.map((op) => op.entity_id));
	expect(retry.ok).toBe(true);
	expect(getReplicationCursor(source, peerId)[1]).toBe(cursorOf(opAt(ops, 1)));
});

it("advances the ACK after successful receiver apply with empty errors", async () => {
	// Arrange
	const ops = seedOps(2);
	const executor = executorFor(async (batch) => [200, receiverPayload(batch)]);

	// Act
	const result = await runSync(executor);

	// Assert
	expect(result.ok).toBe(true);
	expect(memoryKeys()).toEqual(ops.map((op) => op.entity_id));
	expect(getReplicationCursor(source, peerId)[1]).toBe(cursorOf(opAt(ops, 1)));
});

it("advances the ACK for an intentional receiver skip with empty errors", async () => {
	// Arrange: a receiver policy filter deliberately excludes this operation.
	const ops = seedOps(1);
	const executor = executorFor(async () => [
		200,
		{
			applied: 0,
			skipped: 1,
			conflicts: 0,
			errors: [],
			skipped_detail: { reason: "scope_filter", skipped_count: 1 },
			sync_capability: "scoped",
			scope_id: null,
		},
	]);

	// Act
	const result = await runSync(executor);

	// Assert
	expect(result.ok).toBe(true);
	expect(memoryKeys()).toEqual([]);
	expect(getReplicationCursor(source, peerId)[1]).toBe(cursorOf(opAt(ops, 0)));
});

it("advances past intentionally filtered local operations without sending them", async () => {
	// Arrange: private team-scope content must not be sent to this peer.
	const ops = seedOps(1, "private");
	const push = vi.fn(async () => [200, {}] as Awaited<ReturnType<RequestJsonExecutor>>);
	const executor = executorFor(push);

	// Act
	const result = await runSync(executor);

	// Assert
	expect(result.ok).toBe(true);
	expect(push).not.toHaveBeenCalled();
	expect(memoryKeys()).toEqual([]);
	expect(getReplicationCursor(source, peerId)[1]).toBe(cursorOf(opAt(ops, 0)));
});

it.each([
	{ name: "legacy acknowledgment", payload: { ok: true } },
	{ name: "empty errors and null top-level error", payload: { errors: [], error: null } },
	{ name: "empty errors and undefined top-level error", payload: { errors: [], error: undefined } },
])("accepts HTTP 200 with $name", async ({ payload }) => {
	// Arrange: legacy success does not require counts or a protocol version in the reply.
	const ops = seedOps(1);
	const executor = executorFor(async () => [200, payload]);

	// Act
	const result = await runSync(executor);

	// Assert
	expect(result.ok).toBe(true);
	expect(getReplicationCursor(source, peerId)[1]).toBe(cursorOf(opAt(ops, 0)));
});

it.each([
	{ name: "null", errors: null },
	{ name: "string", errors: "receiver_apply_failed" },
	{ name: "object", errors: { code: "receiver_apply_failed" } },
	{ name: "present undefined", errors: undefined },
])("holds the ACK for malformed $name errors", async ({ errors }) => {
	// Arrange: a present errors property must be an array, even with positive apply counts.
	seedOps(1);
	const executor = executorFor(async () => [200, { applied: 1, errors }]);

	// Act
	const result = await runSync(executor);

	// Assert
	expect(result.ok).toBe(false);
	expect(getReplicationCursor(source, peerId)[1]).toBe(baseline);
});

it("holds the ACK for every non-null top-level error, including falsy values", async () => {
	// Arrange: each peer reply must reject the same still-pending operation.
	seedOps(1);
	const errors = ["receiver_apply_failed", "", false, 0];
	const executors = errors.map((error) => executorFor(async () => [200, { errors: [], error }]));

	// Act
	const results = [];
	for (const executor of executors) results.push(await runSync(executor));

	// Assert
	expect(results.map((result) => result.ok)).toEqual(errors.map(() => false));
	expect(
		executors.every((executor) => executor.mock.calls.some(([method]) => method === "POST")),
	).toBe(true);
	expect(getReplicationCursor(source, peerId)[1]).toBe(baseline);
});

it("rejects mixed apply results without reflecting private operation text", async () => {
	// Arrange: receiver error details are untrusted and may contain operation content.
	seedOps(2);
	const privateText = "private fixture content";
	const executor = executorFor(async () => [
		200,
		{
			applied: 1,
			skipped: 0,
			conflicts: 0,
			errors: [`receiver_apply_failed: ${privateText}`],
			skipped_detail: null,
			sync_capability: "scoped",
			scope_id: null,
		},
	]);

	// Act
	const result = await runSync(executor);

	// Assert
	expect(result.ok).toBe(false);
	expect(getReplicationCursor(source, peerId)[1]).toBe(baseline);
	expect(result.error).toBeTruthy();
	expect(result.error).not.toContain(privateText);
	expect(result.error).not.toContain("receiver_apply_failed");
	expect(JSON.stringify(result.addressErrors)).not.toContain(privateText);
});
