import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { columnExists } from "./db.js";
import {
	createSerializedDaemonTickRunner,
	getSyncDaemonPhase,
	refreshCoordinatorPresenceForDaemon,
	resolveSyncDaemonKeysDir,
	runTickOnce,
	setSyncDaemonError,
	setSyncDaemonOk,
	setSyncDaemonPhase,
	syncDaemonTick,
} from "./sync-daemon.js";

import { initTestSchema } from "./test-utils.js";

const ORIGINAL_KEYS_DIR = process.env.CODEMEM_KEYS_DIR;

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

	it("posts coordinator presence and refreshes scope membership cache when enabled", async () => {
		const { coordinatorEnabled, readCoordinatorSyncConfig, registerCoordinatorPresence } =
			await import("./coordinator-runtime.js");
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
			{ keysDir: "/tmp/keys" },
		);
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
		process.env.CODEMEM_KEYS_DIR = "/container/keys";
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
				expect.objectContaining({ keysDir: "/container/keys" }),
			);
		} finally {
			fileDb.close();
			rmSync(dbPath, { force: true });
		}
	});

	it("applies additive schema compatibility before daemon tick state writes", async () => {
		const dbPath = join(tmpdir(), `codemem-sync-daemon-legacy-${Date.now()}.sqlite`);
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
			`);
			expect(columnExists(fileDb, "sync_daemon_state", "phase")).toBe(false);
			expect(columnExists(fileDb, "sync_attempts", "local_sync_capability")).toBe(false);
		} finally {
			fileDb.close();
		}

		await runTickOnce(dbPath);

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
			rmSync(dbPath, { force: true });
		}
	});

	it("runs tick maintenance after coordinator refresh and before peer sync", async () => {
		const { coordinatorEnabled, fetchCoordinatorStalePeers, registerCoordinatorPresence } =
			await import("./coordinator-runtime.js");
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
			expect(order).toEqual(["presence", "membership", "maintenance", "stale-peers", "peer-sync"]);
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
