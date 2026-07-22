import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearRecipientPolicyDenyOverlay,
	type DeriveRecipientPolicyEffectiveDevicesInput,
	deriveRecipientPolicyEffectiveDevices,
	ensureRecipientPolicyReconciliationStep,
	getRecipientPolicyAuthorityState,
	listRecipientPolicyDenyOverlays,
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
});
