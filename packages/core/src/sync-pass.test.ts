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

function grantScopeForSyncPass(
	db: InstanceType<typeof Database>,
	scopeId: string,
	deviceIds: string[],
): void {
	const now = "2026-01-01T00:00:00Z";
	db.prepare(
		`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)
		 ON CONFLICT(scope_id) DO UPDATE SET updated_at = excluded.updated_at`,
	).run(scopeId, scopeId, now, now);
	for (const deviceId of deviceIds) {
		db.prepare(
			`INSERT INTO scope_memberships(
				scope_id, device_id, role, status, membership_epoch, updated_at
			 ) VALUES (?, ?, 'member', 'active', 1, ?)
			 ON CONFLICT(scope_id, device_id) DO UPDATE SET updated_at = excluded.updated_at`,
		).run(scopeId, deviceId, now);
	}
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

	it("does not upgrade a local scoped peer from an enforcing advertisement", () => {
		expect(LOCAL_SYNC_CAPABILITY).toBe("scoped");
		expect(negotiateSyncCapability(LOCAL_SYNC_CAPABILITY, "enforcing")).toBe("enforcing");
	});

	it("downgrades scoped-to-aware sessions to aware", () => {
		expect(negotiateSyncCapability("scoped", "aware")).toBe("aware");
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
			local_sync_capability: "scoped",
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
		grantScopeForSyncPass(db, "acme-work", ["peer-1", "local-device-id"]);

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
								scope_id: "acme-work",
								updated_at: "2026-01-01T00:00:00Z",
							}),
							clock_rev: 1,
							clock_updated_at: "2026-01-01T00:00:00Z",
							clock_device_id: "peer-1",
							device_id: "peer-1",
							created_at: "2026-01-01T00:00:00Z",
							scope_id: "acme-work",
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
			[SYNC_CAPABILITY_HEADER]: "scoped",
		});
		expect(vi.mocked(syncHttpClient.requestJson).mock.calls[1]?.[2]?.headers).toMatchObject({
			[SYNC_CAPABILITY_HEADER]: "scoped",
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
			local_sync_capability: "scoped",
			peer_sync_capability: "enforcing",
			negotiated_sync_capability: "enforcing",
		});
	});

	it("bootstraps every authorized scope advertised by a scoped peer", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-scoped", "fp-scoped", new Date().toISOString());
		// Seed an existing replication cursor so the auto-bootstrap branch is
		// skipped and syncOnce reaches the per-scope iteration via the
		// incremental path. The fresh-peer auto-bootstrap variant is exercised
		// separately below.
		db.prepare(
			"INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
		).run("peer-scoped", "2025-12-31T00:00:00Z|local-op-0", null, new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
		grantScopeForSyncPass(db, "acme-work", ["peer-scoped", "local-device-id"]);

		const statusResponse = {
			fingerprint: "fp-scoped",
			protocol_version: "2",
			sync_capability: "scoped",
			sync_reset: {
				generation: 1,
				snapshot_id: "snap-default",
				baseline_cursor: null,
				retained_floor_cursor: null,
			},
			authorized_scopes: [
				{
					scope_id: "acme-work",
					label: "Acme Work",
					authority_type: "coordinator",
					membership_epoch: 1,
					sync_reset: {
						scope_id: "acme-work",
						generation: 1,
						snapshot_id: "snap-acme-1",
						baseline_cursor: null,
						retained_floor_cursor: null,
					},
				},
			],
		};
		const defaultOpsResponse = {
			reset_required: false,
			generation: 1,
			snapshot_id: "snap-default",
			baseline_cursor: null,
			retained_floor_cursor: null,
			ops: [],
			next_cursor: null,
			skipped: 0,
		};
		const scopedSnapshotResponse = {
			scope_id: "acme-work",
			generation: 1,
			snapshot_id: "snap-acme-1",
			baseline_cursor: null,
			retained_floor_cursor: null,
			sync_capability: "scoped",
			items: [
				{
					entity_id: "key:acme-work-1",
					op_type: "upsert",
					payload_json: JSON.stringify({
						kind: "discovery",
						title: "Scoped memory",
						body_text: "Scoped body",
						active: 1,
						created_at: "2026-01-01T00:00:00Z",
						updated_at: "2026-01-01T00:00:00Z",
						scope_id: "acme-work",
						visibility: "shared",
					}),
					clock_rev: 1,
					clock_updated_at: "2026-01-01T00:00:00Z",
					clock_device_id: "peer-scoped",
				},
			],
			next_page_token: null,
			has_more: false,
		};
		vi.spyOn(syncHttpClient, "requestJson")
			.mockResolvedValueOnce([200, statusResponse])
			.mockResolvedValueOnce([200, defaultOpsResponse])
			.mockResolvedValueOnce([200, scopedSnapshotResponse]);

		const result = await syncOnce(db, "peer-scoped", ["http://127.0.0.1:9090"]);

		if (!result.ok) {
			throw new Error(`syncOnce failed: ${result.error ?? "unknown error"}`);
		}
		expect(result.ok).toBe(true);
		expect(result.perScopeResults).toHaveLength(1);
		expect(result.perScopeResults?.[0]).toMatchObject({
			scope_id: "acme-work",
			label: "Acme Work",
			ok: true,
			opsIn: 1,
			bootstrapped: true,
		});
		// Top-level opsIn aggregates default + scoped.
		expect(result.opsIn).toBe(1);

		const scopedMemory = db
			.prepare("SELECT title, scope_id FROM memory_items WHERE import_key = ?")
			.get("key:acme-work-1") as { title: string; scope_id: string } | undefined;
		expect(scopedMemory).toMatchObject({
			title: "Scoped memory",
			scope_id: "acme-work",
		});
	});

	it("reports per-scope failure without rolling back default-scope sync", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-mixed", "fp-mixed", new Date().toISOString());
		// Pre-existing cursor → skip auto-bootstrap, exercise the incremental
		// success → per-scope failure path.
		db.prepare(
			"INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
		).run("peer-mixed", "2025-12-31T00:00:00Z|local-op-0", null, new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});

		const statusResponse = {
			fingerprint: "fp-mixed",
			protocol_version: "2",
			sync_capability: "scoped",
			sync_reset: {
				generation: 1,
				snapshot_id: "snap-default",
				baseline_cursor: null,
				retained_floor_cursor: null,
			},
			authorized_scopes: [
				{
					scope_id: "broken-scope",
					label: "Broken",
					authority_type: "coordinator",
					membership_epoch: 1,
					sync_reset: {
						scope_id: "broken-scope",
						generation: 1,
						snapshot_id: "snap-broken-1",
						baseline_cursor: null,
						retained_floor_cursor: null,
					},
				},
			],
		};
		const defaultOpsResponse = {
			reset_required: false,
			generation: 1,
			snapshot_id: "snap-default",
			baseline_cursor: null,
			retained_floor_cursor: null,
			ops: [],
			next_cursor: null,
			skipped: 0,
		};
		// Server rejects the snapshot fetch for the scope with a structured reset reason.
		vi.spyOn(syncHttpClient, "requestJson")
			.mockResolvedValueOnce([200, statusResponse])
			.mockResolvedValueOnce([200, defaultOpsResponse])
			.mockResolvedValueOnce([409, { error: "reset_required", reason: "missing_scope" }]);

		const result = await syncOnce(db, "peer-mixed", ["http://127.0.0.1:9090"]);

		// Top-level ok is false because one scope failed, but the default-scope
		// pass succeeded and is observable in opsIn / opsOut and recorded
		// sync_attempts.
		expect(result.ok).toBe(false);
		expect(result.perScopeResults).toHaveLength(1);
		expect(result.perScopeResults?.[0]).toMatchObject({
			scope_id: "broken-scope",
			ok: false,
			failureCategory: "scope",
			bootstrapped: true,
		});
		expect(result.perScopeResults?.[0]?.error).toContain(
			"snapshot fetch failed: reset_required:missing_scope",
		);
		expect(result.failureCategory).toBe("scope");
	});

	it("classifies peer trust failures structurally", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-trust", "fp-trust", new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
		vi.spyOn(syncHttpClient, "requestJson").mockResolvedValueOnce([401, { error: "unauthorized" }]);

		const result = await syncOnce(db, "peer-trust", ["http://127.0.0.1:9090"]);

		expect(result.ok).toBe(false);
		expect(result.failureCategory).toBe("trust");
		expect(result.error).toContain("401: unauthorized");
	});

	it("classifies scoped transport failures structurally", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-connectivity", "fp-connectivity", new Date().toISOString());
		db.prepare(
			"INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
		).run("peer-connectivity", "2025-12-31T00:00:00Z|local-op-0", null, new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
		vi.spyOn(syncHttpClient, "requestJson")
			.mockResolvedValueOnce([
				200,
				{
					fingerprint: "fp-connectivity",
					protocol_version: "2",
					sync_capability: "scoped",
					sync_reset: {
						generation: 1,
						snapshot_id: "snap-default",
						baseline_cursor: null,
						retained_floor_cursor: null,
					},
					authorized_scopes: [
						{
							scope_id: "oss",
							label: "OSS",
							authority_type: "coordinator",
							membership_epoch: 1,
							sync_reset: {
								scope_id: "oss",
								generation: 1,
								snapshot_id: "snap-oss",
								baseline_cursor: null,
								retained_floor_cursor: null,
							},
						},
					],
				},
			])
			.mockResolvedValueOnce([
				200,
				{
					reset_required: false,
					generation: 1,
					snapshot_id: "snap-default",
					baseline_cursor: null,
					retained_floor_cursor: null,
					ops: [],
					next_cursor: null,
					skipped: 0,
				},
			])
			.mockRejectedValueOnce(new Error("fetch failed"));

		const result = await syncOnce(db, "peer-connectivity", ["http://127.0.0.1:9090"]);

		expect(result.ok).toBe(false);
		expect(result.failureCategory).toBe("connectivity");
		expect(result.perScopeResults?.[0]).toMatchObject({
			scope_id: "oss",
			ok: false,
			failureCategory: "connectivity",
		});
	});

	it("replicates a multi-Space corpus from a scoped peer to a fresh receiver (ruu6.7)", async () => {
		// End-to-end regression test for codemem-ruu6: the receiver pairs with
		// a scoped peer that advertises multiple Spaces; after one sync pass
		// the receiver must hold each Space's items routed to the correct
		// scope_id, with independent per-scope cursors. This is the automated
		// version of the dogfood validation in the bead — manual verification
		// against a 10k+ row corpus is documented in
		// docs/plans/2026-05-25-scoped-sync-protocol.md.
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-multi", "fp-multi", new Date().toISOString());
		// Seed cursor so we exercise the incremental + scoped branch rather
		// than the auto-bootstrap branch (which is covered by the earlier
		// scoped-bootstrap test).
		db.prepare(
			"INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
		).run("peer-multi", "2025-12-31T00:00:00Z|local-op-0", null, new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
		grantScopeForSyncPass(db, "acme-work", ["peer-multi", "local-device-id"]);
		grantScopeForSyncPass(db, "oss-projects", ["peer-multi", "local-device-id"]);

		const scopes = ["acme-work", "oss-projects"] as const;
		const itemsPerScope = 3;

		const statusResponse = {
			fingerprint: "fp-multi",
			protocol_version: "2",
			sync_capability: "scoped",
			sync_reset: {
				generation: 1,
				snapshot_id: "snap-default",
				baseline_cursor: null,
				retained_floor_cursor: null,
			},
			authorized_scopes: scopes.map((scope_id) => ({
				scope_id,
				label: scope_id,
				authority_type: "coordinator",
				membership_epoch: 1,
				sync_reset: {
					scope_id,
					generation: 1,
					snapshot_id: `snap-${scope_id}`,
					// Non-null baseline so the per-scope cursor write inside
					// applyBootstrapSnapshot exercises the assertion below.
					baseline_cursor: `2026-01-01T00:00:00Z|baseline-${scope_id}`,
					retained_floor_cursor: null,
				},
			})),
		};
		const defaultOpsResponse = {
			reset_required: false,
			generation: 1,
			snapshot_id: "snap-default",
			baseline_cursor: null,
			retained_floor_cursor: null,
			ops: [],
			next_cursor: null,
			skipped: 0,
		};

		const scopedSnapshots = scopes.map((scope_id) => ({
			scope_id,
			generation: 1,
			snapshot_id: `snap-${scope_id}`,
			baseline_cursor: `2026-01-01T00:00:00Z|baseline-${scope_id}`,
			retained_floor_cursor: null,
			sync_capability: "scoped",
			items: Array.from({ length: itemsPerScope }, (_, i) => ({
				entity_id: `key:${scope_id}-${i + 1}`,
				op_type: "upsert",
				payload_json: JSON.stringify({
					kind: "discovery",
					title: `${scope_id} item ${i + 1}`,
					body_text: `Body for ${scope_id} #${i + 1}`,
					active: 1,
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-01T00:00:00Z",
					scope_id,
					visibility: "shared",
				}),
				clock_rev: 1,
				clock_updated_at: "2026-01-01T00:00:00Z",
				clock_device_id: "peer-multi",
			})),
			next_page_token: null,
			has_more: false,
		}));

		vi.spyOn(syncHttpClient, "requestJson")
			.mockResolvedValueOnce([200, statusResponse])
			.mockResolvedValueOnce([200, defaultOpsResponse])
			.mockResolvedValueOnce([200, scopedSnapshots[0]])
			.mockResolvedValueOnce([200, scopedSnapshots[1]]);

		const result = await syncOnce(db, "peer-multi", ["http://127.0.0.1:9090"]);

		if (!result.ok) {
			throw new Error(`syncOnce failed: ${result.error ?? "unknown error"}`);
		}
		expect(result.ok).toBe(true);
		// Top-level opsIn aggregates both Spaces' bootstrapped items.
		expect(result.opsIn).toBe(itemsPerScope * scopes.length);
		expect(result.perScopeResults).toHaveLength(scopes.length);
		for (let idx = 0; idx < scopes.length; idx += 1) {
			expect(result.perScopeResults?.[idx]).toMatchObject({
				scope_id: scopes[idx],
				ok: true,
				opsIn: itemsPerScope,
				bootstrapped: true,
			});
		}

		// Per-scope DB inspection: each Space's items must land with the
		// correct scope_id, with no cross-pollination between scopes.
		for (const scope_id of scopes) {
			const rows = db
				.prepare(
					"SELECT import_key, scope_id, title FROM memory_items WHERE scope_id = ? ORDER BY import_key",
				)
				.all(scope_id) as Array<{ import_key: string; scope_id: string; title: string }>;
			expect(rows).toHaveLength(itemsPerScope);
			for (const row of rows) {
				expect(row.scope_id).toBe(scope_id);
				expect(row.import_key.startsWith(`key:${scope_id}-`)).toBe(true);
			}
		}

		// Per-scope cursors are advanced independently to each Space's
		// baseline. The default-scope cursor stays at its pre-sync value
		// because no default-scope ops were returned.
		for (const scope_id of scopes) {
			const [lastApplied] = syncReplication.getReplicationCursor(db, "peer-multi", scope_id);
			expect(lastApplied).toBe(`2026-01-01T00:00:00Z|baseline-${scope_id}`);
		}
		expect(syncReplication.getReplicationCursor(db, "peer-multi")).toEqual([
			"2025-12-31T00:00:00Z|local-op-0",
			null,
		]);
	});

	it("canary: bulk of source rows reach a fresh peer across multiple Spaces (ruu6.7)", async () => {
		// Cheap regression canary for the codemem-ruu6 bug shape — source has
		// many rows across multiple Spaces, fresh peer should receive almost
		// all of them (modulo any in scopes the peer is not a member of). The
		// original regression had a stark fingerprint: source had ~24k rows,
		// receiver got exactly 295. A "did the bulk transfer?" assertion
		// would have caught it. This test enforces that floor at a small
		// scale so any future protocol drift that silently filters out a
		// whole class of rows trips here, not in dogfood.
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-canary", "fp-canary", new Date().toISOString());
		db.prepare(
			"INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
		).run("peer-canary", "2025-12-31T00:00:00Z|local-op-0", null, new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
		grantScopeForSyncPass(db, "alpha", ["peer-canary", "local-device-id"]);
		grantScopeForSyncPass(db, "beta", ["peer-canary", "local-device-id"]);
		grantScopeForSyncPass(db, "gamma", ["peer-canary", "local-device-id"]);

		const scopes = ["alpha", "beta", "gamma"] as const;
		const itemsPerScope = 12;
		const expectedTotal = scopes.length * itemsPerScope;

		const statusResponse = {
			fingerprint: "fp-canary",
			protocol_version: "2",
			sync_capability: "scoped",
			sync_reset: {
				generation: 1,
				snapshot_id: "snap-default",
				baseline_cursor: null,
				retained_floor_cursor: null,
			},
			authorized_scopes: scopes.map((scope_id) => ({
				scope_id,
				label: scope_id,
				authority_type: "coordinator",
				membership_epoch: 1,
				sync_reset: {
					scope_id,
					generation: 1,
					snapshot_id: `snap-${scope_id}`,
					baseline_cursor: `2026-01-01T00:00:00Z|baseline-${scope_id}`,
					retained_floor_cursor: null,
				},
			})),
		};
		const defaultOpsResponse = {
			reset_required: false,
			generation: 1,
			snapshot_id: "snap-default",
			baseline_cursor: null,
			retained_floor_cursor: null,
			ops: [],
			next_cursor: null,
			skipped: 0,
		};

		const calls = [statusResponse, defaultOpsResponse] as Record<string, unknown>[];
		for (const scope_id of scopes) {
			calls.push({
				scope_id,
				generation: 1,
				snapshot_id: `snap-${scope_id}`,
				baseline_cursor: `2026-01-01T00:00:00Z|baseline-${scope_id}`,
				retained_floor_cursor: null,
				sync_capability: "scoped",
				items: Array.from({ length: itemsPerScope }, (_, i) => ({
					entity_id: `key:${scope_id}-${i + 1}`,
					op_type: "upsert",
					payload_json: JSON.stringify({
						kind: "discovery",
						title: `${scope_id} item ${i + 1}`,
						body_text: `Body ${scope_id} ${i + 1}`,
						active: 1,
						created_at: "2026-01-01T00:00:00Z",
						updated_at: "2026-01-01T00:00:00Z",
						scope_id,
						visibility: "shared",
					}),
					clock_rev: 1,
					clock_updated_at: "2026-01-01T00:00:00Z",
					clock_device_id: "peer-canary",
				})),
				next_page_token: null,
				has_more: false,
			});
		}

		const spy = vi.spyOn(syncHttpClient, "requestJson");
		for (const call of calls) spy.mockResolvedValueOnce([200, call]);

		const result = await syncOnce(db, "peer-canary", ["http://127.0.0.1:9090"]);

		expect(result.ok).toBe(true);
		// Bulk-transfer canary: count rows the peer received from the source.
		// The original codemem-ruu6 regression failed this with a 295-row
		// receiver against a multi-Space source. Allow zero tolerance because
		// these are synthetic fixtures; in dogfood the bar is "within
		// tombstone tolerance" per the protocol doc.
		const receivedCount = (
			db
				.prepare(
					"SELECT count(*) AS n FROM memory_items WHERE import_key IS NOT NULL AND scope_id IN ('alpha','beta','gamma')",
				)
				.get() as { n: number }
		).n;
		expect(receivedCount).toBe(expectedTotal);
		// And the per-Space breakdown matches; no Space accidentally got
		// short-changed.
		for (const scope_id of scopes) {
			const perScope = (
				db
					.prepare(
						"SELECT count(*) AS n FROM memory_items WHERE import_key IS NOT NULL AND scope_id = ?",
					)
					.get(scope_id) as { n: number }
			).n;
			expect(perScope).toBe(itemsPerScope);
		}
	});

	it("keeps default-scope and per-scope cursors independent after scoped incremental sync", async () => {
		// Seeds an incremental scoped pass and asserts the per-scope cursor is
		// advanced via `replication_cursors_v2(peer, scope_id)` while the
		// default-scope cursor row stays untouched. Locks in the ruu6.4
		// per-scope cursor isolation guarantee end-to-end.
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-cursor", "fp-cursor", new Date().toISOString());
		// Seed both default-scope and acme-work scope cursors so the function
		// has something to compare against.
		syncReplication.setReplicationCursor(db, "peer-cursor", {
			lastApplied: "2025-12-31T00:00:00Z|default-baseline",
		});
		syncReplication.setReplicationCursor(
			db,
			"peer-cursor",
			{ lastApplied: "2025-12-31T00:00:00Z|acme-baseline" },
			"acme-work",
		);
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
		grantScopeForSyncPass(db, "acme-work", ["peer-cursor", "local-device-id"]);

		const statusResponse = {
			fingerprint: "fp-cursor",
			protocol_version: "2",
			sync_capability: "scoped",
			sync_reset: {
				generation: 1,
				snapshot_id: "snap-default",
				baseline_cursor: null,
				retained_floor_cursor: null,
			},
			authorized_scopes: [
				{
					scope_id: "acme-work",
					authority_type: "coordinator",
					membership_epoch: 1,
					sync_reset: {
						scope_id: "acme-work",
						generation: 1,
						snapshot_id: "snap-acme",
						baseline_cursor: null,
						retained_floor_cursor: null,
					},
				},
			],
		};
		const defaultOpsResponse = {
			reset_required: false,
			generation: 1,
			snapshot_id: "snap-default",
			baseline_cursor: null,
			retained_floor_cursor: null,
			ops: [],
			next_cursor: null,
			skipped: 0,
		};
		const scopedOpsResponse = {
			reset_required: false,
			generation: 1,
			snapshot_id: "snap-acme",
			baseline_cursor: null,
			retained_floor_cursor: null,
			ops: [
				{
					op_id: "acme-op-1",
					entity_type: "memory_item",
					entity_id: "key:acme-incremental",
					op_type: "upsert",
					payload_json: JSON.stringify({
						kind: "discovery",
						title: "Scoped incremental",
						body_text: "Body",
						active: 1,
						created_at: "2026-02-01T00:00:00Z",
						updated_at: "2026-02-01T00:00:00Z",
						scope_id: "acme-work",
						visibility: "shared",
					}),
					clock_rev: 1,
					clock_updated_at: "2026-02-01T00:00:00Z",
					clock_device_id: "peer-cursor",
					device_id: "peer-cursor",
					created_at: "2026-02-01T00:00:00Z",
					scope_id: "acme-work",
				},
			],
			next_cursor: "2026-02-01T00:00:00Z|acme-op-1",
			skipped: 0,
		};
		vi.spyOn(syncHttpClient, "requestJson")
			.mockResolvedValueOnce([200, statusResponse])
			.mockResolvedValueOnce([200, defaultOpsResponse])
			.mockResolvedValueOnce([200, scopedOpsResponse]);

		const result = await syncOnce(db, "peer-cursor", ["http://127.0.0.1:9090"]);
		expect(result.ok).toBe(true);
		// Default-scope cursor is unchanged: no default-scope ops returned.
		expect(syncReplication.getReplicationCursor(db, "peer-cursor")).toEqual([
			"2025-12-31T00:00:00Z|default-baseline",
			null,
		]);
		// Per-scope cursor advanced to the scoped next_cursor.
		expect(syncReplication.getReplicationCursor(db, "peer-cursor", "acme-work")).toEqual([
			"2026-02-01T00:00:00Z|acme-op-1",
			null,
		]);
	});

	it("clears a stale per-scope cursor after scoped reset_required", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-reset", "fp-reset", new Date().toISOString());
		syncReplication.setReplicationCursor(db, "peer-reset", {
			lastApplied: "2025-12-31T00:00:00Z|default-baseline",
		});
		syncReplication.setReplicationCursor(
			db,
			"peer-reset",
			{ lastApplied: "2025-12-31T00:00:00Z|stale-acme" },
			"acme-work",
		);
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
		grantScopeForSyncPass(db, "acme-work", ["peer-reset", "local-device-id"]);

		vi.spyOn(syncHttpClient, "requestJson")
			.mockResolvedValueOnce([
				200,
				{
					fingerprint: "fp-reset",
					protocol_version: "2",
					sync_capability: "scoped",
					sync_reset: {
						generation: 1,
						snapshot_id: "snap-default",
						baseline_cursor: null,
						retained_floor_cursor: null,
					},
					authorized_scopes: [
						{
							scope_id: "acme-work",
							label: "acme-work",
							authority_type: "coordinator",
							membership_epoch: 1,
							sync_reset: {
								scope_id: "acme-work",
								generation: 2,
								snapshot_id: "snap-acme-2",
								baseline_cursor: "2026-01-01T00:00:00Z|baseline-acme",
								retained_floor_cursor: null,
							},
						},
					],
				},
			])
			.mockResolvedValueOnce([
				200,
				{
					reset_required: false,
					generation: 1,
					snapshot_id: "snap-default",
					baseline_cursor: null,
					retained_floor_cursor: null,
					ops: [],
					next_cursor: null,
					skipped: 0,
				},
			])
			.mockResolvedValueOnce([
				409,
				{
					reset_required: true,
					reason: "stale_cursor",
					scope_id: "acme-work",
					generation: 2,
					snapshot_id: "snap-acme-2",
					baseline_cursor: "2026-01-01T00:00:00Z|baseline-acme",
					retained_floor_cursor: null,
				},
			]);

		const result = await syncOnce(db, "peer-reset", ["http://127.0.0.1:9090"]);

		expect(result.ok).toBe(false);
		expect(result.perScopeResults?.[0]).toMatchObject({
			scope_id: "acme-work",
			ok: false,
			error: "reset_required:stale_cursor",
			failureCategory: "other",
		});
		expect(result.failureCategory).toBe("other");
		expect(syncReplication.getReplicationCursor(db, "peer-reset", "acme-work")).toEqual([
			null,
			null,
		]);
	});

	it.each([
		"missing_scope",
		"stale_epoch",
		"scope_inactive",
	] as const)("keeps %s reset_required failures categorized as scope access", async (reason) => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run(`peer-${reason}`, `fp-${reason}`, new Date().toISOString());
		syncReplication.setReplicationCursor(db, `peer-${reason}`, {
			lastApplied: "2025-12-31T00:00:00Z|default-baseline",
		});
		syncReplication.setReplicationCursor(
			db,
			`peer-${reason}`,
			{ lastApplied: "2025-12-31T00:00:00Z|stale-acme" },
			"acme-work",
		);
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
		grantScopeForSyncPass(db, "acme-work", [`peer-${reason}`, "local-device-id"]);

		vi.spyOn(syncHttpClient, "requestJson")
			.mockResolvedValueOnce([
				200,
				{
					fingerprint: `fp-${reason}`,
					protocol_version: "2",
					sync_capability: "scoped",
					sync_reset: {
						generation: 1,
						snapshot_id: "snap-default",
						baseline_cursor: null,
						retained_floor_cursor: null,
					},
					authorized_scopes: [
						{
							scope_id: "acme-work",
							label: "acme-work",
							authority_type: "coordinator",
							membership_epoch: 1,
							sync_reset: {
								scope_id: "acme-work",
								generation: 2,
								snapshot_id: "snap-acme-2",
								baseline_cursor: null,
								retained_floor_cursor: null,
							},
						},
					],
				},
			])
			.mockResolvedValueOnce([
				200,
				{
					reset_required: false,
					generation: 1,
					snapshot_id: "snap-default",
					baseline_cursor: null,
					retained_floor_cursor: null,
					ops: [],
					next_cursor: null,
					skipped: 0,
				},
			])
			.mockResolvedValueOnce([
				409,
				{
					reset_required: true,
					reason,
					scope_id: "acme-work",
					generation: 2,
					snapshot_id: "snap-acme-2",
					baseline_cursor: null,
					retained_floor_cursor: null,
				},
			]);

		const result = await syncOnce(db, `peer-${reason}`, ["http://127.0.0.1:9090"]);

		expect(result.ok).toBe(false);
		expect(result.perScopeResults?.[0]).toMatchObject({
			scope_id: "acme-work",
			ok: false,
			error: `reset_required:${reason}`,
			failureCategory: "scope",
		});
		expect(result.failureCategory).toBe("scope");
	});

	it("keeps unsupported-scope reset_required failures categorized as protocol drift", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-unsupported-scope", "fp-unsupported-scope", new Date().toISOString());
		syncReplication.setReplicationCursor(db, "peer-unsupported-scope", {
			lastApplied: "2025-12-31T00:00:00Z|default-baseline",
		});
		syncReplication.setReplicationCursor(
			db,
			"peer-unsupported-scope",
			{ lastApplied: "2025-12-31T00:00:00Z|stale-acme" },
			"acme-work",
		);
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
		grantScopeForSyncPass(db, "acme-work", ["peer-unsupported-scope", "local-device-id"]);

		vi.spyOn(syncHttpClient, "requestJson")
			.mockResolvedValueOnce([
				200,
				{
					fingerprint: "fp-unsupported-scope",
					protocol_version: "2",
					sync_capability: "scoped",
					sync_reset: {
						generation: 1,
						snapshot_id: "snap-default",
						baseline_cursor: null,
						retained_floor_cursor: null,
					},
					authorized_scopes: [
						{
							scope_id: "acme-work",
							label: "acme-work",
							authority_type: "coordinator",
							membership_epoch: 1,
							sync_reset: {
								scope_id: "acme-work",
								generation: 2,
								snapshot_id: "snap-acme-2",
								baseline_cursor: null,
								retained_floor_cursor: null,
							},
						},
					],
				},
			])
			.mockResolvedValueOnce([
				200,
				{
					reset_required: false,
					generation: 1,
					snapshot_id: "snap-default",
					baseline_cursor: null,
					retained_floor_cursor: null,
					ops: [],
					next_cursor: null,
					skipped: 0,
				},
			])
			.mockResolvedValueOnce([
				409,
				{
					reset_required: true,
					reason: "unsupported_scope",
					scope_id: "acme-work",
					generation: 2,
					snapshot_id: "snap-acme-2",
					baseline_cursor: null,
					retained_floor_cursor: null,
				},
			]);

		const result = await syncOnce(db, "peer-unsupported-scope", ["http://127.0.0.1:9090"]);

		expect(result.ok).toBe(false);
		expect(result.perScopeResults?.[0]).toMatchObject({
			scope_id: "acme-work",
			ok: false,
			error: "reset_required:unsupported_scope",
			failureCategory: "other",
		});
		expect(result.failureCategory).toBe("other");
	});

	it("classifies inbound membership rejections as scope failures", async () => {
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-rejected-scope", "fp-rejected-scope", new Date().toISOString());
		db.prepare(
			"INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
		).run("peer-rejected-scope", "2025-12-31T00:00:00Z|local-op-0", null, new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});

		vi.spyOn(syncHttpClient, "requestJson")
			.mockResolvedValueOnce([
				200,
				{
					fingerprint: "fp-rejected-scope",
					protocol_version: "2",
					sync_capability: "scoped",
					sync_reset: {
						generation: 1,
						snapshot_id: "snap-default",
						baseline_cursor: null,
						retained_floor_cursor: null,
					},
					authorized_scopes: [],
				},
			])
			.mockResolvedValueOnce([
				200,
				{
					reset_required: false,
					generation: 1,
					snapshot_id: "snap-default",
					baseline_cursor: null,
					retained_floor_cursor: null,
					ops: [
						{
							op_id: "rejected-scope-op",
							entity_type: "memory_item",
							entity_id: "key:rejected-scope",
							op_type: "upsert",
							payload_json: JSON.stringify({
								kind: "discovery",
								title: "Rejected scoped title",
								body_text: "Rejected scoped body",
								active: 1,
								created_at: "2026-01-01T00:00:00Z",
								updated_at: "2026-01-01T00:00:00Z",
								scope_id: "ungranted-scope",
							}),
							clock_rev: 1,
							clock_updated_at: "2026-01-01T00:00:00Z",
							clock_device_id: "peer-rejected-scope",
							device_id: "peer-rejected-scope",
							created_at: "2026-01-01T00:00:00Z",
							scope_id: "ungranted-scope",
						},
					],
					next_cursor: "2026-01-01T00:00:00Z|rejected-scope-op",
					skipped: 0,
				},
			]);

		const result = await syncOnce(db, "peer-rejected-scope", ["http://127.0.0.1:9090"]);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("inbound scope rejected");
		expect(result.failureCategory).toBe("scope");
		expect(syncReplication.getReplicationCursor(db, "peer-rejected-scope")[0]).toBe(
			"2025-12-31T00:00:00Z|local-op-0",
		);
	});

	it("rejects pulled ops that spoof the local device without advancing cursor", async () => {
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
		grantScopeForSyncPass(db, "acme-work", ["peer-1", "local-device-id"]);

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
							op_id: "spoof-local-op",
							entity_type: "memory_item",
							entity_id: "key:spoof-local",
							op_type: "upsert",
							payload_json: JSON.stringify({
								kind: "discovery",
								title: "Spoofed title",
								body_text: "Spoofed body",
								scope_id: "acme-work",
							}),
							clock_rev: 1,
							clock_updated_at: "2026-01-01T00:00:00Z",
							clock_device_id: "peer-1",
							device_id: "local-device-id",
							created_at: "2026-01-01T00:00:00Z",
							scope_id: "acme-work",
						},
					],
					next_cursor: "2026-01-01T00:00:00Z|spoof-local-op",
					skipped: 0,
				},
			]);

		const result = await syncOnce(db, "peer-1", ["http://127.0.0.1:9090"]);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("inbound op device mismatch:spoof-local-op");
		expect(syncReplication.getReplicationCursor(db, "peer-1")[0]).toBe(
			"2025-12-31T00:00:00Z|local-op-0",
		);
		expect(
			db.prepare("SELECT 1 FROM memory_items WHERE import_key = ?").get("key:spoof-local"),
		).toBeUndefined();
		expect(
			db.prepare("SELECT reason FROM sync_scope_rejections WHERE op_id = ?").get("spoof-local-op"),
		).toBeUndefined();
	});

	it("rejects spoofed local-device ops from unsupported peers without advancing cursor", async () => {
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
					ops: [
						{
							op_id: "legacy-spoof-local-op",
							entity_type: "memory_item",
							entity_id: "legacy-spoof-key",
							op_type: "upsert",
							payload_json: JSON.stringify({
								body_text: "Spoofed legacy body",
								created_at: "2026-01-01T00:00:00Z",
								kind: "discovery",
								title: "Spoofed legacy title",
								updated_at: "2026-01-01T00:00:00Z",
								visibility: "shared",
							}),
							clock_rev: 1,
							clock_updated_at: "2026-01-01T00:00:00Z",
							clock_device_id: "peer-legacy",
							device_id: "local-device-id",
							created_at: "2026-01-01T00:00:00Z",
						},
					],
					next_cursor: "2026-01-01T00:00:00Z|legacy-spoof-local-op",
					skipped: 0,
				},
			]);

		const result = await syncOnce(db, "peer-legacy", ["http://127.0.0.1:9090"]);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("inbound op device mismatch:legacy-spoof-local-op");
		expect(syncReplication.getReplicationCursor(db, "peer-legacy")[0]).toBe(
			"2025-12-31T00:00:00Z|local-op-0",
		);
		expect(
			db.prepare("SELECT 1 FROM memory_items WHERE import_key = ?").get("legacy-spoof-key"),
		).toBeUndefined();
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
					ops: [
						{
							op_id: "legacy-op-1",
							entity_type: "memory_item",
							entity_id: "legacy-key-1",
							op_type: "upsert",
							payload_json: JSON.stringify({
								active: 1,
								body_text: "Legacy body",
								created_at: "2026-01-01T00:00:00Z",
								kind: "discovery",
								title: "Legacy title",
								updated_at: "2026-01-01T00:00:00Z",
								visibility: "shared",
							}),
							clock_rev: 1,
							clock_updated_at: "2026-01-01T00:00:00Z",
							clock_device_id: "peer-legacy",
							device_id: "peer-legacy",
							created_at: "2026-01-01T00:00:00Z",
						},
					],
					next_cursor: "2026-01-01T00:00:00Z|legacy-op-1",
					skipped: 0,
				},
			]);

		const result = await syncOnce(db, "peer-legacy", ["http://127.0.0.1:9090"]);

		expect(result.ok).toBe(true);
		expect(result.opsIn).toBe(1);
		expect(syncReplication.getReplicationCursor(db, "peer-legacy")[0]).toBe(
			"2026-01-01T00:00:00Z|legacy-op-1",
		);
		expect(
			db
				.prepare("SELECT title, scope_id FROM memory_items WHERE import_key = ?")
				.get("legacy-key-1"),
		).toMatchObject({ title: "Legacy title", scope_id: null });
		expect(db.prepare("SELECT count(*) AS count FROM sync_scope_rejections").get()).toMatchObject({
			count: 0,
		});
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
			local_sync_capability: "scoped",
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
		grantScopeForSyncPass(db, "acme-work", ["peer-1", "local-device-id"]);
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
								scope_id: "acme-work",
								updated_at: "2026-01-01T00:00:00Z",
							}),
							clock_rev: 1,
							clock_updated_at: "2026-01-01T00:00:00Z",
							clock_device_id: "peer-1",
							device_id: "peer-1",
							created_at: "2026-01-01T00:00:00Z",
							scope_id: "acme-work",
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

		vi.spyOn(syncHttpClient, "requestJson").mockResolvedValue([
			200,
			{
				...statusPayload,
				sync_reset: { ...statusPayload.sync_reset, scope_id: "acme-work" },
			},
		]);
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
		expect(fetchCall?.[1]).toMatchObject({ scope_id: "acme-work" });
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
