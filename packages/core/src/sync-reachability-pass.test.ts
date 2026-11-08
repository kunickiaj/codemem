import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelayPeerClient, type RelayPeerClient } from "./relay-peer-client.js";
import { relayAudienceId, relayBodyDigest } from "./relay-service-proof.js";
import * as syncAuth from "./sync-auth.js";
import * as channelPass from "./sync-channel-pass.js";
import {
	saveSyncChannelCompletedBoundary,
	saveSyncChannelOutboundAck,
} from "./sync-channel-progress.js";
import type { RequestJsonExecutor } from "./sync-http-client.js";
import * as syncIdentity from "./sync-identity.js";
import { runSyncPass } from "./sync-orchestration.js";
import { consecutiveConnectivityFailures, type SyncPassOptions, syncOnce } from "./sync-pass.js";
import {
	maintainSyncReachability,
	runReachableSyncPass,
	type SyncReachabilityOptions,
} from "./sync-reachability-pass.js";
import { readPeerSyncActivity, recordSyncTransferObservation } from "./sync-transfer-activity.js";
import { initTestSchema } from "./test-utils.js";

const addresses = ["http://127.0.0.1:19001", "http://127.0.0.1:19002"];
const boundary = {
	generation: 1,
	snapshot_id: "snapshot",
	baseline_cursor: null,
	retained_floor_cursor: null,
};
const status = {
	fingerprint: "pinned",
	protocol_version: "2",
	sync_capability: "enforcing",
	sync_reset: boundary,
};
const networkError = () => Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });

function successfulExchange() {
	return vi.fn<RequestJsonExecutor>(async (method, url) => {
		if (new URL(url).pathname === "/v1/status") return [200, status];
		if (method === "GET")
			return [200, { ...boundary, reset_required: false, ops: [], next_cursor: null, skipped: 0 }];
		return [200, { applied: 0, skipped: 0, errors: [] }];
	});
}

function approvedClient() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
	const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
	const pin = `ssh-ed25519 ${wire.toString("base64")}`;
	return createRelayPeerClient({
		enabled: false,
		url: "wss://relay.invalid/v1/relay",
		servicePublicKey: pin,
		deviceId: "local",
		localIdentity: { key: privateKey, expectedPin: pin },
		authorityId: "authority",
		groupId: "group",
		relayAudienceId: relayAudienceId("wss://relay.invalid", relayBodyDigest(wire)),
		externalPathname: "/v1/relay/admission-check",
		coordinator: { check: vi.fn(async () => null) },
		resolvePeerPin: () => pin,
		validateLocal: () => true,
		onInbound: vi.fn(async () => {}),
	});
}

it("maintains an actual relay with the caller signal and a three-second deadline", async () => {
	// Arrange: no connection is opened by the replaced maintenance port.
	vi.spyOn(performance, "now").mockReturnValue(1_000);
	const relay = approvedClient();
	const maintain = vi.spyOn(relay, "maintainRegistration").mockResolvedValue();
	const signal = new AbortController().signal;
	// Act.
	await maintainSyncReachability({
		scopeId: "space",
		logicalOrigin: "https://peer.invalid",
		relay,
		signal,
	});
	// Assert.
	expect(maintain).toHaveBeenCalledExactlyOnceWith(signal, 4_000);
});

it("caps maintenance to the caller deadline and continues direct sync after maintenance fails", async () => {
	// Arrange.
	vi.spyOn(performance, "now").mockReturnValue(1_000);
	const relay = approvedClient();
	const maintain = vi
		.spyOn(relay, "maintainRegistration")
		.mockRejectedValue(new Error("registration unavailable"));
	const opts = options(successfulExchange(), relay);
	opts.reachability = {
		...opts.reachability,
		deadlineMs: 2_000,
		signal: new AbortController().signal,
	};
	// Act.
	await maintainSyncReachability(opts.reachability);
	const result = await runReachableSyncPass(db, "peer", addresses, opts);
	// Assert.
	expect(maintain).toHaveBeenCalledExactlyOnceWith(opts.reachability.signal, 2_000);
	expect(result).toMatchObject({ ok: true, transport: "direct" });
	expect(scoped).not.toHaveBeenCalled();
});

it("never maintains a structural relay substitute or an omitted client", async () => {
	// Arrange.
	const maintainRegistration = vi.fn();
	const fake = { maintainRegistration } as unknown as RelayPeerClient;
	const reachability = { scopeId: "space", logicalOrigin: "https://peer.invalid" };
	// Act.
	await maintainSyncReachability({ ...reachability, relay: fake });
	await maintainSyncReachability(reachability);
	// Assert.
	expect(maintainRegistration).not.toHaveBeenCalled();
});

const databases: Database.Database[] = [];
const directories: string[] = [];
let db: Database.Database;
let scoped: ReturnType<typeof vi.spyOn<typeof channelPass, "syncScopedChannelOnce">>;

function database() {
	const value = new Database(":memory:");
	initTestSchema(value);
	for (const peer of ["peer", "other-peer"])
		value
			.prepare(
				"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES (?, 'pinned', 'current-public-key', '2026-01-01')",
			)
			.run(peer);
	for (const peer of ["peer", "other-peer"])
		value
			.prepare(
				"INSERT INTO replication_cursors(peer_device_id, last_applied_cursor, updated_at) VALUES (?, '2026-01-01T00:00:00Z|previous', '2026-01-01')",
			)
			.run(peer);
	databases.push(value);
	return value;
}

function options(
	requestExecutor: RequestJsonExecutor,
	relay?: RelayPeerClient,
): SyncPassOptions & { reachability: SyncReachabilityOptions } {
	return {
		requestExecutor,
		reachability: { scopeId: "space", logicalOrigin: "https://peer.invalid", relay },
	};
}

beforeEach(() => {
	db = database();
	vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue(["local", "public-key"]);
	vi.spyOn(syncAuth, "buildDirectPeerAuthHeaders").mockReturnValue({});
	scoped = vi.spyOn(channelPass, "syncScopedChannelOnce").mockResolvedValue({
		ok: true,
		scope_id: "space",
		opsIn: 0,
		opsOut: 0,
		bootstrapped: false,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const value of databases.splice(0)) value.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

async function sharedFileConnections() {
	const directory = mkdtempSync(join(tmpdir(), "codemem-peer-admission-"));
	directories.push(directory);
	const path = join(directory, "sync.sqlite");
	await db.backup(path);
	const first = new Database(path);
	const second = new Database(path);
	databases.push(first, second);
	return { first, second };
}

it.each(["success", "failure", "cancellation"] as const)(
	"owns shared relay admission across connections until direct %s finishes",
	async (outcome) => {
		// Arrange: both handles open the same SQLite file, and both callers share one real client.
		const { first, second } = await sharedFileConnections();
		const relay = approvedClient();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		const exchange = successfulExchange();
		const execute = vi.fn<RequestJsonExecutor>(async (method, url, request) => {
			entered.resolve();
			await release.promise;
			if (outcome === "failure") throw new Error("terminal probe failure");
			return exchange(method, url, request);
		});
		const opts = options(execute, relay);
		opts.reachability = { ...opts.reachability, signal: controller.signal };
		const pending = runReachableSyncPass(first, "peer", addresses, opts);
		await entered.promise;
		const competing = successfulExchange();
		let busy: Awaited<ReturnType<typeof runReachableSyncPass>>;
		let otherPeer: Awaited<ReturnType<typeof runReachableSyncPass>>;
		let stillBusy: Awaited<ReturnType<typeof runReachableSyncPass>>;
		try {
			// Act: a rejected contender must not release the original caller's ownership.
			busy = await runReachableSyncPass(second, "peer", addresses, options(competing, relay));
			otherPeer = await runReachableSyncPass(
				second,
				"other-peer",
				addresses,
				options(successfulExchange(), relay),
			);
			stillBusy = await runReachableSyncPass(second, "peer", addresses, options(competing, relay));
		} finally {
			if (outcome === "cancellation") controller.abort();
			release.resolve();
		}
		const completed = await pending;
		const retry = await runReachableSyncPass(
			second,
			"peer",
			addresses,
			options(successfulExchange(), relay),
		);
		// Assert: ownership covers direct work too, and every terminal outcome releases it.
		for (const result of [busy, stillBusy])
			expect(result).toMatchObject({
				ok: false,
				transport: "wait",
				error: "Peer sync is already in progress",
			});
		expect(competing).not.toHaveBeenCalled();
		expect(otherPeer).toMatchObject({ ok: true, transport: "direct" });
		expect(completed.ok).toBe(outcome === "success");
		expect(retry).toMatchObject({ ok: true, transport: "direct" });
	},
);

it("retains same-connection admission when callers provide distinct real relay clients", async () => {
	// Arrange: relay ownership supplements the existing database ownership.
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const exchange = successfulExchange();
	const execute = vi.fn<RequestJsonExecutor>(async (method, url, request) => {
		entered.resolve();
		await release.promise;
		return exchange(method, url, request);
	});
	const pending = runReachableSyncPass(db, "peer", addresses, options(execute, approvedClient()));
	await entered.promise;
	const competing = successfulExchange();
	let busy: Awaited<ReturnType<typeof runReachableSyncPass>>;
	try {
		// Act.
		busy = await runReachableSyncPass(db, "peer", addresses, options(competing, approvedClient()));
	} finally {
		release.resolve();
	}
	const completed = await pending;
	// Assert: switching relay instances cannot bypass the database's active peer.
	expect(busy).toMatchObject({
		ok: false,
		transport: "wait",
		error: "Peer sync is already in progress",
	});
	expect(competing).not.toHaveBeenCalled();
	expect(completed).toMatchObject({ ok: true, transport: "direct" });
});

it("completes direct sync before considering an approved relay", async () => {
	// Arrange: only identity signing and network ports are replaced.
	const execute = successfulExchange();
	const relay = approvedClient();
	const factory = vi.spyOn(relay, "factory");
	// Act.
	const result = await runReachableSyncPass(db, "peer", addresses, options(execute, relay));
	// Assert: the real legacy pull and push both ran on the first origin.
	expect(result, JSON.stringify(result)).toMatchObject({ ok: true, transport: "direct" });
	expect(execute.mock.calls.map(([method, url]) => [method, new URL(url).pathname])).toEqual([
		["GET", "/v1/status"],
		["GET", "/v1/ops"],
		["POST", "/v1/ops"],
	]);
	expect(factory).not.toHaveBeenCalled();
	expect(scoped).not.toHaveBeenCalled();
});

it("preserves a base path prefix throughout direct sync without switching origin or relay", async () => {
	// Arrange: reuse the exchange payloads behind a prefixed peer endpoint.
	const prefixedAddresses = addresses.map((address) => `${address}/codemem`);
	const exchange = successfulExchange();
	const mockRequestJsonExecutor = vi.fn<RequestJsonExecutor>(async (method, url, request) => {
		const endpoint = new URL(url);
		endpoint.pathname = endpoint.pathname.replace(/^\/codemem(?=\/)/, "");
		return exchange(method, endpoint.toString(), request);
	});
	const relay = approvedClient();
	const factory = vi.spyOn(relay, "factory");
	// Act.
	const result = await runReachableSyncPass(
		db,
		"peer",
		prefixedAddresses,
		options(mockRequestJsonExecutor, relay),
	);
	// Assert: status must authenticate before either application request starts.
	expect(result, JSON.stringify(result)).toMatchObject({ ok: true, transport: "direct" });
	expect(
		mockRequestJsonExecutor.mock.calls.map(([method, url]) => [method, new URL(url).pathname]),
	).toEqual([
		["GET", "/codemem/v1/status"],
		["GET", "/codemem/v1/ops"],
		["POST", "/codemem/v1/ops"],
	]);
	expect(new Set(mockRequestJsonExecutor.mock.calls.map(([, url]) => new URL(url).origin))).toEqual(
		new Set([addresses[0]]),
	);
	expect(factory).not.toHaveBeenCalled();
	expect(scoped).not.toHaveBeenCalled();
});

it("waits without starting a transport when no address or approved relay is available", async () => {
	// Arrange.
	const execute = successfulExchange();
	// Act.
	const result = await runReachableSyncPass(db, "peer", [], options(execute));
	// Assert.
	expect(result).toMatchObject({
		ok: false,
		transport: "wait",
		error: "no dialable peer addresses",
	});
	expect(execute).not.toHaveBeenCalled();
	expect(scoped).not.toHaveBeenCalled();
});

it("retains the legacy result when reachability is not enabled", async () => {
	// Arrange.
	const requestExecutor = successfulExchange();
	// Act.
	const result = await runReachableSyncPass(db, "peer", addresses, { requestExecutor });
	// Assert.
	expect(result.ok).toBe(true);
	expect(result.transport).toBeUndefined();
	expect(scoped).not.toHaveBeenCalled();
});

it("does not probe or fall back for an unpinned peer", async () => {
	// Arrange.
	db.prepare("UPDATE sync_peers SET pinned_fingerprint = '' WHERE peer_device_id = 'peer'").run();
	const execute = successfulExchange();
	// Act.
	const result = await runReachableSyncPass(
		db,
		"peer",
		addresses,
		options(execute, approvedClient()),
	);
	// Assert.
	expect(result).toMatchObject({ ok: false, transport: "direct", error: "Peer is not pinned" });
	expect(execute).not.toHaveBeenCalled();
	expect(scoped).not.toHaveBeenCalled();
});

it.each([
	["Node errno", networkError()],
	["fetch cause", new TypeError("fetch failed", { cause: networkError() })],
	["timeout", new DOMException("expired", "TimeoutError")],
	["Undici", Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" })],
])("waits after a typed %s failure without an approved relay", async (_label, error) => {
	// Arrange.
	const execute = vi.fn<RequestJsonExecutor>().mockRejectedValue(error);
	// Act.
	const result = await runReachableSyncPass(db, "peer", addresses, options(execute));
	// Assert: direct address probing is allowed before any authenticated status.
	expect(result).toMatchObject({ ok: false, transport: "wait" });
	expect(execute).toHaveBeenCalledTimes(2);
	expect(scoped).not.toHaveBeenCalled();
});

it("falls back using the approved relay, selected scope, current pin and caller lifetime", async () => {
	// Arrange: the relay implementation is real, but its scoped application port is mocked.
	const relay = approvedClient();
	const factory = vi.spyOn(relay, "factory");
	const execute = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	const opts = options(execute, relay);
	const signal = new AbortController().signal;
	const deadlineMs = performance.now() + 20_000;
	opts.reachability = { ...opts.reachability, signal, deadlineMs };
	// Act.
	const result = await runReachableSyncPass(db, "peer", addresses, opts);
	// Assert.
	expect(result).toMatchObject({ ok: true, transport: "relay" });
	expect(factory).toHaveBeenCalledExactlyOnceWith("peer", "current-public-key");
	expect(scoped).toHaveBeenCalledWith(
		expect.objectContaining({
			db,
			peerDeviceId: "peer",
			scopeId: "space",
			logicalOrigin: "https://peer.invalid",
			signal,
			deadlineMs,
			factory: expect.objectContaining({ open: expect.any(Function) }),
		}),
	);
});

it.each([true, false])(
	"updates peer success timestamps only for successful relay: %s",
	async (ok) => {
		// Arrange: preserve raw address formatting even when direct probes fail.
		const now = "2026-11-03T18:00:00.000Z";
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(now));
		const stored = {
			addresses_json: '[ "http://127.0.0.1:19002", "http://127.0.0.1:19001" ]',
			manual_addresses_json: '[ "http://127.0.0.1:19001" ]',
			last_success_address: "http://127.0.0.1:19002",
		};
		const stale = "2026-01-01T00:00:00.000Z";
		db.prepare(
			`UPDATE sync_peers SET addresses_json = ?, manual_addresses_json = ?,
		last_success_address = ?, last_sync_at = ?, last_seen_at = NULL,
		last_error = 'previous failure' WHERE peer_device_id = 'peer'`,
		).run(stored.addresses_json, stored.manual_addresses_json, stored.last_success_address, stale);
		if (!ok)
			scoped.mockResolvedValueOnce({
				ok: false,
				scope_id: "space",
				opsIn: 0,
				opsOut: 0,
				bootstrapped: false,
				error: "scope not authorized",
				failureCategory: "trust",
			});
		const execute = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
		// Act.
		const result = await runReachableSyncPass(
			db,
			"peer",
			addresses,
			options(execute, approvedClient()),
		);
		// Assert: relay success refreshes health without promoting any direct address.
		expect(result).toMatchObject({ ok, transport: "relay" });
		expect(execute).toHaveBeenCalledTimes(2);
		expect(scoped).toHaveBeenCalledTimes(1);
		const health = db
			.prepare("SELECT last_sync_at, last_seen_at FROM sync_peers WHERE peer_device_id = 'peer'")
			.get();
		expect.soft(health).toEqual({ last_sync_at: ok ? now : stale, last_seen_at: ok ? now : null });
		if (ok)
			expect
				.soft(db.prepare("SELECT last_error FROM sync_peers WHERE peer_device_id = 'peer'").get())
				.toEqual({ last_error: null });
		expect(
			db
				.prepare(
					"SELECT addresses_json, manual_addresses_json, last_success_address FROM sync_peers WHERE peer_device_id = 'peer'",
				)
				.get(),
		).toEqual(stored);
	},
);

it.each([401, 403, 429, 500])("does not switch origin or relay after HTTP %i", async (code) => {
	// Arrange.
	const execute = vi.fn<RequestJsonExecutor>().mockResolvedValue([code, { error: "denied" }]);
	// Act.
	const result = await runReachableSyncPass(
		db,
		"peer",
		addresses,
		options(execute, approvedClient()),
	);
	// Assert.
	expect(result).toMatchObject({ ok: false, transport: "direct" });
	expect(execute).toHaveBeenCalledTimes(1);
	expect(scoped).not.toHaveBeenCalled();
});

it.each([
	["fingerprint mismatch", { ...status, fingerprint: "wrong" }],
	["protocol mismatch", { ...status, protocol_version: "999" }],
	["missing reset boundary", { ...status, sync_reset: undefined }],
	["malformed status", null],
])("does not fall back after %s", async (_label, payload) => {
	// Arrange.
	const execute = vi.fn<RequestJsonExecutor>().mockResolvedValue([200, payload]);
	// Act.
	const result = await runReachableSyncPass(
		db,
		"peer",
		addresses,
		options(execute, approvedClient()),
	);
	// Assert.
	expect(result).toMatchObject({ ok: false, transport: "direct" });
	expect(execute).toHaveBeenCalledTimes(1);
	expect(scoped).not.toHaveBeenCalled();
});

it.each([
	["unknown exception", new Error("unexpected")],
	["untyped connectivity text", new Error("ECONNREFUSED")],
	["TLS validation", Object.assign(new Error("certificate"), { code: "CERT_HAS_EXPIRED" })],
])("treats %s as terminal", async (_label, error) => {
	// Arrange.
	const execute = vi.fn<RequestJsonExecutor>().mockRejectedValue(error);
	// Act.
	const result = await runReachableSyncPass(
		db,
		"peer",
		addresses,
		options(execute, approvedClient()),
	);
	// Assert.
	expect(result).toMatchObject({ ok: false, transport: "direct" });
	expect(execute).toHaveBeenCalledTimes(1);
	expect(scoped).not.toHaveBeenCalled();
});

it.each(["GET", "POST"])(
	"never retries another origin after committed %s uncertainty",
	async (failingMethod) => {
		// Arrange.
		const execute = successfulExchange();
		const normal = execute.getMockImplementation();
		if (!normal) throw new Error("Missing exchange fixture");
		execute.mockImplementation(async (method, url, request) => {
			if (new URL(url).pathname !== "/v1/status" && method === failingMethod) throw networkError();
			return normal(method, url, request);
		});
		// Act.
		const result = await runReachableSyncPass(
			db,
			"peer",
			addresses,
			options(execute, approvedClient()),
		);
		// Assert: even a possibly applied POST cannot be sent on another path.
		expect(result).toMatchObject({ ok: false, transport: "direct" });
		expect(new Set(execute.mock.calls.map(([, url]) => new URL(url).origin))).toEqual(
			new Set([addresses[0]]),
		);
		expect(execute.mock.calls.filter(([method]) => method === "POST")).toHaveLength(
			failingMethod === "POST" ? 1 : 0,
		);
		expect(scoped).not.toHaveBeenCalled();
	},
);

it("rejects a structural relay substitute without invoking its factory", async () => {
	// Arrange.
	const factory = vi.fn();
	const relay = { factory } as unknown as RelayPeerClient;
	const execute = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	// Act.
	const result = await runReachableSyncPass(db, "peer", [], options(execute, relay));
	// Assert.
	expect(result).toMatchObject({
		ok: false,
		transport: "wait",
		error: "Relay transport is unavailable",
	});
	expect(factory).not.toHaveBeenCalled();
	expect(scoped).not.toHaveBeenCalled();
});

it("records the final direct receive failure when an invalid relay cannot replace it", async () => {
	// Arrange: a real direct probe fails before the structural relay is rejected.
	const factory = vi.fn();
	const relay = { factory } as unknown as RelayPeerClient;
	const execute = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	// Act.
	const result = await runReachableSyncPass(
		db,
		"peer",
		addresses.slice(0, 1),
		options(execute, relay),
	);
	// Assert: rejecting the substitute must not discard the direct failure observation.
	expect(result).toMatchObject({
		ok: false,
		transport: "wait",
		error: "Relay transport is unavailable",
	});
	expect(execute).toHaveBeenCalledTimes(1);
	expect(factory).not.toHaveBeenCalled();
	expect(scoped).not.toHaveBeenCalled();
	expect(readPeerSyncActivity(db, ["peer"]).get("peer")?.receive).toMatchObject({
		errorCode: "exchange_failed",
		lastAttemptAt: expect.any(String),
		lastSuccessAt: null,
	});
});

it.each(["cancelled", "expired"])(
	"does not start requests for a caller already %s",
	async (mode) => {
		// Arrange.
		const execute = successfulExchange();
		const controller = new AbortController();
		if (mode === "cancelled") controller.abort();
		const opts = options(execute, approvedClient());
		opts.reachability = {
			...opts.reachability,
			signal: controller.signal,
			deadlineMs: mode === "expired" ? performance.now() - 1 : performance.now() + 20_000,
		};
		// Act.
		const result = await runReachableSyncPass(db, "peer", addresses, opts);
		// Assert.
		expect(result).toMatchObject({ ok: false, transport: "wait" });
		expect(execute).not.toHaveBeenCalled();
		expect(scoped).not.toHaveBeenCalled();
	},
);

it("propagates cancellation during a probe and releases the peer lock", async () => {
	// Arrange.
	const controller = new AbortController();
	const execute = vi.fn<RequestJsonExecutor>(async (_method, _url, request) => {
		expect(request?.signal).toBe(controller.signal);
		expect(request?.redirect).toBe("error");
		controller.abort();
		throw networkError();
	});
	const opts = options(execute, approvedClient());
	opts.reachability = { ...opts.reachability, signal: controller.signal };
	// Act.
	const cancelled = await runReachableSyncPass(db, "peer", addresses, opts);
	const next = await runReachableSyncPass(db, "peer", addresses, options(successfulExchange()));
	// Assert.
	expect(cancelled.ok).toBe(false);
	expect(execute).toHaveBeenCalledTimes(1);
	expect(scoped).not.toHaveBeenCalled();
	expect(next).toMatchObject({ ok: true, transport: "direct" });
});

it("caps direct request timeouts to the caller deadline", async () => {
	// Arrange.
	const execute = successfulExchange();
	const opts = options(execute);
	opts.reachability = { ...opts.reachability, deadlineMs: performance.now() + 1_500 };
	// Act.
	const result = await runReachableSyncPass(db, "peer", addresses, opts);
	// Assert.
	expect(result).toMatchObject({ ok: true });
	for (const [, , request] of execute.mock.calls) {
		expect(request?.timeoutS).toBeGreaterThan(0);
		expect(request?.timeoutS).toBeLessThanOrEqual(1.5);
	}
});

it("shares the ten-second probe budget across addresses", async () => {
	// Arrange: advance a monotonic clock at the request boundary, without sleeping.
	let now = 1_000;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const execute = vi.fn<RequestJsonExecutor>(async () => {
		now += 9_000;
		throw networkError();
	});
	// Act.
	const result = await runReachableSyncPass(db, "peer", addresses, options(execute));
	// Assert.
	expect(result).toMatchObject({ ok: false, transport: "wait" });
	expect(execute.mock.calls.map(([, , request]) => request?.timeoutS)).toEqual([3, 1]);
});

it("preserves legacy bootstrap timeouts after committed direct work exceeds sixty seconds", async () => {
	// Arrange: a real two-page initial bootstrap takes more than one minute in total.
	let now = 1_000;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	db.prepare("DELETE FROM replication_cursors WHERE peer_device_id = 'peer'").run();
	let pages = 0;
	const execute = vi.fn<RequestJsonExecutor>(async (_method, url) => {
		if (new URL(url).pathname === "/v1/status") return [200, status];
		pages++;
		now += 35_000;
		return [
			200,
			{
				...boundary,
				items: [],
				has_more: pages === 1,
				next_page_token: pages === 1 ? "page-two" : null,
			},
		];
	});
	// Act.
	const result = await runReachableSyncPass(
		db,
		"peer",
		addresses,
		options(execute, approvedClient()),
	);
	// Assert.
	expect(result, JSON.stringify(result)).toMatchObject({ ok: true, transport: "direct" });
	expect(execute).toHaveBeenCalledTimes(3);
	expect(execute.mock.calls.slice(1).map(([, , request]) => request?.timeoutS)).toEqual([60, 60]);
	expect(scoped).not.toHaveBeenCalled();
});

it("records one final attempt per unreachable tick and counts backoff by tick", async () => {
	// Arrange.
	db.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = 'peer'").run(
		JSON.stringify(addresses),
	);
	const execute = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	// Act.
	const first = await runSyncPass(db, "peer", options(execute));
	const firstCount = db
		.prepare("SELECT count(*) AS count FROM sync_attempts WHERE peer_device_id = 'peer'")
		.get();
	const second = await runSyncPass(db, "peer", options(execute));
	// Assert.
	expect(first.transport).toBe("wait");
	expect(second.transport).toBe("wait");
	expect(firstCount).toEqual({ count: 1 });
	expect(
		db.prepare("SELECT count(*) AS count FROM sync_attempts WHERE peer_device_id = 'peer'").get(),
	).toEqual({ count: 2 });
	expect(consecutiveConnectivityFailures(db, "peer")).toBe(2);
	expect(db.prepare("SELECT transport FROM sync_attempts ORDER BY id").all()).toEqual([
		{ transport: null },
		{ transport: null },
	]);
});

it("records only the selected relay result after direct probing fails", async () => {
	// Arrange.
	db.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = 'peer'").run(
		JSON.stringify(addresses),
	);
	const execute = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	// Act.
	const result = await runSyncPass(db, "peer", options(execute, approvedClient()));
	// Assert.
	expect(result).toMatchObject({ ok: true, transport: "relay" });
	expect(
		db
			.prepare(
				"SELECT ok, ops_in, ops_out, error, transport FROM sync_attempts WHERE peer_device_id = 'peer'",
			)
			.all(),
	).toEqual([{ ok: 1, ops_in: 0, ops_out: 0, error: null, transport: "relay" }]);
});

it("records relay failure diagnostics without inheriting the failed direct probe transport", async () => {
	// Arrange: syncOnce records a direct diagnostic before relay is selected.
	db.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = 'peer'").run(
		JSON.stringify(addresses),
	);
	const execute = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	scoped.mockResolvedValue({
		ok: false,
		scope_id: "space",
		opsIn: 0,
		opsOut: 0,
		bootstrapped: false,
		error: "relay exchange failed",
	});
	// Act.
	const result = await runSyncPass(db, "peer", options(execute, approvedClient()));
	// Assert: final route and diagnostics both describe the selected relay attempt.
	expect(result).toMatchObject({ ok: false, transport: "relay", error: "relay exchange failed" });
	expect(db.prepare("SELECT ok, error, transport FROM sync_attempts").all()).toEqual([
		{ ok: 0, error: "relay exchange failed", transport: "relay" },
	]);
});

it.each([true, false])(
	"does not publish a failed first address while the second address is pending (success: %s)",
	async (succeeds) => {
		// Arrange: the real direct pass pauses at its second status request.
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const exchange = successfulExchange();
		const execute = vi.fn<RequestJsonExecutor>(async (method, url, request) => {
			if (new URL(url).origin === addresses[0]) throw networkError();
			if (new URL(url).pathname === "/v1/status") {
				entered.resolve();
				await release.promise;
				if (!succeeds) throw networkError();
			}
			return exchange(method, url, request);
		});
		// Act: read activity before releasing the remaining address.
		const pending = runReachableSyncPass(db, "peer", addresses, options(execute));
		await entered.promise;
		const during = readPeerSyncActivity(db, ["peer"]).get("peer");
		release.resolve();
		const result = await pending;
		const after = readPeerSyncActivity(db, ["peer"]).get("peer");
		// Assert: only the final selected outcome can report a failure.
		expect.soft(during?.receive).toMatchObject({ errorCode: null, lastAttemptAt: null });
		expect(result).toMatchObject({ ok: succeeds, transport: succeeds ? "direct" : "wait" });
		expect(after?.receive.errorCode).toBe(succeeds ? null : "exchange_failed");
	},
);

it.each([true, false])(
	"does not publish direct failures while relay fallback is pending (success: %s)",
	async (succeeds) => {
		// Arrange: model the scoped channel's successful and pre-pull failed observations.
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		scoped.mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			if (succeeds) {
				recordSyncTransferObservation(db, "peer", "receive", { preserveScopedError: true });
				recordSyncTransferObservation(db, "peer", "send");
			} else {
				recordSyncTransferObservation(db, "peer", "receive", { errorCode: "exchange_failed" });
			}
			return {
				ok: succeeds,
				scope_id: "space",
				opsIn: 0,
				opsOut: 0,
				bootstrapped: false,
				...(succeeds ? {} : { error: "scoped channel exchange failed: relay_rejected" }),
			};
		});
		const execute = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
		// Act: the relay has started, but has not returned a selected outcome.
		const pending = runReachableSyncPass(db, "peer", addresses, options(execute, approvedClient()));
		await entered.promise;
		const during = readPeerSyncActivity(db, ["peer"]).get("peer");
		release.resolve();
		const result = await pending;
		const after = readPeerSyncActivity(db, ["peer"]).get("peer");
		// Assert: a final relay failure must still leave the peer's failed receive visible.
		expect.soft(during?.receive).toMatchObject({ errorCode: null, lastAttemptAt: null });
		expect(result).toMatchObject({ ok: succeeds, transport: "relay" });
		expect(after?.receive.errorCode).toBe(succeeds ? null : "exchange_failed");
	},
);

it("retains final negotiation failures when reachability is disabled", async () => {
	// Arrange: direct-only callers must still publish a final failed receive.
	const requestExecutor = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	// Act.
	const result = await runReachableSyncPass(db, "peer", addresses, { requestExecutor });
	// Assert.
	expect(result.ok).toBe(false);
	expect(result.transport).toBeUndefined();
	expect(readPeerSyncActivity(db, ["peer"]).get("peer")?.receive).toMatchObject({
		errorCode: "exchange_failed",
		lastAttemptAt: expect.any(String),
		lastSuccessAt: null,
	});
});

it.each([
	{ errorCode: "exchange_failed", source: "initiated", expected: null },
	{ errorCode: "apply_failed", source: "initiated", expected: "apply_failed" },
	{ errorCode: "scope_rejected", source: "initiated", expected: "scope_rejected" },
	{ errorCode: "exchange_failed", source: "inbound", expected: "exchange_failed" },
	{ errorCode: "apply_failed", source: "inbound", expected: "apply_failed" },
	{ errorCode: "scope_rejected", source: "inbound", expected: "scope_rejected" },
] as const)(
	"relay success preserves $source $errorCode according to source and scope",
	async ({ errorCode, source, expected }) => {
		// Arrange: scoped success can resolve only a generic initiated receive failure.
		recordSyncTransferObservation(db, "peer", "receive", { errorCode, source });
		scoped.mockImplementationOnce(async () => {
			recordSyncTransferObservation(db, "peer", "receive", { preserveScopedError: true });
			recordSyncTransferObservation(db, "peer", "send");
			return { ok: true, scope_id: "space", opsIn: 0, opsOut: 0, bootstrapped: false };
		});
		const execute = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
		// Act.
		const result = await runReachableSyncPass(
			db,
			"peer",
			addresses,
			options(execute, approvedClient()),
		);
		// Assert: the aggregate activity must retain errors from unretried scopes or inbound work.
		expect(result).toMatchObject({ ok: true, transport: "relay" });
		expect(readPeerSyncActivity(db, ["peer"]).get("peer")?.receive.errorCode).toBe(expected);
	},
);

it("records one diagnostic when the public selector rejects invalid configuration", async () => {
	// Arrange.
	const opts = options(successfulExchange());
	opts.reachability = { ...opts.reachability, scopeId: "" };
	// Act.
	const result = await runSyncPass(db, "peer", opts);
	// Assert.
	expect(result.ok).toBe(false);
	expect(
		db.prepare("SELECT ok, error FROM sync_attempts WHERE peer_device_id = 'peer'").all(),
	).toEqual([{ ok: 0, error: result.error }]);
});

it("records one successful attempt for a selected direct pass", async () => {
	// Arrange.
	db.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = 'peer'").run(
		JSON.stringify(addresses),
	);
	// Act.
	const result = await runSyncPass(db, "peer", options(successfulExchange()));
	// Assert.
	expect(result).toMatchObject({ ok: true, transport: "direct" });
	expect(
		db.prepare("SELECT ok, transport FROM sync_attempts WHERE peer_device_id = 'peer'").all(),
	).toEqual([{ ok: 1, transport: "direct" }]);
});

it.each([true, false])("records direct transport for a bootstrap with success=%s", async (ok) => {
	// Arrange: no cursor selects bootstrap, with every HTTP request replaced.
	db.prepare("DELETE FROM replication_cursors WHERE peer_device_id = 'peer'").run();
	const execute = vi.fn<RequestJsonExecutor>(async (_method, url) => {
		if (new URL(url).pathname === "/v1/status") return [200, status];
		if (!ok) return [500, { error: "snapshot unavailable" }];
		return [200, { ...boundary, items: [], has_more: false, next_page_token: null }];
	});
	// Act: syncOnce must also record transport without the outer reachability selector.
	const result = await syncOnce(db, "peer", addresses, { requestExecutor: execute });
	// Assert.
	expect(result.ok).toBe(ok);
	expect(db.prepare("SELECT ok, transport FROM sync_attempts").all()).toEqual([
		{ ok: Number(ok), transport: "direct" },
	]);
});

it("retains direct capability diagnostics and transport when a committed exchange fails", async () => {
	// Arrange: status commits direct sync before the pull fails.
	db.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = 'peer'").run(
		JSON.stringify(addresses),
	);
	const execute = vi.fn<RequestJsonExecutor>(async (_method, url) => {
		if (new URL(url).pathname === "/v1/status") return [200, status];
		throw networkError();
	});
	// Act.
	const result = await runSyncPass(db, "peer", options(execute, approvedClient()));
	// Assert: the directRecord diagnostic path must retain the selected route.
	expect(result).toMatchObject({ ok: false, transport: "direct" });
	expect(db.prepare("SELECT ok, transport, peer_sync_capability FROM sync_attempts").all()).toEqual(
		[{ ok: 0, transport: "direct", peer_sync_capability: "enforcing" }],
	);
});

it("still enforces an explicit caller deadline after direct status commits", async () => {
	// Arrange.
	let now = 1_000;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const execute = successfulExchange();
	const normal = execute.getMockImplementation();
	if (!normal) throw new Error("Missing exchange fixture");
	execute.mockImplementation(async (method, url, request) => {
		const response = await normal(method, url, request);
		if (new URL(url).pathname !== "/v1/status") now += 2_000;
		return response;
	});
	const opts = options(execute, approvedClient());
	opts.reachability = { ...opts.reachability, deadlineMs: 2_000 };
	// Act.
	const result = await runReachableSyncPass(db, "peer", addresses, opts);
	// Assert.
	expect(result.ok).toBe(false);
	expect(execute.mock.calls.filter(([method]) => method === "POST")).toHaveLength(0);
	expect(scoped).not.toHaveBeenCalled();
});

it.each([true, false])(
	"does not record a concurrent wait while the active pass finishes (success: %s)",
	async (succeeds) => {
		// Arrange: defer the active pass at the network boundary instead of using timers.
		db.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = 'peer'").run(
			JSON.stringify(addresses),
		);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const exchange = successfulExchange();
		const execute = vi.fn<RequestJsonExecutor>(async (method, url, request) => {
			if (new URL(url).pathname === "/v1/status") {
				entered.resolve();
				await release.promise;
				if (!succeeds) throw networkError();
			}
			return exchange(method, url, request);
		});
		const pending = runSyncPass(db, "peer", options(execute));
		await entered.promise;
		// Act.
		const overlappingExchange = successfulExchange();
		const busy = await runSyncPass(db, "peer", options(overlappingExchange));
		const busyRows = db
			.prepare("SELECT ok, error FROM sync_attempts WHERE peer_device_id = 'peer'")
			.all();
		release.resolve();
		const first = await pending;
		// Assert: only the pass that actually ran may affect attempts or connectivity backoff.
		expect(busy).toMatchObject({
			ok: false,
			transport: "wait",
			error: "Peer sync is already in progress",
		});
		expect(overlappingExchange).not.toHaveBeenCalled();
		expect(busyRows).toEqual([]);
		expect(first.ok).toBe(succeeds);
		expect(
			db.prepare("SELECT ok, error FROM sync_attempts WHERE peer_device_id = 'peer'").all(),
		).toEqual([{ ok: succeeds ? 1 : 0, error: first.error ?? null }]);
		expect(consecutiveConnectivityFailures(db, "peer")).toBe(succeeds ? 0 : 1);
	},
);

it("gives relay its own lifetime when slow direct attempts used most of the pass deadline", async () => {
	// Arrange: unreachable direct addresses take 40 of the pass's 60 seconds.
	let now = 1_000;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const execute = vi.fn<RequestJsonExecutor>(async () => {
		now += 40_000;
		throw networkError();
	});
	// Act.
	const result = await runReachableSyncPass(
		db,
		"peer",
		addresses,
		options(execute, approvedClient()),
	);
	// Assert: relay still starts, without the 20 seconds direct left behind as its deadline.
	expect(result).toMatchObject({ transport: "relay" });
	expect(scoped).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: undefined }));
});

it("does not start relay when the overall deadline expires during a network failure", async () => {
	// Arrange.
	let now = 1_000;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const execute = vi.fn<RequestJsonExecutor>(async () => {
		now += 61_000;
		throw networkError();
	});
	// Act.
	const result = await runReachableSyncPass(
		db,
		"peer",
		addresses,
		options(execute, approvedClient()),
	);
	// Assert.
	expect(result.ok).toBe(false);
	expect(execute).toHaveBeenCalledTimes(1);
	expect(scoped).not.toHaveBeenCalled();
});

it("serializes scopes for one database and peer while allowing other peers and databases", async () => {
	// Arrange: a deferred request provides a deterministic overlapping pass.
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const execute = vi.fn<RequestJsonExecutor>(async () => {
		entered.resolve();
		await release.promise;
		throw networkError();
	});
	const first = runReachableSyncPass(db, "peer", addresses.slice(0, 1), options(execute));
	await entered.promise;
	const differentScope = options(successfulExchange());
	differentScope.reachability = { ...differentScope.reachability, scopeId: "other-space" };
	// Act.
	const blocked = await runReachableSyncPass(db, "peer", addresses, differentScope);
	const otherPeer = await runReachableSyncPass(
		db,
		"other-peer",
		addresses,
		options(successfulExchange()),
	);
	const otherDb = await runReachableSyncPass(
		database(),
		"peer",
		addresses,
		options(successfulExchange()),
	);
	release.resolve();
	await first;
	const retry = await runReachableSyncPass(db, "peer", addresses, options(successfulExchange()));
	// Assert.
	expect(blocked).toMatchObject({
		ok: false,
		transport: "wait",
		error: "Peer sync is already in progress",
	});
	expect(otherPeer.ok).toBe(true);
	expect(otherDb.ok).toBe(true);
	expect(retry.ok).toBe(true);
});

it("does not change progress or invoke relay when local signing is unavailable", async () => {
	// Arrange.
	db.prepare(
		"UPDATE replication_cursors SET last_applied_cursor = 'read-cursor', last_acked_cursor = 'write-cursor' WHERE peer_device_id = 'peer'",
	).run();
	const before = db.prepare("SELECT * FROM replication_cursors").all();
	const target = { peerDeviceId: "peer", scopeId: "space", boundary };
	saveSyncChannelCompletedBoundary(db, target);
	saveSyncChannelOutboundAck(db, { ...target, cursor: "2026-01-01T00:00:00Z|acked" });
	const privateBefore = db.prepare("SELECT * FROM sync_channel_progress").all();
	vi.mocked(syncIdentity.ensureDeviceIdentity).mockImplementation(() => {
		throw new Error("no key");
	});
	const execute = successfulExchange();
	// Act.
	const result = await runReachableSyncPass(
		db,
		"peer",
		addresses,
		options(execute, approvedClient()),
	);
	// Assert.
	expect(result).toMatchObject({ ok: false, transport: "direct" });
	expect(db.prepare("SELECT * FROM replication_cursors").all()).toEqual(before);
	expect(db.prepare("SELECT * FROM sync_channel_progress").all()).toEqual(privateBefore);
	expect(execute).not.toHaveBeenCalled();
	expect(scoped).not.toHaveBeenCalled();
});

it("reports a scoped relay failure and captures a fresh current pin on the next pass", async () => {
	// Arrange.
	const relay = approvedClient();
	const factory = vi.spyOn(relay, "factory");
	const execute = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	scoped.mockResolvedValueOnce({
		ok: false,
		scope_id: "space",
		opsIn: 0,
		opsOut: 0,
		bootstrapped: false,
		error: "scope not authorized",
		failureCategory: "trust",
	});
	// Act.
	const failed = await runReachableSyncPass(db, "peer", [], options(execute, relay));
	db.prepare(
		"UPDATE sync_peers SET public_key = 'replacement-key' WHERE peer_device_id = 'peer'",
	).run();
	const next = await runReachableSyncPass(db, "peer", [], options(execute, relay));
	// Assert: a failed relay pass also releases the peer lock.
	expect(failed).toMatchObject({
		ok: false,
		transport: "relay",
		error: "scope not authorized",
		failureCategory: "trust",
	});
	expect(next).toMatchObject({ ok: true, transport: "relay" });
	expect(factory.mock.calls).toEqual([
		["peer", "current-public-key"],
		["peer", "replacement-key"],
	]);
	expect(factory.mock.results[0]?.value).not.toBe(factory.mock.results[1]?.value);
});
