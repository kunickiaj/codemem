import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearRecipientPolicyDenyOverlay,
	type DeriveRecipientPolicyEffectiveDevicesInput,
	deriveRecipientPolicyEffectiveDevices,
	ensureRecipientPolicyReconciliationStep,
	getRecipientPolicyAuthorityState,
	listPendingRecipientPolicyRefreshSteps,
	listPendingRecipientPolicyRevocationRefreshSteps,
	listRecipientPolicyDenyOverlays,
	PENDING_RECIPIENT_POLICY_REVOCATION_REFRESH_STEPS_SQL,
	pruneRecipientPolicyReconciliationSteps,
	pruneSupersededRecipientPolicyCapabilitySteps,
	putRecipientPolicyDenyOverlay,
	recordRecipientPolicyAuthorityExecution,
	recordRecipientPolicyReconciliationStepState,
	recordRecipientPolicyStableParityPass,
	upsertRecipientPolicyAuthorityObservation,
} from "./recipient-policy-reconciliation.js";
import { initTestSchema } from "./test-utils.js";

const PROJECT = "https://git.example.invalid/acme/project.git";
const NOW = "2026-07-22T10:00:00.000Z";

function graph(): DeriveRecipientPolicyEffectiveDevicesInput {
	return {
		canonicalProjectIdentity: PROJECT,
		projectRecipients: [
			{
				canonicalProjectIdentity: PROJECT,
				recipientKind: "identity",
				recipientId: "identity-a",
				status: "active",
			},
			{
				canonicalProjectIdentity: PROJECT,
				recipientKind: "team",
				recipientId: "team-a",
				status: "active",
			},
		],
		identities: [
			{ identityId: "identity-a", status: "active", mergedIntoIdentityId: null },
			{ identityId: "identity-b", status: "active", mergedIntoIdentityId: null },
		],
		teams: [{ teamId: "team-a", status: "active" }],
		teamMemberships: [{ teamId: "team-a", identityId: "identity-b", status: "active" }],
		identityDevices: [
			{ identityId: "identity-a", deviceId: "device-a", status: "active" },
			{ identityId: "identity-b", deviceId: "device-b", status: "active" },
		],
	};
}

describe("strict recipient-policy effective-device derivation", () => {
	it("derives direct and team devices without enrollment, trust, or filter inputs", () => {
		const result = deriveRecipientPolicyEffectiveDevices(graph());

		expect(result.status).toBe("eligible");
		expect(result.devices).toEqual([
			{
				canonicalProjectIdentity: PROJECT,
				identityId: "identity-a",
				deviceId: "device-a",
				sources: [{ kind: "direct_identity" }],
			},
			{
				canonicalProjectIdentity: PROJECT,
				identityId: "identity-b",
				deviceId: "device-b",
				sources: [{ kind: "team_membership", teamId: "team-a" }],
			},
		]);
	});

	it("deduplicates an exact device reached directly and through a team", () => {
		const input = graph();
		input.teamMemberships.push({ teamId: "team-a", identityId: "identity-a", status: "active" });

		const result = deriveRecipientPolicyEffectiveDevices(input);

		expect(result.devices[0]?.sources).toEqual([
			{ kind: "direct_identity" },
			{ kind: "team_membership", teamId: "team-a" },
		]);
		expect(result.devices).toHaveLength(2);
	});

	it.each([
		["missing", undefined, "identity_missing"],
		["pending", { identityId: "identity-a", status: "pending" }, "identity_not_active"],
		[
			"merged",
			{ identityId: "identity-a", status: "active", mergedIntoIdentityId: "identity-b" },
			"identity_merged",
		],
		["deactivated", { identityId: "identity-a", status: "deactivated" }, "identity_not_active"],
	] as const)("blocks the whole Project for a %s direct identity", (_label, replacement, code) => {
		const input = graph();
		input.identities = input.identities.filter((identity) => identity.identityId !== "identity-a");
		if (replacement) input.identities.push(replacement);

		const result = deriveRecipientPolicyEffectiveDevices(input);

		expect(result.status).toBe("blocked");
		expect(result.devices).toEqual([]);
		expect(result.blocked).toContainEqual({ code, referenceId: "identity-a" });
	});

	it("blocks all grant candidates when a team has an orphan active member", () => {
		const input = graph();
		input.teamMemberships.push({
			teamId: "team-a",
			identityId: "identity-orphan",
			status: "active",
		});

		const result = deriveRecipientPolicyEffectiveDevices(input);

		expect(result.devices).toEqual([]);
		expect(result.blocked).toContainEqual({
			code: "team_member_identity_missing",
			referenceId: "identity-orphan",
		});
	});

	it("uses exact canonical Project identity and ignores sibling recipients", () => {
		const input = graph();
		input.projectRecipients.push({
			canonicalProjectIdentity: `${PROJECT}-sibling`,
			recipientKind: "identity",
			recipientId: "identity-orphan",
			status: "active",
		});

		const result = deriveRecipientPolicyEffectiveDevices(input);

		expect(result.status).toBe("eligible");
		expect(result.devices.map((device) => device.deviceId)).toEqual(["device-a", "device-b"]);
	});
});

describe("recipient-policy reconciliation persistence", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => db.close());

	it("persists observations idempotently without promoting legacy authority", () => {
		const input = {
			canonicalProjectIdentity: PROJECT,
			generation: 1,
			desiredDevicesDigest: "desired:one",
			currentDevicesDigest: "desired:one",
			freshSnapshotFingerprint: "snapshot:one",
			freshSnapshotObservedAt: NOW,
			now: NOW,
		};

		upsertRecipientPolicyAuthorityObservation(db, input);
		upsertRecipientPolicyAuthorityObservation(db, input);

		const state = getRecipientPolicyAuthorityState(db, PROJECT);
		expect(state?.authorityState).toBe("legacy");
		expect(state?.generation).toBe(1);
		expect(db.prepare("SELECT COUNT(*) FROM recipient_policy_authority_states").pluck().get()).toBe(
			1,
		);
	});

	it("stores stable parity evidence without changing authority", () => {
		upsertRecipientPolicyAuthorityObservation(db, {
			canonicalProjectIdentity: PROJECT,
			generation: 2,
			desiredDevicesDigest: "devices:same",
			currentDevicesDigest: "devices:same",
			freshSnapshotFingerprint: "snapshot:fresh",
			freshSnapshotObservedAt: NOW,
			now: NOW,
		});

		const state = recordRecipientPolicyStableParityPass(db, {
			canonicalProjectIdentity: PROJECT,
			generation: 2,
			evidenceDigest: "parity:stable",
			snapshotFingerprint: "snapshot:fresh",
			passedAt: NOW,
		});

		expect(state.stableParityEvidenceDigest).toBe("parity:stable");
		expect(state.authorityState).toBe("legacy");
	});

	it("persists attempt, error, and lease timestamps without changing authority", () => {
		upsertRecipientPolicyAuthorityObservation(db, {
			canonicalProjectIdentity: PROJECT,
			generation: 2,
			desiredDevicesDigest: "devices:desired",
			currentDevicesDigest: null,
			freshSnapshotFingerprint: null,
			freshSnapshotObservedAt: null,
			now: NOW,
		});

		const state = recordRecipientPolicyAuthorityExecution(db, {
			canonicalProjectIdentity: PROJECT,
			generation: 2,
			attemptCount: 1,
			lastAttemptAt: NOW,
			lastCompletedAt: null,
			safeErrorCode: "snapshot_stale",
			lastErrorAt: NOW,
			leaseOwner: "worker-a",
			leaseAcquiredAt: NOW,
			leaseExpiresAt: "2026-07-22T10:01:00.000Z",
			updatedAt: NOW,
		});

		expect(state).toMatchObject({
			authorityState: "legacy",
			attemptCount: 1,
			safeErrorCode: "snapshot_stale",
			leaseOwner: "worker-a",
		});
	});

	it("creates deterministic generation-scoped steps and rejects conflicting reuse", () => {
		const input = {
			canonicalProjectIdentity: PROJECT,
			generation: 3,
			stepKey: "revoke:device-a",
			payloadDigest: "payload:one",
			now: NOW,
		};

		const first = ensureRecipientPolicyReconciliationStep(db, input);
		const replay = ensureRecipientPolicyReconciliationStep(db, input);
		const running = recordRecipientPolicyReconciliationStepState(db, {
			canonicalProjectIdentity: PROJECT,
			generation: 3,
			stepKey: input.stepKey,
			effectId: first.effectId,
			status: "running",
			attemptCount: 1,
			startedAt: NOW,
			completedAt: null,
			lastAttemptAt: NOW,
			safeErrorCode: null,
			errorAt: null,
			leaseOwner: "worker-a",
			leaseAcquiredAt: NOW,
			leaseExpiresAt: "2026-07-22T10:01:00.000Z",
			updatedAt: NOW,
		});

		expect(replay.effectId).toBe(first.effectId);
		expect(running).toMatchObject({
			status: "running",
			attemptCount: 1,
			leaseOwner: "worker-a",
		});
		expect(
			db.prepare("SELECT COUNT(*) FROM recipient_policy_reconciliation_steps").pluck().get(),
		).toBe(1);
		expect(() =>
			ensureRecipientPolicyReconciliationStep(db, { ...input, payloadDigest: "payload:changed" }),
		).toThrow("recipient_policy_reconciliation_step_conflict");
	});

	it("prunes only old completed capability and refresh bookkeeping", () => {
		const insert = db.prepare(
			`INSERT INTO recipient_policy_reconciliation_steps(
			 canonical_project_identity, generation, step_key, effect_id, payload_digest,
			 status, completed_at, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, 'payload', ?, ?, ?, ?)`,
		);
		for (let generation = 1; generation <= 4; generation += 1) {
			const at = `2026-07-22T10:0${generation}:00.000Z`;
			insert.run(
				PROJECT,
				generation,
				`capability:pass:${generation}`,
				`cap-${generation}`,
				"completed",
				at,
				at,
				at,
			);
			insert.run(
				PROJECT,
				generation,
				`refresh:pass:${generation}`,
				`refresh-${generation}`,
				"completed",
				at,
				at,
				at,
			);
		}
		insert.run(PROJECT, 1, "revoke:snapshot:device-a", "revoke-1", "completed", NOW, NOW, NOW);
		insert.run(PROJECT, 1, "grant:pass:device-a", "grant-1", "completed", NOW, NOW, NOW);
		insert.run(
			PROJECT,
			1,
			"refresh-after-revocations-v2:scope:steady:snapshot:completed",
			"revocation-refresh-completed",
			"completed",
			NOW,
			NOW,
			NOW,
		);
		insert.run(PROJECT, 1, "capability:pending:device-a", "cap-pending", "failed", null, NOW, NOW);
		insert.run(PROJECT, 1, "capability:waiting:device-a", "cap-waiting", "waiting", null, NOW, NOW);
		insert.run(PROJECT, 1, "refresh:running", "refresh-running", "running", null, NOW, NOW);
		insert.run(
			PROJECT,
			1,
			"refresh-after-revocations-v2:scope:steady:snapshot:pending",
			"refresh-pending",
			"pending",
			null,
			NOW,
			NOW,
		);

		expect(
			pruneRecipientPolicyReconciliationSteps(db, {
				canonicalProjectIdentity: PROJECT,
				retainCompletedPerKind: 2,
			}),
		).toBe(4);

		const rows = db
			.prepare(
				`SELECT step_key, status FROM recipient_policy_reconciliation_steps
				 WHERE canonical_project_identity = ? ORDER BY step_key`,
			)
			.all(PROJECT) as Array<{ step_key: string; status: string }>;
		expect(rows.map((row) => row.step_key)).not.toContain("capability:pass:1");
		expect(rows.map((row) => row.step_key)).not.toContain("refresh:pass:1");
		expect(rows).toEqual(
			expect.arrayContaining([
				{ step_key: "capability:pending:device-a", status: "failed" },
				{ step_key: "capability:waiting:device-a", status: "waiting" },
				{ step_key: "grant:pass:device-a", status: "completed" },
				{ step_key: "revoke:snapshot:device-a", status: "completed" },
				{
					step_key: "refresh-after-revocations-v2:scope:steady:snapshot:completed",
					status: "completed",
				},
				{
					step_key: "refresh-after-revocations-v2:scope:steady:snapshot:pending",
					status: "pending",
				},
				{ step_key: "refresh:running", status: "running" },
			]),
		);

		const otherProject = "https://git.example.invalid/acme/other.git";
		insert.run(otherProject, 1, "capability:pass:other", "cap-other", "completed", NOW, NOW, NOW);
		pruneRecipientPolicyReconciliationSteps(db, {
			canonicalProjectIdentity: PROJECT,
			retainCompletedPerKind: 0,
		});
		expect(
			db
				.prepare(
					"SELECT COUNT(*) FROM recipient_policy_reconciliation_steps WHERE canonical_project_identity = ?",
				)
				.pluck()
				.get(otherProject),
		).toBe(1);
	});

	it("drains completed bookkeeping overflow with tied timestamps", () => {
		const insert = db.prepare(
			`INSERT INTO recipient_policy_reconciliation_steps(
			 canonical_project_identity, generation, step_key, effect_id, payload_digest,
			 status, completed_at, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, 'payload', 'completed', ?, ?, ?)`,
		);
		for (let generation = 1; generation <= 200; generation += 1) {
			insert.run(
				PROJECT,
				generation,
				`capability:pass:${generation}`,
				`cap-${generation}`,
				NOW,
				NOW,
				NOW,
			);
			insert.run(
				PROJECT,
				generation,
				`refresh:pass:${generation}`,
				`refresh-${generation}`,
				NOW,
				NOW,
				NOW,
			);
		}

		expect(
			pruneRecipientPolicyReconciliationSteps(db, {
				canonicalProjectIdentity: PROJECT,
				retainCompletedPerKind: 2,
			}),
		).toBe(396);
		expect(
			db
				.prepare(
					`SELECT step_key, generation FROM recipient_policy_reconciliation_steps
					 WHERE canonical_project_identity = ? ORDER BY step_key`,
				)
				.all(PROJECT),
		).toEqual([
			{ step_key: "capability:pass:199", generation: 199 },
			{ step_key: "capability:pass:200", generation: 200 },
			{ step_key: "refresh:pass:199", generation: 199 },
			{ step_key: "refresh:pass:200", generation: 200 },
		]);
	});

	it("prunes only incomplete capability steps from superseded passes", () => {
		const insert = db.prepare(
			`INSERT INTO recipient_policy_reconciliation_steps(
			 canonical_project_identity, generation, step_key, effect_id, payload_digest,
			 status, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, 'payload', ?, ?, ?)`,
		);
		insert.run(PROJECT, 1, "capability:old-pass:device-a", "old-failed", "failed", NOW, NOW);
		insert.run(
			PROJECT,
			2,
			"capability:current-pass:device-a",
			"current-failed",
			"failed",
			NOW,
			NOW,
		);
		insert.run(PROJECT, 1, "capability:old-pass:device-b", "old-pending", "pending", NOW, NOW);
		insert.run(
			PROJECT,
			2,
			"capability:current-pass:device-b",
			"current-pending",
			"pending",
			NOW,
			NOW,
		);
		insert.run(PROJECT, 1, "capability:old-pass:device-c", "old-running", "running", NOW, NOW);
		insert.run(
			PROJECT,
			2,
			"capability:current-pass:device-c",
			"current-running",
			"running",
			NOW,
			NOW,
		);
		insert.run(
			PROJECT,
			1,
			"capability:current-pass:device-e",
			"old-generation",
			"failed",
			NOW,
			NOW,
		);
		insert.run(PROJECT, 1, "capability:old-pass:device-d", "old-completed", "completed", NOW, NOW);
		insert.run(PROJECT, 1, "refresh:old-pass", "old-refresh", "failed", NOW, NOW);
		const otherProject = "https://git.example.invalid/acme/other.git";
		insert.run(
			otherProject,
			1,
			"capability:old-pass:device-a",
			"other-old-failed",
			"failed",
			NOW,
			NOW,
		);

		expect(
			pruneSupersededRecipientPolicyCapabilitySteps(db, {
				canonicalProjectIdentity: PROJECT,
				activeGeneration: 2,
				activePassKey: "current-pass",
			}),
		).toBe(4);
		expect(
			db
				.prepare(
					`SELECT step_key, status FROM recipient_policy_reconciliation_steps
					 WHERE canonical_project_identity = ? ORDER BY step_key`,
				)
				.all(PROJECT),
		).toEqual([
			{ step_key: "capability:current-pass:device-a", status: "failed" },
			{ step_key: "capability:current-pass:device-b", status: "pending" },
			{ step_key: "capability:current-pass:device-c", status: "running" },
			{ step_key: "capability:old-pass:device-d", status: "completed" },
			{ step_key: "refresh:old-pass", status: "failed" },
		]);
		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM recipient_policy_reconciliation_steps
					 WHERE canonical_project_identity = ?`,
				)
				.pluck()
				.get(otherProject),
		).toBe(1);
	});

	it("bounds pending revocation refresh lookup while preserving deterministic order", () => {
		const insert = db.prepare(
			`INSERT INTO recipient_policy_reconciliation_steps(
			 canonical_project_identity, generation, step_key, effect_id, payload_digest,
			 status, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, 'payload', ?, ?, ?)`,
		);
		for (let generation = 3; generation >= 1; generation -= 1) {
			insert.run(
				PROJECT,
				generation,
				`refresh-after-revocations-v2:scope:steady:snapshot:${generation}`,
				`refresh-${generation}`,
				"failed",
				NOW,
				NOW,
			);
		}
		insert.run(PROJECT, 0, "capability:pass:device-a", "capability", "failed", NOW, NOW);

		expect(listPendingRecipientPolicyRevocationRefreshSteps(db, PROJECT, 2)).toEqual([
			{
				generation: 1,
				stepKey: "refresh-after-revocations-v2:scope:steady:snapshot:1",
			},
			{
				generation: 2,
				stepKey: "refresh-after-revocations-v2:scope:steady:snapshot:2",
			},
		]);
		const plan = db
			.prepare(`EXPLAIN QUERY PLAN ${PENDING_RECIPIENT_POLICY_REVOCATION_REFRESH_STEPS_SQL}`)
			.all(PROJECT, 2) as Array<{ detail: string }>;
		expect(
			plan.some((row) =>
				row.detail.includes("idx_recipient_policy_reconciliation_steps_pending_refresh"),
			),
		).toBe(true);
	});

	it("bounds ordinary refresh lookup without selecting revocation refreshes", () => {
		const insert = db.prepare(
			`INSERT INTO recipient_policy_reconciliation_steps(
			 canonical_project_identity, generation, step_key, effect_id, payload_digest,
			 status, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, 'payload', 'failed', ?, ?)`,
		);
		insert.run(PROJECT, 2, "refresh:pass-b", "ordinary-2", NOW, NOW);
		insert.run(PROJECT, 1, "refresh:pass-a", "ordinary-1", NOW, NOW);
		insert.run(
			PROJECT,
			1,
			"refresh-after-revocations-v2:scope:steady:snapshot:1",
			"revocation-1",
			NOW,
			NOW,
		);
		insert.run(PROJECT, 0, "capability:pass:device-a", "capability-1", NOW, NOW);

		expect(listPendingRecipientPolicyRefreshSteps(db, PROJECT)).toEqual([
			{ generation: 1, stepKey: "refresh:pass-a" },
			{ generation: 2, stepKey: "refresh:pass-b" },
		]);
		expect(listPendingRecipientPolicyRefreshSteps(db, PROJECT, 1)).toEqual([
			{ generation: 1, stepKey: "refresh:pass-a" },
		]);
	});

	it("keeps deny overlays keyed by exact Project, scope, and device until verified", () => {
		const input = {
			canonicalProjectIdentity: PROJECT,
			scopeId: "scope-project",
			deviceId: "device-a",
			generation: 4,
			reasonCode: "pending_revoke",
			now: NOW,
		};
		putRecipientPolicyDenyOverlay(db, input);
		putRecipientPolicyDenyOverlay(db, input);

		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toHaveLength(1);
		expect(
			clearRecipientPolicyDenyOverlay(db, {
				canonicalProjectIdentity: PROJECT,
				scopeId: "scope-project",
				deviceId: "device-a",
				verifiedGeneration: 3,
			}),
		).toBe(false);
		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toHaveLength(1);
		expect(
			clearRecipientPolicyDenyOverlay(db, {
				canonicalProjectIdentity: PROJECT,
				scopeId: "scope-project",
				deviceId: "device-a",
				verifiedGeneration: 4,
			}),
		).toBe(true);
	});

	it("allows same-generation deny reasons to become stricter without accepting stale writes", () => {
		const base = {
			canonicalProjectIdentity: PROJECT,
			scopeId: "scope-project",
			deviceId: "device-a",
			generation: 4,
			now: NOW,
		};
		putRecipientPolicyDenyOverlay(db, {
			...base,
			reasonCode: "enrollment_identity_conflict",
		});
		putRecipientPolicyDenyOverlay(db, { ...base, reasonCode: "pending_revoke" });

		expect(listRecipientPolicyDenyOverlays(db, PROJECT)).toEqual([
			expect.objectContaining({ generation: 4, reasonCode: "pending_revoke" }),
		]);
		expect(() =>
			putRecipientPolicyDenyOverlay(db, {
				...base,
				generation: 3,
				reasonCode: "enrollment_identity_conflict",
			}),
		).toThrow("recipient_policy_deny_overlay_stale");
	});
});
