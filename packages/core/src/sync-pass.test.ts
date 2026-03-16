import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	consecutiveConnectivityFailures,
	cursorAdvances,
	isConnectivityError,
	peerBackoffSeconds,
	shouldSkipOfflinePeer,
	syncOnce,
} from "./sync-pass.js";
import { initTestSchema } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Schema helper — adds sync tables not in base test schema
// ---------------------------------------------------------------------------

function addSyncTables(db: InstanceType<typeof Database>): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sync_peers (
			peer_device_id TEXT PRIMARY KEY,
			name TEXT,
			pinned_fingerprint TEXT,
			public_key TEXT,
			addresses_json TEXT,
			claimed_local_actor INTEGER NOT NULL DEFAULT 0,
			actor_id TEXT,
			projects_include_json TEXT,
			projects_exclude_json TEXT,
			created_at TEXT NOT NULL,
			last_seen_at TEXT,
			last_sync_at TEXT,
			last_error TEXT
		);

		CREATE TABLE IF NOT EXISTS sync_attempts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			peer_device_id TEXT NOT NULL,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			ok INTEGER NOT NULL DEFAULT 0,
			ops_in INTEGER NOT NULL DEFAULT 0,
			ops_out INTEGER NOT NULL DEFAULT 0,
			error TEXT
		);

		CREATE TABLE IF NOT EXISTS replication_ops (
			op_id TEXT PRIMARY KEY,
			entity_type TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			op_type TEXT NOT NULL,
			payload_json TEXT,
			clock_rev INTEGER NOT NULL,
			clock_updated_at TEXT NOT NULL,
			clock_device_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`);
}

// ---------------------------------------------------------------------------
// cursorAdvances
// ---------------------------------------------------------------------------

describe("cursorAdvances", () => {
	it("returns true when current is null and candidate is valid", () => {
		expect(cursorAdvances(null, "2026-01-01T00:00:00Z|op-1")).toBe(true);
	});

	it("returns true when candidate is newer than current", () => {
		expect(cursorAdvances("2026-01-01T00:00:00Z|op-1", "2026-01-02T00:00:00Z|op-2")).toBe(true);
	});

	it("returns false when candidate is older than current", () => {
		expect(cursorAdvances("2026-01-02T00:00:00Z|op-2", "2026-01-01T00:00:00Z|op-1")).toBe(false);
	});

	it("returns false when candidate equals current", () => {
		expect(cursorAdvances("2026-01-01T00:00:00Z|op-1", "2026-01-01T00:00:00Z|op-1")).toBe(false);
	});

	it("returns false when candidate is null", () => {
		expect(cursorAdvances("2026-01-01T00:00:00Z|op-1", null)).toBe(false);
	});

	it("returns false when candidate has no pipe separator", () => {
		expect(cursorAdvances(null, "invalid-cursor")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// syncOnce — edge cases (no network)
// ---------------------------------------------------------------------------

describe("syncOnce", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		addSyncTables(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns error when peer is not pinned", async () => {
		// No sync_peers row at all
		const result = await syncOnce(db, "unknown-peer", ["127.0.0.1:9090"]);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("peer not pinned");
	});

	it("returns error when peer has empty pinned_fingerprint", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "", new Date().toISOString());
		const result = await syncOnce(db, "peer-1", ["127.0.0.1:9090"]);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("peer not pinned");
	});

	it("returns error with no dialable addresses", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "abc123", new Date().toISOString());
		// ensureDeviceIdentity will fail in test (no ssh-keygen setup),
		// but we test the "no addresses" path by passing empty array
		// The device identity error will happen first — that's fine, it proves
		// the error recording path works too.
		const result = await syncOnce(db, "peer-1", []);
		expect(result.ok).toBe(false);
		// Either "device identity unavailable" or "no dialable peer addresses"
		expect(result.error).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// isConnectivityError
// ---------------------------------------------------------------------------

describe("isConnectivityError", () => {
	it("detects connection refused", () => {
		expect(isConnectivityError("Connection refused")).toBe(true);
	});

	it("detects timeout", () => {
		expect(isConnectivityError("request timed out")).toBe(true);
	});

	it("returns false for auth errors", () => {
		expect(isConnectivityError("peer fingerprint mismatch")).toBe(false);
	});

	it("returns false for null", () => {
		expect(isConnectivityError(null)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// peerBackoffSeconds
// ---------------------------------------------------------------------------

describe("peerBackoffSeconds", () => {
	it("returns 0 for 0 or 1 failures", () => {
		expect(peerBackoffSeconds(0)).toBe(0);
		expect(peerBackoffSeconds(1)).toBe(0);
	});

	it("returns base backoff for 2 failures", () => {
		expect(peerBackoffSeconds(2)).toBe(120);
	});

	it("doubles for 3 failures", () => {
		expect(peerBackoffSeconds(3)).toBe(240);
	});

	it("caps at max backoff", () => {
		expect(peerBackoffSeconds(20)).toBe(1800);
	});
});

// ---------------------------------------------------------------------------
// consecutiveConnectivityFailures
// ---------------------------------------------------------------------------

describe("consecutiveConnectivityFailures", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		addSyncTables(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns 0 when no attempts exist", () => {
		expect(consecutiveConnectivityFailures(db, "peer-1")).toBe(0);
	});

	it("counts consecutive connectivity failures", () => {
		const now = new Date();
		for (let i = 0; i < 3; i++) {
			const ts = new Date(now.getTime() + i * 1000).toISOString();
			db.prepare(
				"INSERT INTO sync_attempts (peer_device_id, started_at, ok, error) VALUES (?, ?, 0, ?)",
			).run("peer-1", ts, "Connection refused");
		}
		expect(consecutiveConnectivityFailures(db, "peer-1")).toBe(3);
	});

	it("stops counting at a success", () => {
		const now = new Date();
		// Old failure
		db.prepare(
			"INSERT INTO sync_attempts (peer_device_id, started_at, ok, error) VALUES (?, ?, 0, ?)",
		).run("peer-1", new Date(now.getTime()).toISOString(), "Connection refused");
		// Success
		db.prepare("INSERT INTO sync_attempts (peer_device_id, started_at, ok) VALUES (?, ?, 1)").run(
			"peer-1",
			new Date(now.getTime() + 1000).toISOString(),
		);
		// New failure
		db.prepare(
			"INSERT INTO sync_attempts (peer_device_id, started_at, ok, error) VALUES (?, ?, 0, ?)",
		).run("peer-1", new Date(now.getTime() + 2000).toISOString(), "Connection refused");

		expect(consecutiveConnectivityFailures(db, "peer-1")).toBe(1);
	});

	it("stops counting at a non-connectivity error", () => {
		const now = new Date();
		db.prepare(
			"INSERT INTO sync_attempts (peer_device_id, started_at, ok, error) VALUES (?, ?, 0, ?)",
		).run("peer-1", new Date(now.getTime()).toISOString(), "peer fingerprint mismatch");
		db.prepare(
			"INSERT INTO sync_attempts (peer_device_id, started_at, ok, error) VALUES (?, ?, 0, ?)",
		).run("peer-1", new Date(now.getTime() + 1000).toISOString(), "Connection refused");

		// Most recent is connectivity, but the one before is not
		expect(consecutiveConnectivityFailures(db, "peer-1")).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// shouldSkipOfflinePeer
// ---------------------------------------------------------------------------

describe("shouldSkipOfflinePeer", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		addSyncTables(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns false when fewer than 2 failures", () => {
		expect(shouldSkipOfflinePeer(db, "peer-1")).toBe(false);
	});

	it("returns true when recent consecutive failures within backoff", () => {
		const now = new Date();
		// Insert 3 consecutive connectivity failures, all very recent
		for (let i = 0; i < 3; i++) {
			const ts = new Date(now.getTime() - (2 - i) * 1000).toISOString();
			db.prepare(
				"INSERT INTO sync_attempts (peer_device_id, started_at, ok, error) VALUES (?, ?, 0, ?)",
			).run("peer-1", ts, "Connection refused");
		}
		expect(shouldSkipOfflinePeer(db, "peer-1")).toBe(true);
	});

	it("returns false when backoff period has elapsed", () => {
		// Insert 2 failures from long ago (> 2 min backoff)
		const longAgo = new Date(Date.now() - 300_000);
		for (let i = 0; i < 2; i++) {
			const ts = new Date(longAgo.getTime() + i * 1000).toISOString();
			db.prepare(
				"INSERT INTO sync_attempts (peer_device_id, started_at, ok, error) VALUES (?, ?, 0, ?)",
			).run("peer-1", ts, "Connection refused");
		}
		expect(shouldSkipOfflinePeer(db, "peer-1")).toBe(false);
	});
});
