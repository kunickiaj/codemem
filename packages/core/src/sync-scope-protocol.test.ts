import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	publicKeyFromWire,
	wireBytes,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { putRecipientPolicyDenyOverlay } from "./recipient-policy-reconciliation.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
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

const LOCAL_DEVICE = "local-device";
const PEER_DEVICE = "peer-device";
const SCOPE_ID = "acme-work";
const NOW = "2026-05-25T00:00:00.000Z";
let db: InstanceType<typeof Database>;

function insertScope(
	scopeId: string,
	opts: { membershipEpoch?: number; status?: string; authorityType?: string; label?: string } = {},
) {
	const membershipEpoch = opts.membershipEpoch ?? 0;
	const status = opts.status ?? "active";
	const authorityType = opts.authorityType ?? "coordinator";
	db.prepare(
		`INSERT OR REPLACE INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			) VALUES (?, ?, 'team', ?, 'coordinator-1', 'group-1', ?, ?, ?, ?)`,
	).run(
		scopeId,
		opts.label ?? `Scope ${scopeId}`,
		authorityType,
		membershipEpoch,
		status,
		NOW,
		NOW,
	);
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

function useScopeTestFixture() {
	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
	});
}

describe("parseSyncScopeRequest scoped path", () => {
	useScopeTestFixture();

	it("rejects coordinator raw memberships without retained refresh evidence", () => {
		// Arrange: fresh-looking rows are not coordinator enrollment evidence.
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, LOCAL_DEVICE);
		grantMembership(SCOPE_ID, PEER_DEVICE);
		// Act: admission and advertisement must apply the same evidence requirement.
		const context = {
			db,
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
			negotiatedCapability: "scoped" as const,
			peerDeviceId: PEER_DEVICE,
		};
		const admission = parseSyncScopeRequest(SCOPE_ID, true, context);
		const advertised = listAuthorizedScopesForPeer(db, context);
		// Assert: no scoped data path is admitted from device IDs alone.
		expect(admission).toEqual({ ok: false, reason: "missing_scope" });
		expect(advertised).toEqual([]);
	});

	it("accepts a scoped request when peer is an authorized active member", async () => {
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, LOCAL_DEVICE);
		grantMembership(SCOPE_ID, PEER_DEVICE);
		await refreshTestScopeRows(db);
		const result = parseSyncScopeRequest(SCOPE_ID, true, {
			db,
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
			negotiatedCapability: "scoped",
			peerDeviceId: PEER_DEVICE,
		});
		expect(result).toEqual({ ok: true, mode: "scoped", scope_id: SCOPE_ID });
	});
});

const otherWire = wireBytes();
otherWire[50] ^= 1;
const wrongKey = publicKeyFromWire(otherWire);
const keyContext = {
	localDeviceId: LOCAL_DEVICE,
	peerDeviceId: PEER_DEVICE,
	localSigningPublicKey: CANONICAL_PUBLIC_KEY,
	authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
	negotiatedCapability: "scoped" as const,
};

describe("managed signing-key admission and advertisement", () => {
	useScopeTestFixture();
	it.each([
		{ name: "wrong peer", authenticatedPeerSigningKey: wrongKey },
		{ name: "wrong local", localSigningPublicKey: wrongKey },
		{ name: "missing peer", authenticatedPeerSigningKey: undefined },
		{ name: "missing local", localSigningPublicKey: undefined },
		{ name: "legacy opaque fingerprint", authenticatedPeerSigningKey: "fp-peer" },
	])(
		"denies admission and advertisement with $name key despite fresh device memberships",
		async ({ name: _name, ...keys }) => {
			// Arrange: the coordinator verified both device IDs with their enrolled keys.
			insertScope(SCOPE_ID);
			grantMembership(SCOPE_ID, LOCAL_DEVICE);
			grantMembership(SCOPE_ID, PEER_DEVICE);
			await refreshTestScopeRows(db);
			const context = { ...keyContext, ...keys };
			// Act: actual caller keys must be checked, not inferred from device IDs.
			const admission = parseSyncScopeRequest(SCOPE_ID, true, { db, ...context });
			const advertised = listAuthorizedScopesForPeer(db, context);
			// Assert: a fresh membership does not authorize a different signer.
			expect(admission).toEqual({ ok: false, reason: "missing_scope" });
			expect(advertised).toEqual([]);
		},
	);

	it.each(ACCEPTED_ALIASES)(
		"admits canonical enrolled identity with $name signing-key alias",
		async ({ publicKey }) => {
			// Arrange: refresh retains a canonical key identity, not presentation text.
			insertScope(SCOPE_ID);
			grantMembership(SCOPE_ID, LOCAL_DEVICE);
			grantMembership(SCOPE_ID, PEER_DEVICE);
			await refreshTestScopeRows(db);
			const context = {
				...keyContext,
				localSigningPublicKey: publicKey,
				authenticatedPeerSigningKey: publicKey,
			};
			// Act.
			const admission = parseSyncScopeRequest(SCOPE_ID, true, { db, ...context });
			const advertised = listAuthorizedScopesForPeer(db, context);
			// Assert.
			expect(admission).toEqual({ ok: true, mode: "scoped", scope_id: SCOPE_ID });
			expect(advertised.map((scope) => scope.scope_id)).toEqual([SCOPE_ID]);
		},
	);
});

describe("retained scope evidence and direct grants", () => {
	useScopeTestFixture();
	it("keeps verified offline evidence usable without advancing cache timestamps", async () => {
		// Arrange: the last successful refresh predates an unavailable coordinator.
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, LOCAL_DEVICE);
		grantMembership(SCOPE_ID, PEER_DEVICE);
		await refreshTestScopeRows(db);
		db.prepare(
			"UPDATE scope_membership_cache_state SET last_success_at = '2000-01-01T00:00:00.000Z', last_error = 'coordinator_unavailable'",
		).run();
		const before = db.prepare("SELECT * FROM scope_membership_cache_state").all();
		// Act: a read must neither expire unchanged evidence nor refresh the cache.
		const admission = parseSyncScopeRequest(SCOPE_ID, true, { db, ...keyContext });
		const advertised = listAuthorizedScopesForPeer(db, keyContext);
		// Assert.
		expect(admission.ok).toBe(true);
		expect(advertised.map((scope) => scope.scope_id)).toEqual([SCOPE_ID]);
		expect(db.prepare("SELECT * FROM scope_membership_cache_state").all()).toEqual(before);
	});

	it("rejects the old signing key after a refresh retains peer rotation", async () => {
		// Arrange: the second genuine refresh replaces the enrollment for the same device.
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, LOCAL_DEVICE);
		grantMembership(SCOPE_ID, PEER_DEVICE);
		await refreshTestScopeRows(db);
		await refreshTestScopeRows(db, { [PEER_DEVICE]: wrongKey });
		// Act.
		const oldAdmission = parseSyncScopeRequest(SCOPE_ID, true, { db, ...keyContext });
		const oldAdvertisement = listAuthorizedScopesForPeer(db, keyContext);
		const rotatedAdmission = parseSyncScopeRequest(SCOPE_ID, true, {
			db,
			...keyContext,
			authenticatedPeerSigningKey: wrongKey,
		});
		// Assert: only the newly enrolled signer can use the device's scope.
		expect(oldAdmission).toEqual({ ok: false, reason: "missing_scope" });
		expect(oldAdvertisement).toEqual([]);
		expect(rotatedAdmission.ok).toBe(true);
	});

	it.each(["manual", "invite"])(
		"retains unmanaged %s direct-scope admission without coordinator evidence",
		(authorityType) => {
			// Arrange: direct scopes are not coordinator-managed memberships.
			insertScope(SCOPE_ID, { authorityType });
			grantMembership(SCOPE_ID, LOCAL_DEVICE);
			grantMembership(SCOPE_ID, PEER_DEVICE);
			// Act.
			const admitted = parseSyncScopeRequest(SCOPE_ID, true, { db, ...keyContext });
			db.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE device_id = ?").run(
				PEER_DEVICE,
			);
			const revoked = parseSyncScopeRequest(SCOPE_ID, true, { db, ...keyContext });
			// Assert: direct grants remain usable, but revocation still blocks admission.
			expect(admitted.ok).toBe(true);
			expect(revoked).toEqual({ ok: false, reason: "scope_inactive" });
		},
	);
});

describe("scoped admission failure reasons", () => {
	useScopeTestFixture();
	it("rejects an active custom local-authority scope even when both devices are members", () => {
		insertScope(SCOPE_ID, { authorityType: "local" });
		grantMembership(SCOPE_ID, LOCAL_DEVICE);
		grantMembership(SCOPE_ID, PEER_DEVICE);

		const result = parseSyncScopeRequest(SCOPE_ID, true, {
			db,
			localDeviceId: LOCAL_DEVICE,
			negotiatedCapability: "scoped",
			peerDeviceId: PEER_DEVICE,
		});

		expect(result).toEqual({ ok: false, reason: "missing_scope" });
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

	it("rejects with missing_scope when peer is not a member", async () => {
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, LOCAL_DEVICE);
		// Peer not granted.
		await refreshTestScopeRows(db);
		const result = parseSyncScopeRequest(SCOPE_ID, true, {
			...keyContext,
			db,
		});
		expect(result).toEqual({ ok: false, reason: "missing_scope" });
	});

	it("rejects with missing_scope when local device is not a member", async () => {
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, PEER_DEVICE);
		// Local device not granted; peer membership alone is not enough.
		await refreshTestScopeRows(db);
		const result = parseSyncScopeRequest(SCOPE_ID, true, {
			...keyContext,
			db,
		});
		expect(result).toEqual({ ok: false, reason: "missing_scope" });
	});

	it("rejects with stale_epoch when peer membership epoch is behind authority", async () => {
		insertScope(SCOPE_ID, { membershipEpoch: 5 });
		grantMembership(SCOPE_ID, LOCAL_DEVICE, { membershipEpoch: 5 });
		grantMembership(SCOPE_ID, PEER_DEVICE, { membershipEpoch: 5 });
		await refreshTestScopeRows(db);
		db.prepare("UPDATE scope_memberships SET membership_epoch = 3 WHERE device_id = ?").run(
			PEER_DEVICE,
		);
		const result = parseSyncScopeRequest(SCOPE_ID, true, {
			db,
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
			negotiatedCapability: "scoped",
			peerDeviceId: PEER_DEVICE,
		});
		expect(result).toEqual({ ok: false, reason: "stale_epoch" });
	});

	it("rejects with scope_inactive when membership was revoked", async () => {
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, LOCAL_DEVICE);
		grantMembership(SCOPE_ID, PEER_DEVICE);
		await refreshTestScopeRows(db);
		db.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE device_id = ?").run(
			PEER_DEVICE,
		);
		const result = parseSyncScopeRequest(SCOPE_ID, true, {
			db,
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
			negotiatedCapability: "scoped",
			peerDeviceId: PEER_DEVICE,
		});
		expect(result).toEqual({ ok: false, reason: "scope_inactive" });
	});

	it("rejects a scoped request while an exact peer deny overlay is pending", async () => {
		insertScope(SCOPE_ID);
		grantMembership(SCOPE_ID, LOCAL_DEVICE);
		grantMembership(SCOPE_ID, PEER_DEVICE);
		await refreshTestScopeRows(db);
		putRecipientPolicyDenyOverlay(db, {
			canonicalProjectIdentity: "project:acme",
			scopeId: SCOPE_ID,
			deviceId: PEER_DEVICE,
			generation: 2,
			reasonCode: "pending_revoke",
			now: NOW,
		});

		expect(
			parseSyncScopeRequest(SCOPE_ID, true, {
				db,
				localDeviceId: LOCAL_DEVICE,
				localSigningPublicKey: CANONICAL_PUBLIC_KEY,
				authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
				negotiatedCapability: "scoped",
				peerDeviceId: PEER_DEVICE,
			}),
		).toEqual({ ok: false, reason: "missing_scope" });
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

describe("listAuthorizedScopesForPeer", () => {
	useScopeTestFixture();
	it("returns an empty list when the local device has no memberships", () => {
		expect(
			listAuthorizedScopesForPeer(db, {
				localDeviceId: LOCAL_DEVICE,
				peerDeviceId: PEER_DEVICE,
			}),
		).toEqual([]);
	});

	it("returns scopes both devices are active members of, sorted by scope_id", async () => {
		insertScope("zeta", { label: "Zeta" });
		insertScope("alpha", { label: "Alpha" });
		grantMembership("zeta", LOCAL_DEVICE);
		grantMembership("zeta", PEER_DEVICE);
		grantMembership("alpha", LOCAL_DEVICE);
		grantMembership("alpha", PEER_DEVICE);

		await refreshTestScopeRows(db);
		const scopes = listAuthorizedScopesForPeer(db, {
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
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

	it("excludes scopes where the peer is not a member", async () => {
		insertScope("acme-work");
		insertScope("oss");
		grantMembership("acme-work", LOCAL_DEVICE);
		grantMembership("acme-work", PEER_DEVICE);
		grantMembership("oss", LOCAL_DEVICE);
		// Peer not in oss.

		await refreshTestScopeRows(db);
		const scopes = listAuthorizedScopesForPeer(db, {
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
			peerDeviceId: PEER_DEVICE,
		});
		expect(scopes.map((s) => s.scope_id)).toEqual(["acme-work"]);
	});

	it("excludes the legacy local-default scope", async () => {
		insertScope("local-default", { authorityType: "local" });
		insertScope("acme-work");
		grantMembership("local-default", LOCAL_DEVICE);
		grantMembership("local-default", PEER_DEVICE);
		grantMembership("acme-work", LOCAL_DEVICE);
		grantMembership("acme-work", PEER_DEVICE);

		await refreshTestScopeRows(db);
		const scopes = listAuthorizedScopesForPeer(db, {
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
			peerDeviceId: PEER_DEVICE,
		});
		expect(scopes.map((s) => s.scope_id)).toEqual(["acme-work"]);
	});

	it("excludes custom local-authority scopes while keeping coordinator siblings", async () => {
		insertScope("local-notes", { authorityType: "local" });
		insertScope("team-notes");
		for (const scopeId of ["local-notes", "team-notes"]) {
			grantMembership(scopeId, LOCAL_DEVICE);
			grantMembership(scopeId, PEER_DEVICE);
		}

		await refreshTestScopeRows(db);
		const scopes = listAuthorizedScopesForPeer(db, {
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
			peerDeviceId: PEER_DEVICE,
		});

		expect(scopes.map((scope) => scope.scope_id)).toEqual(["team-notes"]);
		expect(scopes[0]?.authority_type).toBe("coordinator");
	});

	it("excludes scopes where the peer membership is revoked", async () => {
		insertScope("acme-work");
		grantMembership("acme-work", LOCAL_DEVICE);
		grantMembership("acme-work", PEER_DEVICE);
		await refreshTestScopeRows(db);
		db.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE device_id = ?").run(
			PEER_DEVICE,
		);

		const scopes = listAuthorizedScopesForPeer(db, {
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
			peerDeviceId: PEER_DEVICE,
		});
		expect(scopes).toEqual([]);
	});
});

describe("scope advertisement deny overlays", () => {
	useScopeTestFixture();
	it("does not advertise an exact denied scope and leaves sibling scopes available", async () => {
		insertScope("acme-work");
		insertScope("oss");
		for (const scopeId of ["acme-work", "oss"]) {
			grantMembership(scopeId, LOCAL_DEVICE);
			grantMembership(scopeId, PEER_DEVICE);
		}
		await refreshTestScopeRows(db);
		putRecipientPolicyDenyOverlay(db, {
			canonicalProjectIdentity: "project:acme",
			scopeId: "acme-work",
			deviceId: PEER_DEVICE,
			generation: 2,
			reasonCode: "pending_revoke",
			now: NOW,
		});

		expect(
			listAuthorizedScopesForPeer(db, {
				localDeviceId: LOCAL_DEVICE,
				peerDeviceId: PEER_DEVICE,
				localSigningPublicKey: CANONICAL_PUBLIC_KEY,
				authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
			}).map((scope) => scope.scope_id),
		).toEqual(["oss"]);
	});

	it("does not advertise a scope denied for the local device", async () => {
		insertScope("acme-work");
		grantMembership("acme-work", LOCAL_DEVICE);
		grantMembership("acme-work", PEER_DEVICE);
		await refreshTestScopeRows(db);
		putRecipientPolicyDenyOverlay(db, {
			canonicalProjectIdentity: "project:acme",
			scopeId: "acme-work",
			deviceId: LOCAL_DEVICE,
			generation: 2,
			reasonCode: "pending_revoke",
			now: NOW,
		});

		expect(
			listAuthorizedScopesForPeer(db, {
				localDeviceId: LOCAL_DEVICE,
				localSigningPublicKey: CANONICAL_PUBLIC_KEY,
				authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
				peerDeviceId: PEER_DEVICE,
			}),
		).toEqual([]);
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
});

describe("authorized per-peer scope diagnostics", () => {
	useScopeTestFixture();
	it("marks empty authorized Spaces current after scoped bootstrap records a cursor marker", async () => {
		insertScope("empty-work");
		grantMembership("empty-work", LOCAL_DEVICE);
		grantMembership("empty-work", PEER_DEVICE);
		setReplicationCursor(
			db,
			PEER_DEVICE,
			{ lastAcked: SCOPED_NULL_BASELINE_BOOTSTRAP_CURSOR_MARKER },
			"empty-work",
		);

		await refreshTestScopeRows(db);
		const scopes = listPerPeerScopeSyncState(db, {
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
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

	it("does not treat peer-wide scoped attempts as per-Space evidence", async () => {
		insertScope("empty-work");
		grantMembership("empty-work", LOCAL_DEVICE);
		grantMembership("empty-work", PEER_DEVICE);
		recordSyncAttempt(PEER_DEVICE, "2026-05-26T00:00:00.000Z");

		await refreshTestScopeRows(db);
		const scopes = listPerPeerScopeSyncState(db, {
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
			peerDeviceId: PEER_DEVICE,
		});

		expect(scopes).toHaveLength(1);
		expect(scopes[0]).toMatchObject({
			bootstrapped: false,
			last_applied_cursor: null,
			scope_id: "empty-work",
		});
	});

	it("keeps newly granted Spaces pending until scoped sync records a cursor marker", async () => {
		insertScope("new-work");
		grantMembership("new-work", LOCAL_DEVICE);
		grantMembership("new-work", PEER_DEVICE);
		recordSyncAttempt(PEER_DEVICE, "2026-05-26T00:00:00.000Z");

		await refreshTestScopeRows(db);
		const scopes = listPerPeerScopeSyncState(db, {
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
			peerDeviceId: PEER_DEVICE,
		});

		expect(scopes).toHaveLength(1);
		expect(scopes[0]).toMatchObject({
			bootstrapped: false,
			last_applied_cursor: null,
			scope_id: "new-work",
		});
	});

	it("keeps empty Spaces pending after failed or non-scoped sync attempts", async () => {
		insertScope("empty-work");
		grantMembership("empty-work", LOCAL_DEVICE);
		grantMembership("empty-work", PEER_DEVICE);
		recordSyncAttempt(PEER_DEVICE, "2026-05-26T00:00:00.000Z", { ok: false });
		recordSyncAttempt(PEER_DEVICE, "2026-05-27T00:00:00.000Z", { capability: "aware" });

		await refreshTestScopeRows(db);
		const scopes = listPerPeerScopeSyncState(db, {
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
			peerDeviceId: PEER_DEVICE,
		});

		expect(scopes).toHaveLength(1);
		expect(scopes[0]).toMatchObject({
			bootstrapped: false,
			last_applied_cursor: null,
			scope_id: "empty-work",
		});
	});

	it("keeps unadvertised Spaces pending even when newer irrelevant attempts exist", async () => {
		insertScope("empty-work");
		grantMembership("empty-work", LOCAL_DEVICE);
		grantMembership("empty-work", PEER_DEVICE);
		recordSyncAttempt(PEER_DEVICE, "2026-05-26T00:00:00.000Z");
		recordSyncAttempt(PEER_DEVICE, "2026-05-27T00:00:00.000Z", { ok: false });
		recordSyncAttempt(PEER_DEVICE, "2026-05-28T00:00:00.000Z", { capability: "aware" });

		await refreshTestScopeRows(db);
		const scopes = listPerPeerScopeSyncState(db, {
			localDeviceId: LOCAL_DEVICE,
			localSigningPublicKey: CANONICAL_PUBLIC_KEY,
			authenticatedPeerSigningKey: CANONICAL_PUBLIC_KEY,
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
