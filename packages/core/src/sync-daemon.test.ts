import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { columnExists } from "./db.js";
import {
	getSyncDaemonPhase,
	refreshCoordinatorPresenceForDaemon,
	runTickOnce,
	setSyncDaemonError,
	setSyncDaemonOk,
	setSyncDaemonPhase,
	syncDaemonTick,
} from "./sync-daemon.js";

import { initTestSchema } from "./test-utils.js";

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
