import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { columnExists, connect } from "./db.js";
import type { RelayPeerClient } from "./relay-peer-client.js";
import {
	createSerializedDaemonTickRunner,
	getSyncDaemonPhase,
	refreshCoordinatorForDaemon,
	refreshCoordinatorPresenceForDaemon,
	resolveSyncDaemonKeysDir,
	runSyncDaemon,
	runTickOnce,
	setSyncDaemonError,
	setSyncDaemonOk,
	setSyncDaemonPhase,
	syncDaemonTick,
} from "./sync-daemon.js";
import * as syncIdentity from "./sync-identity.js";
import { ensureDeviceIdentity, resolveKeyPaths } from "./sync-identity.js";
import * as reachabilityPass from "./sync-reachability-pass.js";

import { initTestSchema } from "./test-utils.js";

const ORIGINAL_KEYS_DIR = process.env.CODEMEM_KEYS_DIR;

async function resetReachabilityMocks(): Promise<void> {
	vi.clearAllMocks();
	const { coordinatorEnabled } = await import("./coordinator-runtime.js");
	const { shouldSkipOfflinePeer } = await import("./sync-pass.js");
	vi.mocked(coordinatorEnabled).mockReturnValue(false);
	vi.mocked(shouldSkipOfflinePeer).mockReturnValue(false);
	vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue(["local", "public-key"]);
}

describe("daemon reachability wiring", () => {
	beforeEach(resetReachabilityMocks);
	afterEach(() => vi.restoreAllMocks());

	it("maintains opt-in reachability before passing the same configuration to peer sync", async () => {
		// Arrange: the existing tick callback seeds a peer in an in-memory database.
		const { runSyncPass } = await import("./sync-pass.js");
		const reachability = {
			scopeId: "space",
			logicalOrigin: "https://peer.invalid",
			signal: new AbortController().signal,
		};
		const maintain = vi.spyOn(reachabilityPass, "maintainSyncReachability").mockResolvedValue();
		// Act.
		await runTickOnce(
			":memory:",
			undefined,
			undefined,
			({ db }) => {
				db.prepare(
					"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, created_at) VALUES ('peer', 'pin', '2026-01-01')",
				).run();
			},
			reachability,
		);
		// Assert.
		expect(maintain).toHaveBeenCalledExactlyOnceWith(reachability);
		expect(runSyncPass).toHaveBeenCalledExactlyOnceWith(
			expect.any(Database),
			"peer",
			expect.objectContaining({ reachability }),
		);
		expect(maintain.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(runSyncPass).mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("does not invoke relay maintenance for a default daemon tick", async () => {
		// Arrange.
		const { runSyncPass } = await import("./sync-pass.js");
		const maintain = vi.spyOn(reachabilityPass, "maintainSyncReachability").mockResolvedValue();
		// Act.
		await runTickOnce(":memory:", undefined, undefined, ({ db }) => {
			db.prepare(
				"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, created_at) VALUES ('peer', 'pin', '2026-01-01')",
			).run();
		});
		// Assert.
		expect(maintain).not.toHaveBeenCalled();
		expect(runSyncPass).toHaveBeenCalledExactlyOnceWith(
			expect.any(Database),
			"peer",
			expect.objectContaining({ reachability: undefined }),
		);
	});

	it("combines daemon and caller cancellation for the scheduled startup tick", async () => {
		// Arrange: stop through the existing first-tick completion callback.
		const daemonAbort = new AbortController();
		const callerAbort = new AbortController();
		let cancelledBeforeDaemonStopped = false;
		const maintain = vi
			.spyOn(reachabilityPass, "maintainSyncReachability")
			.mockImplementation(async (options) => {
				callerAbort.abort();
				cancelledBeforeDaemonStopped =
					options.signal?.aborted === true && !daemonAbort.signal.aborted;
			});
		// Act.
		await runSyncDaemon({
			dbPath: ":memory:",
			signal: daemonAbort.signal,
			reachability: {
				scopeId: "space",
				logicalOrigin: "https://peer.invalid",
				signal: callerAbort.signal,
			},
			onAfterCoordinatorRefresh: ({ db }) => {
				db.prepare(
					"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, created_at) VALUES ('peer', 'pin', '2026-01-01')",
				).run();
			},
			onPhaseChange: (phase) => {
				if (phase === "running") daemonAbort.abort();
			},
		});
		// Assert: a distinct combined signal carries caller cancellation into maintenance.
		expect(maintain).toHaveBeenCalledTimes(1);
		const signal = maintain.mock.calls[0]?.[0].signal;
		expect(signal).not.toBe(daemonAbort.signal);
		expect(signal).not.toBe(callerAbort.signal);
		expect(signal?.aborted).toBe(true);
		expect(cancelledBeforeDaemonStopped).toBe(true);
	});

	it("does not maintain an opted-in relay when no peers are configured", async () => {
		// Arrange: a fresh in-memory store has no sync peers.
		const { runSyncPass } = await import("./sync-pass.js");
		const maintain = vi.spyOn(reachabilityPass, "maintainSyncReachability").mockResolvedValue();
		// Act.
		await runTickOnce(":memory:", undefined, undefined, undefined, {
			scopeId: "space",
			logicalOrigin: "https://peer.invalid",
		});
		// Assert.
		expect(maintain).not.toHaveBeenCalled();
		expect(runSyncPass).not.toHaveBeenCalled();
	});
});

describe("per-peer daemon reachability", () => {
	beforeEach(resetReachabilityMocks);
	afterEach(() => vi.restoreAllMocks());

	it("routes each peer through its group's client and maintains every client", async () => {
		// Arrange: two groups with one client each, and a resolver that maps peers to groups.
		const { runSyncPass } = await import("./sync-pass.js");
		const daemonAbort = new AbortController();
		const callerAbort = new AbortController();
		const cancelledBeforeDaemonStopped: boolean[] = [];
		const maintain = vi
			.spyOn(reachabilityPass, "maintainSyncReachability")
			.mockImplementation(async (target) => {
				callerAbort.abort();
				cancelledBeforeDaemonStopped.push(
					target.signal?.aborted === true && !daemonAbort.signal.aborted,
				);
			});
		const clientA = { group: "a" } as unknown as RelayPeerClient;
		const clientB = { group: "b" } as unknown as RelayPeerClient;
		const routes = new Map([
			["peer-a", { scopeId: "space-a", logicalOrigin: "https://peer.invalid", relay: clientA }],
			["peer-b", { scopeId: "space-b", logicalOrigin: "https://peer.invalid", relay: clientB }],
		]);
		const resolver = {
			forPeer: (_db: unknown, peer: string) => routes.get(peer),
			clients: () => [clientA, clientB, clientA],
			signal: callerAbort.signal,
		};
		// Act: the scheduled startup tick runs through the daemon's combined signal.
		await runSyncDaemon({
			dbPath: ":memory:",
			signal: daemonAbort.signal,
			reachability: resolver,
			onAfterCoordinatorRefresh: ({ db }) => {
				for (const peer of ["peer-a", "peer-b", "peer-direct"])
					db.prepare(
						"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, created_at) VALUES (?, 'pin', '2026-01-01')",
					).run(peer);
			},
			onPhaseChange: (phase) => {
				if (phase === "running") daemonAbort.abort();
			},
		});
		// Assert: duplicate clients are maintained once, before any peer pass.
		expect(maintain.mock.calls.map(([target]) => target.relay)).toEqual([clientA, clientB]);
		const passes = vi.mocked(runSyncPass).mock.calls;
		expect(
			Object.fromEntries(passes.map(([, peer, options]) => [peer, options?.reachability])),
		).toEqual({
			"peer-a": expect.objectContaining({ scopeId: "space-a", relay: clientA }),
			"peer-b": expect.objectContaining({ scopeId: "space-b", relay: clientB }),
			"peer-direct": undefined,
		});
		// Caller cancellation reaches maintenance and every relay pass through a combined signal.
		expect(cancelledBeforeDaemonStopped).toEqual([true, true]);
		const passSignals = passes.flatMap(([, , options]) => options?.reachability?.signal ?? []);
		expect(passSignals).toHaveLength(2);
		for (const signal of passSignals) expect(signal).not.toBe(callerAbort.signal);
		expect(maintain.mock.invocationCallOrder.at(-1)).toBeLessThan(
			vi.mocked(runSyncPass).mock.invocationCallOrder[0] ?? 0,
		);
	});
});

function insertPeers(...peers: string[]) {
	return ({ db }: { db: InstanceType<typeof Database> }) => {
		for (const peer of peers)
			db.prepare(
				"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, created_at) VALUES (?, 'pin', '2026-01-01')",
			).run(peer);
	};
}

describe("relay daemon resilience", () => {
	beforeEach(resetReachabilityMocks);
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("renews relay registration on its own timer while a long tick runs", async () => {
		// Arrange: the first peer pass hangs for longer than two tick intervals.
		vi.useFakeTimers();
		const { runSyncPass } = await import("./sync-pass.js");
		let finishPass = () => {};
		vi.mocked(runSyncPass).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishPass = () => resolve({ ok: true, opsIn: 0, opsOut: 0, addressErrors: [] });
				}),
		);
		const maintain = vi.spyOn(reachabilityPass, "maintainSyncReachability").mockResolvedValue();
		const client = { name: "relay" } as unknown as RelayPeerClient;
		const abort = new AbortController();
		const daemon = runSyncDaemon({
			dbPath: ":memory:",
			intervalS: 120,
			signal: abort.signal,
			reachability: { forPeer: () => undefined, clients: () => [client] },
			onAfterCoordinatorRefresh: insertPeers("peer"),
		});
		try {
			// Act: start the tick, then let 240 s pass while it is still running.
			await vi.advanceTimersByTimeAsync(0);
			const tickMaintenance = maintain.mock.calls.length;
			await vi.advanceTimersByTimeAsync(240_000);
			// Assert: scheduled ticks were skipped, but the timer maintained the client four times.
			expect(tickMaintenance).toBe(1);
			expect(runSyncPass).toHaveBeenCalledTimes(1);
			expect(maintain).toHaveBeenCalledTimes(5);
			for (const [target] of maintain.mock.calls) expect(target.relay).toBe(client);
		} finally {
			finishPass();
			abort.abort();
			await daemon;
		}
	});

	it("keeps syncing other peers directly when the resolver throws", async () => {
		// Arrange: route resolution fails for one peer and client listing fails outright.
		const { runSyncPass } = await import("./sync-pass.js");
		const maintain = vi.spyOn(reachabilityPass, "maintainSyncReachability").mockResolvedValue();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const client = { name: "relay" } as unknown as RelayPeerClient;
		const route = { scopeId: "space", logicalOrigin: "https://peer.invalid", relay: client };
		// Act.
		await runTickOnce(":memory:", undefined, undefined, insertPeers("peer-bad", "peer-good"), {
			forPeer: (_db, peer) => {
				if (peer === "peer-bad") throw new Error("resolver failed");
				return route;
			},
			clients: () => {
				throw new Error("listing failed");
			},
		});
		// Assert.
		const passes = vi.mocked(runSyncPass).mock.calls;
		expect(
			Object.fromEntries(passes.map(([, peer, options]) => [peer, options?.reachability])),
		).toEqual({
			"peer-bad": undefined,
			"peer-good": expect.objectContaining({ scopeId: "space", relay: client }),
		});
		expect(maintain).not.toHaveBeenCalled();
		expect(errors).toHaveBeenCalledTimes(2);
	});
});

it("starts each daemon tick without reusing an expired absolute pass deadline", async () => {
	// Arrange: virtual scheduling runs the existing startup and periodic tick.
	vi.useFakeTimers();
	vi.clearAllMocks();
	const { runSyncPass, shouldSkipOfflinePeer } = await import("./sync-pass.js");
	const { coordinatorEnabled } = await import("./coordinator-runtime.js");
	vi.mocked(shouldSkipOfflinePeer).mockReturnValue(false);
	vi.mocked(coordinatorEnabled).mockReturnValue(false);
	vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue(["local", "public-key"]);
	const maintain = vi.spyOn(reachabilityPass, "maintainSyncReachability").mockResolvedValue();
	const abort = new AbortController();
	const daemon = runSyncDaemon({
		dbPath: ":memory:",
		signal: abort.signal,
		reachability: {
			scopeId: "space",
			logicalOrigin: "https://peer.invalid",
			deadlineMs: performance.now() - 1,
		},
		onAfterCoordinatorRefresh: ({ db }) => {
			db.prepare(
				"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, created_at) VALUES ('peer', 'pin', '2026-01-01')",
			).run();
		},
	});
	try {
		// Act.
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(120_000);
		abort.abort();
		await daemon;
		// Assert.
		expect(maintain).toHaveBeenCalledTimes(2);
		expect(runSyncPass).toHaveBeenCalledTimes(2);
		for (const [, , options] of vi.mocked(runSyncPass).mock.calls)
			expect(options?.reachability?.deadlineMs).toBeUndefined();
	} finally {
		abort.abort();
		await daemon;
		vi.useRealTimers();
		vi.restoreAllMocks();
	}
});

afterEach(() => {
	if (ORIGINAL_KEYS_DIR === undefined) {
		delete process.env.CODEMEM_KEYS_DIR;
	} else {
		process.env.CODEMEM_KEYS_DIR = ORIGINAL_KEYS_DIR;
	}
});

vi.mock("./coordinator-runtime.js", () => ({
	coordinatorEnabled: vi.fn().mockReturnValue(false),
	fetchCoordinatorStalePeers: vi.fn().mockResolvedValue(new Set()),
	readCoordinatorSyncConfig: vi.fn().mockReturnValue({}),
	refreshAuthorizedCoordinatorPeerTrust: vi.fn().mockResolvedValue({ peers: [], trusted: 0 }),
	registerCoordinatorPresence: vi.fn().mockResolvedValue(null),
}));

vi.mock("./scope-membership-cache.js", () => ({
	refreshConfiguredScopeMembershipCache: vi.fn().mockResolvedValue({
		status: "skipped",
		coordinatorId: null,
		groups: [],
	}),
}));

// Mock sync-pass to avoid needing real keys/network
vi.mock("./sync-pass.js", () => ({
	syncPassPreflight: vi.fn(),
	runSyncPass: vi.fn().mockResolvedValue({ ok: true, opsIn: 0, opsOut: 0, addressErrors: [] }),
	shouldSkipOfflinePeer: vi.fn().mockReturnValue(false),
}));

// Mock discovery to avoid env var issues
vi.mock("./sync-discovery.js", () => ({
	mdnsEnabled: vi.fn().mockReturnValue(false),
	discoverPeersViaMdns: vi.fn().mockReturnValue([]),
	advertiseMdns: vi.fn().mockReturnValue({ close: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// syncDaemonTick
// ---------------------------------------------------------------------------

describe("syncDaemonTick", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		vi.clearAllMocks();
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns empty array when no peers exist", async () => {
		const { syncPassPreflight } = await import("./sync-pass.js");
		const results = await syncDaemonTick(db);
		expect(results).toEqual([]);
		expect(syncPassPreflight).not.toHaveBeenCalled();
	});

	it("runs sync for each peer", async () => {
		const { syncPassPreflight } = await import("./sync-pass.js");
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "fp1", now);
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-2", "fp2", now);

		const results = await syncDaemonTick(db);
		expect(results).toHaveLength(2);
		expect(results[0].ok).toBe(true);
		expect(results[1].ok).toBe(true);
		expect(syncPassPreflight).toHaveBeenCalledTimes(1);
	});

	it("skips offline peers in backoff", async () => {
		const { shouldSkipOfflinePeer } = await import("./sync-pass.js");
		vi.mocked(shouldSkipOfflinePeer).mockReturnValue(true);

		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "fp1", now);

		const results = await syncDaemonTick(db);
		expect(results).toHaveLength(1);
		expect(results[0].skipped).toBe(true);
		expect(results[0].reason).toContain("backoff");
	});

	it("skips peers with expired coordinator presence", async () => {
		const { runSyncPass, shouldSkipOfflinePeer } = await import("./sync-pass.js");
		vi.mocked(shouldSkipOfflinePeer).mockReturnValue(false);
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "fp1", now);
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-2", "fp2", now);

		const stalePeers = new Set(["peer-1"]);
		const results = await syncDaemonTick(db, undefined, stalePeers);
		expect(results).toHaveLength(2);
		expect(results[0].skipped).toBe(true);
		expect(results[0].reason).toContain("coordinator presence expired");
		expect(results[1].ok).toBe(true);
		expect(runSyncPass).toHaveBeenCalledTimes(1);
		expect(runSyncPass).toHaveBeenCalledWith(db, "peer-2", expect.anything());
	});

	it("skips only the matching stale pinned coordinator identity", async () => {
		const { runSyncPass, shouldSkipOfflinePeer } = await import("./sync-pass.js");
		vi.mocked(shouldSkipOfflinePeer).mockReturnValue(false);
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "old-fp", now);
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-2", "fp2", now);

		const results = await syncDaemonTick(db, undefined, new Set(["peer-1:old-fp"]));

		expect(results).toHaveLength(2);
		expect(results[0].skipped).toBe(true);
		expect(results[0].reason).toContain("coordinator presence expired");
		expect(results[1].ok).toBe(true);
		expect(runSyncPass).toHaveBeenCalledTimes(1);
		expect(runSyncPass).toHaveBeenCalledWith(db, "peer-2", expect.anything());
	});

	it("syncs all peers when stalePeers set is empty", async () => {
		const { runSyncPass, shouldSkipOfflinePeer } = await import("./sync-pass.js");
		vi.mocked(shouldSkipOfflinePeer).mockReturnValue(false);
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "fp1", now);

		const results = await syncDaemonTick(db, undefined, new Set());
		expect(results).toHaveLength(1);
		expect(results[0].ok).toBe(true);
		expect(runSyncPass).toHaveBeenCalledTimes(1);
	});

	it("threads syncOpsLimit from coordinator config into runSyncPass", async () => {
		const { runSyncPass } = await import("./sync-pass.js");
		const { readCoordinatorSyncConfig } = await import("./coordinator-runtime.js");
		vi.mocked(readCoordinatorSyncConfig).mockReturnValue({
			syncOpsLimit: 750,
		} as unknown as ReturnType<typeof readCoordinatorSyncConfig>);

		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "fp1", now);

		await syncDaemonTick(db, "/tmp/keys");

		expect(runSyncPass).toHaveBeenCalledWith(
			db,
			"peer-1",
			expect.objectContaining({ limit: 750, keysDir: "/tmp/keys" }),
		);
	});

	it("forwards the workspace scanner to runSyncPass so inbound peer apply uses workspace rules", async () => {
		// Wiring regression: without this, the daemon path falls back to the
		// built-in default scanner and the foreground viewer's workspace
		// `secret_scanner` config block is silently skipped on inbound
		// peer payloads. sync-pass.ts:syncOnce emits a one-shot warning
		// "[codemem] sync apply running without explicit scanner" when no
		// scanner is supplied; serve.ts now passes store.scanner through
		// runSyncDaemon → runTickOnce → syncDaemonTick → runSyncPass.
		const { runSyncPass } = await import("./sync-pass.js");
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "fp1", now);

		const fakeScanner = { scan: vi.fn() } as unknown as Parameters<typeof syncDaemonTick>[3];
		await syncDaemonTick(db, "/tmp/keys", new Set(), fakeScanner);

		expect(runSyncPass).toHaveBeenCalledWith(
			db,
			"peer-1",
			expect.objectContaining({ scanner: fakeScanner }),
		);
	});
});

describe("resolveSyncDaemonKeysDir", () => {
	it("falls back to CODEMEM_KEYS_DIR when the caller omits keysDir", () => {
		process.env.CODEMEM_KEYS_DIR = "/container/keys";
		expect(resolveSyncDaemonKeysDir()).toBe("/container/keys");
	});

	it("prefers the explicit daemon keysDir over CODEMEM_KEYS_DIR", () => {
		process.env.CODEMEM_KEYS_DIR = "/container/keys";
		expect(resolveSyncDaemonKeysDir("/explicit/keys")).toBe("/explicit/keys");
	});
});

describe("runSyncDaemon identity recovery", () => {
	it("records identity_error and keeps retrying when restored private keys are missing", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "codemem-sync-daemon-identity-"));
		const dbPath = join(tempDir, "mem.sqlite");
		const keysDir = join(tempDir, "keys");
		const db = connect(dbPath);
		initTestSchema(db);
		ensureDeviceIdentity(db, { keysDir });
		const [privatePath] = resolveKeyPaths(keysDir);
		const privateKey = readFileSync(privatePath);
		rmSync(privatePath);
		db.close();

		const abort = new AbortController();
		const daemon = runSyncDaemon({ dbPath, keysDir, intervalS: 0.01, signal: abort.signal });
		try {
			await vi.waitFor(() => {
				const stateDb = connect(dbPath);
				try {
					expect(getSyncDaemonPhase(stateDb)).toBe("identity_error");
					expect(
						stateDb.prepare("SELECT last_error FROM sync_daemon_state WHERE id = 1").pluck().get(),
					).toContain("device_identity_private_key_missing");
				} finally {
					stateDb.close();
				}
			});

			writeFileSync(privatePath, privateKey, { mode: 0o600 });
			await vi.waitFor(() => {
				const stateDb = connect(dbPath);
				try {
					expect(getSyncDaemonPhase(stateDb)).toBeNull();
				} finally {
					stateDb.close();
				}
			});
		} finally {
			abort.abort();
			await daemon;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("records identity_error and recovers when device.key cannot be read", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "codemem-sync-daemon-unreadable-identity-"));
		const dbPath = join(tempDir, "mem.sqlite");
		const keysDir = join(tempDir, "keys");
		const db = connect(dbPath);
		initTestSchema(db);
		ensureDeviceIdentity(db, { keysDir });
		const [privatePath] = resolveKeyPaths(keysDir);
		const privateKey = readFileSync(privatePath);
		rmSync(privatePath);
		mkdirSync(privatePath);
		db.close();

		const abort = new AbortController();
		const daemon = runSyncDaemon({ dbPath, keysDir, intervalS: 0.01, signal: abort.signal });
		try {
			await vi.waitFor(() => {
				const stateDb = connect(dbPath);
				try {
					expect(getSyncDaemonPhase(stateDb)).toBe("identity_error");
					expect(
						stateDb.prepare("SELECT last_error FROM sync_daemon_state WHERE id = 1").pluck().get(),
					).toContain("device_identity_private_key_invalid");
				} finally {
					stateDb.close();
				}
			});

			rmSync(privatePath, { recursive: true });
			writeFileSync(privatePath, privateKey, { mode: 0o600 });
			await vi.waitFor(() => {
				const stateDb = connect(dbPath);
				try {
					expect(getSyncDaemonPhase(stateDb)).toBeNull();
				} finally {
					stateDb.close();
				}
			});
		} finally {
			abort.abort();
			await daemon;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("refreshCoordinatorPresenceForDaemon", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		vi.clearAllMocks();
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("does nothing when coordinator sync is not configured", async () => {
		const { coordinatorEnabled, registerCoordinatorPresence } = await import(
			"./coordinator-runtime.js"
		);
		const { refreshConfiguredScopeMembershipCache } = await import("./scope-membership-cache.js");
		vi.mocked(coordinatorEnabled).mockReturnValue(false);

		expect(await refreshCoordinatorPresenceForDaemon(db, ":memory:")).toBe(false);
		expect(registerCoordinatorPresence).not.toHaveBeenCalled();
		expect(refreshConfiguredScopeMembershipCache).not.toHaveBeenCalled();
	});

	it("returns the peer snapshot so the tick does not look peers up twice", async () => {
		const { coordinatorEnabled, readCoordinatorSyncConfig, refreshAuthorizedCoordinatorPeerTrust } =
			await import("./coordinator-runtime.js");
		const peers = [{ device_id: "peer-1", fingerprint: "fp-1", stale: false }];
		vi.mocked(coordinatorEnabled).mockReturnValue(true);
		vi.mocked(readCoordinatorSyncConfig).mockReturnValue({
			syncCoordinatorUrl: "http://coord",
			syncCoordinatorGroups: ["team"],
		} as never);
		vi.mocked(refreshAuthorizedCoordinatorPeerTrust).mockResolvedValue({ peers, trusted: 1 });

		expect(await refreshCoordinatorForDaemon(db, ":memory:", "/tmp/keys")).toEqual({
			refreshed: true,
			peers,
		});
		expect(refreshAuthorizedCoordinatorPeerTrust).toHaveBeenCalledTimes(1);
	});

	it("reports no peer snapshot when the coordinator is not configured", async () => {
		const { coordinatorEnabled } = await import("./coordinator-runtime.js");
		vi.mocked(coordinatorEnabled).mockReturnValue(false);

		expect(await refreshCoordinatorForDaemon(db, ":memory:")).toEqual({
			refreshed: false,
			peers: null,
		});
	});

	it("posts coordinator presence and refreshes scope membership cache when enabled", async () => {
		const {
			coordinatorEnabled,
			readCoordinatorSyncConfig,
			refreshAuthorizedCoordinatorPeerTrust,
			registerCoordinatorPresence,
		} = await import("./coordinator-runtime.js");
		const { refreshConfiguredScopeMembershipCache } = await import("./scope-membership-cache.js");
		vi.mocked(coordinatorEnabled).mockReturnValue(true);
		vi.mocked(readCoordinatorSyncConfig).mockReturnValue({
			syncCoordinatorUrl: "http://coord",
			syncCoordinatorGroups: ["team"],
			syncCoordinatorAdminSecret: "secret",
		} as never);

		expect(await refreshCoordinatorPresenceForDaemon(db, ":memory:", "/tmp/keys")).toBe(true);
		expect(registerCoordinatorPresence).toHaveBeenCalledWith(
			{ db, dbPath: ":memory:" },
			expect.objectContaining({
				syncCoordinatorUrl: "http://coord",
				syncCoordinatorGroups: ["team"],
			}),
			{ keysDir: "/tmp/keys" },
		);
		expect(refreshConfiguredScopeMembershipCache).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				syncCoordinatorUrl: "http://coord",
				syncCoordinatorGroups: ["team"],
				syncCoordinatorAdminSecret: "secret",
			}),
			{ keysDir: "/tmp/keys", dbPath: ":memory:" },
		);
		expect(refreshAuthorizedCoordinatorPeerTrust).toHaveBeenCalledWith(
			{ db, dbPath: ":memory:" },
			expect.objectContaining({
				syncCoordinatorUrl: "http://coord",
				syncCoordinatorGroups: ["team"],
			}),
			{ keysDir: "/tmp/keys" },
		);
	});

	it("does not refresh authorized peer trust when membership refresh fails", async () => {
		const { coordinatorEnabled, refreshAuthorizedCoordinatorPeerTrust } = await import(
			"./coordinator-runtime.js"
		);
		const { refreshConfiguredScopeMembershipCache } = await import("./scope-membership-cache.js");
		vi.mocked(coordinatorEnabled).mockReturnValue(true);
		vi.mocked(refreshConfiguredScopeMembershipCache).mockRejectedValueOnce(
			new Error("membership refresh failed"),
		);

		await expect(refreshCoordinatorPresenceForDaemon(db, ":memory:")).rejects.toThrow(
			"membership refresh failed",
		);
		expect(refreshAuthorizedCoordinatorPeerTrust).not.toHaveBeenCalled();
	});

	it("keeps direct peer sync running when coordinator heartbeat fails", async () => {
		const { coordinatorEnabled, readCoordinatorSyncConfig, registerCoordinatorPresence } =
			await import("./coordinator-runtime.js");
		const { syncPassPreflight } = await import("./sync-pass.js");
		vi.mocked(coordinatorEnabled).mockReturnValue(true);
		vi.mocked(readCoordinatorSyncConfig).mockReturnValue({
			syncCoordinatorUrl: "http://coord",
			syncCoordinatorGroups: ["team"],
		} as never);
		vi.mocked(registerCoordinatorPresence).mockRejectedValue(new Error("coordinator timeout"));

		const dbPath = join(tmpdir(), `codemem-sync-daemon-${Date.now()}.sqlite`);
		const fileDb = new Database(dbPath);
		try {
			initTestSchema(fileDb);
			fileDb
				.prepare(
					"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
				)
				.run("peer-1", "fp1", new Date().toISOString());

			await runTickOnce(dbPath);
			expect(syncPassPreflight).toHaveBeenCalledTimes(1);
		} finally {
			fileDb.close();
			rmSync(dbPath, { force: true });
		}
	});

	it("threads CODEMEM_KEYS_DIR through one-off ticks when keysDir is omitted", async () => {
		const { runSyncPass } = await import("./sync-pass.js");
		const tempDir = mkdtempSync(join(tmpdir(), "codemem-sync-daemon-env-keys-"));
		const keysDir = join(tempDir, "keys");
		process.env.CODEMEM_KEYS_DIR = keysDir;
		const dbPath = join(tmpdir(), `codemem-sync-daemon-env-keys-${Date.now()}.sqlite`);
		const fileDb = new Database(dbPath);
		try {
			initTestSchema(fileDb);
			fileDb
				.prepare(
					"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
				)
				.run("peer-1", "fp1", new Date().toISOString());

			await runTickOnce(dbPath);
			expect(runSyncPass).toHaveBeenCalledWith(
				expect.any(Database),
				"peer-1",
				expect.objectContaining({ keysDir, dbPath }),
			);
		} finally {
			fileDb.close();
			rmSync(dbPath, { force: true });
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("applies additive schema compatibility before daemon tick state writes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "codemem-sync-daemon-legacy-"));
		const dbPath = join(tempDir, "mem.sqlite");
		const keysDir = join(tempDir, "keys");
		const fileDb = new Database(dbPath);
		try {
			fileDb.exec(`
				CREATE TABLE sync_peers (
					peer_device_id TEXT PRIMARY KEY,
					created_at TEXT NOT NULL
				);
				CREATE TABLE sync_daemon_state (
					id INTEGER PRIMARY KEY,
					last_error TEXT,
					last_traceback TEXT,
					last_error_at TEXT,
					last_ok_at TEXT
				);
				CREATE TABLE sync_attempts (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					peer_device_id TEXT NOT NULL,
					started_at TEXT NOT NULL,
					finished_at TEXT,
					ok INTEGER NOT NULL DEFAULT 0,
					ops_in INTEGER NOT NULL DEFAULT 0,
					ops_out INTEGER NOT NULL DEFAULT 0,
					error TEXT
				);
				CREATE TABLE sync_device (
					device_id TEXT PRIMARY KEY,
					public_key TEXT NOT NULL,
					fingerprint TEXT NOT NULL,
					created_at TEXT NOT NULL
				);
			`);
			ensureDeviceIdentity(fileDb, { keysDir });
			expect(columnExists(fileDb, "sync_daemon_state", "phase")).toBe(false);
			expect(columnExists(fileDb, "sync_attempts", "local_sync_capability")).toBe(false);
		} finally {
			fileDb.close();
		}

		await runTickOnce(dbPath, keysDir);

		const verified = new Database(dbPath);
		try {
			expect(columnExists(verified, "sync_daemon_state", "phase")).toBe(true);
			expect(columnExists(verified, "sync_attempts", "local_sync_capability")).toBe(true);
			expect(columnExists(verified, "sync_attempts", "peer_sync_capability")).toBe(true);
			expect(columnExists(verified, "sync_attempts", "negotiated_sync_capability")).toBe(true);
			const row = verified
				.prepare("SELECT last_ok_at, phase FROM sync_daemon_state WHERE id = 1")
				.get() as { last_ok_at: string | null; phase: string | null } | undefined;
			expect(row?.last_ok_at).toBeTruthy();
			expect(row?.phase).toBeNull();
		} finally {
			verified.close();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("runs tick maintenance after coordinator refresh and before peer sync", async () => {
		const {
			coordinatorEnabled,
			fetchCoordinatorStalePeers,
			refreshAuthorizedCoordinatorPeerTrust,
			registerCoordinatorPresence,
		} = await import("./coordinator-runtime.js");
		const { refreshConfiguredScopeMembershipCache } = await import("./scope-membership-cache.js");
		const { runSyncPass } = await import("./sync-pass.js");
		const order: string[] = [];
		vi.mocked(coordinatorEnabled).mockReturnValue(true);
		vi.mocked(registerCoordinatorPresence).mockImplementation(async () => {
			order.push("presence");
			return null;
		});
		vi.mocked(refreshConfiguredScopeMembershipCache).mockImplementation(async () => {
			order.push("membership");
			return { status: "skipped", coordinatorId: null, groups: [] } as never;
		});
		vi.mocked(refreshAuthorizedCoordinatorPeerTrust).mockImplementation(async () => {
			order.push("trust");
			return { peers: [], trusted: 0 };
		});
		vi.mocked(fetchCoordinatorStalePeers).mockImplementation(async () => {
			order.push("stale-peers");
			return new Set();
		});
		vi.mocked(runSyncPass).mockImplementation(async () => {
			order.push("peer-sync");
			return { ok: true, opsIn: 0, opsOut: 0, addressErrors: [] } as never;
		});
		const dbPath = join(tmpdir(), `codemem-sync-daemon-callback-order-${Date.now()}.sqlite`);
		const fileDb = new Database(dbPath);
		try {
			initTestSchema(fileDb);
			fileDb
				.prepare(
					"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
				)
				.run("peer-1", "fp1", new Date().toISOString());
		} finally {
			fileDb.close();
		}

		try {
			await runTickOnce(dbPath, undefined, undefined, () => {
				order.push("maintenance");
			});
			expect(order).toEqual([
				"presence",
				"membership",
				"trust",
				"maintenance",
				"stale-peers",
				"peer-sync",
			]);
		} finally {
			rmSync(dbPath, { force: true });
		}
	});

	it("records maintenance failure and continues normal peer sync", async () => {
		const { coordinatorEnabled } = await import("./coordinator-runtime.js");
		const { runSyncPass } = await import("./sync-pass.js");
		vi.mocked(coordinatorEnabled).mockReturnValue(false);
		vi.mocked(runSyncPass).mockResolvedValue({
			ok: true,
			opsIn: 0,
			opsOut: 0,
			addressErrors: [],
		} as never);
		const dbPath = join(tmpdir(), `codemem-sync-daemon-callback-error-${Date.now()}.sqlite`);
		const fileDb = new Database(dbPath);
		try {
			initTestSchema(fileDb);
			fileDb
				.prepare(
					"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
				)
				.run("peer-1", "fp1", new Date().toISOString());
		} finally {
			fileDb.close();
		}

		try {
			await runTickOnce(dbPath, undefined, undefined, () => {
				throw new Error("share maintenance unavailable");
			});
			expect(runSyncPass).toHaveBeenCalled();
			const verified = new Database(dbPath);
			try {
				const state = verified
					.prepare(
						"SELECT last_error, last_error_at, last_ok_at FROM sync_daemon_state WHERE id = 1",
					)
					.get() as { last_error: string; last_error_at: string; last_ok_at: string | null };
				expect(state.last_error).toContain(
					"daemon tick callback failed: share maintenance unavailable",
				);
				expect(state.last_error_at).toBeTruthy();
				expect(state.last_ok_at).toBeNull();
			} finally {
				verified.close();
			}
		} finally {
			rmSync(dbPath, { force: true });
		}
	});
});

describe("createSerializedDaemonTickRunner", () => {
	it("does not overlap maintenance callbacks across serialized ticks", async () => {
		let finishFirst!: () => void;
		const first = new Promise<void>((resolve) => {
			finishFirst = resolve;
		});
		const tick = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
		const firstCompleted = vi.fn();
		const run = createSerializedDaemonTickRunner(tick, firstCompleted);

		expect(run()).toBe(true);
		expect(run()).toBe(false);
		expect(tick).toHaveBeenCalledTimes(1);
		finishFirst();
		await first;
		await Promise.resolve();
		expect(firstCompleted).toHaveBeenCalledTimes(1);
		expect(run()).toBe(true);
		expect(tick).toHaveBeenCalledTimes(2);
	});

	it("consumes a rejected tick and permits the next scheduled tick", async () => {
		const failure = new Error("database connection failed before tick setup");
		const tick = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
		const firstCompleted = vi.fn();
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const run = createSerializedDaemonTickRunner(tick, firstCompleted);

		try {
			expect(run()).toBe(true);
			await vi.waitFor(() => expect(firstCompleted).toHaveBeenCalledOnce());
			await vi.waitFor(() =>
				expect(errorLog).toHaveBeenCalledWith(
					"[codemem] scheduled sync daemon tick failed:",
					failure,
				),
			);

			expect(run()).toBe(true);
			await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(2));
		} finally {
			errorLog.mockRestore();
		}
	});

	it("contains a locked diagnostic write and recovers on a later tick", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "codemem-sync-daemon-locked-diagnostic-"));
		const dbPath = join(tempDir, "mem.sqlite");
		const keysDir = join(tempDir, "keys");
		const setupDb = new Database(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		const lockDb = new Database(dbPath);
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (error: unknown) => unhandledRejections.push(error);
		process.on("unhandledRejection", onUnhandledRejection);
		let lockOnCallback = true;
		const firstCompleted = vi.fn();
		const tick = vi.fn(() =>
			runTickOnce(dbPath, keysDir, undefined, ({ db }) => {
				if (!lockOnCallback) return;
				lockOnCallback = false;
				db.pragma("busy_timeout = 1");
				lockDb.exec("BEGIN EXCLUSIVE");
				throw new Error("maintenance callback failed while database is locked");
			}),
		);
		const run = createSerializedDaemonTickRunner(tick, firstCompleted);

		try {
			expect(run()).toBe(true);
			await vi.waitFor(() => expect(firstCompleted).toHaveBeenCalledOnce());
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandledRejections).toEqual([]);
			expect(errorLog).toHaveBeenCalledWith(
				expect.stringContaining("could not persist its diagnostic"),
				expect.any(Error),
				expect.objectContaining({ code: "SQLITE_BUSY" }),
			);

			lockDb.exec("ROLLBACK");
			expect(run()).toBe(true);
			await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(2));
			await vi.waitFor(() => {
				const verified = new Database(dbPath);
				try {
					const lastOkAt = verified
						.prepare("SELECT last_ok_at FROM sync_daemon_state WHERE id = 1")
						.pluck()
						.get();
					expect(lastOkAt).toBeTruthy();
				} finally {
					verified.close();
				}
			});
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
			if (lockDb.inTransaction) lockDb.exec("ROLLBACK");
			lockDb.close();
			errorLog.mockRestore();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Daemon state helpers
// ---------------------------------------------------------------------------

describe("setSyncDaemonOk", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("inserts daemon ok state", () => {
		setSyncDaemonOk(db);
		const row = db.prepare("SELECT * FROM sync_daemon_state WHERE id = 1").get() as Record<
			string,
			unknown
		>;
		expect(row).toBeTruthy();
		expect(row.last_ok_at).toBeTruthy();
	});

	it("updates daemon ok state on subsequent calls", () => {
		setSyncDaemonOk(db);
		const first = (
			db.prepare("SELECT last_ok_at FROM sync_daemon_state WHERE id = 1").get() as Record<
				string,
				unknown
			>
		).last_ok_at;

		// Small delay to ensure different timestamp
		setSyncDaemonOk(db);
		const second = (
			db.prepare("SELECT last_ok_at FROM sync_daemon_state WHERE id = 1").get() as Record<
				string,
				unknown
			>
		).last_ok_at;

		// Both should be valid ISO timestamps
		expect(typeof first).toBe("string");
		expect(typeof second).toBe("string");
	});
});

describe("setSyncDaemonError", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("records error and traceback", () => {
		setSyncDaemonError(db, "something broke", "Error: something broke\n    at foo.ts:1");
		const row = db.prepare("SELECT * FROM sync_daemon_state WHERE id = 1").get() as Record<
			string,
			unknown
		>;
		expect(row.last_error).toBe("something broke");
		expect(row.last_traceback).toContain("foo.ts");
		expect(row.last_error_at).toBeTruthy();
	});

	it("upserts on subsequent errors", () => {
		setSyncDaemonError(db, "first error");
		setSyncDaemonError(db, "second error");
		const row = db.prepare("SELECT * FROM sync_daemon_state WHERE id = 1").get() as Record<
			string,
			unknown
		>;
		expect(row.last_error).toBe("second error");

		// Should only have 1 row
		const count = db.prepare("SELECT COUNT(*) as n FROM sync_daemon_state").get() as { n: number };
		expect(count.n).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Sync daemon phase (rebootstrap safety gate)
// ---------------------------------------------------------------------------

describe("getSyncDaemonPhase / setSyncDaemonPhase", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns null when no phase is set", () => {
		expect(getSyncDaemonPhase(db)).toBeNull();
	});

	it("returns null when daemon state row exists but phase is null", () => {
		setSyncDaemonOk(db);
		expect(getSyncDaemonPhase(db)).toBeNull();
	});

	it("persists and retrieves needs_attention phase", () => {
		setSyncDaemonPhase(db, "needs_attention");
		expect(getSyncDaemonPhase(db)).toBe("needs_attention");
	});

	it("persists and retrieves identity_error phase", () => {
		setSyncDaemonPhase(db, "identity_error");
		expect(getSyncDaemonPhase(db)).toBe("identity_error");
	});

	it("clears phase when set to null", () => {
		setSyncDaemonPhase(db, "needs_attention");
		setSyncDaemonPhase(db, null);
		expect(getSyncDaemonPhase(db)).toBeNull();
	});

	it("setSyncDaemonOk clears an active phase", () => {
		setSyncDaemonPhase(db, "needs_attention");
		setSyncDaemonOk(db);
		expect(getSyncDaemonPhase(db)).toBeNull();
	});
});
