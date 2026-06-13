import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	SCOPED_NULL_BASELINE_BOOTSTRAP_CURSOR_MARKER,
	setReplicationCursor,
} from "./sync-replication.js";
import {
	addSyncScopeToBoundary,
	listAuthorizedScopesForPeer,
	listPerPeerScopeSyncState,
	parseSyncScopeRequest,
	syncScopeResetRequiredPayload,
} from "./sync-scope-protocol.js";
import { initTestSchema } from "./test-utils.js";

describe("sync scope protocol compatibility", () => {
	it("treats omitted scope_id as legacy compatibility mode", () => {
		expect(parseSyncScopeRequest(undefined, false)).toEqual({
			ok: true,
			mode: "legacy",
			scope_id: null,
		});
	});

	it("returns missing_scope when scope_id is present but empty", () => {
		expect(parseSyncScopeRequest("  ", true)).toEqual({ ok: false, reason: "missing_scope" });
	});

	it("returns unsupported_scope for explicit scoped requests without scoped capability", () => {
		expect(parseSyncScopeRequest("acme-work", true)).toEqual({
			ok: false,
			reason: "unsupported_scope",
		});
		expect(parseSyncScopeRequest("acme-work", true, { negotiatedCapability: "aware" })).toEqual({
			ok: false,
			reason: "unsupported_scope",
		});
	});

	it("adds legacy scope shape to reset boundaries", () => {
		expect(
			addSyncScopeToBoundary(
				{
					generation: 2,
					snapshot_id: "snapshot-2",
					baseline_cursor: null,
					retained_floor_cursor: "2026-01-01T00:00:00Z|floor",
				},
				null,
			),
		).toEqual({
			generation: 2,
			snapshot_id: "snapshot-2",
			baseline_cursor: null,
			retained_floor_cursor: "2026-01-01T00:00:00Z|floor",
			scope_id: null,
		});
	});

	it("builds reset_required payloads for scope protocol errors", () => {
		expect(
			syncScopeResetRequiredPayload(
				{
					generation: 3,
					snapshot_id: "snapshot-3",
					baseline_cursor: "2026-01-01T00:00:01Z|base",
					retained_floor_cursor: null,
				},
				"unsupported_scope",
				"aware",
			),
		).toEqual({
			error: "reset_required",
			reset_required: true,
			sync_capability: "aware",
			reason: "unsupported_scope",
			generation: 3,
			snapshot_id: "snapshot-3",
			baseline_cursor: "2026-01-01T00:00:01Z|base",
			retained_floor_cursor: null,
			scope_id: null,
		});
	});

	it("echoes the requested scope_id on reset_required when provided", () => {
		expect(
			syncScopeResetRequiredPayload(
				{
					generation: 1,
					snapshot_id: "snap-acme",
					baseline_cursor: null,
					retained_floor_cursor: null,
				},
				"missing_scope",
				"scoped",
				"acme-work",
			),
		).toMatchObject({ scope_id: "acme-work", reason: "missing_scope" });
	});
});

describe("parseSyncScopeRequest scoped path", () => {
	const LOCAL_DEVICE = "local-device";
	const PEER_DEVICE = "peer-device";
	const SCOPE_ID = "acme-work";
	const NOW = "2026-05-25T00:00:00.000Z";
	let db: InstanceType<typeof Database>;

	function insertScope(
		scopeId: string,
		opts: { membershipEpoch?: number; status?: string; authorityType?: string } = {},
	) {
		const membershipEpoch = opts.membershipEpoch ?? 0;
		const status = opts.status ?? "active";
		const authorityType = opts.authorityType ?? "coordinator";
		db.prepare(
			`INSERT OR REPLACE INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			) VALUES (?, ?, 'team', ?, 'coordinator-1', 'group-1', ?, ?, ?, ?)`,
		).run(scopeId, `Scope ${scopeId}`, authorityType, membershipEpoch, status, NOW, NOW);
	}

	function grantMembership(
		scopeId: string,
		deviceId: string,
		opts: { membershipEpoch?: number; status?: string } = {},
	) {
		const membershipEpoch = opts.membershipEpoch ?? 0;
		const status = opts.status ?? "active";
		db.prepare(
			`INSERT OR REPLACE INTO scope_memberships(
				scope_id, device_id, role, status, membership_epoch,
				coordinator_id, group_id, updated_at
			) VALUES (?, ?, 'member', ?, ?, 'coordinator-1', 'group-1', ?)`,
		).run(scopeId, deviceId, status, membershipEpoch, NOW);
	}

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("accepts a scoped request when peer is an authorized active member", () => {
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, LOCAL_DEVICE);
		grantMembership(SCOPE_ID, PEER_DEVICE);
		const result = parseSyncScopeRequest(SCOPE_ID, true, {
			db,
			localDeviceId: LOCAL_DEVICE,
			negotiatedCapability: "scoped",
			peerDeviceId: PEER_DEVICE,
		});
		expect(result).toEqual({ ok: true, mode: "scoped", scope_id: SCOPE_ID });
	});

	it("rejects with missing_scope when the scope does not exist", () => {
		const result = parseSyncScopeRequest("does-not-exist", true, {
			db,
			localDeviceId: LOCAL_DEVICE,
			negotiatedCapability: "scoped",
			peerDeviceId: PEER_DEVICE,
		});
		expect(result).toEqual({ ok: false, reason: "missing_scope" });
	});

	it("rejects with missing_scope when peer is not a member", () => {
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, LOCAL_DEVICE);
		// Peer not granted.
		const result = parseSyncScopeRequest(SCOPE_ID, true, {
			db,
			localDeviceId: LOCAL_DEVICE,
			negotiatedCapability: "scoped",
			peerDeviceId: PEER_DEVICE,
		});
		expect(result).toEqual({ ok: false, reason: "missing_scope" });
	});

	it("rejects with missing_scope when local device is not a member", () => {
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, PEER_DEVICE);
		// Local device not granted; peer membership alone is not enough.
		const result = parseSyncScopeRequest(SCOPE_ID, true, {
			db,
			localDeviceId: LOCAL_DEVICE,
			negotiatedCapability: "scoped",
			peerDeviceId: PEER_DEVICE,
		});
		expect(result).toEqual({ ok: false, reason: "missing_scope" });
	});

	it("rejects with stale_epoch when peer membership epoch is behind authority", () => {
		insertScope(SCOPE_ID, { membershipEpoch: 5 });
		grantMembership(SCOPE_ID, LOCAL_DEVICE, { membershipEpoch: 5 });
		grantMembership(SCOPE_ID, PEER_DEVICE, { membershipEpoch: 3 });
		const result = parseSyncScopeRequest(SCOPE_ID, true, {
			db,
			localDeviceId: LOCAL_DEVICE,
			negotiatedCapability: "scoped",
			peerDeviceId: PEER_DEVICE,
		});
		expect(result).toEqual({ ok: false, reason: "stale_epoch" });
	});

	it("rejects with scope_inactive when membership was revoked", () => {
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, LOCAL_DEVICE);
		grantMembership(SCOPE_ID, PEER_DEVICE, { status: "revoked" });
		const result = parseSyncScopeRequest(SCOPE_ID, true, {
			db,
			localDeviceId: LOCAL_DEVICE,
			negotiatedCapability: "scoped",
			peerDeviceId: PEER_DEVICE,
		});
		expect(result).toEqual({ ok: false, reason: "scope_inactive" });
	});

	it("falls back to unsupported_scope when caller advertises a lower capability", () => {
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, LOCAL_DEVICE);
		grantMembership(SCOPE_ID, PEER_DEVICE);
		const result = parseSyncScopeRequest(SCOPE_ID, true, {
			db,
			localDeviceId: LOCAL_DEVICE,
			negotiatedCapability: "aware",
			peerDeviceId: PEER_DEVICE,
		});
		expect(result).toEqual({ ok: false, reason: "unsupported_scope" });
	});
});

describe("listAuthorizedScopesForPeer", () => {
	const LOCAL_DEVICE = "local-device";
	const PEER_DEVICE = "peer-device";
	const NOW = "2026-05-25T00:00:00.000Z";
	let db: InstanceType<typeof Database>;

	function insertScope(
		scopeId: string,
		opts: {
			membershipEpoch?: number;
			status?: string;
			authorityType?: string;
			label?: string;
		} = {},
	) {
		const membershipEpoch = opts.membershipEpoch ?? 0;
		const status = opts.status ?? "active";
		const authorityType = opts.authorityType ?? "coordinator";
		const label = opts.label ?? `Scope ${scopeId}`;
		db.prepare(
			`INSERT OR REPLACE INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			) VALUES (?, ?, 'team', ?, 'coordinator-1', 'group-1', ?, ?, ?, ?)`,
		).run(scopeId, label, authorityType, membershipEpoch, status, NOW, NOW);
	}

	function grantMembership(scopeId: string, deviceId: string, status = "active") {
		db.prepare(
			`INSERT OR REPLACE INTO scope_memberships(
				scope_id, device_id, role, status, membership_epoch,
				coordinator_id, group_id, updated_at
			) VALUES (?, ?, 'member', ?, 0, 'coordinator-1', 'group-1', ?)`,
		).run(scopeId, deviceId, status, NOW);
	}

	function recordSyncAttempt(
		peerDeviceId: string,
		completedAt: string,
		opts: { ok?: boolean; capability?: string } = {},
	) {
		db.prepare(
			`INSERT INTO sync_attempts(
				peer_device_id, started_at, finished_at, ok, ops_in, ops_out, negotiated_sync_capability
			) VALUES (?, ?, ?, ?, 0, 0, ?)`,
		).run(
			peerDeviceId,
			completedAt,
			completedAt,
			opts.ok === false ? 0 : 1,
			opts.capability ?? "scoped",
		);
	}

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns an empty list when the local device has no memberships", () => {
		expect(
			listAuthorizedScopesForPeer(db, {
				localDeviceId: LOCAL_DEVICE,
				peerDeviceId: PEER_DEVICE,
			}),
		).toEqual([]);
	});

	it("returns scopes both devices are active members of, sorted by scope_id", () => {
		insertScope("zeta", { label: "Zeta" });
		insertScope("alpha", { label: "Alpha" });
		grantMembership("zeta", LOCAL_DEVICE);
		grantMembership("zeta", PEER_DEVICE);
		grantMembership("alpha", LOCAL_DEVICE);
		grantMembership("alpha", PEER_DEVICE);

		const scopes = listAuthorizedScopesForPeer(db, {
			localDeviceId: LOCAL_DEVICE,
			peerDeviceId: PEER_DEVICE,
		});

		expect(scopes.map((s) => s.scope_id)).toEqual(["alpha", "zeta"]);
		expect(scopes[0]).toMatchObject({
			scope_id: "alpha",
			label: "Alpha",
			authority_type: "coordinator",
			membership_epoch: 0,
			sync_reset: expect.objectContaining({
				scope_id: "alpha",
				generation: 1,
			}),
		});
	});

	it("excludes scopes where the peer is not a member", () => {
		insertScope("acme-work");
		insertScope("oss");
		grantMembership("acme-work", LOCAL_DEVICE);
		grantMembership("acme-work", PEER_DEVICE);
		grantMembership("oss", LOCAL_DEVICE);
		// Peer not in oss.

		const scopes = listAuthorizedScopesForPeer(db, {
			localDeviceId: LOCAL_DEVICE,
			peerDeviceId: PEER_DEVICE,
		});
		expect(scopes.map((s) => s.scope_id)).toEqual(["acme-work"]);
	});

	it("excludes the legacy local-default scope", () => {
		insertScope("local-default", { authorityType: "local" });
		insertScope("acme-work");
		grantMembership("local-default", LOCAL_DEVICE);
		grantMembership("local-default", PEER_DEVICE);
		grantMembership("acme-work", LOCAL_DEVICE);
		grantMembership("acme-work", PEER_DEVICE);

		const scopes = listAuthorizedScopesForPeer(db, {
			localDeviceId: LOCAL_DEVICE,
			peerDeviceId: PEER_DEVICE,
		});
		expect(scopes.map((s) => s.scope_id)).toEqual(["acme-work"]);
	});

	it("excludes scopes where the peer membership is revoked", () => {
		insertScope("acme-work");
		grantMembership("acme-work", LOCAL_DEVICE);
		grantMembership("acme-work", PEER_DEVICE, "revoked");

		const scopes = listAuthorizedScopesForPeer(db, {
			localDeviceId: LOCAL_DEVICE,
			peerDeviceId: PEER_DEVICE,
		});
		expect(scopes).toEqual([]);
	});

	it("returns an empty list when local and peer device ids are equal", () => {
		insertScope("acme-work");
		grantMembership("acme-work", LOCAL_DEVICE);
		expect(
			listAuthorizedScopesForPeer(db, {
				localDeviceId: LOCAL_DEVICE,
				peerDeviceId: LOCAL_DEVICE,
			}),
		).toEqual([]);
	});

	it("marks empty authorized Spaces current after scoped bootstrap records a cursor marker", () => {
		insertScope("empty-work");
		grantMembership("empty-work", LOCAL_DEVICE);
		grantMembership("empty-work", PEER_DEVICE);
		setReplicationCursor(
			db,
			PEER_DEVICE,
			{ lastAcked: SCOPED_NULL_BASELINE_BOOTSTRAP_CURSOR_MARKER },
			"empty-work",
		);

		const scopes = listPerPeerScopeSyncState(db, {
			localDeviceId: LOCAL_DEVICE,
			peerDeviceId: PEER_DEVICE,
		});

		expect(scopes).toHaveLength(1);
		expect(scopes[0]).toMatchObject({
			bootstrapped: true,
			last_acked_cursor: null,
			last_applied_cursor: null,
			scope_id: "empty-work",
		});
	});

	it("does not treat peer-wide scoped attempts as per-Space evidence", () => {
		insertScope("empty-work");
		grantMembership("empty-work", LOCAL_DEVICE);
		grantMembership("empty-work", PEER_DEVICE);
		recordSyncAttempt(PEER_DEVICE, "2026-05-26T00:00:00.000Z");

		const scopes = listPerPeerScopeSyncState(db, {
			localDeviceId: LOCAL_DEVICE,
			peerDeviceId: PEER_DEVICE,
		});

		expect(scopes).toHaveLength(1);
		expect(scopes[0]).toMatchObject({
			bootstrapped: false,
			last_applied_cursor: null,
			scope_id: "empty-work",
		});
	});

	it("keeps newly granted Spaces pending until scoped sync records a cursor marker", () => {
		insertScope("new-work");
		grantMembership("new-work", LOCAL_DEVICE);
		grantMembership("new-work", PEER_DEVICE);
		recordSyncAttempt(PEER_DEVICE, "2026-05-26T00:00:00.000Z");

		const scopes = listPerPeerScopeSyncState(db, {
			localDeviceId: LOCAL_DEVICE,
			peerDeviceId: PEER_DEVICE,
		});

		expect(scopes).toHaveLength(1);
		expect(scopes[0]).toMatchObject({
			bootstrapped: false,
			last_applied_cursor: null,
			scope_id: "new-work",
		});
	});

	it("keeps empty Spaces pending after failed or non-scoped sync attempts", () => {
		insertScope("empty-work");
		grantMembership("empty-work", LOCAL_DEVICE);
		grantMembership("empty-work", PEER_DEVICE);
		recordSyncAttempt(PEER_DEVICE, "2026-05-26T00:00:00.000Z", { ok: false });
		recordSyncAttempt(PEER_DEVICE, "2026-05-27T00:00:00.000Z", { capability: "aware" });

		const scopes = listPerPeerScopeSyncState(db, {
			localDeviceId: LOCAL_DEVICE,
			peerDeviceId: PEER_DEVICE,
		});

		expect(scopes).toHaveLength(1);
		expect(scopes[0]).toMatchObject({
			bootstrapped: false,
			last_applied_cursor: null,
			scope_id: "empty-work",
		});
	});

	it("keeps unadvertised Spaces pending even when newer irrelevant attempts exist", () => {
		insertScope("empty-work");
		grantMembership("empty-work", LOCAL_DEVICE);
		grantMembership("empty-work", PEER_DEVICE);
		recordSyncAttempt(PEER_DEVICE, "2026-05-26T00:00:00.000Z");
		recordSyncAttempt(PEER_DEVICE, "2026-05-27T00:00:00.000Z", { ok: false });
		recordSyncAttempt(PEER_DEVICE, "2026-05-28T00:00:00.000Z", { capability: "aware" });

		const scopes = listPerPeerScopeSyncState(db, {
			localDeviceId: LOCAL_DEVICE,
			peerDeviceId: PEER_DEVICE,
		});

		expect(scopes).toHaveLength(1);
		expect(scopes[0]).toMatchObject({
			bootstrapped: false,
			last_applied_cursor: null,
			scope_id: "empty-work",
		});
	});
});
