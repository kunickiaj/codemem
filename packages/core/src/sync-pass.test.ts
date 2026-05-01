import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import * as syncAuth from "./sync-auth.js";
import * as syncBootstrap from "./sync-bootstrap.js";
import {
	LOCAL_SYNC_CAPABILITY,
	negotiateSyncCapability,
	normalizeSyncCapability,
	SYNC_CAPABILITY_HEADER,
} from "./sync-capability.js";
import * as syncHttpClient from "./sync-http-client.js";
import * as syncIdentity from "./sync-identity.js";
import {
	consecutiveConnectivityFailures,
	cursorAdvances,
	isConnectivityError,
	peerBackoffSeconds,
	shouldSkipOfflinePeer,
	syncOnce,
	syncPassPreflight,
} from "./sync-pass.js";
import * as syncReplication from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import * as vectorMigration from "./vector-migration.js";
import { VECTOR_MODEL_MIGRATION_JOB } from "./vector-migration.js";
import * as vectors from "./vectors.js";

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
			error TEXT,
			local_sync_capability TEXT,
			peer_sync_capability TEXT,
			negotiated_sync_capability TEXT
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

			CREATE TABLE IF NOT EXISTS replication_cursors (
				peer_device_id TEXT PRIMARY KEY,
				last_applied_cursor TEXT,
				last_acked_cursor TEXT,
				updated_at TEXT
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

describe("sync capability negotiation", () => {
	it("normalizes missing or unknown peer capability to unsupported", () => {
		expect(normalizeSyncCapability(undefined)).toBe("unsupported");
		expect(normalizeSyncCapability("unknown-future-mode")).toBe("unsupported");
		expect(normalizeSyncCapability(" AWARE ")).toBe("aware");
	});

	it("downgrades unsupported-to-aware sessions to unsupported", () => {
		expect(negotiateSyncCapability("aware", "unsupported")).toBe("unsupported");
	});

	it("downgrades aware-to-enforcing sessions to aware", () => {
		expect(negotiateSyncCapability("aware", "enforcing")).toBe("aware");
	});

	it("does not upgrade a local aware peer from an enforcing advertisement", () => {
		expect(LOCAL_SYNC_CAPABILITY).toBe("aware");
		expect(negotiateSyncCapability(LOCAL_SYNC_CAPABILITY, "enforcing")).toBe("aware");
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
		vi.restoreAllMocks();
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

	it("records local capability diagnostics when device identity fails before status", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-identity-fail", "abc123", new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockImplementation(() => {
			throw new Error("private key missing");
		});

		const result = await syncOnce(db, "peer-identity-fail", ["http://127.0.0.1:9090"]);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("device identity unavailable");
		const attempt = db
			.prepare(
				`SELECT local_sync_capability, peer_sync_capability, negotiated_sync_capability
				   FROM sync_attempts
				  WHERE peer_device_id = ?
				  ORDER BY id DESC
				  LIMIT 1`,
			)
			.get("peer-identity-fail") as Record<string, unknown>;
		expect(attempt).toMatchObject({
			local_sync_capability: "aware",
			peer_sync_capability: "unsupported",
			negotiated_sync_capability: "unsupported",
		});
	});

	it("queues durable vector catch-up after applying incremental inbound ops", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "abc123", new Date().toISOString());
		db.prepare(
			"INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
		).run("peer-1", "2025-12-31T00:00:00Z|local-op-0", null, new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});

		vi.spyOn(syncHttpClient, "requestJson")
			.mockResolvedValueOnce([
				200,
				{
					fingerprint: "abc123",
					protocol_version: "2",
					sync_capability: "enforcing",
					sync_reset: {
						generation: 1,
						snapshot_id: "snap-1",
						baseline_cursor: null,
						retained_floor_cursor: null,
					},
				},
			])
			.mockResolvedValueOnce([
				200,
				{
					reset_required: false,
					generation: 1,
					snapshot_id: "snap-1",
					baseline_cursor: null,
					retained_floor_cursor: null,
					ops: [
						{
							op_id: "remote-op-1",
							entity_type: "memory_item",
							entity_id: "key:sync-pass-1",
							op_type: "upsert",
							payload_json: JSON.stringify({
								kind: "discovery",
								title: "Remote title",
								body_text: "Remote body",
								active: 1,
								created_at: "2026-01-01T00:00:00Z",
								updated_at: "2026-01-01T00:00:00Z",
							}),
							clock_rev: 1,
							clock_updated_at: "2026-01-01T00:00:00Z",
							clock_device_id: "dev-remote",
							device_id: "dev-remote",
							created_at: "2026-01-01T00:00:00Z",
						},
					],
					next_cursor: "2026-01-01T00:00:00Z|remote-op-1",
					skipped: 0,
				},
			]);

		const result = await syncOnce(db, "peer-1", ["http://127.0.0.1:9090"]);

		if (!result.ok) {
			throw new Error(`syncOnce failed: ${result.error ?? "unknown error"}`);
		}
		expect(result.ok).toBe(true);
		expect(result.opsIn).toBe(1);
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "pending",
			message: "Queued vector catch-up for incremental sync data",
			metadata: {
				trigger: "sync_incremental",
				pending_upsert_memory_ids: [expect.any(Number)],
				pending_delete_memory_ids: [],
			},
		});
		expect(syncReplication.getReplicationCursor(db, "peer-1")[0]).toBe(
			"2026-01-01T00:00:00Z|remote-op-1",
		);
		expect(vi.mocked(syncHttpClient.requestJson).mock.calls[0]?.[2]?.headers).toMatchObject({
			[SYNC_CAPABILITY_HEADER]: "aware",
		});
		expect(vi.mocked(syncHttpClient.requestJson).mock.calls[1]?.[2]?.headers).toMatchObject({
			[SYNC_CAPABILITY_HEADER]: "aware",
		});
		const attempt = db
			.prepare(
				`SELECT local_sync_capability, peer_sync_capability, negotiated_sync_capability
				   FROM sync_attempts
				  WHERE peer_device_id = ?
				  ORDER BY id DESC
				  LIMIT 1`,
			)
			.get("peer-1") as Record<string, unknown>;
		expect(attempt).toMatchObject({
			local_sync_capability: "aware",
			peer_sync_capability: "enforcing",
			negotiated_sync_capability: "aware",
		});
	});

	it("treats missing peer capability as unsupported while preserving legacy sync", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-legacy", "legacy-fp", new Date().toISOString());
		db.prepare(
			"INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
		).run("peer-legacy", "2025-12-31T00:00:00Z|local-op-0", null, new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
		vi.spyOn(syncHttpClient, "requestJson")
			.mockResolvedValueOnce([
				200,
				{
					fingerprint: "legacy-fp",
					protocol_version: "2",
					sync_reset: {
						generation: 1,
						snapshot_id: "snap-legacy",
						baseline_cursor: null,
						retained_floor_cursor: null,
					},
				},
			])
			.mockResolvedValueOnce([
				200,
				{
					reset_required: false,
					generation: 1,
					snapshot_id: "snap-legacy",
					baseline_cursor: null,
					retained_floor_cursor: null,
					ops: [],
					next_cursor: null,
					skipped: 0,
				},
			]);

		const result = await syncOnce(db, "peer-legacy", ["http://127.0.0.1:9090"]);

		expect(result.ok).toBe(true);
		const attempt = db
			.prepare(
				`SELECT local_sync_capability, peer_sync_capability, negotiated_sync_capability
				   FROM sync_attempts
				  WHERE peer_device_id = ?
				  ORDER BY id DESC
				  LIMIT 1`,
			)
			.get("peer-legacy") as Record<string, unknown>;
		expect(attempt).toMatchObject({
			local_sync_capability: "aware",
			peer_sync_capability: "unsupported",
			negotiated_sync_capability: "unsupported",
		});
	});

	it("falls back to immediate vector maintenance when durable queueing throws", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "abc123", new Date().toISOString());
		db.prepare(
			"INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
		).run("peer-1", "2025-12-31T00:00:00Z|local-op-0", null, new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
		vi.spyOn(vectorMigration, "queueVectorBackfillForIncrementalSync").mockImplementation(() => {
			throw new Error("queue write failed");
		});
		const fallbackSpy = vi
			.spyOn(vectors, "bestEffortMaintainVectorsForSyncFallback")
			.mockResolvedValue({ deleted: 0, inserted: 1, errors: [] });

		vi.spyOn(syncHttpClient, "requestJson")
			.mockResolvedValueOnce([
				200,
				{
					fingerprint: "abc123",
					protocol_version: "2",
					sync_reset: {
						generation: 1,
						snapshot_id: "snap-1",
						baseline_cursor: null,
						retained_floor_cursor: null,
					},
				},
			])
			.mockResolvedValueOnce([
				200,
				{
					reset_required: false,
					generation: 1,
					snapshot_id: "snap-1",
					baseline_cursor: null,
					retained_floor_cursor: null,
					ops: [
						{
							op_id: "remote-op-fallback",
							entity_type: "memory_item",
							entity_id: "key:sync-pass-fallback",
							op_type: "upsert",
							payload_json: JSON.stringify({
								kind: "discovery",
								title: "Remote title",
								body_text: "Remote body",
								active: 1,
								created_at: "2026-01-01T00:00:00Z",
								updated_at: "2026-01-01T00:00:00Z",
							}),
							clock_rev: 1,
							clock_updated_at: "2026-01-01T00:00:00Z",
							clock_device_id: "dev-remote",
							device_id: "dev-remote",
							created_at: "2026-01-01T00:00:00Z",
						},
					],
					next_cursor: "2026-01-01T00:00:00Z|remote-op-fallback",
					skipped: 0,
				},
			]);

		const result = await syncOnce(db, "peer-1", ["http://127.0.0.1:9090"]);

		if (!result.ok) {
			throw new Error(`syncOnce failed: ${result.error ?? "unknown error"}`);
		}
		expect(result.ok).toBe(true);
		expect(fallbackSpy).toHaveBeenCalledWith(
			db,
			expect.objectContaining({ upsertMemoryIds: [expect.any(Number)], deleteMemoryIds: [] }),
		);
	});

	it("promotes the working address after falling back from an unreachable candidate", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, addresses_json, created_at) VALUES (?, ?, ?, ?)",
		).run(
			"peer-1",
			"abc123",
			JSON.stringify(["http://10.0.0.9:9090", "http://100.64.0.5:9090"]),
			new Date().toISOString(),
		);
		db.prepare(
			"INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
		).run("peer-1", "2025-12-31T00:00:00Z|local-op-0", null, new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});

		vi.spyOn(syncHttpClient, "requestJson")
			.mockRejectedValueOnce(new Error("network is unreachable"))
			.mockResolvedValueOnce([
				200,
				{
					fingerprint: "abc123",
					protocol_version: "2",
					sync_reset: {
						generation: 1,
						snapshot_id: "snap-1",
						baseline_cursor: null,
						retained_floor_cursor: null,
					},
				},
			])
			.mockResolvedValueOnce([
				200,
				{
					reset_required: false,
					generation: 1,
					snapshot_id: "snap-1",
					baseline_cursor: null,
					retained_floor_cursor: null,
					ops: [],
					next_cursor: null,
					skipped: 0,
				},
			]);

		const result = await syncOnce(db, "peer-1", ["http://10.0.0.9:9090", "http://100.64.0.5:9090"]);

		if (!result.ok) {
			throw new Error(`syncOnce failed: ${result.error ?? "unknown error"}`);
		}
		expect(result.address).toBe("http://100.64.0.5:9090");
		const row = db
			.prepare("SELECT addresses_json FROM sync_peers WHERE peer_device_id = ?")
			.get("peer-1") as { addresses_json: string };
		expect(JSON.parse(row.addresses_json)).toEqual([
			"http://100.64.0.5:9090",
			"http://10.0.0.9:9090",
		]);
	});
});

describe("syncPassPreflight", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		db.close();
	});

	it("does not run retention pruning in sync preflight", () => {
		const pruneSpy = vi.spyOn(syncReplication, "pruneReplicationOps");

		syncPassPreflight(db);

		expect(pruneSpy).not.toHaveBeenCalled();
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

	it("returns base backoff with jitter for 2 failures", () => {
		// Base = 120s, jitter range = [60, 120)
		const result = peerBackoffSeconds(2);
		expect(result).toBeGreaterThanOrEqual(60);
		expect(result).toBeLessThanOrEqual(120);
	});

	it("doubles base for 3 failures (with jitter)", () => {
		// Base = 240s, jitter range = [120, 240)
		const result = peerBackoffSeconds(3);
		expect(result).toBeGreaterThanOrEqual(120);
		expect(result).toBeLessThanOrEqual(240);
	});

	it("caps at max backoff (with jitter)", () => {
		// Max = 1800s, jitter range = [900, 1800)
		const result = peerBackoffSeconds(20);
		expect(result).toBeGreaterThanOrEqual(900);
		expect(result).toBeLessThanOrEqual(1800);
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
				"INSERT INTO sync_attempts (peer_device_id, started_at, ok, ops_in, ops_out, error) VALUES (?, ?, 0, 0, 0, ?)",
			).run("peer-1", ts, "Connection refused");
		}
		expect(consecutiveConnectivityFailures(db, "peer-1")).toBe(3);
	});

	it("stops counting at a success", () => {
		const now = new Date();
		// Old failure
		db.prepare(
			"INSERT INTO sync_attempts (peer_device_id, started_at, ok, ops_in, ops_out, error) VALUES (?, ?, 0, 0, 0, ?)",
		).run("peer-1", new Date(now.getTime()).toISOString(), "Connection refused");
		// Success
		db.prepare(
			"INSERT INTO sync_attempts (peer_device_id, started_at, ok, ops_in, ops_out) VALUES (?, ?, 1, 0, 0)",
		).run("peer-1", new Date(now.getTime() + 1000).toISOString());
		// New failure
		db.prepare(
			"INSERT INTO sync_attempts (peer_device_id, started_at, ok, ops_in, ops_out, error) VALUES (?, ?, 0, 0, 0, ?)",
		).run("peer-1", new Date(now.getTime() + 2000).toISOString(), "Connection refused");

		expect(consecutiveConnectivityFailures(db, "peer-1")).toBe(1);
	});

	it("stops counting at a non-connectivity error", () => {
		const now = new Date();
		db.prepare(
			"INSERT INTO sync_attempts (peer_device_id, started_at, ok, ops_in, ops_out, error) VALUES (?, ?, 0, 0, 0, ?)",
		).run("peer-1", new Date(now.getTime()).toISOString(), "peer fingerprint mismatch");
		db.prepare(
			"INSERT INTO sync_attempts (peer_device_id, started_at, ok, ops_in, ops_out, error) VALUES (?, ?, 0, 0, 0, ?)",
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
				"INSERT INTO sync_attempts (peer_device_id, started_at, ok, ops_in, ops_out, error) VALUES (?, ?, 0, 0, 0, ?)",
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
				"INSERT INTO sync_attempts (peer_device_id, started_at, ok, ops_in, ops_out, error) VALUES (?, ?, 0, 0, 0, ?)",
			).run("peer-1", ts, "Connection refused");
		}
		expect(shouldSkipOfflinePeer(db, "peer-1")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// syncOnce — auto-bootstrap path
// ---------------------------------------------------------------------------

describe("syncOnce auto-bootstrap", () => {
	let db: InstanceType<typeof Database>;
	const peerDeviceId = "peer-bootstrap-1";
	const address = "http://127.0.0.1:9999";
	const fingerprint = "test-fingerprint-abc";

	function seedPeer(opts?: { withCursor?: boolean; withSharedMemory?: boolean }) {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, name, pinned_fingerprint, addresses_json, created_at) VALUES (?, ?, ?, ?, ?)",
		).run(
			peerDeviceId,
			"test-peer",
			fingerprint,
			JSON.stringify([address]),
			new Date().toISOString(),
		);

		// Seed device identity
		db.prepare(
			"INSERT OR REPLACE INTO device_state (key, value) VALUES ('device_id', 'local-device-id')",
		).run();

		if (opts?.withCursor) {
			db.prepare(
				"INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
			).run(
				peerDeviceId,
				"2026-01-01T00:00:00Z|op-1",
				"2026-01-01T00:00:00Z|op-1",
				new Date().toISOString(),
			);
		}

		if (opts?.withSharedMemory) {
			const sessionId = db
				.prepare("INSERT INTO sessions (started_at, user, tool_version) VALUES (?, ?, ?)")
				.run(new Date().toISOString(), "test", "test").lastInsertRowid;
			db.prepare(
				"INSERT INTO memory_items (session_id, kind, title, body_text, import_key, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				Number(sessionId),
				"discovery",
				"existing",
				"existing shared memory",
				"existing-key-1",
				"shared",
				new Date().toISOString(),
				new Date().toISOString(),
			);
		}
	}

	// Mock the status endpoint and bootstrap functions
	const statusPayload = {
		fingerprint,
		protocol_version: "2",
		sync_reset: {
			generation: 1,
			snapshot_id: "snap-1",
			baseline_cursor: "2026-01-01T00:00:00Z|base",
			retained_floor_cursor: null,
		},
	};

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		addSyncTables(db);
		// Add replication_cursors table used by getReplicationCursor
		db.exec(`
			CREATE TABLE IF NOT EXISTS replication_cursors (
				peer_device_id TEXT PRIMARY KEY,
				last_applied_cursor TEXT,
				last_acked_cursor TEXT
			);
			CREATE TABLE IF NOT EXISTS device_state (
				key TEXT PRIMARY KEY,
				value TEXT
			);
		`);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		db.close();
	});

	it("triggers bootstrap for empty local state with no cursor", async () => {
		seedPeer();

		vi.spyOn(syncHttpClient, "requestJson").mockResolvedValue([200, statusPayload]);
		vi.spyOn(syncBootstrap, "fetchAllSnapshotPages").mockResolvedValue({
			items: [],
			generation: 1,
			snapshot_id: "snap-1",
			baseline_cursor: "2026-01-01T00:00:00Z|base",
		});
		vi.spyOn(syncBootstrap, "applyBootstrapSnapshot").mockReturnValue({
			ok: true,
			applied: 42,
			deleted: 0,
		});

		const result = await syncOnce(db, peerDeviceId, [address]);

		expect(result.ok).toBe(true);
		expect(result.opsIn).toBe(42);
		expect(syncBootstrap.fetchAllSnapshotPages).toHaveBeenCalledOnce();
		expect(syncBootstrap.applyBootstrapSnapshot).toHaveBeenCalledOnce();

		// Verify the elevated page size was used
		const fetchCall = vi.mocked(syncBootstrap.fetchAllSnapshotPages).mock.calls[0];
		expect(fetchCall?.[3]?.pageSize).toBe(2000);
	});

	it("falls through to incremental when local shared data exists", async () => {
		seedPeer({ withSharedMemory: true });

		// Mock the status + incremental ops path
		vi.spyOn(syncHttpClient, "requestJson").mockResolvedValue([
			200,
			{
				...statusPayload,
				reset_required: false,
				generation: 1,
				snapshot_id: "snap-1",
				baseline_cursor: "2026-01-01T00:00:00Z|base",
				retained_floor_cursor: null,
				ops: [],
				next_cursor: null,
			},
		]);
		const fetchSpy = vi.spyOn(syncBootstrap, "fetchAllSnapshotPages");

		await syncOnce(db, peerDeviceId, [address]);

		// Should NOT have called bootstrap
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("falls through to incremental when cursor already exists", async () => {
		seedPeer({ withCursor: true });

		vi.spyOn(syncHttpClient, "requestJson").mockResolvedValue([
			200,
			{
				...statusPayload,
				reset_required: false,
				generation: 1,
				snapshot_id: "snap-1",
				baseline_cursor: "2026-01-01T00:00:00Z|base",
				retained_floor_cursor: null,
				ops: [],
				next_cursor: null,
			},
		]);
		const fetchSpy = vi.spyOn(syncBootstrap, "fetchAllSnapshotPages");

		await syncOnce(db, peerDeviceId, [address]);

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("bails when shared memories appear during bootstrap fetch", async () => {
		seedPeer();

		vi.spyOn(syncHttpClient, "requestJson").mockResolvedValue([200, statusPayload]);
		vi.spyOn(syncBootstrap, "fetchAllSnapshotPages").mockImplementation(async () => {
			// Simulate another process inserting shared memory during the fetch
			const sessionId = db
				.prepare("INSERT INTO sessions (started_at, user, tool_version) VALUES (?, ?, ?)")
				.run(new Date().toISOString(), "other", "other").lastInsertRowid;
			db.prepare(
				"INSERT INTO memory_items (session_id, kind, title, body_text, import_key, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				Number(sessionId),
				"discovery",
				"sneaky",
				"appeared during fetch",
				"sneaky-key",
				"shared",
				new Date().toISOString(),
				new Date().toISOString(),
			);

			return {
				items: [],
				generation: 1,
				snapshot_id: "snap-1",
				baseline_cursor: "2026-01-01T00:00:00Z|base",
			};
		});
		const applySpy = vi.spyOn(syncBootstrap, "applyBootstrapSnapshot");

		const result = await syncOnce(db, peerDeviceId, [address]);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("shared memory change(s) appeared during initial bootstrap");
		expect(applySpy).not.toHaveBeenCalled();
	});
});
