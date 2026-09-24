import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import { isStrictRecipientPolicyId } from "./recipient-policy-identifiers.js";
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
import {
	canonicalRepositoryProjectIdentity,
	repositoryIdentitiesByWorkspace,
} from "./repository-mapping-aliases.js";
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

function scopeMappingsBelongToProject(
	mappings: Array<{ workspace_identity: string | null; project_pattern: string }>,
	repositoryIdentities: ReadonlyMap<string, string>,
	projectId: string,
): boolean {
	return mappings.every((mapping) => {
		if (mapping.workspace_identity == null) return false;
		return (
			canonicalRepositoryProjectIdentity(repositoryIdentities, mapping.workspace_identity) ===
				projectId &&
			canonicalRepositoryProjectIdentity(repositoryIdentities, mapping.project_pattern) ===
				projectId
		);
	});
}

function mappedProjectsForScope(
	mappings: Array<{ workspace_identity: string | null; project_pattern: string }>,
	repositoryIdentities: ReadonlyMap<string, string>,
): Set<string> {
	return new Set(
		mappings.flatMap((mapping) => {
			if (mapping.workspace_identity == null) return [];
			const workspaceProject = canonicalRepositoryProjectIdentity(
				repositoryIdentities,
				mapping.workspace_identity,
			);
			const patternProject = canonicalRepositoryProjectIdentity(
				repositoryIdentities,
				mapping.project_pattern,
			);
			return workspaceProject === patternProject ? [workspaceProject] : [];
		}),
	);
}

function boundary(db: Database, projectId: string): ManagedProjectBoundary {
	const repositoryIdentities = repositoryIdentitiesByWorkspace(db);
	const mappings = db
		.prepare(
			`SELECT workspace_identity, project_pattern, scope_id
			 FROM project_scope_mappings ORDER BY id`,
		)
		.all() as Array<{
		workspace_identity: string | null;
		project_pattern: string;
		scope_id: string;
	}>;
	const matchingMappings = mappings.filter(
		(mapping) =>
			mapping.workspace_identity != null &&
			canonicalRepositoryProjectIdentity(repositoryIdentities, mapping.workspace_identity) ===
				projectId &&
			canonicalRepositoryProjectIdentity(repositoryIdentities, mapping.project_pattern) ===
				projectId,
	);
	const matchingScopeIds = [...new Set(matchingMappings.map((mapping) => mapping.scope_id))];
	const mapping = matchingMappings[0];
	if (!mapping || matchingScopeIds.length !== 1 || !validId(mapping.scope_id)) {
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
	const scopeMappings = mappings.filter((candidate) => candidate.scope_id === mapping.scope_id);
	const mappedProjects = mappedProjectsForScope(scopeMappings, repositoryIdentities);
	if (
		scopes.length !== 1 ||
		mappedProjects.size !== 1 ||
		!mappedProjects.has(projectId) ||
		!scopeMappingsBelongToProject(scopeMappings, repositoryIdentities, projectId) ||
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
			!isStrictRecipientPolicyId(membership.deviceId) ||
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
	const canonicalProjectIdentity = canonicalRepositoryProjectIdentity(
		repositoryIdentitiesByWorkspace(db),
		input.canonicalProjectIdentity,
	);
	const canonicalState = getRecipientPolicyAuthorityState(db, canonicalProjectIdentity);
	const policyIdentity = canonicalState ? canonicalProjectIdentity : input.canonicalProjectIdentity;
	const state = canonicalState ?? getRecipientPolicyAuthorityState(db, policyIdentity);
	if (!state || state.authorityState === "legacy") return;
	const desired = deriveRecipientPolicyEffectiveDevicesFromDatabase(db, policyIdentity);
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

interface RecipientPolicyReconciliationRun {
	db: Database;
	projectId: string;
	leaseOwner: string;
	lease: Lease;
	effects: RecipientPolicyReconcilerEffects;
	activeGeneration: number;
	revokedDeviceIds: string[];
	grantedDeviceIds: string[];
}

interface PolicyRevocationOutcome {
	policyRevocations: RevocationStep[];
	replayedRevocationRefresh: boolean;
	revocationRefreshError: unknown;
}

async function applyPolicyRevocation(
	run: RecipientPolicyReconciliationRun,
	input: { scopeId: string; snapshotStateKey: string; revocation: RevocationStep },
): Promise<unknown | null> {
	const changed = await step(
		run.db,
		{
			projectId: run.projectId,
			generation: run.activeGeneration,
			stepKey: input.revocation.stepKey,
			payload: { scopeId: input.scopeId, deviceId: input.revocation.deviceId, status: "revoked" },
			leaseOwner: run.leaseOwner,
			lease: run.lease,
			now: run.effects.now,
		},
		async (effectId) => {
			const receipt = await run.effects.revoke({
				effectId,
				canonicalProjectIdentity: run.projectId,
				generation: run.activeGeneration,
				scopeId: input.scopeId,
				deviceId: input.revocation.deviceId,
			});
			validateReceipt(receipt, {
				effectId,
				scopeId: input.scopeId,
				deviceId: input.revocation.deviceId,
				status: "revoked",
			});
		},
	);
	if (changed) run.revokedDeviceIds.push(input.revocation.deviceId);
	try {
		await refreshAfterRevocations(run.db, {
			projectId: run.projectId,
			generation: run.activeGeneration,
			scopeId: input.scopeId,
			snapshotStateKey: input.snapshotStateKey,
			phase: "steady_state",
			revocations: [input.revocation],
			leaseOwner: run.leaseOwner,
			lease: run.lease,
			effects: run.effects,
		});
		return null;
	} catch (error) {
		return error;
	}
}

async function applyPolicyRevocations(
	run: RecipientPolicyReconciliationRun,
	input: {
		scopeId: string;
		snapshotStateKey: string;
		revokeDeviceIds: string[];
	},
): Promise<PolicyRevocationOutcome> {
	const policyRevocations = input.revokeDeviceIds.map((deviceId) => ({
		deviceId,
		stepKey: `revoke:${input.snapshotStateKey}:${deviceId}`,
	}));
	let replayedRevocationRefresh = false;
	let revocationRefreshError: unknown = null;
	for (const revocation of policyRevocations) {
		const refreshError = await applyPolicyRevocation(run, { ...input, revocation });
		replayedRevocationRefresh ||= refreshError === null;
		revocationRefreshError ??= refreshError;
	}
	if (!revocationRefreshError) {
		try {
			replayedRevocationRefresh =
				(await retryPendingRevocationRefreshes(run.db, {
					projectId: run.projectId,
					scopeId: input.scopeId,
					leaseOwner: run.leaseOwner,
					lease: run.lease,
					effects: run.effects,
				})) || replayedRevocationRefresh;
		} catch (error) {
			revocationRefreshError = error;
		}
	}
	return { policyRevocations, replayedRevocationRefresh, revocationRefreshError };
}

interface GrantEffectInput {
	scopeId: string;
	snapshotStateKey: string;
	expectedDeviceIds: string[];
	grantDeviceIds: string[];
	passKey: string;
	desiredIdentityByDeviceId: Map<string, string>;
}

async function capabilityFailure(
	run: RecipientPolicyReconciliationRun,
	input: GrantEffectInput,
): Promise<RecipientPolicyReconcileResult | null> {
	const capability = await preflight(run.db, {
		projectId: run.projectId,
		generation: run.activeGeneration,
		scopeId: input.scopeId,
		deviceIds: input.expectedDeviceIds,
		passKey: input.passKey,
		leaseOwner: run.leaseOwner,
		lease: run.lease,
		effects: run.effects,
	});
	if (capability === "supported") return null;
	const safeErrorCode =
		capability === "unsupported"
			? "recipient_policy_capability_unsupported"
			: "recipient_policy_capability_undetermined";
	authority(run.db, { projectId: run.projectId, safeErrorCode, now: run.effects.now() });
	return result(
		run.projectId,
		capability === "unsupported" ? "needs_attention" : "waiting",
		run.activeGeneration,
		safeErrorCode,
		run.revokedDeviceIds,
	);
}

async function staleGrantEnrollment(
	run: RecipientPolicyReconciliationRun,
	input: GrantEffectInput,
): Promise<RecipientPolicyReconcileResult | null> {
	if (input.grantDeviceIds.length === 0) return null;
	const enrollments = boundaryEnrollmentIdentities(
		await run.effects.listBoundaryEnrollments({
			canonicalProjectIdentity: run.projectId,
			scopeId: input.scopeId,
		}),
	);
	const changed = input.grantDeviceIds.some(
		(deviceId) =>
			!isEnrollmentEnabledForIdentityGrant(
				enrollments.get(deviceId),
				input.desiredIdentityByDeviceId.get(deviceId),
			),
	);
	if (!changed) return null;
	resetParity(run.db, run.projectId, run.effects.now());
	authority(run.db, {
		projectId: run.projectId,
		safeErrorCode: "recipient_policy_generation_stale",
		now: run.effects.now(),
	});
	return result(
		run.projectId,
		"stale",
		run.activeGeneration,
		"recipient_policy_generation_stale",
		run.revokedDeviceIds,
	);
}

async function applyGrantSteps(
	run: RecipientPolicyReconciliationRun,
	input: GrantEffectInput,
): Promise<void> {
	for (const deviceId of input.grantDeviceIds) {
		const changed = await step(
			run.db,
			{
				projectId: run.projectId,
				generation: run.activeGeneration,
				stepKey: `grant:${input.snapshotStateKey}:${deviceId}`,
				payload: { scopeId: input.scopeId, deviceId, role: "member" },
				leaseOwner: run.leaseOwner,
				lease: run.lease,
				now: run.effects.now,
			},
			async (effectId) => {
				const receipt = await run.effects.grant({
					effectId,
					canonicalProjectIdentity: run.projectId,
					generation: run.activeGeneration,
					scopeId: input.scopeId,
					deviceId,
					role: "member",
				});
				validateReceipt(receipt, {
					effectId,
					scopeId: input.scopeId,
					deviceId,
					status: "active",
				});
			},
		);
		if (changed) run.grantedDeviceIds.push(deviceId);
	}
}

async function checkCapabilitiesAndApplyGrants(
	run: RecipientPolicyReconciliationRun,
	input: GrantEffectInput,
): Promise<RecipientPolicyReconcileResult | null> {
	const capabilityOutcome = await capabilityFailure(run, input);
	if (capabilityOutcome) return capabilityOutcome;
	const staleOutcome = await staleGrantEnrollment(run, input);
	if (staleOutcome) return staleOutcome;
	await applyGrantSteps(run, input);
	return null;
}

async function revokeChangedGrantBindings(
	run: RecipientPolicyReconciliationRun,
	input: GrantEffectInput,
): Promise<RecipientPolicyReconcileResult | null> {
	if (input.grantDeviceIds.length === 0) return null;
	const enrollments = boundaryEnrollmentIdentities(
		await run.effects.listBoundaryEnrollments({
			canonicalProjectIdentity: run.projectId,
			scopeId: input.scopeId,
		}),
	);
	const changedBindings: EnrollmentRevocation[] = input.grantDeviceIds.flatMap((deviceId) => {
		const binding = enrollments.get(deviceId);
		if (
			isEnrollmentEnabledForIdentityGrant(binding, input.desiredIdentityByDeviceId.get(deviceId))
		) {
			return [];
		}
		return [
			{
				deviceId,
				reasonCode:
					enrollmentRevocationReason(binding, input.desiredIdentityByDeviceId.get(deviceId)) ??
					"enrollment_identity_conflict",
			},
		];
	});
	if (changedBindings.length === 0) return null;
	await applyEnrollmentRevocations(run.db, {
		projectId: run.projectId,
		generation: run.activeGeneration,
		scopeId: input.scopeId,
		snapshotStateKey: input.snapshotStateKey,
		phase: "post_grant",
		revocations: changedBindings,
		changedDeviceIds: run.revokedDeviceIds,
		leaseOwner: run.leaseOwner,
		lease: run.lease,
		effects: run.effects,
	});
	authority(run.db, {
		projectId: run.projectId,
		safeErrorCode: "recipient_policy_generation_stale",
		now: run.effects.now(),
	});
	return result(
		run.projectId,
		"stale",
		run.activeGeneration,
		"recipient_policy_generation_stale",
		run.revokedDeviceIds,
		run.grantedDeviceIds,
	);
}

async function refreshAfterGrantEffects(
	run: RecipientPolicyReconciliationRun,
	input: GrantEffectInput & {
		revocations: RevocationStep[];
		replayedRevocationRefresh: boolean;
	},
): Promise<void> {
	const replayedRefresh = await retryPendingRefreshes(run.db, {
		projectId: run.projectId,
		scopeId: input.scopeId,
		leaseOwner: run.leaseOwner,
		lease: run.lease,
		effects: run.effects,
	});
	if (
		replayedRefresh ||
		(input.grantDeviceIds.length === 0 &&
			(input.revocations.length > 0 || input.replayedRevocationRefresh))
	) {
		return;
	}
	await step(
		run.db,
		{
			projectId: run.projectId,
			generation: run.activeGeneration,
			stepKey: `refresh:${input.passKey}`,
			payload: { canonicalProjectIdentity: run.projectId },
			leaseOwner: run.leaseOwner,
			lease: run.lease,
			now: run.effects.now,
		},
		async () =>
			run.effects.refresh({
				canonicalProjectIdentity: run.projectId,
				scopeId: input.scopeId,
			}),
	);
}

async function revalidateGrantsAndRefresh(
	run: RecipientPolicyReconciliationRun,
	input: GrantEffectInput & {
		revocations: RevocationStep[];
		replayedRevocationRefresh: boolean;
	},
): Promise<RecipientPolicyReconcileResult | null> {
	const staleOutcome = await revokeChangedGrantBindings(run, input);
	if (staleOutcome) return staleOutcome;
	await refreshAfterGrantEffects(run, input);
	return null;
}

interface VerifiedParity {
	snapshot: RecipientPolicyCoordinatorSnapshot;
	parity: boolean;
}

function incompleteParityResult(
	run: RecipientPolicyReconciliationRun,
): RecipientPolicyReconcileResult {
	resetParity(run.db, run.projectId, run.effects.now());
	authority(run.db, {
		projectId: run.projectId,
		safeErrorCode: "recipient_policy_parity_incomplete",
		now: run.effects.now(),
	});
	return result(
		run.projectId,
		"waiting",
		run.activeGeneration,
		"recipient_policy_parity_incomplete",
		run.revokedDeviceIds,
		run.grantedDeviceIds,
	);
}

function activeParityResult(run: RecipientPolicyReconciliationRun): RecipientPolicyReconcileResult {
	authority(run.db, {
		projectId: run.projectId,
		state: "active",
		safeErrorCode: null,
		now: run.effects.now(),
		completed: true,
	});
	return result(
		run.projectId,
		"active",
		run.activeGeneration,
		null,
		run.revokedDeviceIds,
		run.grantedDeviceIds,
	);
}

async function verifyMembershipParity(
	run: RecipientPolicyReconciliationRun,
	input: {
		scopeId: string;
		expectedDeviceIds: string[];
		expectedDigest: string;
		grantEligibleSet: Set<string>;
	},
): Promise<VerifiedParity> {
	const verificationRequestedAt = run.effects.now();
	const snapshot = await run.effects.snapshot({
		canonicalProjectIdentity: run.projectId,
		scopeId: input.scopeId,
	});
	const verifiedDeviceIds = activeSnapshotDevices(snapshot, input.scopeId, verificationRequestedAt);
	const verifiedSet = new Set(verifiedDeviceIds);
	for (const overlay of listRecipientPolicyDenyOverlays(run.db, run.projectId)) {
		const revokeVerified = !verifiedSet.has(overlay.deviceId);
		const desiredActiveVerified =
			input.grantEligibleSet.has(overlay.deviceId) && verifiedSet.has(overlay.deviceId);
		if (overlay.scopeId === input.scopeId && (revokeVerified || desiredActiveVerified)) {
			clearRecipientPolicyDenyOverlay(run.db, {
				canonicalProjectIdentity: run.projectId,
				scopeId: overlay.scopeId,
				deviceId: overlay.deviceId,
				verifiedGeneration: run.activeGeneration,
			});
		}
	}
	const deniedDeviceIds = new Set(
		listRecipientPolicyDenyOverlays(run.db, run.projectId)
			.filter((overlay) => overlay.scopeId === input.scopeId)
			.map((overlay) => overlay.deviceId),
	);
	const effectiveVerifiedDeviceIds = verifiedDeviceIds.filter(
		(deviceId) => !deniedDeviceIds.has(deviceId),
	);
	const membershipParity =
		verifiedDeviceIds.length === input.expectedDeviceIds.length &&
		verifiedDeviceIds.every((deviceId, index) => deviceId === input.expectedDeviceIds[index]);
	const parity =
		membershipParity && !input.expectedDeviceIds.some((deviceId) => deniedDeviceIds.has(deviceId));
	upsertRecipientPolicyAuthorityObservation(run.db, {
		canonicalProjectIdentity: run.projectId,
		generation: run.activeGeneration,
		desiredDevicesDigest: input.expectedDigest,
		currentDevicesDigest: parity
			? input.expectedDigest
			: deviceDigest(membershipParity ? effectiveVerifiedDeviceIds : verifiedDeviceIds),
		freshSnapshotFingerprint: snapshot.fingerprint,
		freshSnapshotObservedAt: snapshot.observedAt,
		now: run.effects.now(),
	});
	return { snapshot, parity };
}

function finishParityPass(
	run: RecipientPolicyReconciliationRun,
	input: {
		scopeId: string;
		expectedDeviceIds: string[];
		expectedDigest: string;
		revokeDeviceIds: string[];
		grantDeviceIds: string[];
		verified: VerifiedParity;
	},
): RecipientPolicyReconcileResult {
	if (!input.verified.parity) return incompleteParityResult(run);
	const evidenceDigest = digest("recipient-policy-parity-v1", {
		canonicalProjectIdentity: run.projectId,
		generation: run.activeGeneration,
		scopeId: input.scopeId,
		desiredDevicesDigest: input.expectedDigest,
		deviceIds: input.expectedDeviceIds,
	});
	const state = getRecipientPolicyAuthorityState(run.db, run.projectId);
	const laterUnchangedNoOp =
		input.revokeDeviceIds.length === 0 &&
		input.grantDeviceIds.length === 0 &&
		state?.stableParityEvidenceDigest === evidenceDigest &&
		state.stableParityPassedAt !== null &&
		timestamp(input.verified.snapshot.observedAt, "recipient_policy_snapshot_invalid") >=
			timestamp(state.stableParityPassedAt, "recipient_policy_parity_evidence_invalid");
	if (laterUnchangedNoOp) return activeParityResult(run);
	if (state?.stableParityEvidenceDigest !== evidenceDigest) {
		resetParity(run.db, run.projectId, run.effects.now());
		recordRecipientPolicyStableParityPass(run.db, {
			canonicalProjectIdentity: run.projectId,
			generation: run.activeGeneration,
			evidenceDigest,
			snapshotFingerprint: input.verified.snapshot.fingerprint,
			passedAt: input.verified.snapshot.observedAt,
		});
	}
	authority(run.db, {
		projectId: run.projectId,
		state: "eligible",
		safeErrorCode: null,
		now: run.effects.now(),
		completed: true,
	});
	return result(
		run.projectId,
		"parity_pending",
		run.activeGeneration,
		null,
		run.revokedDeviceIds,
		run.grantedDeviceIds,
	);
}

type ReconciliationStage<T> =
	| { kind: "continue"; value: T }
	| { kind: "complete"; result: RecipientPolicyReconcileResult };

interface InitialReconciliationState {
	managedBoundary: ManagedProjectBoundary;
	desired: ReturnType<typeof deriveRecipientPolicyEffectiveDevicesFromDatabase>;
	initialSnapshot: RecipientPolicyCoordinatorSnapshot;
	currentDeviceIds: string[];
	policyDesiredSet: Set<string>;
	currentSet: Set<string>;
	revokeDeviceIds: string[];
	snapshotStateKey: string;
	policyRevocations: RevocationStep[];
	replayedRevocationRefresh: boolean;
	revocationRefreshError: unknown;
}

function stagePolicyRevocations(
	run: RecipientPolicyReconciliationRun,
	scopeId: string,
	revokeDeviceIds: string[],
): void {
	run.activeGeneration = Math.max(run.activeGeneration, 1);
	if (revokeDeviceIds.length > 0) resetParity(run.db, run.projectId, run.effects.now());
	for (const deviceId of revokeDeviceIds) {
		putRecipientPolicyDenyOverlay(run.db, {
			canonicalProjectIdentity: run.projectId,
			scopeId,
			deviceId,
			generation: run.activeGeneration,
			reasonCode: "pending_revoke",
			now: run.effects.now(),
		});
	}
}

async function prepareInitialReconciliation(
	run: RecipientPolicyReconciliationRun,
	startedAt: string,
): Promise<ReconciliationStage<InitialReconciliationState>> {
	pruneRecipientPolicyReconciliationSteps(run.db, {
		canonicalProjectIdentity: run.projectId,
	});
	const managedBoundary = boundary(run.db, run.projectId);
	const desired = deriveRecipientPolicyEffectiveDevicesFromDatabase(run.db, run.projectId);
	if (desired.status !== "eligible") {
		authority(run.db, {
			projectId: run.projectId,
			safeErrorCode: "recipient_policy_desired_state_invalid",
			now: run.effects.now(),
		});
		return {
			kind: "complete",
			result: result(
				run.projectId,
				"needs_attention",
				run.activeGeneration,
				"recipient_policy_desired_state_invalid",
			),
		};
	}
	const initialSnapshot = await run.effects.snapshot({
		canonicalProjectIdentity: run.projectId,
		scopeId: managedBoundary.scopeId,
	});
	const currentDeviceIds = activeSnapshotDevices(
		initialSnapshot,
		managedBoundary.scopeId,
		startedAt,
	);
	const policyDesiredSet = new Set(desired.devices.map((device) => device.deviceId).toSorted());
	const currentSet = new Set(currentDeviceIds);
	const revokeDeviceIds = currentDeviceIds.filter((deviceId) => !policyDesiredSet.has(deviceId));
	stagePolicyRevocations(run, managedBoundary.scopeId, revokeDeviceIds);
	const snapshotStateKey = digest("recipient-policy-snapshot-state-v1", {
		fingerprint: initialSnapshot.fingerprint,
	});
	const revocationOutcome = await applyPolicyRevocations(run, {
		scopeId: managedBoundary.scopeId,
		snapshotStateKey,
		revokeDeviceIds,
	});
	return {
		kind: "continue",
		value: {
			managedBoundary,
			desired,
			initialSnapshot,
			currentDeviceIds,
			policyDesiredSet,
			currentSet,
			revokeDeviceIds,
			snapshotStateKey,
			...revocationOutcome,
		},
	};
}

interface PreparedGrantEffects {
	grantEffectInput: GrantEffectInput;
	expectedDigest: string;
	grantEligibleSet: Set<string>;
	revocations: RevocationStep[];
}

interface EnrollmentReconciliationState {
	enrollmentIdentities: Map<string, RecipientPolicyBoundaryEnrollment>;
	desiredIdentityByDeviceId: Map<string, string>;
	enrollmentRevocations: EnrollmentRevocation[];
	remainingCurrentDeviceIds: string[];
}

function staleDesiredResult(
	run: RecipientPolicyReconciliationRun,
	initial: InitialReconciliationState,
): RecipientPolicyReconcileResult | null {
	const rederived = deriveRecipientPolicyEffectiveDevicesFromDatabase(run.db, run.projectId);
	if (
		rederived.status === "eligible" &&
		rederived.desiredDevicesDigest === initial.desired.desiredDevicesDigest
	) {
		return null;
	}
	authority(run.db, {
		projectId: run.projectId,
		safeErrorCode: "recipient_policy_generation_stale",
		now: run.effects.now(),
	});
	return result(
		run.projectId,
		"stale",
		run.activeGeneration,
		"recipient_policy_generation_stale",
		run.revokedDeviceIds,
	);
}

async function reconcileEnrollmentState(
	run: RecipientPolicyReconciliationRun,
	initial: InitialReconciliationState,
): Promise<ReconciliationStage<EnrollmentReconciliationState>> {
	const staleResult = staleDesiredResult(run, initial);
	if (staleResult) return { kind: "complete", result: staleResult };
	const remainingPolicyCurrentDeviceIds = initial.currentDeviceIds.filter(
		(deviceId) => !initial.revokeDeviceIds.includes(deviceId),
	);
	const enrollmentIdentities = boundaryEnrollmentIdentities(
		await run.effects.listBoundaryEnrollments({
			canonicalProjectIdentity: run.projectId,
			scopeId: initial.managedBoundary.scopeId,
		}),
	);
	const desiredIdentityByDeviceId = new Map(
		initial.desired.devices.map((device) => [device.deviceId, device.identityId]),
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
	if (initial.revocationRefreshError) {
		stageEnrollmentRevocationOverlays(run.db, {
			projectId: run.projectId,
			generation: run.activeGeneration,
			scopeId: initial.managedBoundary.scopeId,
			revocations: enrollmentRevocations,
			effects: run.effects,
		});
		throw initial.revocationRefreshError;
	}
	await applyEnrollmentRevocations(run.db, {
		projectId: run.projectId,
		generation: run.activeGeneration,
		scopeId: initial.managedBoundary.scopeId,
		snapshotStateKey: initial.snapshotStateKey,
		phase: "steady_state",
		revocations: enrollmentRevocations,
		changedDeviceIds: run.revokedDeviceIds,
		leaseOwner: run.leaseOwner,
		lease: run.lease,
		effects: run.effects,
	});
	const enrollmentRevokedDeviceIds = new Set(enrollmentRevocations.map(({ deviceId }) => deviceId));
	return {
		kind: "continue",
		value: {
			enrollmentIdentities,
			desiredIdentityByDeviceId,
			enrollmentRevocations,
			remainingCurrentDeviceIds: remainingPolicyCurrentDeviceIds.filter(
				(deviceId) => !enrollmentRevokedDeviceIds.has(deviceId),
			),
		},
	};
}

interface GrantDecision {
	grantEligibleSet: Set<string>;
	expectedDeviceIds: string[];
	expectedDigest: string;
	grantDeviceIds: string[];
	passKey: string;
}

function decideGrantEffects(
	initial: InitialReconciliationState,
	enrollment: EnrollmentReconciliationState,
): GrantDecision {
	const grantEligibleDeviceIds = initial.desired.devices
		.filter((device) =>
			isEnrollmentEnabledForIdentityGrant(
				enrollment.enrollmentIdentities.get(device.deviceId),
				device.identityId,
			),
		)
		.map((device) => device.deviceId)
		.toSorted();
	const grantEligibleSet = new Set(grantEligibleDeviceIds);
	const expectedDeviceIds = [
		...new Set([
			...enrollment.remainingCurrentDeviceIds.filter((deviceId) =>
				initial.policyDesiredSet.has(deviceId),
			),
			...grantEligibleDeviceIds,
		]),
	].toSorted();
	return {
		grantEligibleSet,
		expectedDeviceIds,
		expectedDigest: deviceDigest(expectedDeviceIds),
		grantDeviceIds: grantEligibleDeviceIds.filter((deviceId) => !initial.currentSet.has(deviceId)),
		passKey: digest("recipient-policy-pass-v1", {
			fingerprint: initial.initialSnapshot.fingerprint,
			observedAt: initial.initialSnapshot.observedAt,
		}),
	};
}

async function prepareGrantEffects(
	run: RecipientPolicyReconciliationRun,
	initial: InitialReconciliationState,
): Promise<ReconciliationStage<PreparedGrantEffects>> {
	const enrollmentStage = await reconcileEnrollmentState(run, initial);
	if (enrollmentStage.kind === "complete") return enrollmentStage;
	const enrollment = enrollmentStage.value;
	const decision = decideGrantEffects(initial, enrollment);
	fenceGrantPreparation(run, {
		scopeId: initial.managedBoundary.scopeId,
		expectedDigest: decision.expectedDigest,
		passKey: decision.passKey,
		grantEligibleSet: decision.grantEligibleSet,
		currentSet: initial.currentSet,
	});
	const revocations = [
		...initial.policyRevocations,
		...enrollment.enrollmentRevocations.map((revocation) =>
			enrollmentRevocationStep(revocation, "steady_state", initial.snapshotStateKey),
		),
	];
	upsertRecipientPolicyAuthorityObservation(run.db, {
		canonicalProjectIdentity: run.projectId,
		generation: run.activeGeneration,
		desiredDevicesDigest: decision.expectedDigest,
		currentDevicesDigest:
			decision.grantDeviceIds.length === 0
				? decision.expectedDigest
				: deviceDigest(enrollment.remainingCurrentDeviceIds),
		freshSnapshotFingerprint: initial.initialSnapshot.fingerprint,
		freshSnapshotObservedAt: initial.initialSnapshot.observedAt,
		now: run.effects.now(),
	});
	if (decision.grantDeviceIds.length > 0) resetParity(run.db, run.projectId, run.effects.now());
	return {
		kind: "continue",
		value: {
			grantEffectInput: {
				scopeId: initial.managedBoundary.scopeId,
				snapshotStateKey: initial.snapshotStateKey,
				expectedDeviceIds: decision.expectedDeviceIds,
				grantDeviceIds: decision.grantDeviceIds,
				passKey: decision.passKey,
				desiredIdentityByDeviceId: enrollment.desiredIdentityByDeviceId,
			},
			expectedDigest: decision.expectedDigest,
			grantEligibleSet: decision.grantEligibleSet,
			revocations,
		},
	};
}

function fenceGrantPreparation(
	run: RecipientPolicyReconciliationRun,
	input: {
		scopeId: string;
		expectedDigest: string;
		passKey: string;
		grantEligibleSet: Set<string>;
		currentSet: Set<string>;
	},
): void {
	// Fence capability-step pruning and generation-verified deny cleanup together;
	// a replacement worker must not lose its steps or race a stale overlay release.
	run.db
		.transaction(() => {
			assertLease(run.db, run.projectId, run.leaseOwner, run.effects.now());
			run.activeGeneration = generation(run.db, run.projectId, input.expectedDigest);
			pruneSupersededRecipientPolicyCapabilitySteps(run.db, {
				canonicalProjectIdentity: run.projectId,
				activeGeneration: run.activeGeneration,
				activePassKey: input.passKey,
			});
			for (const overlay of listRecipientPolicyDenyOverlays(run.db, run.projectId)) {
				if (
					overlay.scopeId === input.scopeId &&
					input.grantEligibleSet.has(overlay.deviceId) &&
					input.currentSet.has(overlay.deviceId)
				) {
					clearRecipientPolicyDenyOverlay(run.db, {
						canonicalProjectIdentity: run.projectId,
						scopeId: overlay.scopeId,
						deviceId: overlay.deviceId,
						verifiedGeneration: run.activeGeneration,
					});
				}
			}
		})
		.immediate();
}

async function executeRecipientPolicyReconciliation(
	run: RecipientPolicyReconciliationRun,
	startedAt: string,
): Promise<RecipientPolicyReconcileResult> {
	try {
		const initialStage = await prepareInitialReconciliation(run, startedAt);
		if (initialStage.kind === "complete") return initialStage.result;
		const initial = initialStage.value;
		const grantStage = await prepareGrantEffects(run, initial);
		if (grantStage.kind === "complete") return grantStage.result;
		const prepared = grantStage.value;
		const grantOutcome = await checkCapabilitiesAndApplyGrants(run, prepared.grantEffectInput);
		if (grantOutcome) return grantOutcome;
		const refreshOutcome = await revalidateGrantsAndRefresh(run, {
			...prepared.grantEffectInput,
			revocations: prepared.revocations,
			replayedRevocationRefresh: initial.replayedRevocationRefresh,
		});
		if (refreshOutcome) return refreshOutcome;
		const verified = await verifyMembershipParity(run, {
			scopeId: initial.managedBoundary.scopeId,
			expectedDeviceIds: prepared.grantEffectInput.expectedDeviceIds,
			expectedDigest: prepared.expectedDigest,
			grantEligibleSet: prepared.grantEligibleSet,
		});
		return finishParityPass(run, {
			scopeId: initial.managedBoundary.scopeId,
			expectedDeviceIds: prepared.grantEffectInput.expectedDeviceIds,
			expectedDigest: prepared.expectedDigest,
			revokeDeviceIds: initial.revokeDeviceIds,
			grantDeviceIds: prepared.grantEffectInput.grantDeviceIds,
			verified,
		});
	} catch (error) {
		const safeErrorCode = safeError(error, "recipient_policy_reconciliation_failed");
		authority(run.db, { projectId: run.projectId, safeErrorCode, now: run.effects.now() });
		return result(
			run.projectId,
			safeErrorCode === "recipient_policy_snapshot_not_fresh" ? "waiting" : "needs_attention",
			run.activeGeneration,
			safeErrorCode,
			run.revokedDeviceIds,
			run.grantedDeviceIds,
		);
	}
}

function migrateRecipientPolicyAliasAuthority(
	db: Database,
	canonicalProjectIdentity: string,
	aliases: string[],
): void {
	const authorityIdentities = [canonicalProjectIdentity, ...aliases];
	const placeholders = authorityIdentities.map(() => "?").join(", ");
	const authoritySource = db
		.prepare(
			`SELECT canonical_project_identity FROM recipient_policy_authority_states
			 WHERE canonical_project_identity IN (${placeholders})
			 ORDER BY generation DESC, updated_at DESC, canonical_project_identity ASC LIMIT 1`,
		)
		.pluck()
		.get(...authorityIdentities) as string | undefined;
	if (!authoritySource || authoritySource === canonicalProjectIdentity) return;
	db.prepare(
		"DELETE FROM recipient_policy_authority_states WHERE canonical_project_identity = ?",
	).run(canonicalProjectIdentity);
	db.prepare(
		`UPDATE recipient_policy_authority_states SET canonical_project_identity = ?
		 WHERE canonical_project_identity = ?`,
	).run(canonicalProjectIdentity, authoritySource);
}

interface AliasStepRow {
	canonical_project_identity: string;
	generation: number;
	step_key: string;
	effect_id: string;
	payload_digest: string;
	status: string;
	attempt_count: number;
	started_at: string | null;
	completed_at: string | null;
	last_attempt_at: string | null;
	safe_error_code: string | null;
	error_at: string | null;
	lease_owner: string | null;
	lease_acquired_at: string | null;
	lease_expires_at: string | null;
	created_at: string;
	updated_at: string;
}

function canonicalAliasStepPayloadDigest(
	step: AliasStepRow,
	canonicalProjectIdentity: string,
): string {
	if (
		!step.step_key.startsWith("refresh:") &&
		!step.step_key.startsWith("refresh-after-revocations-v2:")
	) {
		return step.payload_digest;
	}
	return digest("recipient-policy-step-payload-v1", { canonicalProjectIdentity });
}

function aliasStepEffectId(
	step: AliasStepRow,
	canonicalProjectIdentity: string,
	payloadDigest: string,
): string {
	if (["running", "failed"].includes(step.status)) return step.effect_id;
	return deterministicRecipientPolicyReconciliationEffectId({
		canonicalProjectIdentity,
		generation: step.generation,
		stepKey: step.step_key,
		payloadDigest,
	});
}

function shouldPromoteAliasStep(aliasStep: AliasStepRow, canonicalStep: AliasStepRow): boolean {
	if (aliasStep.status === "completed") return canonicalStep.status !== "completed";
	return ["running", "failed"].includes(aliasStep.status) && canonicalStep.status === "pending";
}

function rekeyRecipientPolicyAliasStep(
	db: Database,
	input: {
		alias: string;
		canonicalProjectIdentity: string;
		effectId: string;
		payloadDigest: string;
		step: AliasStepRow;
	},
): void {
	db.prepare(
		`UPDATE recipient_policy_reconciliation_steps
		 SET canonical_project_identity = ?, effect_id = ?, payload_digest = ?
		 WHERE canonical_project_identity = ? AND generation = ? AND step_key = ?`,
	).run(
		input.canonicalProjectIdentity,
		input.effectId,
		input.payloadDigest,
		input.alias,
		input.step.generation,
		input.step.step_key,
	);
}

function promoteCompletedRecipientPolicyAliasStep(
	db: Database,
	canonicalProjectIdentity: string,
	step: AliasStepRow,
	effectId: string,
	payloadDigest: string,
): void {
	db.prepare(
		`UPDATE recipient_policy_reconciliation_steps SET effect_id = ?, payload_digest = ?,
		 status = ?, attempt_count = ?, started_at = ?, completed_at = ?, last_attempt_at = ?,
		 safe_error_code = ?, error_at = ?, lease_owner = ?, lease_acquired_at = ?,
		 lease_expires_at = ?, created_at = MIN(created_at, ?), updated_at = MAX(updated_at, ?)
		 WHERE canonical_project_identity = ? AND generation = ? AND step_key = ?`,
	).run(
		effectId,
		payloadDigest,
		step.status,
		step.attempt_count,
		step.started_at,
		step.completed_at,
		step.last_attempt_at,
		step.safe_error_code,
		step.error_at,
		step.lease_owner,
		step.lease_acquired_at,
		step.lease_expires_at,
		step.created_at,
		step.updated_at,
		canonicalProjectIdentity,
		step.generation,
		step.step_key,
	);
}

function migrateRecipientPolicyAliasSteps(
	db: Database,
	canonicalProjectIdentity: string,
	alias: string,
): void {
	const aliasSteps = db
		.prepare(
			"SELECT * FROM recipient_policy_reconciliation_steps WHERE canonical_project_identity = ?",
		)
		.all(alias) as AliasStepRow[];
	for (const aliasStep of aliasSteps) {
		const payloadDigest = canonicalAliasStepPayloadDigest(aliasStep, canonicalProjectIdentity);
		const canonicalStep = db
			.prepare(
				`SELECT * FROM recipient_policy_reconciliation_steps
				 WHERE canonical_project_identity = ? AND generation = ? AND step_key = ?`,
			)
			.get(canonicalProjectIdentity, aliasStep.generation, aliasStep.step_key) as
			| AliasStepRow
			| undefined;
		if (canonicalStep && canonicalStep.payload_digest !== payloadDigest) {
			throw new Error("recipient_policy_reconciliation_step_conflict");
		}
		const effectId = aliasStepEffectId(aliasStep, canonicalProjectIdentity, payloadDigest);
		if (!canonicalStep) {
			rekeyRecipientPolicyAliasStep(db, {
				alias,
				canonicalProjectIdentity,
				effectId,
				payloadDigest,
				step: aliasStep,
			});
			continue;
		}
		if (shouldPromoteAliasStep(aliasStep, canonicalStep)) {
			promoteCompletedRecipientPolicyAliasStep(
				db,
				canonicalProjectIdentity,
				aliasStep,
				effectId,
				payloadDigest,
			);
		}
		db.prepare(
			`DELETE FROM recipient_policy_reconciliation_steps
			 WHERE canonical_project_identity = ? AND generation = ? AND step_key = ?`,
		).run(alias, aliasStep.generation, aliasStep.step_key);
	}
}

function hasLiveAuthorityLease(db: Database, projectIdentities: string[], now: string): boolean {
	if (projectIdentities.length === 0) return false;
	const placeholders = projectIdentities.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT lease_expires_at FROM recipient_policy_authority_states
			 WHERE canonical_project_identity IN (${placeholders})
			 AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL`,
		)
		.all(...projectIdentities) as Array<{ lease_expires_at: string }>;
	const nowTimestamp = timestamp(now, "recipient_policy_reconciliation_time_invalid");
	return rows.some(
		(row) =>
			timestamp(row.lease_expires_at, "recipient_policy_reconciliation_lease_invalid") >
			nowTimestamp,
	);
}

function migrateRecipientPolicyAliasState(
	db: Database,
	canonicalProjectIdentity: string,
	aliases: Iterable<string>,
	now: string,
): boolean {
	const aliasList = [...new Set(aliases)].filter((alias) => alias !== canonicalProjectIdentity);
	if (aliasList.length === 0) return true;
	const migrate = db.transaction(() => {
		if (hasLiveAuthorityLease(db, [canonicalProjectIdentity, ...aliasList], now)) return false;
		migrateRecipientPolicyAliasAuthority(db, canonicalProjectIdentity, aliasList);
		for (const alias of aliasList) {
			db.prepare(
				"DELETE FROM recipient_policy_authority_states WHERE canonical_project_identity = ?",
			).run(alias);
			migrateRecipientPolicyAliasSteps(db, canonicalProjectIdentity, alias);
			db.prepare(
				`INSERT INTO recipient_policy_deny_overlays(
					canonical_project_identity, scope_id, device_id, generation, reason_code,
					created_at, updated_at
				 ) SELECT ?, scope_id, device_id, generation, reason_code, created_at, updated_at
				 FROM recipient_policy_deny_overlays WHERE canonical_project_identity = ?
				 ON CONFLICT(canonical_project_identity, scope_id, device_id) DO UPDATE SET
					generation = MAX(recipient_policy_deny_overlays.generation, excluded.generation),
					reason_code = CASE
						WHEN excluded.generation >= recipient_policy_deny_overlays.generation
						THEN excluded.reason_code ELSE recipient_policy_deny_overlays.reason_code END,
					updated_at = MAX(recipient_policy_deny_overlays.updated_at, excluded.updated_at)`,
			).run(canonicalProjectIdentity, alias);
			db.prepare(
				"DELETE FROM recipient_policy_deny_overlays WHERE canonical_project_identity = ?",
			).run(alias);
		}
		return true;
	});
	return migrate.immediate();
}

export async function reconcileRecipientPolicyProject(
	db: Database,
	input: ReconcileRecipientPolicyProjectInput,
	effects: RecipientPolicyReconcilerEffects,
): Promise<RecipientPolicyReconcileResult> {
	const repositoryIdentities = repositoryIdentitiesByWorkspace(db);
	const projectId = canonicalRepositoryProjectIdentity(
		repositoryIdentities,
		input.canonicalProjectIdentity,
	);
	const aliases = [...repositoryIdentities]
		.filter(([, repository]) => repository === projectId)
		.map(([cwd]) => cwd);
	const canonicalInput = { ...input, canonicalProjectIdentity: projectId };
	const startedAt = effects.now();
	if (!validId(canonicalInput.canonicalProjectIdentity) || !validId(canonicalInput.leaseOwner)) {
		throw new Error("recipient_policy_reconciliation_input_invalid");
	}
	const duration = canonicalInput.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
	if (!Number.isSafeInteger(duration) || duration <= 0) {
		throw new Error("recipient_policy_reconciliation_lease_invalid");
	}
	timestamp(startedAt, "recipient_policy_reconciliation_time_invalid");
	if (aliases.length > 0 && !migrateRecipientPolicyAliasState(db, projectId, aliases, startedAt)) {
		const generation = Math.max(
			0,
			getRecipientPolicyAuthorityState(db, projectId)?.generation ?? 0,
			...aliases.map((alias) => getRecipientPolicyAuthorityState(db, alias)?.generation ?? 0),
		);
		return result(projectId, "busy", generation, "recipient_policy_lease_held");
	}
	const lease = acquireLease(db, canonicalInput, startedAt);
	if (!lease) {
		return result(
			projectId,
			"busy",
			getRecipientPolicyAuthorityState(db, projectId)?.generation ?? 0,
			"recipient_policy_lease_held",
		);
	}
	const run: RecipientPolicyReconciliationRun = {
		db,
		projectId,
		leaseOwner: input.leaseOwner,
		lease,
		effects,
		activeGeneration: getRecipientPolicyAuthorityState(db, projectId)?.generation ?? 0,
		revokedDeviceIds: [],
		grantedDeviceIds: [],
	};
	try {
		return await executeRecipientPolicyReconciliation(run, startedAt);
	} finally {
		releaseLease(db, projectId, input.leaseOwner, effects.now());
	}
}
