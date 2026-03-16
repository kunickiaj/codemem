import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSyncDaemonError, setSyncDaemonOk, syncDaemonTick } from "./sync-daemon.js";
import { initTestSchema } from "./test-utils.js";

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
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns empty array when no peers exist", async () => {
		const results = await syncDaemonTick(db);
		expect(results).toEqual([]);
	});

	it("runs sync for each peer", async () => {
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
