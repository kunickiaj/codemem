import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import {
	clearRecipientPolicyDenyOverlay,
	deriveRecipientPolicyEffectiveDevicesFromDatabase,
	deterministicRecipientPolicyReconciliationEffectId,
	ensureRecipientPolicyReconciliationStep,
	getRecipientPolicyAuthorityState,
	listPendingRecipientPolicyRefreshSteps,
	listPendingRecipientPolicyRevocationRefreshSteps,
	listRecipientPolicyDenyOverlays,
	pruneRecipientPolicyReconciliationSteps,
	pruneSupersededRecipientPolicyCapabilitySteps,
	putRecipientPolicyDenyOverlay,
	recordRecipientPolicyReconciliationStepState,
	recordRecipientPolicyStableParityPass,
	upsertRecipientPolicyAuthorityObservation,
} from "./recipient-policy-reconciliation.js";
import { SCOPE_MEMBERSHIP_REVOCATION_LIMITATION } from "./scope-membership-semantics.js";

export type RecipientPolicyPeerCapability = "supported" | "unsupported" | "undetermined";

export interface RecipientPolicyCoordinatorSnapshot {
	authoritative: boolean;
	scopeId: string;
	scopeMembershipEpoch?: number;
	fingerprint: string;
	observedAt: string;
	memberships: Array<{
		deviceId: string;
		status: "active" | "revoked";
		membershipEpoch?: number;
	}>;
}

export interface RecipientPolicyCoordinatorEffectReceipt {
	effectId: string;
	scopeId: string;
	deviceId: string;
	status: "active" | "revoked";
}

export interface RecipientPolicyBoundaryEnrollment {
	deviceId: string;
	identityId: string | null;
	publicKey: string;
	fingerprint: string;
	enabled: boolean;
}

export interface RecipientPolicyReconcilerEffects {
	now(): string;
	snapshot(input: {
		canonicalProjectIdentity: string;
		scopeId: string;
	}): Promise<RecipientPolicyCoordinatorSnapshot>;
	listBoundaryEnrollments(input: {
		canonicalProjectIdentity: string;
		scopeId: string;
	}): Promise<RecipientPolicyBoundaryEnrollment[]>;
	probeCapability(input: {
		deviceId: string;
		scopeId: string;
	}): Promise<RecipientPolicyPeerCapability>;
	revoke(input: {
		effectId: string;
		canonicalProjectIdentity: string;
		generation: number;
		scopeId: string;
		deviceId: string;
	}): Promise<RecipientPolicyCoordinatorEffectReceipt>;
	grant(input: {
		effectId: string;
		canonicalProjectIdentity: string;
		generation: number;
		scopeId: string;
		deviceId: string;
		role: "member";
	}): Promise<RecipientPolicyCoordinatorEffectReceipt>;
	refresh(input: { canonicalProjectIdentity: string; scopeId: string }): Promise<void>;
}

export type RecipientPolicyReconcileStatus =
	| "active"
	| "busy"
	| "needs_attention"
	| "parity_pending"
	| "stale"
	| "waiting";

export interface RecipientPolicyReconcileResult {
	canonicalProjectIdentity: string;
	status: RecipientPolicyReconcileStatus;
	generation: number;
	safeErrorCode: string | null;
	revokedDeviceIds: string[];
	grantedDeviceIds: string[];
	deliveredCopiesMayRemain: true;
	revocationWarning: string;
}

export interface ReconcileRecipientPolicyProjectInput {
	canonicalProjectIdentity: string;
	leaseOwner: string;
	leaseDurationMs?: number;
}

interface ManagedProjectBoundary {
	scopeId: string;
}

interface Lease {
	acquiredAt: string;
	expiresAt: string;
}

const DEFAULT_LEASE_DURATION_MS = 60_000;
const DELIVERED_COPY_WARNING = true as const;
const CONTROL_CHARACTER = /\p{Cc}/u;
const RETRYABLE_ACTIVE_AUTHORITY_ERRORS = new Set([
	"recipient_policy_capability_undetermined",
	"recipient_policy_parity_incomplete",
	"recipient_policy_snapshot_not_fresh",
]);
const SAFE_RECONCILIATION_ERRORS = new Set([
	"recipient_policy_active_managed_scope_required",
	"recipient_policy_authority_state_missing",
	"recipient_policy_capability_undetermined",
	"recipient_policy_capability_unsupported",
	"recipient_policy_deny_overlay_conflict",
	"recipient_policy_deny_overlay_stale",
	"recipient_policy_effect_failed",
	"recipient_policy_effect_receipt_invalid",
	"recipient_policy_exact_mapping_required",
	"recipient_policy_generation_conflict",
	"recipient_policy_generation_stale",
	"recipient_policy_lease_lost",
	"recipient_policy_parity_evidence_conflict",
	"recipient_policy_parity_evidence_invalid",
	"recipient_policy_reconciliation_step_conflict",
	"recipient_policy_snapshot_invalid",
	"recipient_policy_snapshot_not_fresh",
]);

function validId(value: string): boolean {
	return value.length > 0 && value === value.trim() && !CONTROL_CHARACTER.test(value);
}

function timestamp(value: string, errorCode: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(errorCode);
	return parsed;
}

function digest(prefix: string, value: unknown): string {
	return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function safeError(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : "";
	return SAFE_RECONCILIATION_ERRORS.has(message) ? message : fallback;
}

function deviceDigest(deviceIds: readonly string[]): string {
	return digest("recipient-policy-current-devices-v1", deviceIds.toSorted());
}

function result(
	projectId: string,
	status: RecipientPolicyReconcileStatus,
	generation: number,
	safeErrorCode: string | null,
	revokedDeviceIds: string[] = [],
	grantedDeviceIds: string[] = [],
): RecipientPolicyReconcileResult {
	return {
		canonicalProjectIdentity: projectId,
		status,
		generation,
		safeErrorCode,
		revokedDeviceIds,
		grantedDeviceIds,
		deliveredCopiesMayRemain: DELIVERED_COPY_WARNING,
		revocationWarning: SCOPE_MEMBERSHIP_REVOCATION_LIMITATION,
	};
}

function acquireLease(
	db: Database,
	input: ReconcileRecipientPolicyProjectInput,
	now: string,
): Lease | null {
	if (!validId(input.canonicalProjectIdentity) || !validId(input.leaseOwner)) {
		throw new Error("recipient_policy_reconciliation_input_invalid");
	}
	const duration = input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
	if (!Number.isSafeInteger(duration) || duration <= 0) {
		throw new Error("recipient_policy_reconciliation_lease_invalid");
	}
	const expiresAt = new Date(
		timestamp(now, "recipient_policy_reconciliation_time_invalid") + duration,
	).toISOString();
	return db.transaction(() => {
		db.prepare(
			`INSERT OR IGNORE INTO recipient_policy_authority_states(
			 canonical_project_identity, authority_state, generation, state_changed_at, created_at, updated_at
			 ) VALUES (?, 'legacy', 0, ?, ?, ?)`,
		).run(input.canonicalProjectIdentity, now, now, now);
		const state = getRecipientPolicyAuthorityState(db, input.canonicalProjectIdentity);
		if (!state) throw new Error("recipient_policy_authority_state_missing");
		const heldByOther =
			state.leaseOwner !== null &&
			state.leaseOwner !== input.leaseOwner &&
			state.leaseExpiresAt !== null &&
			timestamp(state.leaseExpiresAt, "recipient_policy_reconciliation_lease_invalid") >
				timestamp(now, "recipient_policy_reconciliation_time_invalid");
		if (heldByOther) return null;
		db.prepare(
			`UPDATE recipient_policy_authority_states SET lease_owner = ?, lease_acquired_at = ?,
			 lease_expires_at = ?, updated_at = ? WHERE canonical_project_identity = ?`,
		).run(input.leaseOwner, now, expiresAt, now, input.canonicalProjectIdentity);
		return { acquiredAt: now, expiresAt };
	})();
}

function releaseLease(db: Database, projectId: string, leaseOwner: string, now: string): void {
	db.prepare(
		`UPDATE recipient_policy_authority_states SET lease_owner = NULL, lease_acquired_at = NULL,
		 lease_expires_at = NULL, updated_at = ?
		 WHERE canonical_project_identity = ? AND lease_owner = ?`,
	).run(now, projectId, leaseOwner);
}

function assertLease(db: Database, projectId: string, leaseOwner: string, now: string): void {
	const state = getRecipientPolicyAuthorityState(db, projectId);
	if (
		state?.leaseOwner !== leaseOwner ||
		state.leaseExpiresAt === null ||
		timestamp(state.leaseExpiresAt, "recipient_policy_reconciliation_lease_invalid") <=
			timestamp(now, "recipient_policy_reconciliation_time_invalid")
	) {
		throw new Error("recipient_policy_lease_lost");
	}
}

function boundary(db: Database, projectId: string): ManagedProjectBoundary {
	const mappings = db
		.prepare(
			`SELECT workspace_identity, project_pattern, scope_id FROM project_scope_mappings
			 WHERE workspace_identity = ? ORDER BY id`,
		)
		.all(projectId) as Array<{
		workspace_identity: string | null;
		project_pattern: string;
		scope_id: string;
	}>;
	const mapping = mappings[0];
	if (
		!mapping ||
		mappings.length !== 1 ||
		mapping.workspace_identity !== projectId ||
		mapping.project_pattern !== projectId ||
		!validId(mapping.scope_id)
	) {
		throw new Error("recipient_policy_exact_mapping_required");
	}
	const scopes = db
		.prepare(
			`SELECT scope_id, coordinator_id, group_id FROM replication_scopes
			 WHERE scope_id = ? AND kind = 'managed_project' AND authority_type = 'coordinator'
			 AND status = 'active'`,
		)
		.all(mapping.scope_id) as Array<{
		scope_id: string;
		coordinator_id: string | null;
		group_id: string | null;
	}>;
	const mappingCount = Number(
		db
			.prepare("SELECT COUNT(*) FROM project_scope_mappings WHERE scope_id = ?")
			.pluck()
			.get(mapping.scope_id) ?? 0,
	);
	if (
		scopes.length !== 1 ||
		mappingCount !== 1 ||
		!validId(scopes[0]?.coordinator_id ?? "") ||
		!validId(scopes[0]?.group_id ?? "")
	) {
		throw new Error("recipient_policy_active_managed_scope_required");
	}
	return { scopeId: scopes[0]?.scope_id ?? "" };
}

function activeSnapshotDevices(
	snapshot: RecipientPolicyCoordinatorSnapshot,
	expectedScopeId: string,
	requestedAt: string,
): string[] {
	if (
		!snapshot.authoritative ||
		snapshot.scopeId !== expectedScopeId ||
		!validId(snapshot.fingerprint) ||
		timestamp(snapshot.observedAt, "recipient_policy_snapshot_invalid") <
			timestamp(requestedAt, "recipient_policy_reconciliation_time_invalid")
	) {
		throw new Error("recipient_policy_snapshot_not_fresh");
	}
	const scopeMembershipEpoch = snapshot.scopeMembershipEpoch ?? 0;
	if (!Number.isSafeInteger(scopeMembershipEpoch) || scopeMembershipEpoch < 0) {
		throw new Error("recipient_policy_snapshot_invalid");
	}
	const seen = new Set<string>();
	for (const membership of snapshot.memberships) {
		const membershipEpoch = membership.membershipEpoch ?? 0;
		if (
			!validId(membership.deviceId) ||
			!(["active", "revoked"] as const).includes(membership.status) ||
			!Number.isSafeInteger(membershipEpoch) ||
			membershipEpoch < 0 ||
			seen.has(membership.deviceId)
		) {
			throw new Error("recipient_policy_snapshot_invalid");
		}
		seen.add(membership.deviceId);
	}
	return snapshot.memberships
		.filter(
			(membership) =>
				membership.status === "active" && (membership.membershipEpoch ?? 0) >= scopeMembershipEpoch,
		)
		.map((membership) => membership.deviceId)
		.toSorted();
}

function boundaryEnrollmentIdentities(
	enrollments: RecipientPolicyBoundaryEnrollment[],
): Map<string, RecipientPolicyBoundaryEnrollment> {
	const bindings = new Map<string, RecipientPolicyBoundaryEnrollment>();
	for (const enrollment of enrollments) {
		if (
			!validId(enrollment.deviceId) ||
			typeof enrollment.enabled !== "boolean" ||
			(enrollment.identityId !== null && !validId(enrollment.identityId)) ||
			!validId(enrollment.publicKey) ||
			!validId(enrollment.fingerprint) ||
			bindings.has(enrollment.deviceId)
		) {
			throw new Error("recipient_policy_snapshot_invalid");
		}
		bindings.set(enrollment.deviceId, enrollment);
	}
	return bindings;
}

type EnrollmentRevocationReason = "enrollment_disabled" | "enrollment_identity_conflict";
type EnrollmentRevocationPhase = "steady_state" | "post_grant";

interface EnrollmentRevocation {
	deviceId: string;
	reasonCode: EnrollmentRevocationReason;
}

interface RevocationStep {
	deviceId: string;
	stepKey: string;
}

function enrollmentRevocationReason(
	binding: RecipientPolicyBoundaryEnrollment | undefined,
	desiredIdentityId: string | undefined,
): EnrollmentRevocationReason | null {
	if (!binding) return null;
	if (!binding.enabled) return "enrollment_disabled";
	return desiredIdentityId &&
		binding.identityId !== null &&
		binding.identityId !== desiredIdentityId
		? "enrollment_identity_conflict"
		: null;
}

function isEnrollmentEnabledForIdentityGrant(
	binding: RecipientPolicyBoundaryEnrollment | undefined,
	desiredIdentityId: string | undefined,
): boolean {
	return Boolean(binding?.enabled && desiredIdentityId && binding.identityId === desiredIdentityId);
}

function unreachableEnrollmentRevocationCase(value: never): never {
	throw new Error(`recipient_policy_enrollment_revocation_invalid:${String(value)}`);
}

function enrollmentRevocationStepKey(
	reasonCode: EnrollmentRevocationReason,
	phase: EnrollmentRevocationPhase,
	snapshotStateKey: string,
	deviceId: string,
): string {
	switch (phase) {
		case "steady_state":
			switch (reasonCode) {
				case "enrollment_identity_conflict":
					return `revoke-enrollment-conflict:${snapshotStateKey}:${deviceId}`;
				case "enrollment_disabled":
					return `revoke-enrollment-disabled:${snapshotStateKey}:${deviceId}`;
				default:
					return unreachableEnrollmentRevocationCase(reasonCode);
			}
		case "post_grant":
			switch (reasonCode) {
				case "enrollment_identity_conflict":
					return `revoke-post-grant-enrollment-conflict:${snapshotStateKey}:${deviceId}`;
				case "enrollment_disabled":
					return `revoke-post-grant-enrollment-disabled:${snapshotStateKey}:${deviceId}`;
				default:
					return unreachableEnrollmentRevocationCase(reasonCode);
			}
		default:
			return unreachableEnrollmentRevocationCase(phase);
	}
}

function enrollmentRevocationStep(
	revocation: EnrollmentRevocation,
	phase: EnrollmentRevocationPhase,
	snapshotStateKey: string,
): RevocationStep {
	return {
		deviceId: revocation.deviceId,
		stepKey: enrollmentRevocationStepKey(
			revocation.reasonCode,
			phase,
			snapshotStateKey,
			revocation.deviceId,
		),
	};
}

function revocationRefreshStepKey(input: {
	scopeId: string;
	phase: EnrollmentRevocationPhase;
	snapshotStateKey: string;
	revocationSetKey: string;
}): string {
	const scopeKey = digest("recipient-policy-revocation-refresh-scope-v1", input.scopeId);
	return `refresh-after-revocations-v2:${scopeKey}:${input.phase}:${input.snapshotStateKey}:${input.revocationSetKey}`;
}

function generation(db: Database, projectId: string, desiredDigest: string): number {
	const state = getRecipientPolicyAuthorityState(db, projectId);
	if (!state || state.desiredDevicesDigest === null) return 1;
	return state.desiredDevicesDigest === desiredDigest ? state.generation : state.generation + 1;
}

function authority(
	db: Database,
	input: {
		projectId: string;
		state?: "active" | "eligible" | "legacy" | "rolled_back";
		safeErrorCode: string | null;
		now: string;
		completed?: boolean;
	},
): void {
	const current = getRecipientPolicyAuthorityState(db, input.projectId);
	const preserveActiveAuthority =
		input.safeErrorCode !== null && RETRYABLE_ACTIVE_AUTHORITY_ERRORS.has(input.safeErrorCode);
	const nextState =
		input.state ??
		(current?.authorityState === "active" && !preserveActiveAuthority ? "rolled_back" : undefined);
	db.prepare(
		`UPDATE recipient_policy_authority_states SET
		 authority_state = COALESCE(?, authority_state),
		 state_changed_at = CASE WHEN ? IS NULL OR ? = authority_state THEN state_changed_at ELSE ? END,
		 safe_error_code = ?, last_error_at = CASE WHEN ? IS NULL THEN NULL ELSE ? END,
		 last_completed_at = CASE WHEN ? THEN ? ELSE last_completed_at END,
		 attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?
		 WHERE canonical_project_identity = ?`,
	).run(
		nextState ?? null,
		nextState ?? null,
		nextState ?? null,
		input.now,
		input.safeErrorCode,
		input.safeErrorCode,
		input.now,
		input.completed ? 1 : 0,
		input.now,
		input.now,
		input.now,
		input.projectId,
	);
}

function resetParity(db: Database, projectId: string, now: string): void {
	db.prepare(
		`UPDATE recipient_policy_authority_states SET stable_parity_evidence_digest = NULL,
		 stable_parity_passed_at = NULL, updated_at = ? WHERE canonical_project_identity = ?`,
	).run(now, projectId);
}

async function step(
	db: Database,
	input: {
		projectId: string;
		generation: number;
		stepKey: string;
		payload: unknown;
		leaseOwner: string;
		lease: Lease;
		now: () => string;
	},
	work: (effectId: string) => Promise<void>,
): Promise<boolean> {
	const createdAt = input.now();
	assertLease(db, input.projectId, input.leaseOwner, createdAt);
	const persisted = ensureRecipientPolicyReconciliationStep(db, {
		canonicalProjectIdentity: input.projectId,
		generation: input.generation,
		stepKey: input.stepKey,
		payloadDigest: digest("recipient-policy-step-payload-v1", input.payload),
		now: createdAt,
	});
	if (persisted.status === "completed") return false;
	recordRecipientPolicyReconciliationStepState(db, {
		canonicalProjectIdentity: input.projectId,
		generation: input.generation,
		stepKey: input.stepKey,
		effectId: persisted.effectId,
		status: "running",
		attemptCount: persisted.attemptCount + 1,
		startedAt: persisted.startedAt ?? createdAt,
		completedAt: null,
		lastAttemptAt: createdAt,
		safeErrorCode: null,
		errorAt: null,
		leaseOwner: input.leaseOwner,
		leaseAcquiredAt: input.lease.acquiredAt,
		leaseExpiresAt: input.lease.expiresAt,
		updatedAt: createdAt,
	});
	try {
		await work(persisted.effectId);
	} catch (error) {
		const failedAt = input.now();
		const safeErrorCode = safeError(error, "recipient_policy_effect_failed");
		recordRecipientPolicyReconciliationStepState(db, {
			canonicalProjectIdentity: input.projectId,
			generation: input.generation,
			stepKey: input.stepKey,
			effectId: persisted.effectId,
			status: "failed",
			attemptCount: persisted.attemptCount + 1,
			startedAt: persisted.startedAt ?? createdAt,
			completedAt: null,
			lastAttemptAt: failedAt,
			safeErrorCode,
			errorAt: failedAt,
			leaseOwner: input.leaseOwner,
			leaseAcquiredAt: input.lease.acquiredAt,
			leaseExpiresAt: input.lease.expiresAt,
			updatedAt: failedAt,
		});
		throw new Error(safeErrorCode);
	}
	const completedAt = input.now();
	recordRecipientPolicyReconciliationStepState(db, {
		canonicalProjectIdentity: input.projectId,
		generation: input.generation,
		stepKey: input.stepKey,
		effectId: persisted.effectId,
		status: "completed",
		attemptCount: persisted.attemptCount + 1,
		startedAt: persisted.startedAt ?? createdAt,
		completedAt,
		lastAttemptAt: completedAt,
		safeErrorCode: null,
		errorAt: null,
		leaseOwner: input.leaseOwner,
		leaseAcquiredAt: input.lease.acquiredAt,
		leaseExpiresAt: input.lease.expiresAt,
		updatedAt: completedAt,
	});
	return true;
}

function validateReceipt(
	receipt: RecipientPolicyCoordinatorEffectReceipt,
	expected: { effectId: string; scopeId: string; deviceId: string; status: "active" | "revoked" },
): void {
	if (
		receipt.effectId !== expected.effectId ||
		receipt.scopeId !== expected.scopeId ||
		receipt.deviceId !== expected.deviceId ||
		receipt.status !== expected.status
	) {
		throw new Error("recipient_policy_effect_receipt_invalid");
	}
}

async function applyEnrollmentRevocations(
	db: Database,
	input: {
		projectId: string;
		generation: number;
		scopeId: string;
		snapshotStateKey: string;
		phase: EnrollmentRevocationPhase;
		revocations: EnrollmentRevocation[];
		changedDeviceIds: string[];
		leaseOwner: string;
		lease: Lease;
		effects: RecipientPolicyReconcilerEffects;
	},
): Promise<void> {
	if (input.revocations.length === 0) return;
	stageEnrollmentRevocationOverlays(db, input);
	for (const revocation of input.revocations) {
		const revocationStep = enrollmentRevocationStep(
			revocation,
			input.phase,
			input.snapshotStateKey,
		);
		const changed = await step(
			db,
			{
				projectId: input.projectId,
				generation: input.generation,
				stepKey: revocationStep.stepKey,
				payload: { scopeId: input.scopeId, deviceId: revocation.deviceId, status: "revoked" },
				leaseOwner: input.leaseOwner,
				lease: input.lease,
				now: input.effects.now,
			},
			async (effectId) => {
				const receipt = await input.effects.revoke({
					effectId,
					canonicalProjectIdentity: input.projectId,
					generation: input.generation,
					scopeId: input.scopeId,
					deviceId: revocation.deviceId,
				});
				validateReceipt(receipt, {
					effectId,
					scopeId: input.scopeId,
					deviceId: revocation.deviceId,
					status: "revoked",
				});
			},
		);
		if (changed) input.changedDeviceIds.push(revocation.deviceId);
		await refreshAfterRevocations(db, {
			projectId: input.projectId,
			generation: input.generation,
			scopeId: input.scopeId,
			snapshotStateKey: input.snapshotStateKey,
			phase: input.phase,
			revocations: [revocationStep],
			leaseOwner: input.leaseOwner,
			lease: input.lease,
			effects: input.effects,
		});
	}
}

function stageEnrollmentRevocationOverlays(
	db: Database,
	input: {
		projectId: string;
		generation: number;
		scopeId: string;
		revocations: EnrollmentRevocation[];
		effects: RecipientPolicyReconcilerEffects;
	},
): void {
	if (input.revocations.length === 0) return;
	resetParity(db, input.projectId, input.effects.now());
	for (const { deviceId, reasonCode } of input.revocations) {
		putRecipientPolicyDenyOverlay(db, {
			canonicalProjectIdentity: input.projectId,
			scopeId: input.scopeId,
			deviceId,
			generation: input.generation,
			reasonCode,
			now: input.effects.now(),
		});
	}
}

async function refreshAfterRevocations(
	db: Database,
	input: {
		projectId: string;
		generation: number;
		scopeId: string;
		snapshotStateKey: string;
		phase: EnrollmentRevocationPhase;
		revocations: RevocationStep[];
		leaseOwner: string;
		lease: Lease;
		effects: RecipientPolicyReconcilerEffects;
	},
): Promise<void> {
	const revocationStepKeys = [
		...new Set(input.revocations.map(({ stepKey }) => stepKey)),
	].toSorted();
	if (revocationStepKeys.length === 0) return;
	const revocationSetKey = digest("recipient-policy-revocation-refresh-v2", {
		revocationStepKeys,
	});
	await step(
		db,
		{
			projectId: input.projectId,
			generation: input.generation,
			stepKey: revocationRefreshStepKey({
				scopeId: input.scopeId,
				phase: input.phase,
				snapshotStateKey: input.snapshotStateKey,
				revocationSetKey,
			}),
			payload: { canonicalProjectIdentity: input.projectId },
			leaseOwner: input.leaseOwner,
			lease: input.lease,
			now: input.effects.now,
		},
		async () =>
			input.effects.refresh({
				canonicalProjectIdentity: input.projectId,
				scopeId: input.scopeId,
			}),
	);
}

async function retryPendingRevocationRefreshes(
	db: Database,
	input: {
		projectId: string;
		scopeId: string;
		leaseOwner: string;
		lease: Lease;
		effects: RecipientPolicyReconcilerEffects;
	},
): Promise<boolean> {
	const pending = listPendingRecipientPolicyRevocationRefreshSteps(db, input.projectId);
	for (const refresh of pending) {
		await step(
			db,
			{
				projectId: input.projectId,
				generation: refresh.generation,
				stepKey: refresh.stepKey,
				// The effect refreshes the current boundary, so replay must survive a scope remap.
				payload: { canonicalProjectIdentity: input.projectId },
				leaseOwner: input.leaseOwner,
				lease: input.lease,
				now: input.effects.now,
			},
			async () =>
				input.effects.refresh({
					canonicalProjectIdentity: input.projectId,
					scopeId: input.scopeId,
				}),
		);
	}
	return pending.length > 0;
}

async function retryPendingRefreshes(
	db: Database,
	input: {
		projectId: string;
		scopeId: string;
		leaseOwner: string;
		lease: Lease;
		effects: RecipientPolicyReconcilerEffects;
	},
): Promise<boolean> {
	const pending = listPendingRecipientPolicyRefreshSteps(db, input.projectId);
	for (const refresh of pending) {
		const payload = { canonicalProjectIdentity: input.projectId };
		const payloadDigest = digest("recipient-policy-step-payload-v1", payload);
		const effectId = deterministicRecipientPolicyReconciliationEffectId({
			canonicalProjectIdentity: input.projectId,
			generation: refresh.generation,
			stepKey: refresh.stepKey,
			payloadDigest,
		});
		// Pre-upgrade incomplete refresh rows used snapshot-specific payload identities. Refresh is
		// idempotent and targets the current boundary, so normalize those rows before replay.
		db.transaction(() => {
			assertLease(db, input.projectId, input.leaseOwner, input.effects.now());
			db.prepare(
				`UPDATE recipient_policy_reconciliation_steps
				 SET effect_id = ?, payload_digest = ?
				 WHERE canonical_project_identity = ? AND generation = ? AND step_key = ?
				 AND status IN ('pending', 'running', 'failed')`,
			).run(effectId, payloadDigest, input.projectId, refresh.generation, refresh.stepKey);
		}).immediate();
		await step(
			db,
			{
				projectId: input.projectId,
				generation: refresh.generation,
				stepKey: refresh.stepKey,
				payload,
				leaseOwner: input.leaseOwner,
				lease: input.lease,
				now: input.effects.now,
			},
			async () =>
				input.effects.refresh({
					canonicalProjectIdentity: input.projectId,
					scopeId: input.scopeId,
				}),
		);
	}
	return pending.length > 0;
}

async function preflight(
	db: Database,
	input: {
		projectId: string;
		generation: number;
		scopeId: string;
		deviceIds: string[];
		passKey: string;
		leaseOwner: string;
		lease: Lease;
		effects: RecipientPolicyReconcilerEffects;
	},
): Promise<"supported" | RecipientPolicyPeerCapability> {
	const capabilities: RecipientPolicyPeerCapability[] = [];
	for (const deviceId of input.deviceIds) {
		let capability: RecipientPolicyPeerCapability = "undetermined";
		let executed: boolean | undefined;
		try {
			executed = await step(
				db,
				{
					projectId: input.projectId,
					generation: input.generation,
					stepKey: `capability:${input.passKey}:${deviceId}`,
					payload: { deviceId, passKey: input.passKey },
					leaseOwner: input.leaseOwner,
					lease: input.lease,
					now: input.effects.now,
				},
				async () => {
					const observed = await input.effects.probeCapability({
						deviceId,
						scopeId: input.scopeId,
					});
					capability = ["supported", "unsupported", "undetermined"].includes(observed)
						? observed
						: "undetermined";
					if (capability === "unsupported") {
						throw new Error("recipient_policy_capability_unsupported");
					}
					if (capability === "undetermined") {
						throw new Error("recipient_policy_capability_undetermined");
					}
				},
			);
		} catch (error) {
			const safeErrorCode = safeError(error, "recipient_policy_reconciliation_failed");
			if (safeErrorCode === "recipient_policy_capability_unsupported") {
				capability = "unsupported";
			} else if (safeErrorCode === "recipient_policy_capability_undetermined") {
				capability = "undetermined";
			} else {
				throw error;
			}
		}
		if (executed === false) capability = "supported";
		capabilities.push(capability);
	}
	if (capabilities.includes("unsupported")) return "unsupported";
	if (capabilities.includes("undetermined")) return "undetermined";
	return "supported";
}

export function assertLegacyShareGrantAllowed(
	db: Database,
	input: { canonicalProjectIdentity: string; deviceId: string },
): void {
	const state = getRecipientPolicyAuthorityState(db, input.canonicalProjectIdentity);
	if (!state || state.authorityState === "legacy") return;
	const desired = deriveRecipientPolicyEffectiveDevicesFromDatabase(
		db,
		input.canonicalProjectIdentity,
	);
	const desiredDeviceDigest =
		desired.status === "eligible"
			? deviceDigest(desired.devices.map((item) => item.deviceId).toSorted())
			: null;
	if (
		desired.status !== "eligible" ||
		desiredDeviceDigest !== state.desiredDevicesDigest ||
		!desired.devices.some((item) => item.deviceId === input.deviceId)
	) {
		throw new Error("recipient_policy_legacy_grant_blocked");
	}
}

export async function reconcileRecipientPolicyProject(
	db: Database,
	input: ReconcileRecipientPolicyProjectInput,
	effects: RecipientPolicyReconcilerEffects,
): Promise<RecipientPolicyReconcileResult> {
	const projectId = input.canonicalProjectIdentity;
	const startedAt = effects.now();
	const lease = acquireLease(db, input, startedAt);
	if (!lease) {
		return result(
			projectId,
			"busy",
			getRecipientPolicyAuthorityState(db, projectId)?.generation ?? 0,
			"recipient_policy_lease_held",
		);
	}
	let activeGeneration = getRecipientPolicyAuthorityState(db, projectId)?.generation ?? 0;
	const revokedDeviceIds: string[] = [];
	const grantedDeviceIds: string[] = [];
	try {
		pruneRecipientPolicyReconciliationSteps(db, { canonicalProjectIdentity: projectId });
		const managedBoundary = boundary(db, projectId);
		const desired = deriveRecipientPolicyEffectiveDevicesFromDatabase(db, projectId);
		if (desired.status !== "eligible") {
			authority(db, {
				projectId,
				safeErrorCode: "recipient_policy_desired_state_invalid",
				now: effects.now(),
			});
			return result(
				projectId,
				"needs_attention",
				activeGeneration,
				"recipient_policy_desired_state_invalid",
			);
		}
		const initialSnapshot = await effects.snapshot({
			canonicalProjectIdentity: projectId,
			scopeId: managedBoundary.scopeId,
		});
		const currentDeviceIds = activeSnapshotDevices(
			initialSnapshot,
			managedBoundary.scopeId,
			startedAt,
		);
		const policyDesiredDeviceIds = desired.devices.map((device) => device.deviceId).toSorted();
		const policyDesiredSet = new Set(policyDesiredDeviceIds);
		const currentSet = new Set(currentDeviceIds);
		const revokeDeviceIds = currentDeviceIds.filter((deviceId) => !policyDesiredSet.has(deviceId));
		activeGeneration = Math.max(activeGeneration, 1);
		if (revokeDeviceIds.length > 0) resetParity(db, projectId, effects.now());
		for (const deviceId of revokeDeviceIds) {
			putRecipientPolicyDenyOverlay(db, {
				canonicalProjectIdentity: projectId,
				scopeId: managedBoundary.scopeId,
				deviceId,
				generation: activeGeneration,
				reasonCode: "pending_revoke",
				now: effects.now(),
			});
		}
		const snapshotStateKey = digest("recipient-policy-snapshot-state-v1", {
			fingerprint: initialSnapshot.fingerprint,
		});
		const policyRevocations = revokeDeviceIds.map((deviceId) => ({
			deviceId,
			stepKey: `revoke:${snapshotStateKey}:${deviceId}`,
		}));
		let replayedRevocationRefresh = false;
		let revocationRefreshError: unknown = null;
		for (const revocation of policyRevocations) {
			const changed = await step(
				db,
				{
					projectId,
					generation: activeGeneration,
					stepKey: revocation.stepKey,
					payload: {
						scopeId: managedBoundary.scopeId,
						deviceId: revocation.deviceId,
						status: "revoked",
					},
					leaseOwner: input.leaseOwner,
					lease,
					now: effects.now,
				},
				async (effectId) => {
					const receipt = await effects.revoke({
						effectId,
						canonicalProjectIdentity: projectId,
						generation: activeGeneration,
						scopeId: managedBoundary.scopeId,
						deviceId: revocation.deviceId,
					});
					validateReceipt(receipt, {
						effectId,
						scopeId: managedBoundary.scopeId,
						deviceId: revocation.deviceId,
						status: "revoked",
					});
				},
			);
			if (changed) revokedDeviceIds.push(revocation.deviceId);
			try {
				await refreshAfterRevocations(db, {
					projectId,
					generation: activeGeneration,
					scopeId: managedBoundary.scopeId,
					snapshotStateKey,
					phase: "steady_state",
					revocations: [revocation],
					leaseOwner: input.leaseOwner,
					lease,
					effects,
				});
				replayedRevocationRefresh = true;
			} catch (error) {
				revocationRefreshError ??= error;
			}
		}
		if (!revocationRefreshError) {
			try {
				replayedRevocationRefresh =
					(await retryPendingRevocationRefreshes(db, {
						projectId,
						scopeId: managedBoundary.scopeId,
						leaseOwner: input.leaseOwner,
						lease,
						effects,
					})) || replayedRevocationRefresh;
			} catch (error) {
				revocationRefreshError = error;
			}
		}
		const rederived = deriveRecipientPolicyEffectiveDevicesFromDatabase(db, projectId);
		if (
			rederived.status !== "eligible" ||
			rederived.desiredDevicesDigest !== desired.desiredDevicesDigest
		) {
			authority(db, {
				projectId,
				safeErrorCode: "recipient_policy_generation_stale",
				now: effects.now(),
			});
			return result(
				projectId,
				"stale",
				activeGeneration,
				"recipient_policy_generation_stale",
				revokedDeviceIds,
			);
		}
		const remainingPolicyCurrentDeviceIds = currentDeviceIds.filter(
			(deviceId) => !revokeDeviceIds.includes(deviceId),
		);
		const enrollmentIdentities = boundaryEnrollmentIdentities(
			await effects.listBoundaryEnrollments({
				canonicalProjectIdentity: projectId,
				scopeId: managedBoundary.scopeId,
			}),
		);
		const desiredIdentityByDeviceId = new Map(
			desired.devices.map((device) => [device.deviceId, device.identityId]),
		);
		const enrollmentRevocations: EnrollmentRevocation[] = remainingPolicyCurrentDeviceIds.flatMap(
			(deviceId) => {
				const reasonCode = enrollmentRevocationReason(
					enrollmentIdentities.get(deviceId),
					desiredIdentityByDeviceId.get(deviceId),
				);
				return reasonCode ? [{ deviceId, reasonCode }] : [];
			},
		);
		if (revocationRefreshError) {
			stageEnrollmentRevocationOverlays(db, {
				projectId,
				generation: activeGeneration,
				scopeId: managedBoundary.scopeId,
				revocations: enrollmentRevocations,
				effects,
			});
			throw revocationRefreshError;
		}
		await applyEnrollmentRevocations(db, {
			projectId,
			generation: activeGeneration,
			scopeId: managedBoundary.scopeId,
			snapshotStateKey,
			phase: "steady_state",
			revocations: enrollmentRevocations,
			changedDeviceIds: revokedDeviceIds,
			leaseOwner: input.leaseOwner,
			lease,
			effects,
		});
		const enrollmentRevokedDeviceIds = new Set(
			enrollmentRevocations.map(({ deviceId }) => deviceId),
		);
		const remainingCurrentDeviceIds = remainingPolicyCurrentDeviceIds.filter(
			(deviceId) => !enrollmentRevokedDeviceIds.has(deviceId),
		);
		const grantEligibleDeviceIds = desired.devices
			.filter((device) =>
				isEnrollmentEnabledForIdentityGrant(
					enrollmentIdentities.get(device.deviceId),
					device.identityId,
				),
			)
			.map((device) => device.deviceId)
			.toSorted();
		const grantEligibleSet = new Set(grantEligibleDeviceIds);
		const expectedDeviceIds = [
			...new Set([
				...remainingCurrentDeviceIds.filter((deviceId) => policyDesiredSet.has(deviceId)),
				...grantEligibleDeviceIds,
			]),
		].toSorted();
		const expectedDigest = deviceDigest(expectedDeviceIds);
		const grantDeviceIds = grantEligibleDeviceIds.filter((deviceId) => !currentSet.has(deviceId));
		const passKey = digest("recipient-policy-pass-v1", {
			fingerprint: initialSnapshot.fingerprint,
			observedAt: initialSnapshot.observedAt,
		});
		// Fence capability-step pruning and generation-verified deny cleanup together;
		// a replacement worker must not lose its steps or race a stale overlay release.
		db.transaction(() => {
			assertLease(db, projectId, input.leaseOwner, effects.now());
			activeGeneration = generation(db, projectId, expectedDigest);
			pruneSupersededRecipientPolicyCapabilitySteps(db, {
				canonicalProjectIdentity: projectId,
				activeGeneration,
				activePassKey: passKey,
			});
			for (const overlay of listRecipientPolicyDenyOverlays(db, projectId)) {
				if (
					overlay.scopeId === managedBoundary.scopeId &&
					grantEligibleSet.has(overlay.deviceId) &&
					currentSet.has(overlay.deviceId)
				) {
					clearRecipientPolicyDenyOverlay(db, {
						canonicalProjectIdentity: projectId,
						scopeId: overlay.scopeId,
						deviceId: overlay.deviceId,
						verifiedGeneration: activeGeneration,
					});
				}
			}
		}).immediate();
		const revocations = [
			...policyRevocations,
			...enrollmentRevocations.map((revocation) =>
				enrollmentRevocationStep(revocation, "steady_state", snapshotStateKey),
			),
		];
		upsertRecipientPolicyAuthorityObservation(db, {
			canonicalProjectIdentity: projectId,
			generation: activeGeneration,
			desiredDevicesDigest: expectedDigest,
			currentDevicesDigest:
				grantDeviceIds.length === 0 ? expectedDigest : deviceDigest(remainingCurrentDeviceIds),
			freshSnapshotFingerprint: initialSnapshot.fingerprint,
			freshSnapshotObservedAt: initialSnapshot.observedAt,
			now: effects.now(),
		});
		if (grantDeviceIds.length > 0) resetParity(db, projectId, effects.now());
		const capability = await preflight(db, {
			projectId,
			generation: activeGeneration,
			scopeId: managedBoundary.scopeId,
			deviceIds: expectedDeviceIds,
			passKey,
			leaseOwner: input.leaseOwner,
			lease,
			effects,
		});
		if (capability !== "supported") {
			const safeErrorCode =
				capability === "unsupported"
					? "recipient_policy_capability_unsupported"
					: "recipient_policy_capability_undetermined";
			authority(db, { projectId, safeErrorCode, now: effects.now() });
			return result(
				projectId,
				capability === "unsupported" ? "needs_attention" : "waiting",
				activeGeneration,
				safeErrorCode,
				revokedDeviceIds,
			);
		}
		if (grantDeviceIds.length > 0) {
			const preGrantEnrollmentIdentities = boundaryEnrollmentIdentities(
				await effects.listBoundaryEnrollments({
					canonicalProjectIdentity: projectId,
					scopeId: managedBoundary.scopeId,
				}),
			);
			const changedBinding = grantDeviceIds.some(
				(deviceId) =>
					!isEnrollmentEnabledForIdentityGrant(
						preGrantEnrollmentIdentities.get(deviceId),
						desiredIdentityByDeviceId.get(deviceId),
					),
			);
			if (changedBinding) {
				resetParity(db, projectId, effects.now());
				authority(db, {
					projectId,
					safeErrorCode: "recipient_policy_generation_stale",
					now: effects.now(),
				});
				return result(
					projectId,
					"stale",
					activeGeneration,
					"recipient_policy_generation_stale",
					revokedDeviceIds,
				);
			}
		}
		for (const deviceId of grantDeviceIds) {
			const changed = await step(
				db,
				{
					projectId,
					generation: activeGeneration,
					stepKey: `grant:${snapshotStateKey}:${deviceId}`,
					payload: { scopeId: managedBoundary.scopeId, deviceId, role: "member" },
					leaseOwner: input.leaseOwner,
					lease,
					now: effects.now,
				},
				async (effectId) => {
					const receipt = await effects.grant({
						effectId,
						canonicalProjectIdentity: projectId,
						generation: activeGeneration,
						scopeId: managedBoundary.scopeId,
						deviceId,
						role: "member",
					});
					validateReceipt(receipt, {
						effectId,
						scopeId: managedBoundary.scopeId,
						deviceId,
						status: "active",
					});
				},
			);
			if (changed) grantedDeviceIds.push(deviceId);
		}
		if (grantDeviceIds.length > 0) {
			const postGrantEnrollmentIdentities = boundaryEnrollmentIdentities(
				await effects.listBoundaryEnrollments({
					canonicalProjectIdentity: projectId,
					scopeId: managedBoundary.scopeId,
				}),
			);
			const changedBindings: EnrollmentRevocation[] = grantDeviceIds.flatMap((deviceId) => {
				const binding = postGrantEnrollmentIdentities.get(deviceId);
				if (isEnrollmentEnabledForIdentityGrant(binding, desiredIdentityByDeviceId.get(deviceId))) {
					return [];
				}
				return [
					{
						deviceId,
						reasonCode:
							enrollmentRevocationReason(binding, desiredIdentityByDeviceId.get(deviceId)) ??
							"enrollment_identity_conflict",
					},
				];
			});
			if (changedBindings.length > 0) {
				await applyEnrollmentRevocations(db, {
					projectId,
					generation: activeGeneration,
					scopeId: managedBoundary.scopeId,
					snapshotStateKey,
					phase: "post_grant",
					revocations: changedBindings,
					changedDeviceIds: revokedDeviceIds,
					leaseOwner: input.leaseOwner,
					lease,
					effects,
				});
				authority(db, {
					projectId,
					safeErrorCode: "recipient_policy_generation_stale",
					now: effects.now(),
				});
				return result(
					projectId,
					"stale",
					activeGeneration,
					"recipient_policy_generation_stale",
					revokedDeviceIds,
					grantedDeviceIds,
				);
			}
		}
		const replayedRefresh = await retryPendingRefreshes(db, {
			projectId,
			scopeId: managedBoundary.scopeId,
			leaseOwner: input.leaseOwner,
			lease,
			effects,
		});
		if (
			!replayedRefresh &&
			(grantDeviceIds.length > 0 || (revocations.length === 0 && !replayedRevocationRefresh))
		) {
			await step(
				db,
				{
					projectId,
					generation: activeGeneration,
					stepKey: `refresh:${passKey}`,
					payload: { canonicalProjectIdentity: projectId },
					leaseOwner: input.leaseOwner,
					lease,
					now: effects.now,
				},
				async () =>
					effects.refresh({
						canonicalProjectIdentity: projectId,
						scopeId: managedBoundary.scopeId,
					}),
			);
		}
		const verificationRequestedAt = effects.now();
		const verifiedSnapshot = await effects.snapshot({
			canonicalProjectIdentity: projectId,
			scopeId: managedBoundary.scopeId,
		});
		const verifiedDeviceIds = activeSnapshotDevices(
			verifiedSnapshot,
			managedBoundary.scopeId,
			verificationRequestedAt,
		);
		const verifiedSet = new Set(verifiedDeviceIds);
		for (const overlay of listRecipientPolicyDenyOverlays(db, projectId)) {
			const revokeVerified = !verifiedSet.has(overlay.deviceId);
			const desiredActiveVerified =
				grantEligibleSet.has(overlay.deviceId) && verifiedSet.has(overlay.deviceId);
			if (
				overlay.scopeId === managedBoundary.scopeId &&
				(revokeVerified || desiredActiveVerified)
			) {
				clearRecipientPolicyDenyOverlay(db, {
					canonicalProjectIdentity: projectId,
					scopeId: overlay.scopeId,
					deviceId: overlay.deviceId,
					verifiedGeneration: activeGeneration,
				});
			}
		}
		const deniedDeviceIds = new Set(
			listRecipientPolicyDenyOverlays(db, projectId)
				.filter((overlay) => overlay.scopeId === managedBoundary.scopeId)
				.map((overlay) => overlay.deviceId),
		);
		const effectiveVerifiedDeviceIds = verifiedDeviceIds.filter(
			(deviceId) => !deniedDeviceIds.has(deviceId),
		);
		const membershipParity =
			verifiedDeviceIds.length === expectedDeviceIds.length &&
			verifiedDeviceIds.every((deviceId, index) => deviceId === expectedDeviceIds[index]);
		const parity =
			membershipParity && !expectedDeviceIds.some((deviceId) => deniedDeviceIds.has(deviceId));
		upsertRecipientPolicyAuthorityObservation(db, {
			canonicalProjectIdentity: projectId,
			generation: activeGeneration,
			desiredDevicesDigest: expectedDigest,
			currentDevicesDigest: parity
				? expectedDigest
				: deviceDigest(membershipParity ? effectiveVerifiedDeviceIds : verifiedDeviceIds),
			freshSnapshotFingerprint: verifiedSnapshot.fingerprint,
			freshSnapshotObservedAt: verifiedSnapshot.observedAt,
			now: effects.now(),
		});
		if (!parity) {
			resetParity(db, projectId, effects.now());
			authority(db, {
				projectId,
				safeErrorCode: "recipient_policy_parity_incomplete",
				now: effects.now(),
			});
			return result(
				projectId,
				"waiting",
				activeGeneration,
				"recipient_policy_parity_incomplete",
				revokedDeviceIds,
				grantedDeviceIds,
			);
		}
		const evidenceDigest = digest("recipient-policy-parity-v1", {
			canonicalProjectIdentity: projectId,
			generation: activeGeneration,
			scopeId: managedBoundary.scopeId,
			desiredDevicesDigest: expectedDigest,
			deviceIds: expectedDeviceIds,
		});
		const state = getRecipientPolicyAuthorityState(db, projectId);
		const laterUnchangedNoOp =
			revokeDeviceIds.length === 0 &&
			grantDeviceIds.length === 0 &&
			state?.stableParityEvidenceDigest === evidenceDigest &&
			state.stableParityPassedAt !== null &&
			timestamp(verifiedSnapshot.observedAt, "recipient_policy_snapshot_invalid") >=
				timestamp(state.stableParityPassedAt, "recipient_policy_parity_evidence_invalid");
		if (laterUnchangedNoOp) {
			authority(db, {
				projectId,
				state: "active",
				safeErrorCode: null,
				now: effects.now(),
				completed: true,
			});
			return result(
				projectId,
				"active",
				activeGeneration,
				null,
				revokedDeviceIds,
				grantedDeviceIds,
			);
		}
		if (state?.stableParityEvidenceDigest !== evidenceDigest) {
			resetParity(db, projectId, effects.now());
			recordRecipientPolicyStableParityPass(db, {
				canonicalProjectIdentity: projectId,
				generation: activeGeneration,
				evidenceDigest,
				snapshotFingerprint: verifiedSnapshot.fingerprint,
				passedAt: verifiedSnapshot.observedAt,
			});
		}
		authority(db, {
			projectId,
			state: "eligible",
			safeErrorCode: null,
			now: effects.now(),
			completed: true,
		});
		return result(
			projectId,
			"parity_pending",
			activeGeneration,
			null,
			revokedDeviceIds,
			grantedDeviceIds,
		);
	} catch (error) {
		const safeErrorCode = safeError(error, "recipient_policy_reconciliation_failed");
		authority(db, { projectId, safeErrorCode, now: effects.now() });
		return result(
			projectId,
			safeErrorCode === "recipient_policy_snapshot_not_fresh" ? "waiting" : "needs_attention",
			activeGeneration,
			safeErrorCode,
			revokedDeviceIds,
			grantedDeviceIds,
		);
	} finally {
		releaseLease(db, projectId, input.leaseOwner, effects.now());
	}
}
