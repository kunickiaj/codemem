import {
	assertLegacyShareGrantAllowed,
	initTestSchema,
	type MemoryStore,
	type RecipientPolicyReconcilerEffects,
	reconcileRecipientPolicyProject,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	advancePendingProjectShares,
	recipientPolicyCapabilityFromStatus,
	reconcileRecipientPolicyProjects,
} from "./routes/sync.js";

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

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		store = { actorId: "actor-local", db } as unknown as MemoryStore;
	});

	afterEach(() => db.close());

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
	])("moves pre-step configuration failure %s to explicit recovery", async (errorCode) => {
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

	afterEach(() => db.close());

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
