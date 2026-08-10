import {
	assertLegacyShareGrantAllowed,
	fingerprintPublicKey,
	initTestSchema,
	type MemoryStore,
	type RecipientPolicyReconcilerEffects,
	reconcileRecipientPolicyProject,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	advancePendingProjectShares,
	createRecipientPolicyReconcilerEffects,
	recipientPolicyCapabilityFromStatus,
	reconcileConfiguredCoordinatorEnrollment,
	reconcileRecipientPolicyProjects,
} from "./routes/sync.js";

describe("reconcileConfiguredCoordinatorEnrollment", () => {
	it("skips recipient devices without coordinator admin configuration", async () => {
		const result = await reconcileConfiguredCoordinatorEnrollment({ db: {} } as MemoryStore, {
			config: {
				syncCoordinatorUrl: "https://coord.example.test",
				syncCoordinatorAdminSecret: "",
				syncCoordinatorGroups: ["group-a"],
			} as never,
		});
		expect(result).toMatchObject({ skipped: true, groupsProcessed: 0 });
	});

	it("reads and reconciles each configured group", async () => {
		const calls: string[] = [];
		const result = await reconcileConfiguredCoordinatorEnrollment(
			{ db: {}, deviceId: "device-local" } as MemoryStore,
			{
				config: {
					syncCoordinatorUrl: "https://coord.example.test",
					syncCoordinatorAdminSecret: "secret",
					syncCoordinatorGroups: ["group-a", "group-b"],
				} as never,
				listDevices: async ({ groupId }) => {
					calls.push(`devices:${groupId}`);
					return [];
				},
				listConsumedTeamInvites: async ({ groupId }) => {
					calls.push(`invites:${groupId}`);
					return [];
				},
				reconcileSnapshot: (input) => {
					calls.push(`reconcile:${input.coordinatorId}:${input.groupId}:${input.localDeviceId}`);
					return {
						devicesAdded: 1,
						membershipsAdded: 2,
						identitiesAdded: 1,
						unchanged: 3,
						issues: [],
					};
				},
			},
		);

		expect(calls).toEqual([
			"devices:group-a",
			"invites:group-a",
			"reconcile:https://coord.example.test:group-a:device-local",
			"devices:group-b",
			"invites:group-b",
			"reconcile:https://coord.example.test:group-b:device-local",
		]);
		expect(result).toEqual({
			skipped: false,
			groupsProcessed: 2,
			failedGroups: 0,
			failures: [],
			devicesAdded: 2,
			membershipsAdded: 4,
			identitiesAdded: 2,
			unchanged: 6,
			issues: 0,
		});
	});

	it("reports sanitized failures for each coordinator fetch stage", async () => {
		const result = await reconcileConfiguredCoordinatorEnrollment(
			{ db: {}, deviceId: "device-local" } as MemoryStore,
			{
				config: {
					syncCoordinatorUrl: "https://coord.example.test",
					syncCoordinatorAdminSecret: "secret",
					syncCoordinatorGroups: ["group-a"],
				} as never,
				listDevices: async () => {
					throw new Error("Remote coordinator request failed (404): token=do-not-log");
				},
				listConsumedTeamInvites: async () => {
					throw new Error("coordinator_consumed_team_invite_invalid");
				},
			},
		);

		expect(result).toMatchObject({ groupsProcessed: 0, failedGroups: 1 });
		expect(result.failures).toEqual([
			{ groupId: "group-a", stage: "list_devices", code: "http_404" },
			{
				groupId: "group-a",
				stage: "list_consumed_team_invites",
				code: "coordinator_consumed_team_invite_invalid",
			},
		]);
		expect(JSON.stringify(result.failures)).not.toContain("do-not-log");
	});

	it("reports a sanitized local snapshot reconciliation failure", async () => {
		const result = await reconcileConfiguredCoordinatorEnrollment(
			{ db: {}, deviceId: "device-local" } as MemoryStore,
			{
				config: {
					syncCoordinatorUrl: "https://coord.example.test",
					syncCoordinatorAdminSecret: "secret",
					syncCoordinatorGroups: ["group-a"],
				} as never,
				listDevices: async () => [],
				listConsumedTeamInvites: async () => [],
				reconcileSnapshot: () => {
					throw new Error("database is locked at /private/path");
				},
			},
		);

		expect(result.failures).toEqual([
			{ groupId: "group-a", stage: "reconcile_snapshot", code: "unexpected_error" },
		]);
	});

	it("hashes unsafe group ids and never echoes arbitrary rejection text", async () => {
		const unsafeGroupId = "group a/../private";
		const result = await reconcileConfiguredCoordinatorEnrollment(
			{ db: {}, deviceId: "device-local" } as MemoryStore,
			{
				config: {
					syncCoordinatorUrl: "https://coord.example.test",
					syncCoordinatorAdminSecret: "secret",
					syncCoordinatorGroups: [unsafeGroupId],
				} as never,
				listDevices: async () => {
					throw "https://private.example.test/path?token=secret";
				},
				listConsumedTeamInvites: async () => [],
			},
		);

		expect(result.failures).toEqual([
			{
				groupId: expect.stringMatching(/^group_[0-9a-f]{12}$/u),
				stage: "list_devices",
				code: "unexpected_error",
			},
		]);
		const serialized = JSON.stringify(result.failures);
		expect(serialized).not.toContain(unsafeGroupId);
		expect(serialized).not.toContain("private.example.test");
	});

	it("preserves issues on fetch failure and resolves them after a successful empty snapshot", async () => {
		const db = new Database(":memory:");
		initTestSchema(db);
		try {
			db.prepare(`INSERT INTO coordinator_enrollment_reconciliation_issues(
				coordinator_id, group_id, kind, reference_id, code, status,
				first_seen_at, last_seen_at, occurrence_count, updated_at
			) VALUES (?, 'group-a', 'device', 'device-a', 'identity_not_active', 'open', ?, ?, 1, ?)`).run(
				"https://coord.example.test",
				"2026-07-29T00:00:00.000Z",
				"2026-07-29T00:00:00.000Z",
				"2026-07-29T00:00:00.000Z",
			);
			const store = { db, deviceId: "device-local" } as unknown as MemoryStore;
			const config = {
				syncCoordinatorUrl: "https://coord.example.test/",
				syncCoordinatorAdminSecret: "secret",
				syncCoordinatorGroups: ["group-a"],
			} as never;

			const failed = await reconcileConfiguredCoordinatorEnrollment(store, {
				config,
				listDevices: async () => {
					throw new Error("fetch failed");
				},
				listConsumedTeamInvites: async () => [],
			});
			expect(failed).toMatchObject({ groupsProcessed: 0, failedGroups: 1 });
			expect(
				db.prepare("SELECT status FROM coordinator_enrollment_reconciliation_issues").pluck().get(),
			).toBe("open");

			const succeeded = await reconcileConfiguredCoordinatorEnrollment(store, {
				config,
				listDevices: async () => [],
				listConsumedTeamInvites: async () => [],
			});
			expect(succeeded).toMatchObject({ groupsProcessed: 1, failedGroups: 0, issues: 0 });
			expect(
				db
					.prepare(`SELECT status, resolved_at
					FROM coordinator_enrollment_reconciliation_issues`)
					.get(),
			).toMatchObject({ status: "resolved", resolved_at: expect.any(String) });
		} finally {
			db.close();
		}
	});
});

describe("advancePendingProjectShares", () => {
	let db: InstanceType<typeof Database>;
	let store: MemoryStore;

	function seedOperation(input: { id: string; state: string; owner?: string; createdAt: string }) {
		db.prepare(`INSERT INTO share_operations(
			operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
			person_kind, teammate_name, history_policy, reviewed_project_set_digest,
			coordinator_group_id, invite_token_digest, invite_expires_at, created_at, updated_at
		) VALUES (?, ?, ?, '[]', ?, 'existing', 'Brian', 'existing_and_future', ?,
			'team-a', ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run(
			input.id,
			input.state,
			input.owner ?? "actor-local",
			`person-${input.id}`,
			`digest-${input.id}`,
			`token-${input.id}`,
			input.createdAt,
			input.createdAt,
		);
		db.prepare(`INSERT INTO share_operation_steps(
			operation_id, step_key, effect_id, status, attempt_count, updated_at
		) VALUES (?, 'invite_consumption', ?, 'pending', 0, ?)`).run(
			input.id,
			`invite-consumption:${input.id}`,
			input.createdAt,
		);
	}

	function seedCapabilityBoundary(scopeId: string, groupId: string, now: string): void {
		db.prepare(`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch,
			status, created_at, updated_at
		) VALUES (?, 'Capability boundary', 'managed_project', 'coordinator',
			'https://coord.example.test', ?, 1, 'active', ?, ?)`).run(scopeId, groupId, now, now);
	}

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		store = { actorId: "actor-local", db } as unknown as MemoryStore;
	});

	afterEach(() => db.close());

	it("accepts the local owner device capability without a recipient enrollment binding", async () => {
		store.deviceId = "device-local-owner";
		const effects = createRecipientPolicyReconcilerEffects(store, {
			config: {
				syncCoordinatorUrl: "https://coord.example.test",
				syncCoordinatorAdminSecret: "secret",
				syncCoordinatorGroups: ["group-a"],
			} as never,
		});

		await expect(
			effects.probeCapability({ deviceId: "device-local-owner", scopeId: "scope-not-needed" }),
		).resolves.toBe("supported");
	});

	it("binds reviewed bootstrap capability evidence to the boundary group, identity, and key", async () => {
		const now = "2026-07-26T00:00:00.000Z";
		const scopeId = "scope-capability-a";
		const publicKey = "reviewed-device-key";
		const fingerprint = fingerprintPublicKey(publicKey);
		let reviewedPresence: {
			presence_expires_at?: string;
			presence_capabilities?: Record<string, unknown>;
		} = {};
		seedCapabilityBoundary(scopeId, "group-a", now);
		const listDevices = vi.fn(async () => [
			{
				group_id: "group-a",
				device_id: "device-reviewed",
				public_key: publicKey,
				fingerprint,
				identity_id: "identity:abcdefghijklmnopqr",
				display_name: "Reviewed device",
				enabled: 1,
				created_at: now,
				...reviewedPresence,
			},
			{
				group_id: "group-a",
				device_id: "device-stale-presence",
				public_key: "stale-presence-key",
				fingerprint: fingerprintPublicKey("stale-presence-key"),
				identity_id: "identity:abcdefghijklmnopqr",
				display_name: "Stale presence device",
				enabled: 1,
				created_at: now,
				presence_expires_at: "2026-07-25T23:59:59.000Z",
				presence_capabilities: {
					sync_capability: "scoped",
					sync_features: ["reassign_scope"],
				},
			},
			{
				group_id: "group-a",
				device_id: "device-legacy-presence",
				public_key: "legacy-presence-key",
				fingerprint: fingerprintPublicKey("legacy-presence-key"),
				identity_id: "identity:abcdefghijklmnopqr",
				display_name: "Legacy presence device",
				enabled: 1,
				created_at: now,
				presence_expires_at: "2026-07-27T00:00:00.000Z",
				presence_capabilities: {
					sync_capability: "scoped",
					sync_features: "reassign_scope",
				},
			},
			{
				group_id: "group-a",
				device_id: "device-cross-group",
				public_key: "cross-group-current-key",
				fingerprint: fingerprintPublicKey("cross-group-current-key"),
				identity_id: "identity:abcdefghijklmnopqr",
				display_name: "Cross-group collision",
				enabled: 1,
				created_at: now,
			},
			{
				group_id: "group-a",
				device_id: "device-rekeyed",
				public_key: "current-rekeyed-key",
				fingerprint: fingerprintPublicKey("current-rekeyed-key"),
				identity_id: "identity:abcdefghijklmnopqr",
				display_name: "Rekeyed device",
				enabled: 1,
				created_at: now,
			},
		]);

		const listReviewedRecipientInviteEvidence = vi.fn(async ({ groupId }: { groupId: string }) =>
			groupId === "group-a"
				? [
						{
							invite_id: "invite-reviewed-1",
							group_id: "group-a",
							invite_kind: "team_member" as const,
							policy_team_id: "policy-team-1",
							assigned_identity_id: "identity:abcdefghijklmnopqr",
							recipient_actor_id: "identity:abcdefghijklmnopqr",
							bound_device_id: "device-reviewed",
							bound_public_key: publicKey,
							bound_fingerprint: fingerprint,
							consumed_at: now,
							reviewed_preview_digest: "a".repeat(64),
						},
						{
							invite_id: "invite-stale-key",
							group_id: "group-a",
							invite_kind: "team_member" as const,
							policy_team_id: "policy-team-1",
							assigned_identity_id: "identity:abcdefghijklmnopqr",
							recipient_actor_id: "identity:abcdefghijklmnopqr",
							bound_device_id: "device-rekeyed",
							bound_public_key: "stale-rekeyed-key",
							bound_fingerprint: fingerprintPublicKey("stale-rekeyed-key"),
							consumed_at: now,
							reviewed_preview_digest: "c".repeat(64),
						},
						...[
							{
								deviceId: "device-stale-presence",
								key: "stale-presence-key",
								digest: "d",
							},
							{
								deviceId: "device-legacy-presence",
								key: "legacy-presence-key",
								digest: "e",
							},
						].map((item) => ({
							invite_id: `invite-${item.deviceId}`,
							group_id: "group-a",
							invite_kind: "team_member" as const,
							policy_team_id: "policy-team-1",
							assigned_identity_id: "identity:abcdefghijklmnopqr",
							recipient_actor_id: "identity:abcdefghijklmnopqr",
							bound_device_id: item.deviceId,
							bound_public_key: item.key,
							bound_fingerprint: fingerprintPublicKey(item.key),
							consumed_at: now,
							reviewed_preview_digest: item.digest.repeat(64),
						})),
					]
				: [
						{
							invite_id: "invite-wrong-group",
							group_id: "group-b",
							invite_kind: "team_member" as const,
							policy_team_id: "policy-team-1",
							assigned_identity_id: "identity:abcdefghijklmnopqr",
							recipient_actor_id: "identity:abcdefghijklmnopqr",
							bound_device_id: "device-cross-group",
							bound_public_key: "cross-group-current-key",
							bound_fingerprint: fingerprintPublicKey("cross-group-current-key"),
							consumed_at: now,
							reviewed_preview_digest: "b".repeat(64),
						},
					],
		);
		const effects = createRecipientPolicyReconcilerEffects(store, {
			config: {
				syncCoordinatorUrl: "https://coord.example.test",
				syncCoordinatorAdminSecret: "secret",
				syncCoordinatorGroups: ["group-a", "group-b"],
			} as never,
			listDevices,
			listReviewedRecipientInviteEvidence,
			now: () => now,
		});
		await effects.listBoundaryEnrollments({
			canonicalProjectIdentity: "project-capability-a",
			scopeId,
		});
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
			 VALUES ('device-reviewed', NULL, NULL, ?)`,
		).run(now);
		await expect(effects.probeCapability({ deviceId: "device-reviewed", scopeId })).resolves.toBe(
			"undetermined",
		);
		reviewedPresence = {
			presence_expires_at: "2026-07-27T00:00:00.000Z",
			presence_capabilities: {
				sync_capability: "scoped",
				sync_features: ["reassign_scope"],
			},
		};
		await effects.listBoundaryEnrollments({
			canonicalProjectIdentity: "project-capability-a",
			scopeId,
		});
		await expect(effects.probeCapability({ deviceId: "device-reviewed", scopeId })).resolves.toBe(
			"supported",
		);
		await expect(
			effects.probeCapability({ deviceId: "device-stale-presence", scopeId }),
		).resolves.toBe("undetermined");
		await expect(
			effects.probeCapability({ deviceId: "device-legacy-presence", scopeId }),
		).resolves.toBe("undetermined");
		db.prepare(
			"UPDATE sync_peers SET pinned_fingerprint = 'stale-peer-fingerprint' WHERE peer_device_id = 'device-reviewed'",
		).run();
		await expect(effects.probeCapability({ deviceId: "device-reviewed", scopeId })).resolves.toBe(
			"undetermined",
		);
		await expect(
			effects.probeCapability({ deviceId: "device-cross-group", scopeId }),
		).resolves.toBe("undetermined");
		await expect(effects.probeCapability({ deviceId: "device-rekeyed", scopeId })).resolves.toBe(
			"undetermined",
		);
		await expect(effects.probeCapability({ deviceId: "device-unknown", scopeId })).resolves.toBe(
			"undetermined",
		);
		expect(listReviewedRecipientInviteEvidence).toHaveBeenCalledOnce();
		expect(listReviewedRecipientInviteEvidence.mock.calls.map(([input]) => input.groupId)).toEqual([
			"group-a",
		]);
	});

	it("keeps capability undetermined when reviewed invite evidence validation fails", async () => {
		const now = "2026-07-26T00:00:00.000Z";
		const scopeId = "scope-capability-invalid";
		const publicKey = "unreviewed-device-key";
		seedCapabilityBoundary(scopeId, "group-a", now);
		const listReviewedRecipientInviteEvidence = vi.fn(async () => {
			throw new Error("coordinator_reviewed_recipient_invite_invalid");
		});
		const effects = createRecipientPolicyReconcilerEffects(store, {
			config: {
				syncCoordinatorUrl: "https://coord.example.test",
				syncCoordinatorAdminSecret: "secret",
				syncCoordinatorGroups: ["group-a"],
			} as never,
			listDevices: vi.fn(async () => [
				{
					group_id: "group-a",
					device_id: "device-unreviewed",
					public_key: publicKey,
					fingerprint: fingerprintPublicKey(publicKey),
					identity_id: "identity:abcdefghijklmnopqr",
					display_name: "Unreviewed device",
					enabled: 1,
					created_at: now,
					presence_expires_at: "2099-07-27T00:00:00.000Z",
					presence_capabilities: {
						sync_capability: "scoped",
						sync_features: ["reassign_scope"],
					},
				},
			]),
			listReviewedRecipientInviteEvidence,
		});

		await effects.listBoundaryEnrollments({
			canonicalProjectIdentity: "project-capability-invalid",
			scopeId,
		});
		await expect(effects.probeCapability({ deviceId: "device-unreviewed", scopeId })).resolves.toBe(
			"undetermined",
		);
		await expect(effects.probeCapability({ deviceId: "device-other", scopeId })).resolves.toBe(
			"undetermined",
		);
		expect(listReviewedRecipientInviteEvidence).toHaveBeenCalledOnce();
	});

	it("requires scoped enforcement and reassign_scope capability", () => {
		expect(
			recipientPolicyCapabilityFromStatus({
				sync_capability: "enforcing",
				sync_features: ["reassign_scope"],
			}),
		).toBe("unsupported");
		expect(
			recipientPolicyCapabilityFromStatus({
				sync_capability: "scoped",
				sync_features: [],
			}),
		).toBe("unsupported");
		expect(
			recipientPolicyCapabilityFromStatus({
				sync_capability: "scoped",
				sync_features: ["reassign_scope"],
			}),
		).toBe("supported");
	});

	it("processes a bounded oldest-first locally owned set and isolates failures", async () => {
		seedOperation({ id: "share-oldest", state: "accepted", createdAt: "2026-07-20T00:00:00Z" });
		seedOperation({
			id: "share-foreign",
			state: "accepted",
			owner: "actor-other",
			createdAt: "2026-07-20T00:00:01Z",
		});
		seedOperation({ id: "share-second", state: "provisioning", createdAt: "2026-07-20T00:00:02Z" });
		seedOperation({ id: "share-third", state: "initial_sync", createdAt: "2026-07-20T00:00:03Z" });
		seedOperation({ id: "share-revoked", state: "revoked", createdAt: "2026-07-19T00:00:00Z" });
		seedOperation({ id: "share-revoking", state: "revoking", createdAt: "2026-07-19T00:00:00Z" });
		seedOperation({ id: "share-cancelled", state: "cancelled", createdAt: "2026-07-19T00:00:01Z" });
		const visited: string[] = [];
		const advanceOperation = vi.fn(async (_store: MemoryStore, operationId: string) => {
			visited.push(operationId);
			if (operationId === "share-oldest") throw new Error("injected failure");
			return { advanced: true, state: "active" as const };
		});

		const result = await advancePendingProjectShares(store, {
			limit: 2,
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(visited).toEqual(["share-oldest", "share-second"]);
		expect(result).toMatchObject({ processed: 2, advanced: 1, failed: 1, waiting: 0 });
		expect(result.items[0]).toMatchObject({
			operationId: "share-oldest",
			outcome: "failed",
			error: "injected failure",
		});
		expect(result.items[1]).toEqual({ operationId: "share-second", outcome: "advanced" });
	});

	it("prioritizes advanceable work over older invite polling", async () => {
		for (const [id, createdAt] of [
			["share-waiting-1", "2026-07-20T00:00:00Z"],
			["share-waiting-2", "2026-07-20T00:00:01Z"],
			["share-waiting-3", "2026-07-20T00:00:02Z"],
		] as const) {
			seedOperation({ id, state: "waiting_for_acceptance", createdAt });
		}
		seedOperation({
			id: "share-accepted-new",
			state: "accepted",
			createdAt: "2026-07-20T00:10:00Z",
		});
		const advanceOperation = vi.fn(async (_store: MemoryStore, operationId: string) =>
			operationId === "share-accepted-new"
				? { advanced: true, state: "active" as const }
				: { advanced: false, state: "waiting_for_acceptance" as const },
		);

		await advancePendingProjectShares(store, {
			limit: 3,
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).toHaveBeenCalledWith(store, "share-accepted-new");
	});

	it("retries waiting-for-device operations through the existing advance seam", async () => {
		seedOperation({
			id: "share-waiting-device",
			state: "waiting_for_device",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => ({ advanced: true, state: "active" as const }));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).toHaveBeenCalledWith(store, "share-waiting-device");
		expect(result).toMatchObject({ processed: 1, advanced: 1, failed: 0 });
	});

	it("treats an offline recipient as passive waiting instead of a daemon failure", async () => {
		seedOperation({
			id: "share-waiting-device",
			state: "waiting_for_device",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => {
			throw new Error("waiting_for_device");
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({
			processed: 1,
			advanced: 0,
			waiting: 1,
			attention: 0,
			failed: 0,
		});
		expect(result.items).toEqual([
			{ operationId: "share-waiting-device", outcome: "waiting_for_device" },
		]);
	});

	it("backs off recent waiting-for-device operations", async () => {
		seedOperation({
			id: "share-waiting-device",
			state: "waiting_for_device",
			createdAt: "2026-07-20T00:58:00Z",
		});
		db.prepare("UPDATE share_operations SET recipient_device_id = ? WHERE operation_id = ?").run(
			"device-recipient",
			"share-waiting-device",
		);
		db.prepare(`INSERT INTO sync_peers(
			peer_device_id, addresses_json, created_at, last_seen_at
		) VALUES (
			'device-recipient', '[]', '2026-07-20T00:00:00Z', '2026-07-20T00:59:00Z'
		)`).run();
		const advanceOperation = vi.fn(async () => ({ advanced: true, state: "active" as const }));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).not.toHaveBeenCalled();
		expect(result).toMatchObject({ processed: 0, waiting: 0, attention: 0, failed: 0 });
	});

	it("retries a recent waiting-for-device operation after a fully successful sync", async () => {
		seedOperation({
			id: "share-reconnected-device",
			state: "waiting_for_device",
			createdAt: "2026-07-20T00:58:00Z",
		});
		db.prepare("UPDATE share_operations SET recipient_device_id = ? WHERE operation_id = ?").run(
			"device-recipient",
			"share-reconnected-device",
		);
		db.prepare(`INSERT INTO sync_peers(peer_device_id, created_at, last_sync_at)
			VALUES ('device-recipient', '2026-07-20T00:00:00Z', '2026-07-20T00:59:00Z')`).run();
		db.prepare(`INSERT INTO sync_attempts(
			peer_device_id, started_at, finished_at, ok, ops_in, ops_out
		) VALUES (
			'device-recipient', '2026-07-20T00:59:00Z', '2026-07-20T00:59:00Z', 1, 0, 0
		)`).run();
		const advanceOperation = vi.fn(async () => ({ advanced: true, state: "active" as const }));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).toHaveBeenCalledWith(store, "share-reconnected-device");
		expect(result).toMatchObject({ processed: 1, advanced: 1, failed: 0 });
	});

	it("preserves cooldown when the latest peer activity was not a fully successful sync", async () => {
		seedOperation({
			id: "share-partial-sync",
			state: "waiting_for_device",
			createdAt: "2026-07-20T00:58:00Z",
		});
		db.prepare("UPDATE share_operations SET recipient_device_id = ? WHERE operation_id = ?").run(
			"device-recipient",
			"share-partial-sync",
		);
		db.prepare(`INSERT INTO sync_peers(peer_device_id, created_at, last_sync_at)
			VALUES ('device-recipient', '2026-07-20T00:00:00Z', '2026-07-20T00:59:00Z')`).run();
		db.prepare(`INSERT INTO sync_attempts(
			peer_device_id, started_at, finished_at, ok, ops_in, ops_out
		) VALUES (
			'device-recipient', '2026-07-20T00:58:30Z', '2026-07-20T00:58:30Z', 1, 0, 0
		)`).run();
		db.prepare(`INSERT INTO sync_attempts(
			peer_device_id, started_at, finished_at, ok, ops_in, ops_out, error
		) VALUES (
			'device-recipient', '2026-07-20T00:59:00Z', '2026-07-20T00:59:00Z',
			0, 0, 0, 'scoped sync incomplete'
		)`).run();
		const advanceOperation = vi.fn(async () => ({ advanced: true, state: "active" as const }));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).not.toHaveBeenCalled();
		expect(result).toMatchObject({ processed: 0, waiting: 0, attention: 0, failed: 0 });
	});

	it("preserves cooldown while a capability preflight retry is running", async () => {
		seedOperation({
			id: "share-running-capability",
			state: "waiting_for_device",
			createdAt: "2026-07-20T00:58:00Z",
		});
		db.prepare("UPDATE share_operations SET recipient_device_id = ? WHERE operation_id = ?").run(
			"device-recipient",
			"share-running-capability",
		);
		db.prepare(`INSERT INTO share_operation_steps(
			operation_id, step_key, effect_id, status, attempt_count, safe_error_code, updated_at
		) VALUES (?, 'capability_preflight', 'capability:running', 'running', 2,
			NULL, '2026-07-20T00:58:00Z')`).run("share-running-capability");
		db.prepare(`INSERT INTO sync_attempts(
			peer_device_id, started_at, finished_at, ok, ops_in, ops_out
		) VALUES (
			'device-recipient', '2026-07-20T00:59:00Z', '2026-07-20T00:59:00Z', 1, 0, 0
		)`).run();
		const advanceOperation = vi.fn(async () => ({ advanced: true, state: "active" as const }));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).not.toHaveBeenCalled();
		expect(result).toMatchObject({ processed: 0, waiting: 0, attention: 0, failed: 0 });
	});

	it("preserves cooldown when capability preflight waits on another device", async () => {
		seedOperation({
			id: "share-capability-wait",
			state: "waiting_for_device",
			createdAt: "2026-07-20T00:58:00Z",
		});
		db.prepare("UPDATE share_operations SET recipient_device_id = ? WHERE operation_id = ?").run(
			"device-recipient",
			"share-capability-wait",
		);
		db.prepare(`INSERT INTO share_operation_steps(
			operation_id, step_key, effect_id, status, attempt_count, safe_error_code, updated_at
		) VALUES (?, 'capability_preflight', 'capability:test', 'failed', 1,
			'waiting_for_device', '2026-07-20T00:58:00Z')`).run("share-capability-wait");
		db.prepare(`INSERT INTO sync_peers(peer_device_id, created_at, last_sync_at)
			VALUES ('device-recipient', '2026-07-20T00:00:00Z', '2026-07-20T00:59:00Z')`).run();
		db.prepare(`INSERT INTO sync_attempts(
			peer_device_id, started_at, finished_at, ok, ops_in, ops_out
		) VALUES (
			'device-recipient', '2026-07-20T00:59:00Z', '2026-07-20T00:59:00Z', 1, 0, 0
		)`).run();
		const advanceOperation = vi.fn(async () => ({ advanced: true, state: "active" as const }));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).not.toHaveBeenCalled();
		expect(result).toMatchObject({ processed: 0, waiting: 0, attention: 0, failed: 0 });
	});

	it("leaves terminal needs-attention operations for explicit user retry", async () => {
		seedOperation({
			id: "share-needs-attention",
			state: "needs_attention",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => ({ advanced: true, state: "active" as const }));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).not.toHaveBeenCalled();
		expect(result).toMatchObject({ processed: 0, attention: 0, failed: 0 });
	});

	it("reports a newly terminal operation without failing global daemon health", async () => {
		seedOperation({
			id: "share-failed-setup",
			state: "accepted",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => {
			db.prepare(
				"UPDATE share_operations SET state = 'needs_attention' WHERE operation_id = ?",
			).run("share-failed-setup");
			throw new Error("provisioning_failed");
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({
			processed: 1,
			advanced: 0,
			waiting: 0,
			attention: 1,
			failed: 0,
		});
		expect(result.items[0]).toMatchObject({
			operationId: "share-failed-setup",
			outcome: "needs_attention",
			error: "provisioning_failed",
		});
	});

	it.each([
		"coordinator_not_configured",
		"team_sharing_not_configured",
		"team_selection_ambiguous",
	])("moves deterministic advancement failure %s to explicit recovery", async (errorCode) => {
		seedOperation({
			id: "share-missing-coordinator",
			state: "accepted",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => {
			throw new Error(errorCode);
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({ processed: 1, attention: 1, failed: 0 });
		expect(result.items[0]).toMatchObject({ outcome: "needs_attention" });
		expect(db.prepare("SELECT state FROM share_operations").pluck().get()).toBe("needs_attention");
	});

	it("polls waiting-for-acceptance operations and backs off after a pending response", async () => {
		seedOperation({
			id: "share-awaiting-acceptance",
			state: "waiting_for_acceptance",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => ({
			advanced: false,
			state: "waiting_for_acceptance" as const,
		}));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).toHaveBeenCalledWith(store, "share-awaiting-acceptance");
		expect(result).toMatchObject({ processed: 1, advanced: 0, waiting: 1, failed: 0 });
		expect(db.prepare("SELECT state FROM share_operations").pluck().get()).toBe(
			"waiting_for_acceptance",
		);
		expect(db.prepare("SELECT updated_at FROM share_operations").pluck().get()).toBe(
			"2026-07-20T01:00:00.000Z",
		);
	});

	it("does not poll a recently checked waiting-for-acceptance operation", async () => {
		seedOperation({
			id: "share-awaiting-acceptance",
			state: "waiting_for_acceptance",
			createdAt: "2026-07-20T00:59:45Z",
		});
		const advanceOperation = vi.fn(async () => ({
			advanced: false,
			state: "waiting_for_acceptance" as const,
		}));

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(advanceOperation).not.toHaveBeenCalled();
		expect(result).toMatchObject({ processed: 0, waiting: 0, failed: 0 });
	});

	it("backs off transient invite reconciliation errors without poisoning daemon health", async () => {
		seedOperation({
			id: "share-awaiting-acceptance",
			state: "waiting_for_acceptance",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => {
			throw new Error("coordinator unavailable");
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({
			processed: 1,
			waiting: 1,
			attention: 0,
			failed: 0,
		});
		expect(result.items[0]).toMatchObject({ outcome: "retry_scheduled" });
		expect(
			db
				.prepare(`SELECT status, attempt_count, safe_error_code FROM share_operation_steps
					WHERE operation_id = ? AND step_key = 'invite_consumption'`)
				.get("share-awaiting-acceptance"),
		).toEqual({ status: "pending", attempt_count: 1, safe_error_code: "operation_read_failed" });
	});

	it("moves terminal invite reconciliation errors to explicit recovery", async () => {
		seedOperation({
			id: "share-invalid-acceptance",
			state: "waiting_for_acceptance",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => {
			throw Object.assign(new Error("operation_scope_mismatch"), { status: 409 });
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({ processed: 1, waiting: 0, attention: 1, failed: 0 });
		expect(result.items[0]).toMatchObject({ outcome: "needs_attention" });
		expect(db.prepare("SELECT state FROM share_operations").pluck().get()).toBe("needs_attention");
	});

	it.each([
		"coordinator_not_configured",
		"team_sharing_not_configured",
		"team_selection_ambiguous",
		"recipient_fingerprint_mismatch",
		"recipient_device_identity_conflict",
		"recipient_actor_conflict",
		"pending_person_identity_conflict",
		"operation_intent_mismatch",
		"device_binding_conflict",
		"intent_conflict",
		"inviter_identity_conflict",
	])("moves status-less deterministic conflict %s to explicit recovery", async (errorCode) => {
		seedOperation({
			id: "share-invalid-identity",
			state: "waiting_for_acceptance",
			createdAt: "2026-07-20T00:00:00Z",
		});
		const advanceOperation = vi.fn(async () => {
			throw new Error(errorCode);
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({ processed: 1, waiting: 0, attention: 1, failed: 0 });
		expect(result.items[0]).toMatchObject({ outcome: "needs_attention", error: errorCode });
		expect(db.prepare("SELECT state FROM share_operations").pluck().get()).toBe("needs_attention");
		expect(
			db
				.prepare(`SELECT status, attempt_count, safe_error_code FROM share_operation_steps
					WHERE operation_id = ? AND step_key = 'invite_consumption'`)
				.get("share-invalid-identity"),
		).toEqual({ status: "failed", attempt_count: 1, safe_error_code: errorCode });
	});

	it("keeps transient invite reconciliation passive and recovers after the coordinator returns", async () => {
		seedOperation({
			id: "share-awaiting-acceptance",
			state: "waiting_for_acceptance",
			createdAt: "2026-07-20T00:00:00Z",
		});
		db.prepare(`UPDATE share_operation_steps SET attempt_count = 2
			WHERE operation_id = ? AND step_key = 'invite_consumption'`).run("share-awaiting-acceptance");
		const advanceOperation = vi.fn(async () => {
			throw new Error("coordinator unavailable");
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:00:00Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({ processed: 1, waiting: 1, attention: 0, failed: 0 });
		expect(result.items[0]).toMatchObject({ outcome: "retry_scheduled" });
		expect(db.prepare("SELECT state FROM share_operations").pluck().get()).toBe(
			"waiting_for_acceptance",
		);
		expect(
			db
				.prepare(`SELECT status, attempt_count, safe_error_code FROM share_operation_steps
					WHERE operation_id = ? AND step_key = 'invite_consumption'`)
				.get("share-awaiting-acceptance"),
		).toEqual({ status: "pending", attempt_count: 3, safe_error_code: "operation_read_failed" });

		const recoveredAdvance = vi.fn(async () => {
			db.prepare("UPDATE share_operations SET state = 'active' WHERE operation_id = ?").run(
				"share-awaiting-acceptance",
			);
			return { advanced: true, state: "active" as const };
		});
		const recovered = await advancePendingProjectShares(store, {
			now: new Date("2026-07-20T01:01:00Z"),
			advanceOperation: recoveredAdvance,
		});

		expect(recovered).toMatchObject({ processed: 1, advanced: 1, failed: 0 });
		expect(recoveredAdvance).toHaveBeenCalledWith(store, "share-awaiting-acceptance");
	});
});

describe("recipient-policy maintenance", () => {
	let db: InstanceType<typeof Database>;
	let store: MemoryStore;

	const now = "2026-07-22T10:00:00.000Z";

	function seedRecipientProject(projectId: string, deviceId = `device:${projectId}`): void {
		const identityId = `identity:${projectId}`;
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES (?, ?, 0, 'active', ?, ?)`,
		).run(identityId, identityId, now, now);
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, ?, 'active', 'test', '1', 'native', ?, ?, ?)`,
		).run(deviceId, identityId, deviceId, `device-edge:${projectId}`, now, now);
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity', ?, 'active', 'test', '1', 'native', ?, ?, ?)`,
		).run(projectId, identityId, `recipient-edge:${projectId}`, now, now);
	}

	function seedManagedBoundary(projectId: string, scopeId: string): void {
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch,
			 status, created_at, updated_at
			 ) VALUES (?, ?, 'managed_project', 'coordinator', 'coordinator', 'group', 1,
			 'active', ?, ?)`,
		).run(scopeId, projectId, now, now);
		db.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`,
		).run(projectId, projectId, scopeId, now, now);
	}

	function seedShareOperation(operationId: string): void {
		db.prepare(
			`INSERT INTO share_operations(
			 operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
			 person_kind, teammate_name, history_policy, reviewed_project_set_digest,
			 coordinator_group_id, invite_token_digest, invite_expires_at, created_at, updated_at
			 ) VALUES (?, 'accepted', 'actor-local', '[]', ?, 'existing', 'Brian',
			 'existing_and_future', ?, 'group', ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
		).run(
			operationId,
			`person:${operationId}`,
			`digest:${operationId}`,
			`token:${operationId}`,
			now,
			now,
		);
	}

	function unusedEffects(): RecipientPolicyReconcilerEffects {
		return {
			now: () => now,
			snapshot: vi.fn(async () => {
				throw new Error("unused");
			}),
			listBoundaryEnrollments: vi.fn(async () => {
				throw new Error("unused");
			}),
			probeCapability: vi.fn(async () => "supported"),
			revoke: vi.fn(async () => {
				throw new Error("unused");
			}),
			grant: vi.fn(async () => {
				throw new Error("unused");
			}),
			refresh: vi.fn(async () => undefined),
		};
	}

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		store = { actorId: "actor-local", db, deviceId: "device-local" } as unknown as MemoryStore;
	});

	afterEach(() => {
		db.close();
		vi.unstubAllGlobals();
	});

	it("reads enabled and disabled enrollments from the exact managed boundary group", async () => {
		const projectId = "project-boundary-enrollments";
		const scopeId = "scope-boundary-enrollments";
		const recipientPublicKey = "boundary-recipient-key";
		const ownerPublicKey = "boundary-owner-key";
		const disabledPublicKey = "boundary-disabled-key";
		seedManagedBoundary(projectId, scopeId);
		db.prepare("UPDATE replication_scopes SET coordinator_id = ? WHERE scope_id = ?").run(
			"https://coord.example.test",
			scopeId,
		);
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						items: [
							{
								group_id: "group",
								device_id: "device-recipient",
								public_key: recipientPublicKey,
								fingerprint: fingerprintPublicKey(recipientPublicKey),
								identity_id: "identity-recipient",
								display_name: null,
								enabled: 1,
								created_at: "2026-07-26T00:00:00.000Z",
							},
							{
								group_id: "group",
								device_id: "device-owner",
								public_key: ownerPublicKey,
								fingerprint: fingerprintPublicKey(ownerPublicKey),
								identity_id: null,
								display_name: null,
								enabled: 1,
								created_at: "2026-07-26T00:00:00.000Z",
							},
							{
								group_id: "group",
								device_id: "device-disabled",
								public_key: disabledPublicKey,
								fingerprint: fingerprintPublicKey(disabledPublicKey),
								identity_id: null,
								display_name: null,
								enabled: 0,
								created_at: "2026-07-26T00:00:00.000Z",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const effects = createRecipientPolicyReconcilerEffects(store, {
			config: {
				syncCoordinatorUrl: "https://coord.example.test",
				syncCoordinatorAdminSecret: "secret",
				syncCoordinatorGroups: ["group"],
			} as never,
		});

		await expect(
			effects.listBoundaryEnrollments({ canonicalProjectIdentity: projectId, scopeId }),
		).resolves.toEqual([
			{
				deviceId: "device-recipient",
				identityId: "identity-recipient",
				publicKey: recipientPublicKey,
				fingerprint: fingerprintPublicKey(recipientPublicKey),
				enabled: true,
			},
			{
				deviceId: "device-owner",
				identityId: null,
				publicKey: ownerPublicKey,
				fingerprint: fingerprintPublicKey(ownerPublicKey),
				enabled: true,
			},
			{
				deviceId: "device-disabled",
				identityId: null,
				publicKey: disabledPublicKey,
				fingerprint: fingerprintPublicKey(disabledPublicKey),
				enabled: false,
			},
		]);
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://coord.example.test/v1/admin/devices?group_id=group&include_disabled=1",
		);
		await expect(effects.probeCapability({ deviceId: "device-owner", scopeId })).resolves.toBe(
			"undetermined",
		);
		await expect(effects.probeCapability({ deviceId: "device-disabled", scopeId })).resolves.toBe(
			"undetermined",
		);
	});

	it("rejects non-binary boundary enrollment state", async () => {
		const projectId = "project-malformed-enrollment-state";
		const scopeId = "scope-malformed-enrollment-state";
		const publicKey = "malformed-state-key";
		seedManagedBoundary(projectId, scopeId);
		db.prepare("UPDATE replication_scopes SET coordinator_id = ? WHERE scope_id = ?").run(
			"https://coord.example.test",
			scopeId,
		);
		const listDevices = vi.fn(async ({ groupId }: { groupId: string }) => [
			{
				group_id: groupId,
				device_id: "device-malformed-state",
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
				identity_id: "identity-malformed-state",
				display_name: null,
				enabled: 2,
				created_at: now,
			},
		]);
		const effects = createRecipientPolicyReconcilerEffects(store, {
			config: {
				syncCoordinatorUrl: "https://coord.example.test",
				syncCoordinatorAdminSecret: "secret",
				syncCoordinatorGroups: ["group"],
			} as never,
			listDevices,
		});

		await expect(
			effects.listBoundaryEnrollments({ canonicalProjectIdentity: projectId, scopeId }),
		).rejects.toThrow("recipient_policy_snapshot_invalid");
		expect(listDevices).toHaveBeenCalledWith(
			expect.objectContaining({ groupId: "group", includeDisabled: true }),
		);
	});

	it("rejects malformed boundary enrollment rows before reconciliation", async () => {
		const projectId = "project-malformed-enrollment";
		const scopeId = "scope-malformed-enrollment";
		seedManagedBoundary(projectId, scopeId);
		db.prepare("UPDATE replication_scopes SET coordinator_id = ? WHERE scope_id = ?").run(
			"https://coord.example.test",
			scopeId,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							items: [{ group_id: "group", identity_id: "identity-recipient", enabled: 1 }],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);
		const effects = createRecipientPolicyReconcilerEffects(store, {
			config: {
				syncCoordinatorUrl: "https://coord.example.test",
				syncCoordinatorAdminSecret: "secret",
				syncCoordinatorGroups: ["group"],
			} as never,
		});

		await expect(
			effects.listBoundaryEnrollments({ canonicalProjectIdentity: projectId, scopeId }),
		).rejects.toThrow("recipient_policy_snapshot_not_fresh");
	});

	it("rejects boundary enrollment reads outside the configured coordinator authority", async () => {
		const projectId = "project-boundary-authority";
		const scopeId = "scope-boundary-authority";
		seedManagedBoundary(projectId, scopeId);
		db.prepare("UPDATE replication_scopes SET coordinator_id = ? WHERE scope_id = ?").run(
			"https://coord.example.test",
			scopeId,
		);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		for (const config of [
			{
				syncCoordinatorUrl: "https://coord.example.test",
				syncCoordinatorAdminSecret: "secret",
				syncCoordinatorGroups: ["other-group"],
			},
			{
				syncCoordinatorUrl: "https://other.example.test",
				syncCoordinatorAdminSecret: "secret",
				syncCoordinatorGroups: ["group"],
			},
			{
				syncCoordinatorUrl: "https://coord.example.test",
				syncCoordinatorAdminSecret: "",
				syncCoordinatorGroups: ["group"],
			},
		]) {
			const effects = createRecipientPolicyReconcilerEffects(store, { config: config as never });
			await expect(
				effects.listBoundaryEnrollments({ canonicalProjectIdentity: projectId, scopeId }),
			).rejects.toThrow("recipient_policy_effect_failed");
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("bounds work and isolates one Project failure from the next", async () => {
		seedRecipientProject("project-a");
		seedRecipientProject("project-b");
		seedRecipientProject("project-c");
		const visited: string[] = [];
		const reconcileProject: typeof reconcileRecipientPolicyProject = vi.fn(async (_db, input) => {
			visited.push(input.canonicalProjectIdentity);
			if (input.canonicalProjectIdentity === "project-a") {
				throw new Error("injected failure");
			}
			return {
				canonicalProjectIdentity: input.canonicalProjectIdentity,
				status: "waiting" as const,
				generation: 1,
				safeErrorCode: "recipient_policy_capability_undetermined",
				revokedDeviceIds: [],
				grantedDeviceIds: [],
				deliveredCopiesMayRemain: true as const,
				revocationWarning: "Delivered copies may remain.",
			};
		});

		const result = await reconcileRecipientPolicyProjects(store, {
			limit: 2,
			effects: unusedEffects(),
			reconcileProject,
		});

		expect(visited).toEqual(["project-a", "project-b"]);
		expect(result).toMatchObject({ processed: 2, waiting: 1, failed: 1 });
		expect(result.items.map((item) => item.status)).toEqual(["failed", "waiting"]);
	});

	it("backs off persisted failures and resumes them after the retry window", async () => {
		seedRecipientProject("project-backoff");
		db.prepare(
			`INSERT INTO recipient_policy_authority_states(
			 canonical_project_identity, authority_state, generation, safe_error_code,
			 state_changed_at, attempt_count, last_attempt_at, created_at, updated_at
			 ) VALUES ('project-backoff', 'legacy', 0, 'recipient_policy_capability_undetermined',
			 ?, 1, ?, ?, ?)`,
		).run(now, now, now, now);
		const reconcileProject: typeof reconcileRecipientPolicyProject = vi.fn(async () => {
			throw new Error("backoff should skip reconciliation");
		});

		const backedOff = await reconcileRecipientPolicyProjects(store, {
			now: new Date("2026-07-22T10:00:30.000Z"),
			effects: unusedEffects(),
			reconcileProject,
		});
		expect(backedOff.processed).toBe(0);

		vi.mocked(reconcileProject).mockResolvedValue({
			canonicalProjectIdentity: "project-backoff",
			status: "waiting",
			generation: 0,
			safeErrorCode: "recipient_policy_capability_undetermined",
			revokedDeviceIds: [],
			grantedDeviceIds: [],
			deliveredCopiesMayRemain: true,
			revocationWarning: "Delivered copies may remain.",
		});
		const resumed = await reconcileRecipientPolicyProjects(store, {
			now: new Date("2026-07-22T10:01:01.000Z"),
			effects: unusedEffects(),
			reconcileProject,
		});

		expect(resumed).toMatchObject({ processed: 1, waiting: 1, failed: 0 });
		expect(reconcileProject).toHaveBeenCalledTimes(1);
	});

	it("reconciles a first all-revoked transition without an authority row", async () => {
		const projectId = "project-all-revoked";
		const scopeId = "scope-all-revoked";
		const unrelatedProjectId = "project-unrelated";
		seedRecipientProject(projectId, "device-revoked");
		db.prepare(
			"UPDATE project_recipients SET status = 'revoked' WHERE canonical_project_identity = ?",
		).run(projectId);
		seedManagedBoundary(projectId, scopeId);
		seedManagedBoundary(unrelatedProjectId, "scope-unrelated");

		let tick = 0;
		const nextTime = () => new Date(Date.parse(now) + tick++ * 1000).toISOString();
		const members = new Set(["device-revoked"]);
		const effects: RecipientPolicyReconcilerEffects = {
			now: nextTime,
			snapshot: vi.fn(async () => {
				const deviceIds = [...members].toSorted();
				return {
					authoritative: true,
					scopeId,
					fingerprint: `snapshot:${deviceIds.join(",") || "empty"}`,
					observedAt: nextTime(),
					memberships: deviceIds.map((deviceId) => ({
						deviceId,
						status: "active" as const,
					})),
				};
			}),
			listBoundaryEnrollments: vi.fn(async () => [
				{
					deviceId: "device-revoked",
					identityId: `identity:${projectId}`,
					publicKey: "pk-revoked",
					fingerprint: "fp-revoked",
					enabled: true,
				},
			]),
			probeCapability: vi.fn(async () => "supported"),
			revoke: vi.fn(async (input) => {
				members.delete(input.deviceId);
				return {
					effectId: input.effectId,
					scopeId: input.scopeId,
					deviceId: input.deviceId,
					status: "revoked" as const,
				};
			}),
			grant: vi.fn(async () => {
				throw new Error("empty desired set must not grant");
			}),
			refresh: vi.fn(async () => undefined),
		};
		const reconcileProject: typeof reconcileRecipientPolicyProject = vi.fn(
			reconcileRecipientPolicyProject,
		);
		expect(db.prepare("SELECT COUNT(*) FROM recipient_policy_authority_states").pluck().get()).toBe(
			0,
		);

		const first = await reconcileRecipientPolicyProjects(store, {
			backoffMs: 0,
			effects,
			leaseOwner: "worker-all-revoked-first",
			reconcileProject,
		});

		expect(first).toMatchObject({ processed: 1, waiting: 1, failed: 0 });
		expect(first.items).toEqual([
			{
				canonicalProjectIdentity: projectId,
				status: "parity_pending",
				safeErrorCode: null,
			},
		]);
		expect(reconcileProject).toHaveBeenCalledTimes(1);
		expect(reconcileProject).toHaveBeenCalledWith(
			db,
			expect.objectContaining({ canonicalProjectIdentity: projectId }),
			effects,
		);
		expect(effects.revoke).toHaveBeenCalledTimes(1);
		expect(effects.revoke).toHaveBeenCalledWith(
			expect.objectContaining({ scopeId, deviceId: "device-revoked" }),
		);
		expect(effects.grant).not.toHaveBeenCalled();
		expect([...members]).toEqual([]);
		expect(
			db
				.prepare(
					`SELECT authority_state, safe_error_code, last_completed_at
					 FROM recipient_policy_authority_states
					 WHERE canonical_project_identity = ?`,
				)
				.get(projectId),
		).toMatchObject({
			authority_state: "eligible",
			safe_error_code: null,
			last_completed_at: expect.any(String),
		});
		expect(
			db
				.prepare(
					`SELECT DISTINCT status FROM recipient_policy_reconciliation_steps
					 WHERE canonical_project_identity = ? ORDER BY status`,
				)
				.all(projectId),
		).toEqual([{ status: "completed" }]);

		const retry = await reconcileRecipientPolicyProjects(store, {
			backoffMs: 0,
			effects,
			leaseOwner: "worker-all-revoked-retry",
			reconcileProject,
		});

		expect(retry).toMatchObject({ processed: 1, active: 1, failed: 0 });
		expect(retry.items[0]).toMatchObject({
			canonicalProjectIdentity: projectId,
			status: "active",
			safeErrorCode: null,
		});
		expect(reconcileProject).toHaveBeenCalledTimes(2);
		expect(effects.revoke).toHaveBeenCalledTimes(1);
		expect(effects.grant).not.toHaveBeenCalled();
		expect(
			db
				.prepare(
					`SELECT authority_state, safe_error_code FROM recipient_policy_authority_states
					 WHERE canonical_project_identity = ?`,
				)
				.get(projectId),
		).toEqual({ authority_state: "active", safe_error_code: null });
		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM recipient_policy_authority_states
					 WHERE canonical_project_identity = ?`,
				)
				.pluck()
				.get(unrelatedProjectId),
		).toBe(0);
	});

	it("uses persisted steps for two-pass cutover without duplicate coordinator effects", async () => {
		const projectId = "project-two-pass";
		const scopeId = "scope-two-pass";
		seedRecipientProject(projectId, "device-recipient");
		seedManagedBoundary(projectId, scopeId);
		let tick = 0;
		const members = new Set<string>();
		const effectIds: string[] = [];
		const effects: RecipientPolicyReconcilerEffects = {
			now: () => new Date(Date.parse(now) + tick++ * 1000).toISOString(),
			snapshot: vi.fn(async () => {
				const deviceIds = [...members].toSorted();
				return {
					authoritative: true,
					scopeId,
					fingerprint: `snapshot:${deviceIds.join(",") || "empty"}`,
					observedAt: new Date(Date.parse(now) + tick++ * 1000).toISOString(),
					memberships: deviceIds.map((deviceId) => ({ deviceId, status: "active" as const })),
				};
			}),
			listBoundaryEnrollments: vi.fn(async () => [
				{
					deviceId: "device-recipient",
					identityId: `identity:${projectId}`,
					publicKey: "pk-recipient",
					fingerprint: "fp-recipient",
					enabled: true,
				},
			]),
			probeCapability: vi.fn(async () => "supported"),
			revoke: vi.fn(async (input) => ({
				effectId: input.effectId,
				scopeId: input.scopeId,
				deviceId: input.deviceId,
				status: "revoked" as const,
			})),
			grant: vi.fn(async (input) => {
				effectIds.push(input.effectId);
				members.add(input.deviceId);
				return {
					effectId: input.effectId,
					scopeId: input.scopeId,
					deviceId: input.deviceId,
					status: "active" as const,
				};
			}),
			refresh: vi.fn(async () => undefined),
		};

		const first = await reconcileRecipientPolicyProjects(store, {
			backoffMs: 0,
			effects,
			leaseOwner: "worker-first",
		});
		const second = await reconcileRecipientPolicyProjects(store, {
			backoffMs: 0,
			effects,
			leaseOwner: "worker-second",
		});

		expect(first.items[0]?.status).toBe("parity_pending");
		expect(second.items[0]?.status).toBe("active");
		expect(effectIds).toHaveLength(1);
		expect(new Set(effectIds).size).toBe(1);
	});

	it("blocks a stale legacy share from regranting after active policy removal", async () => {
		const projectId = "project-removed";
		seedRecipientProject(projectId, "device-removed");
		db.prepare(
			"UPDATE project_recipients SET status = 'revoked' WHERE canonical_project_identity = ?",
		).run(projectId);
		db.prepare(
			`INSERT INTO recipient_policy_authority_states(
			 canonical_project_identity, authority_state, generation, state_changed_at, created_at, updated_at
			 ) VALUES (?, 'active', 1, ?, ?, ?)`,
		).run(projectId, now, now, now);
		seedShareOperation("stale-share");
		let grants = 0;
		const advanceOperation = vi.fn(async () => {
			assertLegacyShareGrantAllowed(db, {
				canonicalProjectIdentity: projectId,
				deviceId: "device-removed",
			});
			grants += 1;
			return { advanced: true, state: "active" as const };
		});

		const result = await advancePendingProjectShares(store, {
			now: new Date("2026-07-22T11:00:00.000Z"),
			advanceOperation,
		});

		expect(result).toMatchObject({ processed: 1, advanced: 0, failed: 1 });
		expect(grants).toBe(0);
	});
});
