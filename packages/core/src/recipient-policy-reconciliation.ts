import { createHash } from "node:crypto";
import type { Database } from "./db.js";

export type RecipientPolicyAuthorityState = "legacy" | "eligible" | "active" | "rolled_back";

export type RecipientPolicyDerivationBlockCode =
	| "canonical_project_identity_invalid"
	| "project_recipient_invalid"
	| "identity_missing"
	| "identity_not_active"
	| "identity_merged"
	| "team_missing"
	| "team_not_active"
	| "team_membership_invalid"
	| "team_member_identity_missing"
	| "team_member_identity_not_active"
	| "team_member_identity_merged"
	| "identity_device_invalid"
	| "device_identity_conflict";

export interface RecipientPolicyDerivationIdentity {
	identityId: string;
	status: string;
	mergedIntoIdentityId?: string | null;
}

export interface RecipientPolicyDerivationTeam {
	teamId: string;
	status: string;
}

export interface RecipientPolicyDerivationTeamMembership {
	teamId: string;
	identityId: string;
	status: string;
}

export interface RecipientPolicyDerivationIdentityDevice {
	identityId: string;
	deviceId: string;
	status: string;
}

export interface RecipientPolicyDerivationProjectRecipient {
	canonicalProjectIdentity: string;
	recipientKind: string;
	recipientId: string;
	status: string;
}

export interface RecipientPolicyEffectiveDeviceSource {
	kind: "direct_identity" | "team_membership";
	teamId?: string;
}

export interface StrictRecipientPolicyEffectiveDevice {
	canonicalProjectIdentity: string;
	identityId: string;
	deviceId: string;
	sources: RecipientPolicyEffectiveDeviceSource[];
}

export interface RecipientPolicyDerivationBlock {
	code: RecipientPolicyDerivationBlockCode;
	referenceId: string;
}

export interface DeriveRecipientPolicyEffectiveDevicesInput {
	canonicalProjectIdentity: string;
	projectRecipients: RecipientPolicyDerivationProjectRecipient[];
	identities: RecipientPolicyDerivationIdentity[];
	teams: RecipientPolicyDerivationTeam[];
	teamMemberships: RecipientPolicyDerivationTeamMembership[];
	identityDevices: RecipientPolicyDerivationIdentityDevice[];
}

export interface StrictRecipientPolicyEffectiveDeviceDerivation {
	canonicalProjectIdentity: string;
	status: "eligible" | "blocked";
	devices: StrictRecipientPolicyEffectiveDevice[];
	blocked: RecipientPolicyDerivationBlock[];
	desiredDevicesDigest: string;
}

export interface RecipientPolicyAuthorityStateRecord {
	canonicalProjectIdentity: string;
	authorityState: RecipientPolicyAuthorityState;
	generation: number;
	desiredDevicesDigest: string | null;
	currentDevicesDigest: string | null;
	stableParityEvidenceDigest: string | null;
	stableParityPassedAt: string | null;
	freshSnapshotFingerprint: string | null;
	freshSnapshotObservedAt: string | null;
	safeErrorCode: string | null;
	stateChangedAt: string;
	lastErrorAt: string | null;
	attemptCount: number;
	lastAttemptAt: string | null;
	lastCompletedAt: string | null;
	leaseOwner: string | null;
	leaseAcquiredAt: string | null;
	leaseExpiresAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface UpsertRecipientPolicyAuthorityObservationInput {
	canonicalProjectIdentity: string;
	generation: number;
	desiredDevicesDigest: string;
	currentDevicesDigest: string | null;
	freshSnapshotFingerprint: string | null;
	freshSnapshotObservedAt: string | null;
	now: string;
}

export interface RecordRecipientPolicyAuthorityExecutionInput {
	canonicalProjectIdentity: string;
	generation: number;
	attemptCount: number;
	lastAttemptAt: string | null;
	lastCompletedAt: string | null;
	safeErrorCode: string | null;
	lastErrorAt: string | null;
	leaseOwner: string | null;
	leaseAcquiredAt: string | null;
	leaseExpiresAt: string | null;
	updatedAt: string;
}

export interface EnsureRecipientPolicyReconciliationStepInput {
	canonicalProjectIdentity: string;
	generation: number;
	stepKey: string;
	payloadDigest: string;
	now: string;
}

export interface RecordRecipientPolicyReconciliationStepStateInput {
	canonicalProjectIdentity: string;
	generation: number;
	stepKey: string;
	effectId: string;
	status: "pending" | "running" | "waiting" | "completed" | "failed";
	attemptCount: number;
	startedAt: string | null;
	completedAt: string | null;
	lastAttemptAt: string | null;
	safeErrorCode: string | null;
	errorAt: string | null;
	leaseOwner: string | null;
	leaseAcquiredAt: string | null;
	leaseExpiresAt: string | null;
	updatedAt: string;
}

export interface RecipientPolicyReconciliationStepRecord {
	canonicalProjectIdentity: string;
	generation: number;
	stepKey: string;
	effectId: string;
	payloadDigest: string;
	status: string;
	attemptCount: number;
	startedAt: string | null;
	completedAt: string | null;
	lastAttemptAt: string | null;
	safeErrorCode: string | null;
	errorAt: string | null;
	leaseOwner: string | null;
	leaseAcquiredAt: string | null;
	leaseExpiresAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface RecipientPolicyDenyOverlayRecord {
	canonicalProjectIdentity: string;
	scopeId: string;
	deviceId: string;
	generation: number;
	reasonCode: string;
	createdAt: string;
	updatedAt: string;
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const KNOWN_MEMBERSHIP_STATUSES = new Set(["active", "pending", "revoked"]);
const KNOWN_DEVICE_STATUSES = new Set(["active", "revoked"]);
const KNOWN_RECIPIENT_STATUSES = new Set(["active", "revoked"]);

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function strictId(value: string): boolean {
	return value.length > 0 && value === value.trim() && !CONTROL_CHARACTER.test(value);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.toSorted(([left], [right]) => compareText(left, right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function digest(prefix: string, value: unknown): string {
	return `${prefix}:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function sourceKey(source: RecipientPolicyEffectiveDeviceSource): string {
	return source.kind === "direct_identity" ? source.kind : `${source.kind}\u0000${source.teamId}`;
}

function block(
	blocked: Map<string, RecipientPolicyDerivationBlock>,
	code: RecipientPolicyDerivationBlockCode,
	referenceId: string,
): void {
	blocked.set(`${code}\u0000${referenceId}`, { code, referenceId });
}

function activeIdentityCode(
	identity: RecipientPolicyDerivationIdentity | undefined,
	missing: RecipientPolicyDerivationBlockCode,
	inactive: RecipientPolicyDerivationBlockCode,
	merged: RecipientPolicyDerivationBlockCode,
): RecipientPolicyDerivationBlockCode | null {
	if (!identity) return missing;
	if (identity.status === "merged" || identity.mergedIntoIdentityId) return merged;
	if (identity.status !== "active") return inactive;
	return null;
}

function addEffectiveDevice(
	effective: Map<string, StrictRecipientPolicyEffectiveDevice>,
	deviceOwners: Map<string, string>,
	projectId: string,
	identityId: string,
	deviceId: string,
	source: RecipientPolicyEffectiveDeviceSource,
	blocked: Map<string, RecipientPolicyDerivationBlock>,
): void {
	const owner = deviceOwners.get(deviceId);
	if (owner && owner !== identityId) {
		block(blocked, "device_identity_conflict", deviceId);
		return;
	}
	deviceOwners.set(deviceId, identityId);
	const current = effective.get(deviceId);
	const sources = new Map((current?.sources ?? []).map((item) => [sourceKey(item), item]));
	sources.set(sourceKey(source), source);
	effective.set(deviceId, {
		canonicalProjectIdentity: projectId,
		identityId,
		deviceId,
		sources: [...sources.values()].toSorted((left, right) =>
			compareText(sourceKey(left), sourceKey(right)),
		),
	});
}

export function recipientPolicyDevicesDigest(
	devices: readonly StrictRecipientPolicyEffectiveDevice[],
): string {
	return digest(
		"recipient-policy-devices-v1",
		devices
			.toSorted(
				(left, right) =>
					compareText(left.canonicalProjectIdentity, right.canonicalProjectIdentity) ||
					compareText(left.deviceId, right.deviceId) ||
					compareText(left.identityId, right.identityId),
			)
			.map((device) => ({
				canonicalProjectIdentity: device.canonicalProjectIdentity,
				identityId: device.identityId,
				deviceId: device.deviceId,
				sources: device.sources.toSorted((left, right) =>
					compareText(sourceKey(left), sourceKey(right)),
				),
			})),
	);
}

export function deriveRecipientPolicyEffectiveDevices(
	input: DeriveRecipientPolicyEffectiveDevicesInput,
): StrictRecipientPolicyEffectiveDeviceDerivation {
	const blocked = new Map<string, RecipientPolicyDerivationBlock>();
	if (!strictId(input.canonicalProjectIdentity)) {
		block(blocked, "canonical_project_identity_invalid", input.canonicalProjectIdentity);
	}
	const identities = new Map(input.identities.map((identity) => [identity.identityId, identity]));
	const teams = new Map(input.teams.map((team) => [team.teamId, team]));
	const membershipsByTeam = new Map<string, RecipientPolicyDerivationTeamMembership[]>();
	for (const membership of input.teamMemberships) {
		const current = membershipsByTeam.get(membership.teamId) ?? [];
		current.push(membership);
		membershipsByTeam.set(membership.teamId, current);
	}
	const devicesByIdentity = new Map<string, RecipientPolicyDerivationIdentityDevice[]>();
	for (const device of input.identityDevices) {
		const current = devicesByIdentity.get(device.identityId) ?? [];
		current.push(device);
		devicesByIdentity.set(device.identityId, current);
	}
	const effective = new Map<string, StrictRecipientPolicyEffectiveDevice>();
	const deviceOwners = new Map<string, string>();
	const expandIdentity = (
		identityId: string,
		source: RecipientPolicyEffectiveDeviceSource,
		codes: readonly [
			RecipientPolicyDerivationBlockCode,
			RecipientPolicyDerivationBlockCode,
			RecipientPolicyDerivationBlockCode,
		],
	): void => {
		const identityCode = activeIdentityCode(identities.get(identityId), ...codes);
		if (identityCode) {
			block(blocked, identityCode, identityId);
			return;
		}
		for (const device of devicesByIdentity.get(identityId) ?? []) {
			if (!KNOWN_DEVICE_STATUSES.has(device.status)) {
				block(blocked, "identity_device_invalid", device.deviceId);
				continue;
			}
			if (device.status !== "active") continue;
			if (!strictId(device.identityId) || !strictId(device.deviceId)) {
				block(blocked, "identity_device_invalid", device.deviceId);
				continue;
			}
			addEffectiveDevice(
				effective,
				deviceOwners,
				input.canonicalProjectIdentity,
				identityId,
				device.deviceId,
				source,
				blocked,
			);
		}
	};
	const projectRecipients = input.projectRecipients.filter(
		(recipient) => recipient.canonicalProjectIdentity === input.canonicalProjectIdentity,
	);
	for (const recipient of projectRecipients) {
		if (!KNOWN_RECIPIENT_STATUSES.has(recipient.status)) {
			block(blocked, "project_recipient_invalid", recipient.recipientId);
			continue;
		}
		if (recipient.status !== "active") continue;
		if (!strictId(recipient.recipientId)) {
			block(blocked, "project_recipient_invalid", recipient.recipientId);
			continue;
		}
		if (recipient.recipientKind === "identity") {
			expandIdentity(recipient.recipientId, { kind: "direct_identity" }, [
				"identity_missing",
				"identity_not_active",
				"identity_merged",
			]);
			continue;
		}
		if (recipient.recipientKind !== "team") {
			block(blocked, "project_recipient_invalid", recipient.recipientId);
			continue;
		}
		const team = teams.get(recipient.recipientId);
		if (!team) {
			block(blocked, "team_missing", recipient.recipientId);
			continue;
		}
		if (team.status !== "active") {
			block(blocked, "team_not_active", recipient.recipientId);
			continue;
		}
		for (const membership of membershipsByTeam.get(team.teamId) ?? []) {
			if (!KNOWN_MEMBERSHIP_STATUSES.has(membership.status)) {
				block(blocked, "team_membership_invalid", `${membership.teamId}:${membership.identityId}`);
				continue;
			}
			if (membership.status !== "active") continue;
			if (!strictId(membership.teamId) || !strictId(membership.identityId)) {
				block(blocked, "team_membership_invalid", `${membership.teamId}:${membership.identityId}`);
				continue;
			}
			expandIdentity(membership.identityId, { kind: "team_membership", teamId: team.teamId }, [
				"team_member_identity_missing",
				"team_member_identity_not_active",
				"team_member_identity_merged",
			]);
		}
	}
	const blockedItems = [...blocked.values()].toSorted(
		(left, right) =>
			compareText(left.code, right.code) || compareText(left.referenceId, right.referenceId),
	);
	const devices = [...effective.values()].toSorted(
		(left, right) =>
			compareText(left.deviceId, right.deviceId) || compareText(left.identityId, right.identityId),
	);
	const grantCandidates = blockedItems.length === 0 ? devices : [];
	return {
		canonicalProjectIdentity: input.canonicalProjectIdentity,
		status: blockedItems.length === 0 ? "eligible" : "blocked",
		devices: grantCandidates,
		blocked: blockedItems,
		desiredDevicesDigest: recipientPolicyDevicesDigest(grantCandidates),
	};
}

export function deriveRecipientPolicyEffectiveDevicesFromDatabase(
	db: Database,
	canonicalProjectIdentity: string,
): StrictRecipientPolicyEffectiveDeviceDerivation {
	const projectRecipients = db
		.prepare(
			`SELECT canonical_project_identity, recipient_kind, recipient_id, status
			 FROM project_recipients WHERE canonical_project_identity = ?
			 ORDER BY recipient_kind, recipient_id`,
		)
		.all(canonicalProjectIdentity) as Array<{
		canonical_project_identity: string;
		recipient_kind: string;
		recipient_id: string;
		status: string;
	}>;
	const identities = db
		.prepare("SELECT actor_id, status, merged_into_actor_id FROM actors ORDER BY actor_id")
		.all() as Array<{ actor_id: string; status: string; merged_into_actor_id: string | null }>;
	const teams = db
		.prepare("SELECT team_id, status FROM policy_teams ORDER BY team_id")
		.all() as Array<{
		team_id: string;
		status: string;
	}>;
	const teamMemberships = db
		.prepare(
			"SELECT team_id, identity_id, status FROM policy_team_memberships ORDER BY team_id, identity_id",
		)
		.all() as Array<{ team_id: string; identity_id: string; status: string }>;
	const identityDevices = db
		.prepare(
			"SELECT identity_id, device_id, status FROM identity_devices ORDER BY identity_id, device_id",
		)
		.all() as Array<{ identity_id: string; device_id: string; status: string }>;
	return deriveRecipientPolicyEffectiveDevices({
		canonicalProjectIdentity,
		projectRecipients: projectRecipients.map((row) => ({
			canonicalProjectIdentity: row.canonical_project_identity,
			recipientKind: row.recipient_kind,
			recipientId: row.recipient_id,
			status: row.status,
		})),
		identities: identities.map((row) => ({
			identityId: row.actor_id,
			status: row.status,
			mergedIntoIdentityId: row.merged_into_actor_id,
		})),
		teams: teams.map((row) => ({ teamId: row.team_id, status: row.status })),
		teamMemberships: teamMemberships.map((row) => ({
			teamId: row.team_id,
			identityId: row.identity_id,
			status: row.status,
		})),
		identityDevices: identityDevices.map((row) => ({
			identityId: row.identity_id,
			deviceId: row.device_id,
			status: row.status,
		})),
	});
}

function authorityRow(row: Record<string, unknown>): RecipientPolicyAuthorityStateRecord {
	return {
		canonicalProjectIdentity: String(row.canonical_project_identity),
		authorityState: row.authority_state as RecipientPolicyAuthorityState,
		generation: Number(row.generation),
		desiredDevicesDigest: row.desired_devices_digest as string | null,
		currentDevicesDigest: row.current_devices_digest as string | null,
		stableParityEvidenceDigest: row.stable_parity_evidence_digest as string | null,
		stableParityPassedAt: row.stable_parity_passed_at as string | null,
		freshSnapshotFingerprint: row.fresh_snapshot_fingerprint as string | null,
		freshSnapshotObservedAt: row.fresh_snapshot_observed_at as string | null,
		safeErrorCode: row.safe_error_code as string | null,
		stateChangedAt: String(row.state_changed_at),
		lastErrorAt: row.last_error_at as string | null,
		attemptCount: Number(row.attempt_count),
		lastAttemptAt: row.last_attempt_at as string | null,
		lastCompletedAt: row.last_completed_at as string | null,
		leaseOwner: row.lease_owner as string | null,
		leaseAcquiredAt: row.lease_acquired_at as string | null,
		leaseExpiresAt: row.lease_expires_at as string | null,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export function getRecipientPolicyAuthorityState(
	db: Database,
	canonicalProjectIdentity: string,
): RecipientPolicyAuthorityStateRecord | null {
	const row = db
		.prepare("SELECT * FROM recipient_policy_authority_states WHERE canonical_project_identity = ?")
		.get(canonicalProjectIdentity) as Record<string, unknown> | undefined;
	return row ? authorityRow(row) : null;
}

export function upsertRecipientPolicyAuthorityObservation(
	db: Database,
	input: UpsertRecipientPolicyAuthorityObservationInput,
): RecipientPolicyAuthorityStateRecord {
	if (
		!strictId(input.canonicalProjectIdentity) ||
		!Number.isSafeInteger(input.generation) ||
		input.generation < 0
	) {
		throw new Error("recipient_policy_authority_observation_invalid");
	}
	const existing = getRecipientPolicyAuthorityState(db, input.canonicalProjectIdentity);
	if (existing && input.generation < existing.generation) {
		throw new Error("recipient_policy_generation_stale");
	}
	if (
		existing &&
		input.generation === existing.generation &&
		existing.desiredDevicesDigest !== input.desiredDevicesDigest
	) {
		throw new Error("recipient_policy_generation_conflict");
	}
	db.prepare(
		`INSERT INTO recipient_policy_authority_states(
		 canonical_project_identity, authority_state, generation, desired_devices_digest,
		 current_devices_digest, fresh_snapshot_fingerprint, fresh_snapshot_observed_at,
		 state_changed_at, created_at, updated_at
		 ) VALUES (?, 'legacy', ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(canonical_project_identity) DO UPDATE SET
		 generation = excluded.generation,
		 desired_devices_digest = excluded.desired_devices_digest,
		 current_devices_digest = excluded.current_devices_digest,
		 fresh_snapshot_fingerprint = excluded.fresh_snapshot_fingerprint,
		 fresh_snapshot_observed_at = excluded.fresh_snapshot_observed_at,
		 stable_parity_evidence_digest = CASE
		  WHEN recipient_policy_authority_states.generation = excluded.generation
		  THEN recipient_policy_authority_states.stable_parity_evidence_digest ELSE NULL END,
		 stable_parity_passed_at = CASE
		  WHEN recipient_policy_authority_states.generation = excluded.generation
		  THEN recipient_policy_authority_states.stable_parity_passed_at ELSE NULL END,
		 updated_at = excluded.updated_at`,
	).run(
		input.canonicalProjectIdentity,
		input.generation,
		input.desiredDevicesDigest,
		input.currentDevicesDigest,
		input.freshSnapshotFingerprint,
		input.freshSnapshotObservedAt,
		input.now,
		input.now,
		input.now,
	);
	const state = getRecipientPolicyAuthorityState(db, input.canonicalProjectIdentity);
	if (!state) throw new Error("recipient_policy_authority_state_missing");
	return state;
}

export function recordRecipientPolicyStableParityPass(
	db: Database,
	input: {
		canonicalProjectIdentity: string;
		generation: number;
		evidenceDigest: string;
		snapshotFingerprint: string;
		passedAt: string;
	},
): RecipientPolicyAuthorityStateRecord {
	const state = getRecipientPolicyAuthorityState(db, input.canonicalProjectIdentity);
	if (
		!state ||
		state.generation !== input.generation ||
		state.desiredDevicesDigest === null ||
		state.desiredDevicesDigest !== state.currentDevicesDigest ||
		state.freshSnapshotFingerprint !== input.snapshotFingerprint
	) {
		throw new Error("recipient_policy_parity_evidence_invalid");
	}
	if (
		state.stableParityEvidenceDigest &&
		(state.stableParityEvidenceDigest !== input.evidenceDigest ||
			state.stableParityPassedAt !== input.passedAt)
	) {
		throw new Error("recipient_policy_parity_evidence_conflict");
	}
	db.prepare(
		`UPDATE recipient_policy_authority_states
		 SET stable_parity_evidence_digest = ?, stable_parity_passed_at = ?, updated_at = ?
		 WHERE canonical_project_identity = ?`,
	).run(input.evidenceDigest, input.passedAt, input.passedAt, input.canonicalProjectIdentity);
	const updated = getRecipientPolicyAuthorityState(db, input.canonicalProjectIdentity);
	if (!updated) throw new Error("recipient_policy_authority_state_missing");
	return updated;
}

export function recordRecipientPolicyAuthorityExecution(
	db: Database,
	input: RecordRecipientPolicyAuthorityExecutionInput,
): RecipientPolicyAuthorityStateRecord {
	const state = getRecipientPolicyAuthorityState(db, input.canonicalProjectIdentity);
	if (!state || state.generation !== input.generation) {
		throw new Error("recipient_policy_authority_generation_missing");
	}
	if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < state.attemptCount) {
		throw new Error("recipient_policy_reconciliation_attempt_stale");
	}
	db.prepare(
		`UPDATE recipient_policy_authority_states SET
		 attempt_count = ?, last_attempt_at = ?, last_completed_at = ?, safe_error_code = ?,
		 last_error_at = ?, lease_owner = ?, lease_acquired_at = ?, lease_expires_at = ?,
		 updated_at = ?
		 WHERE canonical_project_identity = ? AND generation = ?`,
	).run(
		input.attemptCount,
		input.lastAttemptAt,
		input.lastCompletedAt,
		input.safeErrorCode,
		input.lastErrorAt,
		input.leaseOwner,
		input.leaseAcquiredAt,
		input.leaseExpiresAt,
		input.updatedAt,
		input.canonicalProjectIdentity,
		input.generation,
	);
	const updated = getRecipientPolicyAuthorityState(db, input.canonicalProjectIdentity);
	if (!updated) throw new Error("recipient_policy_authority_state_missing");
	return updated;
}

export function deterministicRecipientPolicyReconciliationEffectId(input: {
	canonicalProjectIdentity: string;
	generation: number;
	stepKey: string;
	payloadDigest: string;
}): string {
	return digest("recipient-policy-reconciliation-effect-v1", {
		canonicalProjectIdentity: input.canonicalProjectIdentity,
		generation: input.generation,
		stepKey: input.stepKey,
		payloadDigest: input.payloadDigest,
	});
}

function stepRow(row: Record<string, unknown>): RecipientPolicyReconciliationStepRecord {
	return {
		canonicalProjectIdentity: String(row.canonical_project_identity),
		generation: Number(row.generation),
		stepKey: String(row.step_key),
		effectId: String(row.effect_id),
		payloadDigest: String(row.payload_digest),
		status: String(row.status),
		attemptCount: Number(row.attempt_count),
		startedAt: row.started_at as string | null,
		completedAt: row.completed_at as string | null,
		lastAttemptAt: row.last_attempt_at as string | null,
		safeErrorCode: row.safe_error_code as string | null,
		errorAt: row.error_at as string | null,
		leaseOwner: row.lease_owner as string | null,
		leaseAcquiredAt: row.lease_acquired_at as string | null,
		leaseExpiresAt: row.lease_expires_at as string | null,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export function ensureRecipientPolicyReconciliationStep(
	db: Database,
	input: EnsureRecipientPolicyReconciliationStepInput,
): RecipientPolicyReconciliationStepRecord {
	if (
		!strictId(input.canonicalProjectIdentity) ||
		!strictId(input.stepKey) ||
		!Number.isSafeInteger(input.generation) ||
		input.generation < 0
	) {
		throw new Error("recipient_policy_reconciliation_step_invalid");
	}
	const effectId = deterministicRecipientPolicyReconciliationEffectId(input);
	const existing = db
		.prepare(
			`SELECT * FROM recipient_policy_reconciliation_steps
			 WHERE canonical_project_identity = ? AND generation = ? AND step_key = ?`,
		)
		.get(input.canonicalProjectIdentity, input.generation, input.stepKey) as
		| Record<string, unknown>
		| undefined;
	if (existing) {
		if (existing.effect_id !== effectId || existing.payload_digest !== input.payloadDigest) {
			throw new Error("recipient_policy_reconciliation_step_conflict");
		}
		return stepRow(existing);
	}
	db.prepare(
		`INSERT INTO recipient_policy_reconciliation_steps(
		 canonical_project_identity, generation, step_key, effect_id, payload_digest,
		 status, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
	).run(
		input.canonicalProjectIdentity,
		input.generation,
		input.stepKey,
		effectId,
		input.payloadDigest,
		input.now,
		input.now,
	);
	const row = db
		.prepare(
			`SELECT * FROM recipient_policy_reconciliation_steps
			 WHERE canonical_project_identity = ? AND generation = ? AND step_key = ?`,
		)
		.get(input.canonicalProjectIdentity, input.generation, input.stepKey) as Record<
		string,
		unknown
	>;
	return stepRow(row);
}

export function recordRecipientPolicyReconciliationStepState(
	db: Database,
	input: RecordRecipientPolicyReconciliationStepStateInput,
): RecipientPolicyReconciliationStepRecord {
	const existing = db
		.prepare(
			`SELECT * FROM recipient_policy_reconciliation_steps
			 WHERE canonical_project_identity = ? AND generation = ? AND step_key = ?`,
		)
		.get(input.canonicalProjectIdentity, input.generation, input.stepKey) as
		| Record<string, unknown>
		| undefined;
	if (!existing || existing.effect_id !== input.effectId) {
		throw new Error("recipient_policy_reconciliation_step_missing");
	}
	if (
		!Number.isSafeInteger(input.attemptCount) ||
		input.attemptCount < Number(existing.attempt_count)
	) {
		throw new Error("recipient_policy_reconciliation_attempt_stale");
	}
	db.prepare(
		`UPDATE recipient_policy_reconciliation_steps SET
		 status = ?, attempt_count = ?, started_at = ?, completed_at = ?, last_attempt_at = ?,
		 safe_error_code = ?, error_at = ?, lease_owner = ?, lease_acquired_at = ?,
		 lease_expires_at = ?, updated_at = ?
		 WHERE canonical_project_identity = ? AND generation = ? AND step_key = ? AND effect_id = ?`,
	).run(
		input.status,
		input.attemptCount,
		input.startedAt,
		input.completedAt,
		input.lastAttemptAt,
		input.safeErrorCode,
		input.errorAt,
		input.leaseOwner,
		input.leaseAcquiredAt,
		input.leaseExpiresAt,
		input.updatedAt,
		input.canonicalProjectIdentity,
		input.generation,
		input.stepKey,
		input.effectId,
	);
	const row = db
		.prepare(
			`SELECT * FROM recipient_policy_reconciliation_steps
			 WHERE canonical_project_identity = ? AND generation = ? AND step_key = ?`,
		)
		.get(input.canonicalProjectIdentity, input.generation, input.stepKey) as Record<
		string,
		unknown
	>;
	return stepRow(row);
}

function denyOverlayRow(row: Record<string, unknown>): RecipientPolicyDenyOverlayRecord {
	return {
		canonicalProjectIdentity: String(row.canonical_project_identity),
		scopeId: String(row.scope_id),
		deviceId: String(row.device_id),
		generation: Number(row.generation),
		reasonCode: String(row.reason_code),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export function putRecipientPolicyDenyOverlay(
	db: Database,
	input: {
		canonicalProjectIdentity: string;
		scopeId: string;
		deviceId: string;
		generation: number;
		reasonCode: string;
		now: string;
	},
): RecipientPolicyDenyOverlayRecord {
	if (
		![input.canonicalProjectIdentity, input.scopeId, input.deviceId, input.reasonCode].every(
			strictId,
		) ||
		!Number.isSafeInteger(input.generation) ||
		input.generation < 0
	) {
		throw new Error("recipient_policy_deny_overlay_invalid");
	}
	const existing = db
		.prepare(
			`SELECT * FROM recipient_policy_deny_overlays
			 WHERE canonical_project_identity = ? AND scope_id = ? AND device_id = ?`,
		)
		.get(input.canonicalProjectIdentity, input.scopeId, input.deviceId) as
		| Record<string, unknown>
		| undefined;
	if (existing && input.generation < Number(existing.generation)) {
		throw new Error("recipient_policy_deny_overlay_stale");
	}
	if (
		existing &&
		input.generation === Number(existing.generation) &&
		input.reasonCode !== existing.reason_code
	) {
		throw new Error("recipient_policy_deny_overlay_conflict");
	}
	db.prepare(
		`INSERT INTO recipient_policy_deny_overlays(
		 canonical_project_identity, scope_id, device_id, generation, reason_code, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(canonical_project_identity, scope_id, device_id) DO UPDATE SET
		 generation = excluded.generation,
		 reason_code = excluded.reason_code,
		 updated_at = excluded.updated_at`,
	).run(
		input.canonicalProjectIdentity,
		input.scopeId,
		input.deviceId,
		input.generation,
		input.reasonCode,
		input.now,
		input.now,
	);
	const row = db
		.prepare(
			`SELECT * FROM recipient_policy_deny_overlays
			 WHERE canonical_project_identity = ? AND scope_id = ? AND device_id = ?`,
		)
		.get(input.canonicalProjectIdentity, input.scopeId, input.deviceId) as Record<string, unknown>;
	return denyOverlayRow(row);
}

export function listRecipientPolicyDenyOverlays(
	db: Database,
	canonicalProjectIdentity: string,
): RecipientPolicyDenyOverlayRecord[] {
	return (
		db
			.prepare(
				`SELECT * FROM recipient_policy_deny_overlays
				 WHERE canonical_project_identity = ? ORDER BY scope_id, device_id`,
			)
			.all(canonicalProjectIdentity) as Array<Record<string, unknown>>
	).map(denyOverlayRow);
}

/**
 * Returns any deny for a scope/device pair. Active policy reconciliation requires
 * one exact Project per managed scope, so enforcement intentionally fails closed
 * if corrupt legacy state contains more than one Project overlay for the pair.
 */
export function getAnyRecipientPolicyDenyOverlayForScopeDevice(
	db: Database,
	input: { scopeId: string; deviceId: string },
): RecipientPolicyDenyOverlayRecord | null {
	const row = db
		.prepare(
			`SELECT * FROM recipient_policy_deny_overlays
			 WHERE scope_id = ? AND device_id = ?
			 ORDER BY canonical_project_identity
			 LIMIT 1`,
		)
		.get(input.scopeId, input.deviceId) as Record<string, unknown> | undefined;
	return row ? denyOverlayRow(row) : null;
}

export function clearRecipientPolicyDenyOverlay(
	db: Database,
	input: {
		canonicalProjectIdentity: string;
		scopeId: string;
		deviceId: string;
		verifiedGeneration: number;
	},
): boolean {
	const result = db
		.prepare(
			`DELETE FROM recipient_policy_deny_overlays
			 WHERE canonical_project_identity = ? AND scope_id = ? AND device_id = ?
			 AND generation <= ?`,
		)
		.run(input.canonicalProjectIdentity, input.scopeId, input.deviceId, input.verifiedGeneration);
	return result.changes > 0;
}
