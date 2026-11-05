import { describe, expect, it } from "vitest";
import {
	type DirectionEvidence,
	directionSyncHealth,
	overallSyncHealth,
	peerSyncHealth,
} from "./sync-health.js";

const now = Date.parse("2026-11-02T12:00:00.000Z");
const recent = "2026-11-02T11:59:00.000Z";
const empty: DirectionEvidence = {
	lastAttemptAt: null,
	lastSuccessAt: null,
	operations24h: null,
	errorCode: null,
};
const successful: DirectionEvidence = {
	lastAttemptAt: recent,
	lastSuccessAt: recent,
	operations24h: 0,
	errorCode: null,
};

describe("directionSyncHealth", () => {
	it.each([undefined, empty])("preserves unknown counts without an observation: %j", (evidence) => {
		// Arrange: legacy contact cannot prove a directional exchange.
		const options = { now };
		// Act.
		const health = directionSyncHealth(evidence, options);
		// Assert.
		expect(health).toEqual({
			state: "not_verified",
			last_attempt_at: null,
			last_success_at: null,
			operations_24h: null,
			snapshot_items_24h: null,
			observed_since: null,
			pending_count: null,
			reason_code: null,
		});
	});

	it.each([0, 7])("preserves a measured %i operations without claiming no backlog", (count) => {
		// Arrange: a successful window does not prove stream exhaustion.
		const evidence = { ...successful, operations24h: count };
		// Act.
		const health = directionSyncHealth(evidence, { now });
		// Assert.
		expect(health).toEqual({
			state: "succeeded",
			last_attempt_at: recent,
			last_success_at: recent,
			operations_24h: count,
			snapshot_items_24h: null,
			observed_since: null,
			pending_count: null,
			reason_code: null,
		});
	});

	it("keeps snapshot items separate from operations and preserves measurement coverage", () => {
		// Arrange: snapshots and incremental operations measure different transfers.
		const observedSince = "2026-11-01T18:00:00.000Z";
		const evidence = {
			...successful,
			operations24h: 3,
			snapshotItems24h: 12,
			observedSince,
		};
		// Act.
		const health = directionSyncHealth(evidence, { now });
		// Assert: neither counter includes the other, and coverage is not the last success time.
		expect(health).toMatchObject({
			operations_24h: 3,
			snapshot_items_24h: 12,
			observed_since: observedSince,
			last_success_at: recent,
			pending_count: null,
		});
	});

	it("replaces unknown error text with a safe transfer failure reason", () => {
		// Arrange: arbitrary transport diagnostics must not become public reason codes.
		const evidence = {
			...successful,
			errorCode: "Connection failed at https://example.test/private",
		};
		// Act.
		const health = directionSyncHealth(evidence, { now });
		// Assert.
		expect(health).toMatchObject({ state: "needs_attention", reason_code: "transfer_failed" });
	});

	it.each([
		["2026-11-02T11:50:00.000Z", "succeeded"],
		["2026-11-02T11:49:59.999Z", "stale"],
		["invalid", "not_verified"],
		["2026-11-02T12:00:00.001Z", "not_verified"],
		[null, "not_verified"],
	])("classifies success time %s as %s", (lastSuccessAt, state) => {
		// Arrange: freshness requires a valid, non-future success within ten minutes.
		const evidence = { ...successful, lastSuccessAt };
		// Act.
		const health = directionSyncHealth(evidence, { now });
		// Assert.
		expect(health.state).toBe(state);
	});

	it("retains the prior success and counts when a newer attempt fails", () => {
		// Arrange.
		const failedAt = "2026-11-02T11:59:30.000Z";
		const evidence = { ...successful, lastAttemptAt: failedAt, errorCode: "exchange_failed" };
		// Act.
		const health = directionSyncHealth(evidence, { now });
		// Assert: a failure must not erase the useful historical evidence.
		expect(health).toMatchObject({
			state: "needs_attention",
			last_attempt_at: failedAt,
			last_success_at: recent,
			operations_24h: 0,
			reason_code: "transfer_failed",
		});
	});

	it.each([
		{ at: "2026-11-02T11:30:00.000Z", state: "succeeded" },
		{ at: "2026-11-02T11:29:59.999Z", state: "stale" },
	])("uses configured freshness at $at: $state", ({ at, state }) => {
		// Arrange: a long sync interval extends freshness beyond the ten-minute default.
		const evidence = { ...successful, lastSuccessAt: at };
		// Act.
		const health = directionSyncHealth(evidence, { now, staleAfterMs: 30 * 60_000 });
		// Assert.
		expect(health.state).toBe(state);
	});

	it("shows a recorded directional failure even when an older success exists", () => {
		// Arrange.
		const evidence = { ...successful, errorCode: "apply_failed" };
		// Act.
		const health = directionSyncHealth(evidence, { now });
		// Assert.
		expect(health).toMatchObject({ state: "needs_attention", reason_code: "apply_failed" });
	});
});

describe("peerSyncHealth", () => {
	it.each(["2026-11-02T11:58:00.000Z", "invalid", "2026-11-02T12:01:00.000Z"])(
		"ignores recovered or invalid exchange failure time %s",
		(failedAt) => {
			// Arrange: both successes postdate the only valid historical failure.
			const evidence = { send: successful, receive: successful };
			// Act.
			const health = peerSyncHealth(evidence, { now, failedAt });
			// Assert.
			expect(health.state).toBe("exchange_succeeded");
		},
	);

	it("overlays generic failure only on the peer summary without changing directional evidence", () => {
		// Arrange.
		const evidence = {
			send: successful,
			receive: {
				...successful,
				lastAttemptAt: "2026-11-02T11:59:30.000Z",
				errorCode: "scope_rejected",
			},
		};
		const before = peerSyncHealth(evidence, { now });
		// Act.
		const health = peerSyncHealth(evidence, { now, failedAt: "2026-11-02T11:59:30.000Z" });
		// Assert: an acknowledged send cannot become a failed directional attempt.
		expect(health).toEqual({
			state: "needs_attention",
			send: before.send,
			receive: before.receive,
		});
		expect(health.send).toMatchObject({
			state: "succeeded",
			last_attempt_at: recent,
			reason_code: null,
		});
		expect(health.receive).toMatchObject({
			state: "needs_attention",
			reason_code: "scope_rejected",
		});
	});

	it.each([undefined, { send: successful, receive: successful }])(
		"retains generic failure attention without fabricating directional failures: %j",
		(evidence) => {
			// Arrange.
			const before = peerSyncHealth(evidence, { now });
			// Act.
			const health = peerSyncHealth(evidence, { now, failedAt: "2026-11-02T11:59:30.000Z" });
			// Assert.
			expect(health).toEqual({
				state: "needs_attention",
				send: before.send,
				receive: before.receive,
			});
		},
	);

	it("requires successful evidence in both directions", () => {
		// Arrange.
		const evidence = { send: successful, receive: successful };
		// Act.
		const health = peerSyncHealth(evidence, { now });
		// Assert.
		expect(health).toMatchObject({
			state: "exchange_succeeded",
			send: { state: "succeeded", pending_count: null },
			receive: { state: "succeeded", pending_count: null },
		});
	});

	it("does not turn receive-only evidence into a verified send", () => {
		// Arrange.
		const evidence = { send: empty, receive: { ...successful, operations24h: 3 } };
		// Act.
		const health = peerSyncHealth(evidence, { now });
		// Assert.
		expect(health).toMatchObject({
			state: "not_verified",
			send: { state: "not_verified", operations_24h: null },
			receive: { state: "succeeded", operations_24h: 3 },
		});
	});

	it("does not let a later receive success clear an earlier send failure", () => {
		// Arrange: each direction must recover independently.
		const evidence = {
			send: { ...successful, errorCode: "exchange_failed" },
			receive: {
				...successful,
				lastAttemptAt: "2026-11-02T11:59:45.000Z",
				lastSuccessAt: "2026-11-02T11:59:45.000Z",
			},
		};
		// Act.
		const health = peerSyncHealth(evidence, { now });
		// Assert.
		expect(health).toMatchObject({
			state: "needs_attention",
			send: { state: "needs_attention" },
			receive: { state: "succeeded" },
		});
	});

	it.each([
		[undefined, "not_verified"],
		[{ send: successful, receive: empty }, "not_verified"],
		[{ send: successful, receive: { ...successful, lastSuccessAt: "2026-11-01" } }, "stale"],
	])("does not hide an incomplete exchange: %j", (evidence, state) => {
		// Arrange.
		const options = { now };
		// Act.
		const health = peerSyncHealth(evidence, options);
		// Assert.
		expect(health.state).toBe(state);
	});
});

describe("overallSyncHealth", () => {
	it("reports success when every paired peer has verified both directions", () => {
		// Arrange.
		const sync_health = peerSyncHealth({ send: successful, receive: successful }, { now });
		const peers = [
			{ pinned: true, sync_health },
			{ pinned: true, sync_health },
		];
		// Act.
		const health = overallSyncHealth(peers, { enabled: true });
		// Assert.
		expect(health).toEqual({
			state: "exchange_succeeded",
			peer_count: 2,
			attention_count: 0,
			unverified_count: 0,
			stale_count: 0,
		});
	});

	it.each(["needs_attention", "not_verified", "stale", undefined])(
		"does not let a successful peer hide another peer in state %s",
		(state) => {
			// Arrange.
			const peers = [
				{ pinned: true, sync_health: { state: "exchange_succeeded" } },
				{ pinned: true, sync_health: state ? { state } : undefined },
			];
			// Act.
			const health = overallSyncHealth(peers, { enabled: true });
			// Assert.
			expect(health.state).toBe(state ?? "not_verified");
		},
	);

	it("counts all problem states while prioritizing errors over unknown and stale", () => {
		// Arrange.
		const peers = ["exchange_succeeded", "stale", "not_verified", "needs_attention"].map(
			(state) => ({ pinned: true, sync_health: { state } }),
		);
		// Act.
		const health = overallSyncHealth(peers, { enabled: true });
		// Assert.
		expect(health).toEqual({
			state: "needs_attention",
			peer_count: 4,
			attention_count: 1,
			unverified_count: 1,
			stale_count: 1,
		});
	});

	it("prioritizes missing evidence over stale evidence without hiding either count", () => {
		// Arrange.
		const peers = [{ pinned: true, sync_health: { state: "stale" } }, { pinned: true }];
		// Act.
		const health = overallSyncHealth(peers, { enabled: true });
		// Assert.
		expect(health).toMatchObject({ state: "not_verified", unverified_count: 1, stale_count: 1 });
	});

	it("excludes unpaired discovery entries from a successful paired exchange", () => {
		// Arrange.
		const peers = [
			{ pinned: true, sync_health: { state: "exchange_succeeded" } },
			{ pinned: false, sync_health: { state: "needs_attention" } },
		];
		// Act.
		const health = overallSyncHealth(peers, { enabled: true });
		// Assert.
		expect(health).toMatchObject({
			state: "exchange_succeeded",
			peer_count: 1,
			attention_count: 0,
		});
	});

	it.each(["error", "needs_attention"])("surfaces daemon state %s", (daemonState) => {
		// Arrange.
		const peers = [{ pinned: true, sync_health: { state: "exchange_succeeded" } }];
		// Act.
		const health = overallSyncHealth(peers, { enabled: true, daemonState });
		// Assert.
		expect(health.state).toBe("needs_attention");
	});

	it("reports disabled even when a paired peer needs attention", () => {
		// Arrange.
		const peers = [{ pinned: true, sync_health: { state: "needs_attention" } }];
		// Act.
		const health = overallSyncHealth(peers, { enabled: false, daemonState: "error" });
		// Assert.
		expect(health.state).toBe("disabled");
	});

	it.each([
		{ peers: [] },
		{ peers: [{ pinned: false, sync_health: { state: "needs_attention" } }] },
	])("reports no peers when no peer is paired: %j", ({ peers }) => {
		// Arrange.
		const options = { enabled: true };
		// Act.
		const health = overallSyncHealth(peers, options);
		// Assert.
		expect(health).toMatchObject({ state: "no_peers", peer_count: 0, attention_count: 0 });
	});
});
