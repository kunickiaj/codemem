import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as auth from "../../core/src/sync-auth.js";
import { verifyDirectPeerSignature, verifySignature } from "../../core/src/sync-auth.js";
import { syncScopedChannelOnce } from "../../core/src/sync-channel-pass.js";
import {
	getSyncChannelProgress,
	saveSyncChannelCompletedBoundary,
} from "../../core/src/sync-channel-progress.js";
import {
	getReplicationCursor,
	getSyncResetState,
	SCOPED_NULL_BASELINE_BOOTSTRAP_CURSOR_MARKER,
	setReplicationCursor,
	setSyncResetState,
} from "../../core/src/sync-replication.js";
import {
	readPeerSyncActivity,
	recordSyncTransferObservation,
} from "../../core/src/sync-transfer-activity.js";
import { bytes, ORIGIN, SCOPE } from "./sync-channel-dispatch-test-fixtures.js";
import {
	addPassPeer,
	passFixture,
	prepareStaleChannelPull,
} from "./sync-channel-pass-test-fixtures.js";

type Fixture = Awaited<ReturnType<typeof passFixture>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
async function fixture() {
	const f = await passFixture();
	cleanups.push(f.cleanup);
	return f;
}
const INITIAL_CURSOR = "2025-01-01T00:00:00Z|initial";
function incremental(f: Fixture) {
	setReplicationCursor(f.client.db, f.remote.localDeviceId, { lastApplied: INITIAL_CURSOR }, SCOPE);
}
function ids(f: Fixture, side: "client" | "remote") {
	const store = side === "client" ? f.client : f.remote.store;
	return store.db
		.prepare("SELECT title FROM memory_items WHERE scope_id = ? ORDER BY title")
		.pluck()
		.all(SCOPE);
}
function cursor(f: Fixture) {
	return getReplicationCursor(f.client.db, f.remote.localDeviceId, SCOPE);
}
function outboundAck(f: Fixture) {
	return (
		getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE)?.last_acked_cursor ?? null
	);
}
function posts(f: Fixture) {
	return f.requests.filter((request) => request.method === "POST");
}
function assertFailedSendActivity(f: Fixture) {
	expect(
		f.client.db
			.prepare(`SELECT source, error_code FROM sync_transfer_observations
		WHERE peer_device_id = ? AND direction = 'send'`)
			.all(f.remote.localDeviceId),
	).toEqual([{ source: "initiated", error_code: "exchange_failed" }]);
	expect(
		readPeerSyncActivity(f.client.db, [f.remote.localDeviceId]).get(f.remote.localDeviceId),
	).toMatchObject({
		send: { errorCode: "exchange_failed", lastSuccessAt: null, operations24h: 0 },
		receive: { errorCode: null, lastSuccessAt: expect.any(String) },
	});
}
function snapshotCount(requests: Fixture["requests"]) {
	return requests.filter((request) => new URL(request.url).pathname === "/v1/snapshot").length;
}
function unrelatedProgress(f: Fixture) {
	return f.client.db
		.prepare(
			"SELECT * FROM sync_channel_progress WHERE peer_device_id != ? OR scope_id != ? ORDER BY peer_device_id, scope_id",
		)
		.all(f.remote.localDeviceId, SCOPE);
}
function seedUnrelatedProgress(f: Fixture) {
	for (const [peerDeviceId, scopeId] of [
		["unrelated-peer", SCOPE],
		[f.remote.localDeviceId, "another-scope"],
	])
		saveSyncChannelCompletedBoundary(f.client.db, {
			peerDeviceId,
			scopeId,
			boundary: { generation: 8, snapshot_id: "unrelated-boundary", baseline_cursor: null },
		});
	return unrelatedProgress(f);
}
async function peerPair() {
	const first = await fixture();
	const second = await addPassPeer(first);
	cleanups.push(second.cleanup);
	for (const [target, generation, snapshot] of [
		[first, 2, "boundary-b"],
		[second, 7, "boundary-c"],
	] as const)
		setSyncResetState(
			target.remote.store.db,
			{
				generation,
				snapshot_id: snapshot,
				baseline_cursor: null,
				retained_floor_cursor: null,
			},
			SCOPE,
		);
	for (let i = 0; i < 3; i++) first.seed("client", `window-${i}`);
	return { first, second };
}
function assertSignedScope(f: Fixture) {
	const nonces: string[] = [];
	for (const request of f.requests) {
		const h = new Headers(request.headers);
		const query = new URL(request.url).searchParams;
		const body = Buffer.from(request.bodyBytes);
		expect(request.url.startsWith(`${ORIGIN}/v1/`)).toBe(true);
		expect(["/v1/status", "/v1/snapshot", "/v1/ops"]).toContain(new URL(request.url).pathname);
		if (request.method === "POST") expect(JSON.parse(body.toString()).scope_id).toBe(SCOPE);
		else expect(query.get("scope_id")).toBe(SCOPE);
		const material = {
			method: request.method,
			pathWithQuery: request.target,
			bodyBytes: body,
			timestamp: h.get("x-opencode-timestamp") ?? "",
			nonce: h.get("x-opencode-nonce") ?? "",
			publicKey: f.remote.peerPublicKey,
		};
		expect(
			verifySignature({
				...material,
				signature: h.get("x-opencode-signature") ?? "",
				deviceId: f.remote.peerDeviceId,
			}),
		).toBe(true);
		expect(
			verifyDirectPeerSignature({
				...material,
				signature: h.get("x-codemem-signature") ?? "",
				recipientId: h.get("x-codemem-recipient") ?? "",
				expectedRecipientId: f.remote.localDeviceId,
			}),
		).toEqual({ status: "valid", version: "v3" });
		nonces.push(material.nonce);
	}
	expect(new Set(nonces).size).toBe(nonces.length);
	expect(f.factory.open).toHaveBeenCalledTimes(f.requests.length);
	expect(new Set(f.connections.map((connection) => connection.duplex)).size).toBe(
		f.requests.length,
	);
}

it("converges one scoped pull and push through signed fresh Noise HTTP exchanges without saving the logical origin", async () => {
	// Arrange: a cursor makes this an incremental exchange rather than snapshot recovery.
	const f = await fixture();
	incremental(f);
	f.seed("remote", "remote-item");
	f.seed("client", "client-item", "Raw héllo 🌲");
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert: all actual server requests must authenticate their exact transmitted bytes.
	expect(result).toMatchObject({
		scope_id: SCOPE,
		ok: true,
		opsIn: 1,
		opsOut: 1,
		bootstrapped: false,
	});
	expect(ids(f, "client")).toEqual(["client-item", "remote-item"]);
	expect(ids(f, "remote")).toEqual(["client-item", "remote-item"]);
	assertSignedScope(f);
	expect(
		f.client.db
			.prepare(
				"SELECT addresses_json, manual_addresses_json FROM sync_peers WHERE peer_device_id = ?",
			)
			.get(f.remote.localDeviceId),
	).toEqual({ addresses_json: null, manual_addresses_json: null });
	expect(
		f.client.db
			.prepare("SELECT last_success_address FROM sync_peers WHERE peer_device_id = ?")
			.pluck()
			.get(f.remote.localDeviceId),
	).toBeNull();
});

it("clears a prior initiated receive error after a real empty incremental pull", async () => {
	// Arrange: an empty pull must resolve a failed exchange without inventing operations.
	const f = await fixture();
	incremental(f);
	const peerId = f.remote.localDeviceId;
	recordSyncTransferObservation(f.client.db, peerId, "receive", {
		source: "initiated",
		errorCode: "exchange_failed",
	});
	expect(readPeerSyncActivity(f.client.db, [peerId]).get(peerId)?.receive).toMatchObject({
		errorCode: "exchange_failed",
		lastSuccessAt: null,
	});
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert: the actual GET/apply path records success even with no operations.
	expect(result).toMatchObject({ ok: true, opsIn: 0, opsOut: 0, bootstrapped: false });
	expect(f.requests.some((r) => r.method === "GET" && new URL(r.url).pathname === "/v1/ops")).toBe(
		true,
	);
	expect(snapshotCount(f.requests)).toBe(0);
	expect(posts(f)).toHaveLength(0);
	expect(readPeerSyncActivity(f.client.db, [peerId]).get(peerId)?.receive).toMatchObject({
		errorCode: null,
		lastSuccessAt: expect.any(String),
		operations24h: 0,
	});
});

it.each(["apply_failed", "scope_rejected"] as const)(
	"keeps a prior scoped %s after a successful single-Space pull",
	async (errorCode) => {
		// Arrange: the error may belong to another Space that this pass does not retry.
		const f = await fixture();
		incremental(f);
		const peerId = f.remote.localDeviceId;
		recordSyncTransferObservation(f.client.db, peerId, "receive", {
			source: "initiated",
			errorCode,
		});

		// Act
		const result = await syncScopedChannelOnce(f.options);

		// Assert: the pull succeeds and records success without resolving the scoped error.
		expect(result).toMatchObject({ ok: true, opsIn: 0, bootstrapped: false });
		expect(readPeerSyncActivity(f.client.db, [peerId]).get(peerId)?.receive).toMatchObject({
			errorCode,
			lastSuccessAt: expect.any(String),
		});
	},
);

it("clears a prior initiated send error and counts acknowledged unique operations after a real POST", async () => {
	// Arrange: a successful receive must not resolve this independently seeded send error.
	const f = await fixture();
	incremental(f);
	f.seed("client", "acknowledged-item");
	const peerId = f.remote.localDeviceId;
	vi.useFakeTimers({ toFake: ["Date"] });
	cleanups.push(async () => {
		vi.useRealTimers();
	});
	recordSyncTransferObservation(f.client.db, peerId, "send", {
		source: "initiated",
		errorCode: "exchange_failed",
	});
	expect(readPeerSyncActivity(f.client.db, [peerId]).get(peerId)?.send).toMatchObject({
		errorCode: "exchange_failed",
		lastSuccessAt: null,
	});
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert: remote application and the saved ACK precede the missing activity update.
	expect(result).toMatchObject({ ok: true, opsOut: 1 });
	expect(posts(f)).toHaveLength(1);
	expect(ids(f, "remote")).toEqual(["acknowledged-item"]);
	expect(outboundAck(f)).toContain("|acknowledged-item-op");
	expect(readPeerSyncActivity(f.client.db, [peerId]).get(peerId)?.send).toMatchObject({
		errorCode: null,
		lastSuccessAt: expect.any(String),
		operations24h: 1,
	});
});

it("retains the null-baseline bootstrap marker while saving outbound ACK independently", async () => {
	// Arrange
	const f = await fixture();
	// Act
	const first = await syncScopedChannelOnce(f.options);
	const marker = cursor(f);
	f.seed("client", "outbound-item");
	const second = await syncScopedChannelOnce(f.options);
	const acked = getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE);
	f.seed("remote", "later-item");
	const third = await syncScopedChannelOnce(f.options);
	const fourth = await syncScopedChannelOnce(f.options);
	// Assert: an empty snapshot still records progress for a null baseline.
	expect(first).toMatchObject({ ok: true, bootstrapped: true });
	expect(marker[1]).toBe(SCOPED_NULL_BASELINE_BOOTSTRAP_CURSOR_MARKER);
	expect(second).toMatchObject({ ok: true, opsOut: 1 });
	expect(cursor(f)[1]).toBe(SCOPED_NULL_BASELINE_BOOTSTRAP_CURSOR_MARKER);
	expect(acked?.last_acked_cursor).toContain("|outbound-item-op");
	expect(third).toMatchObject({ ok: true, opsIn: 1 });
	expect(fourth).toMatchObject({ ok: true, opsIn: 0, opsOut: 0 });
	expect(ids(f, "client")).toEqual(["later-item", "outbound-item"]);
	expect(
		f.requests.filter((request) => new URL(request.url).pathname === "/v1/snapshot"),
	).toHaveLength(1);
	assertSignedScope(f);
});

it("recovers a pruned memory update by downloading a fresh snapshot after a stale-cursor reset", async () => {
	// Arrange: the peer retains the same generation, snapshot ID, and null baseline after pruning.
	const f = await fixture();
	const { boundary, entityId } = await prepareStaleChannelPull(f);
	const snapshotsBefore = snapshotCount(f.requests);
	const body = () =>
		f.client.db
			.prepare("SELECT body_text FROM memory_items WHERE import_key = ?")
			.pluck()
			.get(entityId);
	expect(body()).toBe("Before pruning");
	// Act
	const reset = await syncScopedChannelOnce(f.options);
	const recovered = await syncScopedChannelOnce(f.options);
	const bodyAfterRecovery = body();
	const later = await syncScopedChannelOnce(f.options);
	// Assert: an empty-since incremental request cannot recover the pruned update.
	expect(reset).toMatchObject({ ok: false, resetRequired: { reason: "stale_cursor" } });
	expect(bodyAfterRecovery).toBe("After pruning");
	expect(recovered).toMatchObject({ ok: true, bootstrapped: true });
	expect(later.ok).toBe(true);
	expect(snapshotCount(f.requests)).toBe(snapshotsBefore + 1);
	expect(getSyncResetState(f.remote.store.db, SCOPE)).toMatchObject({
		generation: boundary.generation,
		snapshot_id: boundary.snapshot_id,
		baseline_cursor: null,
	});
});

it("invalidates only the selected peer and scope completion on a stale-cursor 409 without pushing", async () => {
	// Arrange
	const f = await fixture();
	await prepareStaleChannelPull(f);
	const unrelated = seedUnrelatedProgress(f);
	const previous = getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE);
	const postsBefore = posts(f).length;
	expect(previous?.last_acked_cursor).toContain("|already-acked-op");
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert: the completed boundary must disappear before a future empty cursor can be used.
	expect(result).toMatchObject({ ok: false, resetRequired: { reason: "stale_cursor" } });
	expect(cursor(f)[0]).toBeNull();
	expect(getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE)).toBeNull();
	expect(unrelatedProgress(f)).toEqual(unrelated);
	expect(posts(f)).toHaveLength(postsBefore);
	expect(ids(f, "remote")).not.toContain("pending-outbound");
});

it("keeps the inbound cursor when deletion of stale completion fails before cursor reset", async () => {
	// Arrange: a disposable SQLite trigger models failure at the invalidation boundary.
	const f = await fixture();
	const { previousCursor } = await prepareStaleChannelPull(f);
	const previous = getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE);
	const unrelated = seedUnrelatedProgress(f);
	const postsBefore = posts(f).length;
	f.client.db.exec(`CREATE TRIGGER fail_channel_progress_delete BEFORE DELETE ON sync_channel_progress
		BEGIN SELECT RAISE(ABORT, 'controlled completion deletion failure'); END`);
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert: failed deletion cannot leave valid completion beside an empty inbound cursor.
	expect(result.ok).toBe(false);
	expect(cursor(f)[0]).toBe(previousCursor);
	expect(getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE)).toEqual(previous);
	expect(unrelatedProgress(f)).toEqual(unrelated);
	expect(posts(f)).toHaveLength(postsBefore);
});

it("advances outbound windows without repeating bootstrap when local pruning floor differs from the peer", async () => {
	// Arrange: pruning state belongs to each database, while completion belongs to this peer.
	const f = await fixture();
	setSyncResetState(
		f.client.db,
		{ retained_floor_cursor: "2024-01-01T00:00:00Z|pruned-local" },
		SCOPE,
	);
	for (let i = 0; i < 3; i++) f.seed("client", `window-${i}`);
	// Act
	const results = [];
	const acknowledgements = [];
	for (let i = 0; i < 3; i++) {
		if (i === 1)
			setSyncResetState(
				f.remote.store.db,
				{ retained_floor_cursor: "2023-01-01T00:00:00Z|pruned-remote" },
				SCOPE,
			);
		results.push(await syncScopedChannelOnce({ ...f.options, limit: 1 }));
		acknowledgements.push(
			getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE)?.last_acked_cursor,
		);
	}
	// Assert: null-baseline empty pulls must not restart the outbound first window.
	expect(results.map((result) => [result.ok, result.opsOut])).toEqual([
		[true, 1],
		[true, 1],
		[true, 1],
	]);
	expect(acknowledgements).toEqual([0, 1, 2].map((i) => `2026-01-01T00:00:00Z|window-${i}-op`));
	expect(ids(f, "remote")).toEqual(["window-0", "window-1", "window-2"]);
	expect(snapshotCount(f.requests)).toBe(1);
	expect(getSyncResetState(f.client.db, SCOPE).retained_floor_cursor).not.toBe(
		getSyncResetState(f.remote.store.db, SCOPE).retained_floor_cursor,
	);
});

it("keeps independent outbound windows and one completed snapshot per peer in the same Space", async () => {
	// Arrange
	const { first, second } = await peerPair();
	// Act: each peer overwrites the shared scope reset row during its initial recovery.
	const results = [];
	for (let i = 0; i < 3; i++)
		for (const target of [first, second]) {
			results.push(await syncScopedChannelOnce({ ...target.options, limit: 1 }));
		}
	// Assert: alternating distinct boundaries cannot reset the other peer's ACK.
	expect(results.every((result) => result.ok && result.opsOut === 1)).toBe(true);
	for (const target of [first, second]) {
		expect(snapshotCount(target.requests)).toBe(1);
		expect(
			target.remote.store.db.prepare("SELECT title FROM memory_items ORDER BY title").pluck().all(),
		).toEqual(["window-0", "window-1", "window-2"]);
		expect(
			getSyncChannelProgress(first.client.db, target.remote.localDeviceId, SCOPE)
				?.last_acked_cursor,
		).toContain("|window-2-op");
	}
	expect(
		getSyncChannelProgress(first.client.db, first.remote.localDeviceId, SCOPE)?.snapshot_id,
	).toBe("boundary-b");
	expect(
		getSyncChannelProgress(first.client.db, second.remote.localDeviceId, SCOPE)?.snapshot_id,
	).toBe("boundary-c");
	expect(getSyncResetState(first.client.db, SCOPE).snapshot_id).toBe("boundary-c");
});

it.each(["generation", "snapshot", "baseline"])(
	"recovers a changed peer %s once and resets only that peer's outbound ACK",
	async (change) => {
		// Arrange
		const { first, second } = await peerPair();
		for (let i = 0; i < 3; i++)
			for (const target of [first, second]) {
				const initial = await syncScopedChannelOnce({ ...target.options, limit: 1 });
				expect(initial.ok).toBe(true);
			}
		const otherProgress = getSyncChannelProgress(
			first.client.db,
			second.remote.localDeviceId,
			SCOPE,
		);
		const boundary = { ...getSyncResetState(first.remote.store.db, SCOPE) };
		if (change === "generation") boundary.generation = 3;
		if (change === "snapshot") boundary.snapshot_id = "boundary-b-new";
		if (change === "baseline") boundary.baseline_cursor = "2025-01-01T00:00:00Z|new-baseline";
		setSyncResetState(first.remote.store.db, boundary, SCOPE);
		// Act
		const recovered = await syncScopedChannelOnce({ ...first.options, limit: 1 });
		const resetProgress = getSyncChannelProgress(
			first.client.db,
			first.remote.localDeviceId,
			SCOPE,
		);
		const later = [];
		for (let i = 0; i < 2; i++)
			later.push(await syncScopedChannelOnce({ ...first.options, limit: 1 }));
		// Assert: the legacy bootstrap marker cannot override the changed peer boundary.
		expect(recovered).toMatchObject({ ok: true, bootstrapped: true, opsOut: 1 });
		expect(resetProgress).toMatchObject({
			generation: boundary.generation,
			snapshot_id: boundary.snapshot_id,
			baseline_cursor: boundary.baseline_cursor,
			last_acked_cursor: "2026-01-01T00:00:00Z|window-0-op",
		});
		expect(later.every((result) => result.ok && result.opsOut === 1)).toBe(true);
		expect(snapshotCount(first.requests)).toBe(2);
		expect(
			getSyncChannelProgress(first.client.db, first.remote.localDeviceId, SCOPE)?.last_acked_cursor,
		).toContain("|window-2-op");
		expect(getSyncChannelProgress(first.client.db, second.remote.localDeviceId, SCOPE)).toEqual(
			otherProgress,
		);
		expect(snapshotCount(second.requests)).toBe(1);
	},
);

it.each(["default", "earlier caller", "later caller"])(
	"uses one absolute pass deadline across status, snapshot, and split requests: %s",
	async (kind) => {
		// Arrange: a completed 413 forces multiple POST exchanges within the same pass.
		const f = await fixture();
		f.seed("client", "deadline-a");
		f.seed("client", "deadline-b");
		let refused = false;
		f.control.afterDispatch = (request, response) => {
			if (request.method !== "POST" || refused) return response;
			refused = true;
			return { status: 413, bodyBytes: bytes({ error: "payload_too_large" }) };
		};
		const started = performance.now();
		let deadlineMs: number | undefined;
		if (kind === "earlier caller") deadlineMs = started + 30000;
		if (kind === "later caller") deadlineMs = started + 120000;
		// Act
		const result = await syncScopedChannelOnce({ ...f.options, deadlineMs });
		const ended = performance.now();
		// Assert: each factory budget uses the same absolute deadline, without renewing 60 seconds.
		expect(result).toMatchObject({ ok: true, opsOut: 2 });
		expect(snapshotCount(f.requests)).toBe(1);
		expect(posts(f)).toHaveLength(3);
		const deadlines = f.factory.open.mock.calls.map(([options]) => options.deadlineMs);
		expect(new Set(deadlines).size).toBe(1);
		if (kind === "earlier caller") expect(deadlines[0]).toBe(deadlineMs);
		else {
			expect(deadlines[0]).toBeGreaterThanOrEqual(started + 60000);
			expect(deadlines[0]).toBeLessThanOrEqual(ended + 60000);
		}
	},
);

it("merges a populated scope without deleting local rows missing from the peer snapshot", async () => {
	// Arrange
	const f = await fixture();
	f.seed("client", "local-only");
	f.seed("remote", "remote-only");
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert
	expect(result).toMatchObject({ ok: true, bootstrapped: true, opsIn: 1 });
	expect(ids(f, "client")).toEqual(["local-only", "remote-only"]);
	assertSignedScope(f);
});

it.each(["missing local", "missing peer", "revoked local"])(
	"rejects %s scope proof before opening a channel",
	async (kind) => {
		// Arrange
		const f = await fixture();
		const deviceId = kind === "missing peer" ? f.remote.localDeviceId : f.remote.peerDeviceId;
		if (kind.startsWith("missing"))
			f.client.db
				.prepare("DELETE FROM scope_memberships WHERE scope_id = ? AND device_id = ?")
				.run(SCOPE, deviceId);
		else
			f.client.db
				.prepare(
					"UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ? AND device_id = ?",
				)
				.run(SCOPE, deviceId);
		// Act
		const result = await syncScopedChannelOnce(f.options);
		// Assert
		expect(result).toMatchObject({ scope_id: SCOPE, ok: false, opsIn: 0, opsOut: 0 });
		expect(f.factory.open).not.toHaveBeenCalled();
		expect(cursor(f)).toEqual([null, null]);
		expect(
			f.client.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_channel_progress'",
				)
				.get(),
		).toBeUndefined();
	},
);

it("rejects an authenticated channel for a different current peer before disclosing HTTP bytes", async () => {
	// Arrange
	const f = await fixture();
	f.control.wrongPin = true;
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert
	expect(result).toMatchObject({ ok: false, opsIn: 0, opsOut: 0 });
	expect(f.factory.open).toHaveBeenCalledTimes(1);
	expect(f.requests).toEqual([]);
	expect(cursor(f)).toEqual([null, null]);
});

it("observes owner completion before disposing a wrong-pin channel exactly once", async () => {
	// Arrange: this factory's completion has no rejection observer until the client adopts it.
	const f = await fixture();
	f.control.wrongPin = true;
	const disposed = vi.fn();
	const unhandled = vi.fn();
	process.on("unhandledRejection", unhandled);
	cleanups.push(async () => {
		process.off("unhandledRejection", unhandled);
	});
	f.control.wrapOwner = (connection) => {
		const completion = Promise.withResolvers<void>();
		return {
			duplex: connection.duplex,
			completion: completion.promise,
			async dispose(error) {
				disposed(error);
				completion.reject(error);
				await connection.dispose(error);
			},
		};
	};
	// Act
	const result = await syncScopedChannelOnce(f.options);
	await nextTurn();
	// Assert: rejection during disposal must never escape as an unhandled promise.
	expect(result).toMatchObject({ ok: false, opsIn: 0, opsOut: 0 });
	expect(disposed).toHaveBeenCalledTimes(1);
	expect(unhandled).not.toHaveBeenCalled();
	expect(f.requests).toEqual([]);
	expect(cursor(f)).toEqual([null, null]);
});

it.each(["rotate pin", "revoke local"])(
	"stops before apply or ACK when authorization changes during a response: %s",
	async (change) => {
		// Arrange
		const f = await fixture();
		incremental(f);
		f.seed("remote", "not-applied");
		f.seed("client", "not-pushed");
		f.control.afterDispatch = (request, response) => {
			if (request.method === "GET" && new URL(request.url).pathname === "/v1/ops") {
				if (change === "rotate pin")
					f.client.db
						.prepare("UPDATE sync_peers SET public_key = ? WHERE peer_device_id = ?")
						.run(f.remote.peerPublicKey, f.remote.localDeviceId);
				else
					f.client.db
						.prepare(
							"UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ? AND device_id = ?",
						)
						.run(SCOPE, f.remote.peerDeviceId);
			}
			return response;
		};
		// Act
		const result = await syncScopedChannelOnce(f.options);
		// Assert
		expect(result.ok).toBe(false);
		expect(ids(f, "client")).toEqual(["not-pushed"]);
		expect(cursor(f)).toEqual([INITIAL_CURSOR, null]);
		expect(posts(f)).toEqual([]);
	},
);

it("does not retry or switch paths after a factory failure", async () => {
	// Arrange
	const f = await fixture();
	f.factory.open.mockRejectedValue(new Error("Controlled factory failure"));
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert
	expect(result.ok).toBe(false);
	expect(f.factory.open).toHaveBeenCalledTimes(1);
	expect(f.requests).toEqual([]);
	expect(cursor(f)).toEqual([null, null]);
});

it("rejects an expired exchange deadline without opening a channel", async () => {
	// Arrange
	const f = await fixture();
	const deadlineMs = performance.now() - 1;
	// Act
	const result = await syncScopedChannelOnce({ ...f.options, deadlineMs });
	// Assert
	expect(result.ok).toBe(false);
	expect(f.factory.open).not.toHaveBeenCalled();
	expect(cursor(f)).toEqual([null, null]);
});

it("holds ACK and never replays an uncertain POST that the remote already applied", async () => {
	// Arrange
	const f = await fixture();
	incremental(f);
	f.seed("client", "uncertain-item");
	f.control.afterDispatch = (request, response) => {
		if (request.method === "POST") throw new Error("Controlled failure after remote apply");
		return response;
	};
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert
	expect(result.ok).toBe(false);
	expect(posts(f)).toHaveLength(1);
	expect(ids(f, "remote")).toEqual(["uncertain-item"]);
	expect(outboundAck(f)).toBeNull();
	assertFailedSendActivity(f);
	expect(getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE)).toMatchObject({
		generation: getSyncResetState(f.remote.store.db, SCOPE).generation,
		snapshot_id: getSyncResetState(f.remote.store.db, SCOPE).snapshot_id,
		last_acked_cursor: null,
	});
	expect(f.factory.open).toHaveBeenCalledTimes(f.requests.length);
});

it.each([500, 200])(
	"holds ACK after a completed remote apply error response with status %s",
	async (status) => {
		// Arrange
		const f = await fixture();
		incremental(f);
		f.seed("client", "rejected-item");
		f.control.afterDispatch = (request, response) =>
			request.method === "POST"
				? { status, bodyBytes: bytes({ scope_id: SCOPE, errors: ["controlled_apply_failure"] }) }
				: response;
		// Act
		const result = await syncScopedChannelOnce(f.options);
		// Assert
		expect(result.ok).toBe(false);
		expect(posts(f)).toHaveLength(1);
		expect(outboundAck(f)).toBeNull();
		assertFailedSendActivity(f);
	},
);

it("signs the scoped body before opening each channel", async () => {
	// Arrange
	const f = await fixture();
	incremental(f);
	f.seed("client", "signed-before-open");
	const sign = vi.spyOn(auth, "buildDirectPeerAuthHeaders");
	const prepared: boolean[] = [];
	f.control.beforeOpen = () => {
		const request = sign.mock.calls.at(-1)?.[0];
		if (!request) throw new Error("Channel opened without signed request material");
		const scoped =
			request.method === "POST"
				? JSON.parse(request.bodyBytes.toString()).scope_id === SCOPE
				: new URL(request.url).searchParams.get("scope_id") === SCOPE;
		prepared.push(scoped);
	};
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert
	expect(result).toMatchObject({ ok: true, opsOut: 1 });
	expect(prepared).toHaveLength(f.requests.length);
	expect(prepared.every(Boolean)).toBe(true);
	assertSignedScope(f);
});

it("rechecks local proof after a pending factory open before disclosing HTTP bytes", async () => {
	// Arrange
	const f = await fixture();
	f.control.beforeOpen = () =>
		f.client.db
			.prepare(
				"UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ? AND device_id = ?",
			)
			.run(SCOPE, f.remote.peerDeviceId);
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert
	expect(result.ok).toBe(false);
	expect(f.factory.open).toHaveBeenCalledTimes(1);
	expect(f.requests).toEqual([]);
	expect(cursor(f)).toEqual([null, null]);
});

it("stops before apply and ACK when cancellation arrives during a completed response", async () => {
	// Arrange
	const f = await fixture();
	incremental(f);
	f.seed("remote", "cancelled-inbound");
	f.seed("client", "cancelled-outbound");
	const controller = new AbortController();
	f.control.afterDispatch = (request, response) => {
		if (new URL(request.url).pathname === "/v1/ops") controller.abort();
		return response;
	};
	// Act
	const result = await syncScopedChannelOnce({ ...f.options, signal: controller.signal });
	// Assert
	expect(result.ok).toBe(false);
	expect(ids(f, "client")).toEqual(["cancelled-outbound"]);
	expect(cursor(f)).toEqual([INITIAL_CURSOR, null]);
	expect(posts(f)).toEqual([]);
});

it("splits serialized Unicode POST bodies below one MiB and signs every split afresh", async () => {
	// Arrange: each body fits individually, but their combined UTF-8 payload does not.
	const f = await fixture();
	incremental(f);
	f.seed("client", "large-a", "🌲".repeat(140000));
	f.seed("client", "large-b", "🌲".repeat(140000));
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert
	expect(result).toMatchObject({ ok: true, opsOut: 2 });
	expect(posts(f)).toHaveLength(2);
	for (const request of posts(f)) expect(request.bodyBytes.byteLength).toBeLessThanOrEqual(1048576);
	assertSignedScope(f);
});

it("fails an unsplittable oversized operation without sending it or advancing ACK", async () => {
	// Arrange
	const f = await fixture();
	incremental(f);
	f.seed("client", "too-large", "🌲".repeat(270000));
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert
	expect(result.ok).toBe(false);
	expect(posts(f)).toEqual([]);
	expect(outboundAck(f)).toBeNull();
});

it("starts the first relayed push after the ops the peer already pulled directly", async () => {
	// Arrange: the remote pulled the client's first two ops over direct sync before relay.
	// Seeded ops share one created_at, so op IDs decide the window order here.
	const f = await fixture();
	incremental(f);
	const direct = ["a-pulled", "b-pulled"].map((id) => f.seed("client", id));
	const last = direct.at(-1);
	if (!last) throw new Error("seed failed");
	setReplicationCursor(
		f.remote.store.db,
		f.remote.peerDeviceId,
		{ lastApplied: `${last.created_at}|${last.op_id}` },
		SCOPE,
	);
	f.seed("client", "c-new-after-direct");
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert: only the new op is sent, and the ACK covers everything the remote has.
	expect(result).toMatchObject({ ok: true, opsOut: 1 });
	expect(
		posts(f).flatMap((request) =>
			JSON.parse(Buffer.from(request.bodyBytes).toString()).ops.map(
				(op: { op_id: string }) => op.op_id,
			),
		),
	).toEqual(["c-new-after-direct-op"]);
	expect(outboundAck(f)).toContain("|c-new-after-direct-op");
});

it("records the peer's position when it already has every op, and ignores a malformed one", async () => {
	const f = await fixture();
	incremental(f);
	const op = f.seed("client", "a-already-there");
	setReplicationCursor(
		f.remote.store.db,
		f.remote.peerDeviceId,
		{ lastApplied: `${op.created_at}|${op.op_id}` },
		SCOPE,
	);
	const result = await syncScopedChannelOnce(f.options);
	expect(result).toMatchObject({ ok: true, opsOut: 0 });
	expect(posts(f)).toEqual([]);
	expect(outboundAck(f)).toBe(`${op.created_at}|${op.op_id}`);
	// A later pass whose status reports a malformed cursor still pushes from the saved ACK.
	f.seed("client", "b-second");
	f.control.afterDispatch = (request, response) => {
		if (!request.target.startsWith("/v1/status")) return response;
		const payload = JSON.parse(Buffer.from(response.bodyBytes).toString());
		payload.authorized_scopes[0].applied_cursor = "no-separator";
		return { ...response, bodyBytes: bytes(payload) };
	};
	expect(await syncScopedChannelOnce(f.options)).toMatchObject({ ok: true, opsOut: 1 });
	expect(outboundAck(f)).toContain("|b-second-op");
	// An idle pass whose status reports a position behind the saved ACK keeps the ACK and succeeds.
	f.control.afterDispatch = (request, response) => {
		if (!request.target.startsWith("/v1/status")) return response;
		const payload = JSON.parse(Buffer.from(response.bodyBytes).toString());
		payload.authorized_scopes[0].applied_cursor = `${op.created_at}|${op.op_id}`;
		return { ...response, bodyBytes: bytes(payload) };
	};
	expect(await syncScopedChannelOnce(f.options)).toMatchObject({ ok: true, opsOut: 0 });
	expect(outboundAck(f)).toContain("|b-second-op");
});

it("saves the outbound ACK after each confirmed push batch, so a later failure keeps earlier progress", async () => {
	// Arrange: three ~600 KB operations push as three batches; the second POST fails unapplied.
	const f = await fixture();
	incremental(f);
	for (const id of ["batch-a", "batch-b", "batch-c"]) f.seed("client", id, "x".repeat(600_000));
	let postCount = 0;
	let failSecond = true;
	f.control.beforeDispatch = (request) => {
		if (request.method === "POST" && failSecond && ++postCount === 2)
			f.remote.store.db.exec("SAVEPOINT failed_batch");
	};
	f.control.afterDispatch = (request, response) => {
		if (request.method !== "POST" || !failSecond || postCount !== 2) return response;
		f.remote.store.db.exec("ROLLBACK TO failed_batch; RELEASE failed_batch");
		return { status: 500, bodyBytes: bytes({ error: "internal_error" }) };
	};
	// Act
	const failed = await syncScopedChannelOnce(f.options);
	const ackAfterFailure = outboundAck(f);
	failSecond = false;
	const firstRetryPost = posts(f).length;
	const retried = await syncScopedChannelOnce(f.options);
	// Assert: the failed pass kept batch A, and the retry sent only B and C.
	expect(failed.ok).toBe(false);
	expect(ackAfterFailure).toContain("|batch-a-op");
	expect(retried).toMatchObject({ ok: true, opsOut: 2 });
	expect(
		posts(f)
			.slice(firstRetryPost)
			.flatMap((request) =>
				JSON.parse(Buffer.from(request.bodyBytes).toString()).ops.map(
					(op: { op_id: string }) => op.op_id,
				),
			),
	).toEqual(["batch-b-op", "batch-c-op"]);
	expect(outboundAck(f)).toContain("|batch-c-op");
});

it("splits only after a completed authenticated 413 and uses fresh nonces for the smaller requests", async () => {
	// Arrange: rollback the first dispatch so the controlled refusal applies no operations.
	const f = await fixture();
	incremental(f);
	f.seed("client", "split-a");
	f.seed("client", "split-b");
	let refused = false;
	f.control.beforeDispatch = (request) => {
		if (request.method === "POST" && !refused)
			f.remote.store.db.exec("SAVEPOINT controlled_refusal");
	};
	f.control.afterDispatch = (request, response) => {
		if (request.method === "POST" && !refused) {
			refused = true;
			f.remote.store.db.exec("ROLLBACK TO controlled_refusal; RELEASE controlled_refusal");
			return { status: 413, bodyBytes: bytes({ error: "payload_too_large" }) };
		}
		return response;
	};
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert
	expect(result).toMatchObject({ ok: true, opsOut: 2 });
	expect(posts(f)).toHaveLength(3);
	expect(
		posts(f).map((request) => JSON.parse(Buffer.from(request.bodyBytes).toString()).ops.length),
	).toEqual([2, 1, 1]);
	expect(
		readPeerSyncActivity(f.client.db, [f.remote.localDeviceId]).get(f.remote.localDeviceId)?.send,
	).toMatchObject({ errorCode: null, lastSuccessAt: expect.any(String), operations24h: 2 });
	expect(
		f.client.db
			.prepare(`SELECT transfer_id FROM sync_transfer_receipts
		WHERE peer_device_id = ? AND direction = 'send' AND kind = 'operation'
		ORDER BY transfer_id`)
			.pluck()
			.all(f.remote.localDeviceId),
	).toEqual(["split-a-op", "split-b-op"]);
	assertSignedScope(f);
});

it("does not split or replay a 413 when the owned channel cannot confirm completion", async () => {
	// Arrange: HTTP response bytes alone cannot authorize a retry.
	const f = await fixture();
	incremental(f);
	f.seed("client", "uncertain-split-a");
	f.seed("client", "uncertain-split-b");
	f.control.afterDispatch = (request, response) =>
		request.method === "POST"
			? { status: 413, bodyBytes: bytes({ error: "payload_too_large" }) }
			: response;
	f.control.wrapOwner = (connection) => {
		const completion = connection.completion.then(() => {
			if (f.requests.at(-1)?.method === "POST")
				throw new Error("Controlled owner completion failure");
		});
		void completion.catch(() => {});
		return { ...connection, completion };
	};
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert
	expect(result.ok).toBe(false);
	expect(posts(f)).toHaveLength(1);
	expect(outboundAck(f)).toBeNull();
	expect(f.factory.open).toHaveBeenCalledTimes(f.requests.length);
	assertFailedSendActivity(f);
});

it.each(["empty", "populated"])(
	"collects every real snapshot page before applying an initially %s scope",
	async (state) => {
		// Arrange: the scoped client requests 2,000 items per snapshot page.
		const f = await fixture();
		f.seed("remote", "snapshot-0");
		if (state === "populated") f.seed("client", "local-preserved");
		const insert = f.remote.store.db.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, created_at, updated_at, visibility, origin_device_id, rev, import_key, scope_id, metadata_json)
		SELECT session_id, kind, ?, body_text, created_at, updated_at, visibility, origin_device_id, rev, ?, scope_id, metadata_json
		FROM memory_items WHERE title = 'snapshot-0'`);
		f.remote.store.db.transaction(() => {
			for (let i = 1; i <= 2000; i++)
				insert.run(
					`snapshot-${i}`,
					`memory-source-v1:${Buffer.from(f.remote.localDeviceId).toString("base64url")}:${randomUUID()}`,
				);
		})();
		// Act
		const result = await syncScopedChannelOnce(f.options);
		// Assert: the final page and local-only rows must survive both bootstrap modes.
		expect(result).toMatchObject({ ok: true, bootstrapped: true, opsIn: 2001 });
		expect(ids(f, "client")).toHaveLength(state === "populated" ? 2002 : 2001);
		// The server also stops a page at 1 MiB, so 2,001 items can take more than two pages.
		const pages = f.requests.filter((request) => new URL(request.url).pathname === "/v1/snapshot");
		expect(pages.length).toBeGreaterThanOrEqual(2);
		for (const page of pages.slice(1))
			expect(new URL(page.url).searchParams.get("page_token")).toBeTruthy();
		assertSignedScope(f);
	},
);

it("rejects a snapshot boundary mismatch without replacing local rows or advancing a cursor", async () => {
	// Arrange
	const f = await fixture();
	f.seed("client", "preserved");
	f.seed("remote", "not-merged");
	f.control.afterDispatch = (request, response) => {
		if (new URL(request.url).pathname !== "/v1/snapshot") return response;
		const payload = JSON.parse(Buffer.from(response.bodyBytes).toString());
		return { ...response, bodyBytes: bytes({ ...payload, snapshot_id: "different-boundary" }) };
	};
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert
	expect(result.ok).toBe(false);
	expect(ids(f, "client")).toEqual(["preserved"]);
	expect(cursor(f)).toEqual([null, null]);
	expect(posts(f)).toEqual([]);
});

it("does not apply or acknowledge a cross-scope operation in an otherwise valid response", async () => {
	// Arrange
	const f = await fixture();
	incremental(f);
	const op = f.seed("remote", "wrong-scope");
	op.scope_id = "other-scope";
	op.payload_json = JSON.stringify({ ...JSON.parse(op.payload_json), scope_id: "other-scope" });
	f.control.afterDispatch = (request, response) =>
		request.method === "GET" && new URL(request.url).pathname === "/v1/ops"
			? {
					status: 200,
					bodyBytes: bytes({
						scope_id: SCOPE,
						ops: [op],
						next_cursor: "2026-01-01T00:00:00Z|wrong-scope-op",
					}),
				}
			: response;
	// Act
	const result = await syncScopedChannelOnce(f.options);
	// Assert
	expect(result.ok).toBe(false);
	expect(ids(f, "client")).toEqual([]);
	expect(cursor(f)).toEqual([INITIAL_CURSOR, null]);
	expect(posts(f)).toEqual([]);
});
