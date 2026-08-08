import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertLegacyShareGrantAllowed,
	type RecipientPolicyReconcilerEffects,
	reconcileRecipientPolicyProject,
} from "./recipient-policy-reconciler.js";
import {
	getRecipientPolicyAuthorityState,
	listRecipientPolicyDenyOverlays,
	putRecipientPolicyDenyOverlay,
} from "./recipient-policy-reconciliation.js";
import { initTestSchema } from "./test-utils.js";

const PROJECT = "https://git.example.invalid/acme/reconciled.git";
const SCOPE = "managed-project-scope";
const BASE_TIME = Date.parse("2026-07-22T10:00:00.000Z");

function insertPolicyGraph(db: InstanceType<typeof Database>): void {
	const now = new Date(BASE_TIME).toISOString();
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES ('identity-a', 'Identity A', 1, 'active', ?, ?)`,
	).run(now, now);
	const insertDevice = db.prepare(
		`INSERT INTO identity_devices(
		 device_id, identity_id, display_name, status, provenance, revision, migration_state,
		 idempotency_key, created_at, updated_at
		 ) VALUES (?, 'identity-a', ?, 'active', 'test', '1', 'native', ?, ?, ?)`,
	);
	insertDevice.run("device-keep", "Keep", "device:keep", now, now);
	insertDevice.run("device-new", "New", "device:new", now, now);
	db.prepare(
		`INSERT INTO project_recipients(
		 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
		 policy_revision, migration_state, idempotency_key, created_at, updated_at
		 ) VALUES (?, 'identity', 'identity-a', 'active', 'test', '1', 'native', 'recipient:a', ?, ?)`,
	).run(PROJECT, now, now);
	db.prepare(
		`INSERT INTO replication_scopes(
		 scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch,
		 status, created_at, updated_at
		 ) VALUES (?, 'Managed Project', 'managed_project', 'coordinator', 'coord', 'group', 1,
		 'active', ?, ?)`,
	).run(SCOPE, now, now);
	db.prepare(
		`INSERT INTO project_scope_mappings(
		 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
		 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`,
	).run(PROJECT, PROJECT, SCOPE, now, now);
}

function harness(active: string[]) {
	let tick = 0;
	const members = new Set(active);
	const calls: string[] = [];
	const now = () => new Date(BASE_TIME + tick++ * 1_000).toISOString();
	const effects: RecipientPolicyReconcilerEffects = {
		now,
		snapshot: vi.fn(async () => {
			calls.push("snapshot");
			const deviceIds = [...members].toSorted();
			return {
				authoritative: true,
				scopeId: SCOPE,
				fingerprint: `snapshot:${deviceIds.join(",")}`,
				observedAt: now(),
				memberships: deviceIds.map((deviceId) => ({ deviceId, status: "active" as const })),
			};
		}),
		listBoundaryEnrollments: vi.fn(async () => [
			{
				deviceId: "device-keep",
				identityId: "identity-a",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: true,
			},
			{
				deviceId: "device-new",
				identityId: "identity-a",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				enabled: true,
			},
		]),
		probeCapability: vi.fn(async ({ deviceId }) => {
			calls.push(`probe:${deviceId}`);
			return "supported";
		}),
		revoke: vi.fn(async (input) => {
			calls.push(`revoke:${input.deviceId}`);
			members.delete(input.deviceId);
			return {
				effectId: input.effectId,
				scopeId: input.scopeId,
				deviceId: input.deviceId,
				status: "revoked",
			};
		}),
		grant: vi.fn(async (input) => {
			calls.push(`grant:${input.deviceId}`);
			members.add(input.deviceId);
			return {
				effectId: input.effectId,
				scopeId: input.scopeId,
				deviceId: input.deviceId,
				status: "active",
			};
		}),
		refresh: vi.fn(async () => {
			calls.push("refresh");
		}),
	};
	return { calls, effects, members };
}

function insertActiveAuthority(db: InstanceType<typeof Database>): void {
	const now = new Date(BASE_TIME).toISOString();
	db.prepare(
		`INSERT INTO recipient_policy_authority_states(
		 canonical_project_identity, authority_state, generation, desired_devices_digest,
		 state_changed_at, created_at, updated_at
		 ) VALUES (?, 'active', 1, 'old-desired', ?, ?, ?)`,
	).run(PROJECT, now, now, now);
}

describe("recipient-policy reconciler executor", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		insertPolicyGraph(db);
	});

	afterEach(() => db.close());

	it("revokes before grants, verifies parity, and activates only on a later no-op pass", async () => {
		const { calls, effects } = harness(["device-keep", "device-old"]);

		const first = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(first).toMatchObject({
			status: "parity_pending",
			revokedDeviceIds: ["device-old"],
			grantedDeviceIds: ["device-new"],
			deliveredCopiesMayRemain: true,
		});
		expect(calls).toEqual([
			"snapshot",
			"revoke:device-old",
			"refresh",
			"probe:device-keep",
			"probe:device-new",
			"grant:device-new",
			"refresh",
			"snapshot",
		]);
		expect(getRecipientPolicyAuthorityState(db, PROJECT)?.authorityState).toBe("eligible");
		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([]);

		const second = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-b" },
			effects,
		);

		expect(second.status).toBe("active");
		expect(second.revokedDeviceIds).toEqual([]);
		expect(second.grantedDeviceIds).toEqual([]);
		expect(vi.mocked(effects.revoke)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(effects.grant)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(effects.refresh)).toHaveBeenCalledTimes(3);
		expect(getRecipientPolicyAuthorityState(db, PROJECT)?.authorityState).toBe("active");
	});

	it("does not grant a policy device that is not enrolled in the boundary group", async () => {
		const { effects } = harness(["device-keep"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: "identity-a",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: true,
			},
		]);
		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-boundary" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "parity_pending",
			grantedDeviceIds: [],
		});
		expect(effects.grant).not.toHaveBeenCalled();
		expect(vi.mocked(effects.probeCapability).mock.calls.map(([input]) => input.deviceId)).toEqual([
			"device-keep",
		]);
	});

	it("does not grant when the enrollment Identity changes during preflight", async () => {
		const { effects } = harness(["device-keep"]);
		vi.mocked(effects.listBoundaryEnrollments)
			.mockResolvedValueOnce([
				{
					deviceId: "device-keep",
					identityId: "identity-a",
					publicKey: "pk-keep",
					fingerprint: "fp-keep",
					enabled: true,
				},
				{
					deviceId: "device-new",
					identityId: "identity-a",
					publicKey: "pk-new",
					fingerprint: "fp-new",
					enabled: true,
				},
			])
			.mockResolvedValueOnce([
				{
					deviceId: "device-keep",
					identityId: "identity-a",
					publicKey: "pk-keep",
					fingerprint: "fp-keep",
					enabled: true,
				},
				{
					deviceId: "device-new",
					identityId: "identity-other",
					publicKey: "pk-new-other",
					fingerprint: "fp-new-other",
					enabled: true,
				},
			]);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-identity-race" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "stale",
			safeErrorCode: "recipient_policy_generation_stale",
			grantedDeviceIds: [],
		});
		expect(effects.grant).not.toHaveBeenCalled();
	});

	it("does not grant when the enrollment becomes disabled during preflight", async () => {
		const { effects } = harness(["device-keep"]);
		vi.mocked(effects.listBoundaryEnrollments)
			.mockResolvedValueOnce([
				{
					deviceId: "device-keep",
					identityId: "identity-a",
					publicKey: "pk-keep",
					fingerprint: "fp-keep",
					enabled: true,
				},
				{
					deviceId: "device-new",
					identityId: "identity-a",
					publicKey: "pk-new",
					fingerprint: "fp-new",
					enabled: true,
				},
			])
			.mockResolvedValueOnce([
				{
					deviceId: "device-keep",
					identityId: "identity-a",
					publicKey: "pk-keep",
					fingerprint: "fp-keep",
					enabled: true,
				},
				{
					deviceId: "device-new",
					identityId: null,
					publicKey: "pk-new",
					fingerprint: "fp-new",
					enabled: false,
				},
			]);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-enrollment-race" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "stale",
			safeErrorCode: "recipient_policy_generation_stale",
			grantedDeviceIds: [],
		});
		expect(effects.grant).not.toHaveBeenCalled();
	});

	it("revokes a new grant immediately when its enrollment Identity changes", async () => {
		const { effects } = harness(["device-keep"]);
		const matching = [
			{
				deviceId: "device-keep",
				identityId: "identity-a",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: true,
			},
			{
				deviceId: "device-new",
				identityId: "identity-a",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				enabled: true,
			},
		];
		vi.mocked(effects.listBoundaryEnrollments)
			.mockResolvedValueOnce(matching)
			.mockResolvedValueOnce(matching)
			.mockResolvedValue([
				{
					deviceId: "device-keep",
					identityId: "identity-a",
					publicKey: "pk-keep",
					fingerprint: "fp-keep",
					enabled: true,
				},
				{
					deviceId: "device-new",
					identityId: "identity-other",
					publicKey: "pk-new-other",
					fingerprint: "fp-new-other",
					enabled: true,
				},
			]);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-post-grant-identity-race" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "stale",
			safeErrorCode: "recipient_policy_generation_stale",
			grantedDeviceIds: ["device-new"],
			revokedDeviceIds: ["device-new"],
		});
		expect(effects.grant).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "device-new" }));
		expect(effects.revoke).toHaveBeenCalledWith(
			expect.objectContaining({ deviceId: "device-new" }),
		);
		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([
			expect.objectContaining({
				deviceId: "device-new",
				reasonCode: "enrollment_identity_conflict",
			}),
		]);
	});

	it("revokes a new grant immediately when its enrollment becomes disabled", async () => {
		const { effects } = harness(["device-keep"]);
		const matching = [
			{
				deviceId: "device-keep",
				identityId: "identity-a",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: true,
			},
			{
				deviceId: "device-new",
				identityId: "identity-a",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				enabled: true,
			},
		];
		vi.mocked(effects.listBoundaryEnrollments)
			.mockResolvedValueOnce(matching)
			.mockResolvedValueOnce(matching)
			.mockResolvedValue([
				{
					deviceId: "device-keep",
					identityId: "identity-a",
					publicKey: "pk-keep",
					fingerprint: "fp-keep",
					enabled: true,
				},
				{
					deviceId: "device-new",
					identityId: null,
					publicKey: "pk-new",
					fingerprint: "fp-new",
					enabled: false,
				},
			]);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-post-grant-race" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "stale",
			safeErrorCode: "recipient_policy_generation_stale",
			grantedDeviceIds: ["device-new"],
			revokedDeviceIds: ["device-new"],
		});
		expect(effects.grant).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "device-new" }));
		expect(effects.revoke).toHaveBeenCalledWith(
			expect.objectContaining({ deviceId: "device-new" }),
		);
		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([
			expect.objectContaining({
				deviceId: "device-new",
				reasonCode: "enrollment_disabled",
			}),
		]);
	});

	it("revokes a current device whose boundary enrollment changed Identity", async () => {
		db.prepare(
			"UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-new'",
		).run();
		const { effects } = harness(["device-keep"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: "identity-other",
				publicKey: "key-device-keep-other",
				fingerprint: "fingerprint-device-keep-other",
				enabled: true,
			},
		]);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-enrollment-conflict" },
			effects,
		);

		expect(outcome).toMatchObject({
			revokedDeviceIds: ["device-keep"],
			grantedDeviceIds: [],
		});
		expect(effects.revoke).toHaveBeenCalledWith(
			expect.objectContaining({ scopeId: SCOPE, deviceId: "device-keep" }),
		);
		expect(effects.grant).not.toHaveBeenCalled();
	});

	it("revokes an explicitly disabled current member without mutating global owner policy", async () => {
		db.prepare(
			"UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-new'",
		).run();
		const { effects, members } = harness(["device-keep"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: null,
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: false,
			},
		]);
		vi.mocked(effects.revoke).mockImplementation(async (input) => {
			expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([
				expect.objectContaining({
					scopeId: SCOPE,
					deviceId: "device-keep",
					reasonCode: "enrollment_disabled",
				}),
			]);
			members.delete(input.deviceId);
			return {
				effectId: input.effectId,
				scopeId: input.scopeId,
				deviceId: input.deviceId,
				status: "revoked",
			};
		});

		const first = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-disabled-first" },
			effects,
		);
		const second = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-disabled-second" },
			effects,
		);

		expect(first).toMatchObject({ status: "parity_pending", revokedDeviceIds: ["device-keep"] });
		expect(second).toMatchObject({ status: "active", revokedDeviceIds: [] });
		expect(effects.revoke).toHaveBeenCalledTimes(1);
		expect(
			db.prepare("SELECT status FROM identity_devices WHERE device_id = 'device-keep'").get(),
		).toEqual({ status: "active" });
	});

	it("stages every disabled-member deny overlay before the first revoke", async () => {
		const { effects } = harness(["device-keep", "device-new"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: null,
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: false,
			},
			{
				deviceId: "device-new",
				identityId: null,
				publicKey: "pk-new",
				fingerprint: "fp-new",
				enabled: false,
			},
		]);
		vi.mocked(effects.revoke).mockImplementation(async () => {
			expect(
				listRecipientPolicyDenyOverlays(db, PROJECT)
					.map(({ deviceId }) => deviceId)
					.toSorted(),
			).toEqual(["device-keep", "device-new"]);
			throw new Error("coordinator_unavailable");
		});

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-disabled-failure" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "needs_attention",
			safeErrorCode: "recipient_policy_effect_failed",
		});
		expect(effects.revoke).toHaveBeenCalledTimes(1);
		expect(
			listRecipientPolicyDenyOverlays(db, PROJECT)
				.map(({ deviceId }) => deviceId)
				.toSorted(),
		).toEqual(["device-keep", "device-new"]);
	});

	it("leaves the same device active in another managed Project group", async () => {
		db.prepare(
			"UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-new'",
		).run();
		const otherProject = "https://git.example.invalid/acme/other.git";
		const otherScope = "managed-project-scope-other";
		const now = new Date(BASE_TIME).toISOString();
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity', 'identity-a', 'active', 'test', '1', 'native', 'recipient:other', ?, ?)`,
		).run(otherProject, now, now);
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch,
			 status, created_at, updated_at
			 ) VALUES (?, 'Other Project', 'managed_project', 'coordinator', 'coord', 'group-other', 1,
			 'active', ?, ?)`,
		).run(otherScope, now, now);
		db.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`,
		).run(otherProject, otherProject, otherScope, now, now);
		const { effects } = harness(["device-keep"]);
		vi.mocked(effects.snapshot).mockImplementation(async () => ({
			authoritative: true,
			scopeId: otherScope,
			fingerprint: "snapshot:other:device-keep",
			observedAt: effects.now(),
			memberships: [{ deviceId: "device-keep", status: "active" }],
		}));
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: "identity-a",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: true,
			},
		]);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: otherProject, leaseOwner: "worker-other-group" },
			effects,
		);

		expect(outcome.revokedDeviceIds).toEqual([]);
		expect(effects.revoke).not.toHaveBeenCalled();
	});

	it("does not revoke a current policy device merely omitted from boundary enrollments", async () => {
		db.prepare(
			"UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-new'",
		).run();
		const { effects } = harness(["device-keep"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([]);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-enrollment-omission" },
			effects,
		);

		expect(outcome.revokedDeviceIds).toEqual([]);
		expect(effects.revoke).not.toHaveBeenCalled();
	});

	it("does not treat an enabled enrollment without an Identity as a revocation signal", async () => {
		db.prepare(
			"UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-new'",
		).run();
		const { effects } = harness(["device-keep"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: null,
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: true,
			},
		]);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-null-identity" },
			effects,
		);

		expect(outcome.revokedDeviceIds).toEqual([]);
		expect(effects.revoke).not.toHaveBeenCalled();
	});

	it("blocks legacy grants when active authority excludes a policy-desired device", () => {
		insertActiveAuthority(db);

		expect(() =>
			assertLegacyShareGrantAllowed(db, {
				canonicalProjectIdentity: PROJECT,
				deviceId: "device-keep",
			}),
		).toThrow("recipient_policy_legacy_grant_blocked");
	});

	it("allows legacy retries while active authority still matches policy", async () => {
		const { effects } = harness(["device-keep", "device-new"]);
		await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-activate-1" },
			effects,
		);
		await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-activate-2" },
			effects,
		);

		expect(getRecipientPolicyAuthorityState(db, PROJECT)?.authorityState).toBe("active");
		expect(() =>
			assertLegacyShareGrantAllowed(db, {
				canonicalProjectIdentity: PROJECT,
				deviceId: "device-keep",
			}),
		).not.toThrow();
	});

	it("revokes owner-policy removals when the boundary enrollment read fails", async () => {
		const { effects } = harness(["device-keep", "device-old"]);
		vi.mocked(effects.listBoundaryEnrollments).mockRejectedValue(
			new Error("recipient_policy_snapshot_not_fresh"),
		);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-revoke" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "waiting",
			safeErrorCode: "recipient_policy_snapshot_not_fresh",
			revokedDeviceIds: ["device-old"],
			grantedDeviceIds: [],
		});
		expect(effects.revoke).toHaveBeenCalledWith(
			expect.objectContaining({ scopeId: SCOPE, deviceId: "device-old" }),
		);
		expect(effects.refresh).toHaveBeenCalledWith({
			canonicalProjectIdentity: PROJECT,
			scopeId: SCOPE,
		});
		expect(effects.grant).not.toHaveBeenCalled();
	});

	it("revokes removals before rejecting an unsupported grant candidate", async () => {
		const { effects } = harness(["device-keep", "device-old"]);
		insertActiveAuthority(db);
		vi.mocked(effects.probeCapability).mockImplementation(async ({ deviceId }) =>
			deviceId === "device-new" ? "unsupported" : "supported",
		);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "needs_attention",
			safeErrorCode: "recipient_policy_capability_unsupported",
			revokedDeviceIds: ["device-old"],
		});
		expect(effects.revoke).toHaveBeenCalledWith(
			expect.objectContaining({ deviceId: "device-old" }),
		);
		expect(effects.grant).not.toHaveBeenCalled();
		expect(effects.refresh).toHaveBeenCalledWith({
			canonicalProjectIdentity: PROJECT,
			scopeId: SCOPE,
		});
		expect(vi.mocked(effects.probeCapability).mock.calls.map(([input]) => input.deviceId)).toEqual([
			"device-keep",
			"device-new",
		]);
		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([
			expect.objectContaining({ scopeId: SCOPE, deviceId: "device-old" }),
		]);
		expect(getRecipientPolicyAuthorityState(db, PROJECT)?.authorityState).toBe("rolled_back");
		expect(() =>
			assertLegacyShareGrantAllowed(db, {
				canonicalProjectIdentity: PROJECT,
				deviceId: "device-old",
			}),
		).toThrow("recipient_policy_legacy_grant_blocked");
	});

	it("refreshes disabled-member revocations before unsupported capability returns", async () => {
		const { calls, effects } = harness(["device-keep"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: null,
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: false,
			},
			{
				deviceId: "device-new",
				identityId: "identity-a",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				enabled: true,
			},
		]);
		vi.mocked(effects.probeCapability).mockImplementation(async ({ deviceId }) => {
			calls.push(`probe:${deviceId}`);
			return "unsupported";
		});

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-disabled-unsupported" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "needs_attention",
			safeErrorCode: "recipient_policy_capability_unsupported",
			revokedDeviceIds: ["device-keep"],
		});
		expect(calls.indexOf("refresh")).toBeGreaterThan(calls.indexOf("revoke:device-keep"));
		expect(calls.indexOf("refresh")).toBeLessThan(calls.indexOf("probe:device-new"));
		expect(effects.grant).not.toHaveBeenCalled();
	});

	it("retries a failed revocation refresh without repeating the completed revoke", async () => {
		insertActiveAuthority(db);
		const { calls, effects } = harness(["device-keep"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: "identity-a",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: false,
			},
			{
				deviceId: "device-new",
				identityId: "identity-a",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				enabled: true,
			},
		]);
		vi.mocked(effects.probeCapability).mockImplementation(async ({ deviceId }) => {
			calls.push(`probe:${deviceId}`);
			return "unsupported";
		});
		vi.mocked(effects.refresh)
			.mockImplementationOnce(async () => {
				calls.push("refresh");
				throw new Error("refresh_failed");
			})
			.mockImplementation(async () => {
				calls.push("refresh");
			});

		const failed = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-refresh-failed" },
			effects,
		);
		const refreshGenerations = db
			.prepare(
				`SELECT DISTINCT generation FROM recipient_policy_reconciliation_steps
				 WHERE step_key LIKE 'revoke-enrollment-disabled:%'
				 OR step_key LIKE 'refresh-after-revocations-v2:%'
				 ORDER BY generation`,
			)
			.all();
		const retried = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-refresh-retry" },
			effects,
		);

		expect(failed.safeErrorCode).toBe("recipient_policy_effect_failed");
		expect(failed.revokedDeviceIds).toEqual(["device-keep"]);
		expect(retried.safeErrorCode).toBe("recipient_policy_capability_unsupported");
		expect(refreshGenerations).toEqual([{ generation: 1 }]);
		expect(
			db
				.prepare(
					`SELECT DISTINCT generation FROM recipient_policy_reconciliation_steps
					 WHERE step_key LIKE 'revoke-enrollment-disabled:%'
					 OR step_key LIKE 'refresh-after-revocations-v2:%'
					 ORDER BY generation`,
				)
				.all(),
		).toEqual([{ generation: 1 }]);
		expect(effects.revoke).toHaveBeenCalledTimes(1);
		expect(effects.refresh).toHaveBeenCalledTimes(2);
		expect(calls.lastIndexOf("refresh")).toBeLessThan(calls.lastIndexOf("probe:device-new"));
	});

	it("replays a pending refresh through the current boundary after a scope remap", async () => {
		db.prepare(
			"UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-new'",
		).run();
		const { effects, members } = harness(["device-keep"]);
		let currentScopeId = SCOPE;
		vi.mocked(effects.snapshot).mockImplementation(async () => {
			const deviceIds = [...members].toSorted();
			return {
				authoritative: true,
				scopeId: currentScopeId,
				fingerprint: `snapshot:${deviceIds.join(",")}`,
				observedAt: effects.now(),
				memberships: deviceIds.map((deviceId) => ({ deviceId, status: "active" as const })),
			};
		});
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: "identity-a",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: false,
			},
		]);
		vi.mocked(effects.refresh)
			.mockRejectedValueOnce(new Error("refresh_failed"))
			.mockResolvedValueOnce(undefined)
			.mockRejectedValue(new Error("redundant_refresh"));

		await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-old-scope" },
			effects,
		);
		currentScopeId = "managed-project-scope-remapped";
		const now = effects.now();
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch,
			 status, created_at, updated_at
			 ) VALUES (?, 'Remapped Project', 'managed_project', 'coordinator', 'coord', 'group-remapped', 1,
			 'active', ?, ?)`,
		).run(currentScopeId, now, now);
		db.prepare("UPDATE project_scope_mappings SET scope_id = ? WHERE workspace_identity = ?").run(
			currentScopeId,
			PROJECT,
		);

		const retried = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-remapped-scope" },
			effects,
		);

		expect(retried.safeErrorCode).toBeNull();
		expect(vi.mocked(effects.refresh).mock.calls.map(([input]) => input.scopeId)).toEqual([
			SCOPE,
			currentScopeId,
		]);
	});

	it("stages new revocations before retrying an older failed refresh", async () => {
		db.prepare(
			"UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-new'",
		).run();
		const { effects, members } = harness(["device-keep"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: "identity-a",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: false,
			},
		]);
		vi.mocked(effects.refresh).mockRejectedValue(new Error("refresh_failed"));

		await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-old-refresh" },
			effects,
		);
		members.add("device-old");
		const retried = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-new-revoke" },
			effects,
		);

		expect(retried.safeErrorCode).toBe("recipient_policy_effect_failed");
		expect(vi.mocked(effects.revoke).mock.calls.map(([input]) => input.deviceId)).toEqual([
			"device-keep",
			"device-old",
		]);
		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([
			expect.objectContaining({ deviceId: "device-keep" }),
			expect.objectContaining({ deviceId: "device-old" }),
		]);
	});

	it("retries an incomplete ordinary refresh without creating another step", async () => {
		const { effects } = harness(["device-keep"]);
		vi.mocked(effects.refresh).mockRejectedValue(new Error("refresh_failed"));

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const outcome = await reconcileRecipientPolicyProject(
				db,
				{ canonicalProjectIdentity: PROJECT, leaseOwner: `worker-refresh-${attempt}` },
				effects,
			);

			expect(outcome.safeErrorCode).toBe("recipient_policy_effect_failed");
			expect(
				db
					.prepare(
						`SELECT COUNT(*) FROM recipient_policy_reconciliation_steps
						 WHERE canonical_project_identity = ?
						 AND status IN ('pending', 'running', 'failed')
						 AND step_key GLOB 'refresh:*'`,
					)
					.pluck()
					.get(PROJECT),
			).toBe(1);
		}
	});

	it("retries an incomplete ordinary refresh through a remapped boundary", async () => {
		const { effects, members } = harness(["device-keep"]);
		let currentScopeId = SCOPE;
		vi.mocked(effects.snapshot).mockImplementation(async () => {
			const deviceIds = [...members].toSorted();
			return {
				authoritative: true,
				scopeId: currentScopeId,
				fingerprint: `snapshot:${deviceIds.join(",")}`,
				observedAt: effects.now(),
				memberships: deviceIds.map((deviceId) => ({ deviceId, status: "active" as const })),
			};
		});
		vi.mocked(effects.refresh)
			.mockRejectedValueOnce(new Error("refresh_failed"))
			.mockResolvedValueOnce(undefined)
			.mockRejectedValue(new Error("redundant_refresh"));

		await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-old-ordinary-scope" },
			effects,
		);
		db.prepare(
			`UPDATE recipient_policy_reconciliation_steps
			 SET effect_id = 'legacy-refresh-effect', payload_digest = 'legacy-refresh-payload'
			 WHERE canonical_project_identity = ? AND step_key GLOB 'refresh:*'
			 AND status = 'failed'`,
		).run(PROJECT);
		currentScopeId = "managed-project-scope-ordinary-remapped";
		const now = effects.now();
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch,
			 status, created_at, updated_at
			 ) VALUES (?, 'Remapped Project', 'managed_project', 'coordinator', 'coord',
			 'group-ordinary-remapped', 1, 'active', ?, ?)`,
		).run(currentScopeId, now, now);
		db.prepare("UPDATE project_scope_mappings SET scope_id = ? WHERE workspace_identity = ?").run(
			currentScopeId,
			PROJECT,
		);

		const retried = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-remapped-ordinary-scope" },
			effects,
		);

		expect(retried.safeErrorCode).toBeNull();
		expect(vi.mocked(effects.refresh).mock.calls.map(([input]) => input.scopeId)).toEqual([
			SCOPE,
			currentScopeId,
		]);
	});

	it("continues policy revokes and stages enrollment denials after a refresh failure", async () => {
		const { effects } = harness(["device-keep", "device-old-a", "device-old-b"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: "identity-a",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: false,
			},
			{
				deviceId: "device-new",
				identityId: "identity-a",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				enabled: true,
			},
		]);
		vi.mocked(effects.refresh)
			.mockRejectedValueOnce(new Error("refresh_failed"))
			.mockResolvedValue(undefined);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-refresh-denials" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "needs_attention",
			safeErrorCode: "recipient_policy_effect_failed",
			revokedDeviceIds: ["device-old-a", "device-old-b"],
		});
		expect(vi.mocked(effects.revoke).mock.calls.map(([input]) => input.deviceId)).toEqual([
			"device-old-a",
			"device-old-b",
		]);
		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ deviceId: "device-old-a", reasonCode: "pending_revoke" }),
				expect.objectContaining({ deviceId: "device-old-b", reasonCode: "pending_revoke" }),
				expect.objectContaining({ deviceId: "device-keep", reasonCode: "enrollment_disabled" }),
			]),
		);
		expect(effects.grant).not.toHaveBeenCalled();
	});

	it("refreshes each distinct enrollment revocation reason for the same snapshot", async () => {
		db.prepare(
			"UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-new'",
		).run();
		const { effects, members } = harness(["device-keep"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: "identity-b",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: true,
			},
		]);

		await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-conflict" },
			effects,
		);
		members.add("device-keep");
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: "identity-a",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: false,
			},
		]);

		await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-disabled" },
			effects,
		);

		expect(effects.revoke).toHaveBeenCalledTimes(2);
		expect(effects.refresh).toHaveBeenCalledTimes(2);
	});

	it("retries a failed coordinator mutation with the same deterministic effect identity", async () => {
		const { effects, members } = harness(["device-keep"]);
		const effectIds: string[] = [];
		let fail = true;
		vi.mocked(effects.grant).mockImplementation(async (input) => {
			effectIds.push(input.effectId);
			if (fail) {
				fail = false;
				throw new Error("response_lost");
			}
			members.add(input.deviceId);
			return {
				effectId: input.effectId,
				scopeId: input.scopeId,
				deviceId: input.deviceId,
				status: "active",
			};
		});

		const failed = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);
		const retried = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-b" },
			effects,
		);

		expect(failed.safeErrorCode).toBe("recipient_policy_effect_failed");
		expect(retried.safeErrorCode).toBeNull();
		expect(retried.status).toBe("parity_pending");
		expect(effectIds).toHaveLength(2);
		expect(effectIds[0]).toBe(effectIds[1]);
	});

	it("waits without mutations when a capability is undetermined", async () => {
		const { effects } = harness(["device-keep"]);
		vi.mocked(effects.probeCapability).mockResolvedValue("undetermined");

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "waiting",
			safeErrorCode: "recipient_policy_capability_undetermined",
		});
		expect(effects.revoke).not.toHaveBeenCalled();
		expect(effects.grant).not.toHaveBeenCalled();
	});

	it.each([
		"unsupported",
		"undetermined",
	] as const)("bounds failed capability steps across repeated %s preflights", async (capability) => {
		const { effects } = harness(["device-keep"]);
		vi.mocked(effects.probeCapability).mockResolvedValue(capability);
		const at = new Date(BASE_TIME).toISOString();
		const insert = db.prepare(
			`INSERT INTO recipient_policy_reconciliation_steps(
			 canonical_project_identity, generation, step_key, effect_id, payload_digest,
			 status, created_at, updated_at
			 ) VALUES (?, 1, ?, ?, 'payload', ?, ?, ?)`,
		);
		insert.run(PROJECT, "capability:stale:device-a", "stale-pending", "pending", at, at);
		insert.run(PROJECT, "capability:stale:device-b", "stale-running", "running", at, at);

		for (let pass = 1; pass <= 3; pass += 1) {
			const outcome = await reconcileRecipientPolicyProject(
				db,
				{ canonicalProjectIdentity: PROJECT, leaseOwner: `worker-${pass}` },
				effects,
			);

			expect(outcome.safeErrorCode).toBe(`recipient_policy_capability_${capability}`);
			expect(
				db
					.prepare(
						`SELECT COUNT(*) FROM recipient_policy_reconciliation_steps
							 WHERE canonical_project_identity = ?
							 AND status IN ('pending', 'running', 'failed')
							 AND step_key GLOB 'capability:*'`,
					)
					.pluck()
					.get(PROJECT),
			).toBe(2);
		}
	});

	it("preserves active authority while capability evidence is undetermined", async () => {
		const { effects } = harness(["device-keep"]);
		vi.mocked(effects.probeCapability).mockResolvedValue("undetermined");
		insertActiveAuthority(db);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(outcome.safeErrorCode).toBe("recipient_policy_capability_undetermined");
		expect(getRecipientPolicyAuthorityState(db, PROJECT)?.authorityState).toBe("active");
	});

	it("does not rewrite lease loss during capability preflight as undetermined", async () => {
		const { effects } = harness(["device-keep", "device-new"]);
		insertActiveAuthority(db);
		const at = new Date(BASE_TIME).toISOString();
		db.prepare(
			`INSERT INTO recipient_policy_reconciliation_steps(
			 canonical_project_identity, generation, step_key, effect_id, payload_digest,
			 status, created_at, updated_at
			 ) VALUES (?, 1, 'capability:replacement-pass:device-new', 'replacement-running',
			 'payload', 'running', ?, ?)`,
		).run(PROJECT, at, at);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{
				canonicalProjectIdentity: PROJECT,
				leaseOwner: "worker-expired",
				leaseDurationMs: 1,
			},
			effects,
		);

		expect(outcome).toMatchObject({
			status: "needs_attention",
			safeErrorCode: "recipient_policy_lease_lost",
		});
		expect(effects.probeCapability).not.toHaveBeenCalled();
		expect(getRecipientPolicyAuthorityState(db, PROJECT)?.authorityState).toBe("rolled_back");
		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM recipient_policy_reconciliation_steps
					 WHERE canonical_project_identity = ?
					 AND step_key = 'capability:replacement-pass:device-new'`,
				)
				.pluck()
				.get(PROJECT),
		).toBe(1);
	});

	it("does not rewrite capability effect failures as undetermined", async () => {
		const { effects } = harness(["device-keep", "device-new"]);
		vi.mocked(effects.probeCapability).mockRejectedValue(new Error("network_failed"));

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-failed-probe" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "needs_attention",
			safeErrorCode: "recipient_policy_effect_failed",
		});
	});

	it("preserves active authority while the coordinator snapshot is not fresh", async () => {
		const { effects } = harness(["device-keep", "device-new"]);
		vi.mocked(effects.snapshot).mockResolvedValue({
			authoritative: true,
			scopeId: SCOPE,
			fingerprint: "snapshot:stale",
			observedAt: new Date(BASE_TIME - 1_000).toISOString(),
			memberships: [],
		});
		insertActiveAuthority(db);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(outcome.safeErrorCode).toBe("recipient_policy_snapshot_not_fresh");
		expect(getRecipientPolicyAuthorityState(db, PROJECT)?.authorityState).toBe("active");
	});

	it("keeps a deny overlay until a fresh snapshot actually proves revocation", async () => {
		const { effects } = harness(["device-keep", "device-old"]);
		vi.mocked(effects.revoke).mockImplementation(async (input) => ({
			effectId: input.effectId,
			scopeId: input.scopeId,
			deviceId: input.deviceId,
			status: "revoked",
		}));

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "waiting",
			safeErrorCode: "recipient_policy_parity_incomplete",
		});
		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([
			expect.objectContaining({ deviceId: "device-old" }),
		]);
	});

	it("preserves active authority while fresh parity remains incomplete", async () => {
		const { effects } = harness(["device-keep", "device-old"]);
		vi.mocked(effects.revoke).mockImplementation(async (input) => ({
			effectId: input.effectId,
			scopeId: input.scopeId,
			deviceId: input.deviceId,
			status: "revoked",
		}));
		insertActiveAuthority(db);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(outcome.safeErrorCode).toBe("recipient_policy_parity_incomplete");
		expect(getRecipientPolicyAuthorityState(db, PROJECT)?.authorityState).toBe("active");
	});

	it("re-grants stale active membership and withholds authority until its epoch is current", async () => {
		const { effects } = harness(["device-keep", "device-new"]);
		vi.mocked(effects.snapshot).mockImplementation(async () => ({
			authoritative: true,
			scopeId: SCOPE,
			scopeMembershipEpoch: 2,
			fingerprint: "snapshot:stale-active-device-new",
			observedAt: effects.now(),
			memberships: [
				{ deviceId: "device-keep", status: "active", membershipEpoch: 2 },
				{ deviceId: "device-new", status: "active", membershipEpoch: 1 },
			],
		}));

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(effects.grant).toHaveBeenCalledWith(
			expect.objectContaining({ scopeId: SCOPE, deviceId: "device-new" }),
		);
		expect(outcome).toMatchObject({
			status: "waiting",
			safeErrorCode: "recipient_policy_parity_incomplete",
			grantedDeviceIds: ["device-new"],
		});
		expect(getRecipientPolicyAuthorityState(db, PROJECT)?.authorityState).not.toBe("active");
	});

	it("clears an abandoned deny overlay after a re-desired device is freshly verified active", async () => {
		putRecipientPolicyDenyOverlay(db, {
			canonicalProjectIdentity: PROJECT,
			scopeId: SCOPE,
			deviceId: "device-new",
			generation: 1,
			reasonCode: "pending_revoke",
			now: new Date(BASE_TIME).toISOString(),
		});
		const { effects } = harness(["device-keep", "device-new"]);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(outcome.status).toBe("parity_pending");
		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([]);
	});

	it("clears a freshly active re-enabled device overlay before capability preflight", async () => {
		insertActiveAuthority(db);
		putRecipientPolicyDenyOverlay(db, {
			canonicalProjectIdentity: PROJECT,
			scopeId: SCOPE,
			deviceId: "device-new",
			generation: 2,
			reasonCode: "enrollment_disabled",
			now: new Date(BASE_TIME).toISOString(),
		});
		const { effects } = harness(["device-keep", "device-new"]);
		vi.mocked(effects.snapshot).mockResolvedValue({
			authoritative: true,
			scopeId: SCOPE,
			scopeMembershipEpoch: 3,
			fingerprint: "snapshot:reenabled-epoch-3",
			observedAt: new Date(BASE_TIME + 10_000).toISOString(),
			memberships: ["device-keep", "device-new"].map((deviceId) => ({
				deviceId,
				status: "active" as const,
				membershipEpoch: 3,
			})),
		});
		vi.mocked(effects.probeCapability).mockResolvedValue("undetermined");

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "waiting",
			safeErrorCode: "recipient_policy_capability_undetermined",
		});
		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([]);
		expect(effects.grant).not.toHaveBeenCalled();
		expect(effects.revoke).not.toHaveBeenCalled();
	});

	it("keeps a deny overlay when active membership lacks matching enabled enrollment proof", async () => {
		insertActiveAuthority(db);
		putRecipientPolicyDenyOverlay(db, {
			canonicalProjectIdentity: PROJECT,
			scopeId: SCOPE,
			deviceId: "device-new",
			generation: 2,
			reasonCode: "enrollment_disabled",
			now: new Date(BASE_TIME).toISOString(),
		});
		const { effects } = harness(["device-keep", "device-new"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: "identity-a",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: true,
			},
		]);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "waiting",
			safeErrorCode: "recipient_policy_parity_incomplete",
		});
		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([
			expect.objectContaining({ deviceId: "device-new", scopeId: SCOPE }),
		]);
	});

	it("keeps a deny overlay when matching enrollment remains disabled", async () => {
		insertActiveAuthority(db);
		putRecipientPolicyDenyOverlay(db, {
			canonicalProjectIdentity: PROJECT,
			scopeId: SCOPE,
			deviceId: "device-new",
			generation: 2,
			reasonCode: "enrollment_disabled",
			now: new Date(BASE_TIME).toISOString(),
		});
		const { effects } = harness(["device-keep", "device-new"]);
		vi.mocked(effects.listBoundaryEnrollments).mockResolvedValue([
			{
				deviceId: "device-keep",
				identityId: "identity-a",
				publicKey: "pk-keep",
				fingerprint: "fp-keep",
				enabled: true,
			},
			{
				deviceId: "device-new",
				identityId: "identity-a",
				publicKey: "pk-new",
				fingerprint: "fp-new",
				enabled: false,
			},
		]);
		vi.mocked(effects.probeCapability).mockResolvedValue("undetermined");

		await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([
			expect.objectContaining({ deviceId: "device-new", scopeId: SCOPE }),
		]);
	});

	it("keeps a deny overlay without fresh active membership proof", async () => {
		insertActiveAuthority(db);
		putRecipientPolicyDenyOverlay(db, {
			canonicalProjectIdentity: PROJECT,
			scopeId: SCOPE,
			deviceId: "device-new",
			generation: 2,
			reasonCode: "enrollment_disabled",
			now: new Date(BASE_TIME).toISOString(),
		});
		const { effects } = harness(["device-keep"]);
		vi.mocked(effects.probeCapability).mockResolvedValue("undetermined");

		await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([
			expect.objectContaining({ deviceId: "device-new", scopeId: SCOPE }),
		]);
	});

	it("keeps a deny overlay outside the active managed boundary", async () => {
		insertActiveAuthority(db);
		putRecipientPolicyDenyOverlay(db, {
			canonicalProjectIdentity: PROJECT,
			scopeId: "other-managed-scope",
			deviceId: "device-new",
			generation: 2,
			reasonCode: "enrollment_disabled",
			now: new Date(BASE_TIME).toISOString(),
		});
		const { effects } = harness(["device-keep", "device-new"]);
		vi.mocked(effects.probeCapability).mockResolvedValue("undetermined");

		await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([
			expect.objectContaining({ deviceId: "device-new", scopeId: "other-managed-scope" }),
		]);
	});

	it("cancels a stale generation after revokes and before any grant", async () => {
		const { effects, members } = harness(["device-old"]);
		vi.mocked(effects.revoke).mockImplementation(async (input) => {
			db.prepare(
				"UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-new'",
			).run();
			members.delete(input.deviceId);
			return {
				effectId: input.effectId,
				scopeId: input.scopeId,
				deviceId: input.deviceId,
				status: "revoked",
			};
		});

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(outcome).toMatchObject({
			status: "stale",
			safeErrorCode: "recipient_policy_generation_stale",
			revokedDeviceIds: ["device-old"],
			grantedDeviceIds: [],
		});
		expect(effects.grant).not.toHaveBeenCalled();
	});

	it("rejects ambiguous exact-Project mappings before reading a coordinator snapshot", async () => {
		db.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, 999, 'test', ?, ?)`,
		).run(
			PROJECT,
			PROJECT,
			SCOPE,
			new Date(BASE_TIME).toISOString(),
			new Date(BASE_TIME).toISOString(),
		);
		const { effects } = harness(["device-keep"]);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(outcome.safeErrorCode).toBe("recipient_policy_exact_mapping_required");
		expect(effects.snapshot).not.toHaveBeenCalled();
	});

	it("recovers an expired lease but leaves an unexpired foreign lease untouched", async () => {
		const { effects } = harness(["device-keep", "device-new"]);
		db.prepare(
			`INSERT INTO recipient_policy_authority_states(
			 canonical_project_identity, authority_state, generation, state_changed_at, lease_owner,
			 lease_acquired_at, lease_expires_at, created_at, updated_at
			 ) VALUES (?, 'legacy', 0, ?, 'other-worker', ?, ?, ?, ?)`,
		).run(
			PROJECT,
			new Date(BASE_TIME).toISOString(),
			new Date(BASE_TIME).toISOString(),
			new Date(BASE_TIME + 30_000).toISOString(),
			new Date(BASE_TIME).toISOString(),
			new Date(BASE_TIME).toISOString(),
		);

		const busy = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);
		expect(busy.status).toBe("busy");
		expect(effects.snapshot).not.toHaveBeenCalled();

		db.prepare(
			"UPDATE recipient_policy_authority_states SET lease_expires_at = ? WHERE canonical_project_identity = ?",
		).run(new Date(BASE_TIME - 1_000).toISOString(), PROJECT);
		const recovered = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);
		expect(recovered.status).toBe("parity_pending");
	});

	it("rolls active authority back without granting or clearing a pending deny", async () => {
		const { effects } = harness(["device-keep", "device-old"]);
		vi.mocked(effects.probeCapability).mockResolvedValue("unsupported");
		insertActiveAuthority(db);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-a" },
			effects,
		);

		expect(outcome.status).toBe("needs_attention");
		expect(getRecipientPolicyAuthorityState(db, PROJECT)?.authorityState).toBe("rolled_back");
		expect(effects.grant).not.toHaveBeenCalled();
		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([
			expect.objectContaining({ deviceId: "device-old" }),
		]);
	});
});
