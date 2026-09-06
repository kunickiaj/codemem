import {
	type CoordinatorLegacyTeamCompletionManifestV1,
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "./coordinator-legacy-team-completion.js";
import type { Database } from "./db.js";
import {
	isLegacyTeamCandidateSelectable,
	type LegacyTeamRosterDeviceSnapshot,
} from "./legacy-team-candidate.js";
import {
	applyAdditiveCanonicalLegacyTeamSetupProjectsInTransaction,
	applyCanonicalLegacyTeamSetupActivationInTransaction,
	inspectLegacyTeamSetupActivation,
	LegacyTeamSetupActivationError,
	type LegacyTeamSetupActivationErrorCode,
} from "./legacy-team-setup-activation.js";
import { legacyTeamResolvedProjectRef } from "./legacy-team-setup-draft.js";
import { safeLabel, setupLabelForbiddenIds } from "./legacy-team-setup-label-policy.js";
import {
	LEGACY_TEAM_SETUP_MAX_DEVICES,
	LEGACY_TEAM_SETUP_MAX_PROJECTS,
	requireLegacyTeamSetupSnapshotWithinLimits,
} from "./legacy-team-setup-limits.js";
import { listProjectScopeCandidates } from "./project-scope-settings.js";
import type { LegacyTeamSetupActivationResultV1 } from "./recipient-policy-contract.js";
import {
	compareCodepoints,
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
	legacyTeamDeviceRef,
	legacyTeamProjectRef,
	recipientPolicyDigest,
} from "./recipient-policy-identifiers.js";
import {
	isRecipientPolicyTeamRenameRevision,
	serializeRecipientPolicyCoordinatorGroupMutation,
	serializeRecipientPolicyPublicationMutation,
	serializeRecipientPolicyTeamMutation,
} from "./recipient-policy-team-metadata.js";

export type LegacyTeamSetupCompletionManifestErrorCode =
	| "team_setup_completion_invalid"
	| "team_setup_completion_conflict";

export class LegacyTeamSetupCompletionManifestError extends Error {
	readonly code: LegacyTeamSetupCompletionManifestErrorCode;

	constructor(code: LegacyTeamSetupCompletionManifestErrorCode) {
		super(code);
		this.name = "LegacyTeamSetupCompletionManifestError";
		this.code = code;
	}
}

export class LegacyTeamSetupAdditiveConvergenceError extends Error {
	readonly code: LegacyTeamSetupActivationErrorCode;

	constructor(error: unknown) {
		const code =
			error instanceof LegacyTeamSetupActivationError ||
			error instanceof LegacyTeamSetupCompletionManifestError
				? error.code
				: "team_setup_failed";
		super(code, { cause: error });
		this.name = "LegacyTeamSetupAdditiveConvergenceError";
		this.code = code;
	}
}

class LegacyTeamSetupConfirmationStaleError extends Error {
	readonly code = "team_setup_confirmation_stale" as const;

	constructor() {
		super("team_setup_confirmation_stale");
		this.name = "LegacyTeamSetupConfirmationStaleError";
	}
}

class LegacyTeamSetupRosterCapacityError extends Error {
	readonly code = "team_setup_roster_unavailable" as const;

	constructor() {
		super("team_setup_roster_unavailable");
		this.name = "LegacyTeamSetupRosterCapacityError";
	}
}

interface DraftRow {
	attempt_id: string;
	candidate_id: string;
	coordinator_id: string;
	group_id: string;
	state: string;
	display_name: string;
	finish_digest: string | null;
	completed_at: string | null;
}

interface DraftDeviceRow {
	device_id: string;
	key_fingerprint: string;
	enabled: number;
	decision: string;
	target_identity_id: string | null;
}

interface ApplyCompletionManifestInput {
	coordinatorId: string;
	groupId: string;
	manifest: unknown;
	freshRoster: readonly LegacyTeamRosterDeviceSnapshot[];
	expectedDraftManifest?: CoordinatorLegacyTeamCompletionManifestV1;
	recipientPolicyLocksHeld?: {
		publication: true;
		team: true;
		coordinatorGroup: true;
	};
}

const LEGACY_TEAM_SETUP_MAX_PROJECT_CANDIDATE_SCAN_ROWS = 10_000;
const LEGACY_TEAM_SETUP_MAX_PROJECT_CANDIDATE_METADATA_ROWS = 10_000;

interface DraftProjectRow {
	project_ref: string;
	source_project_identity: string;
	resolved_project_identity: string | null;
	target_scope_id: string | null;
}

interface ResolvedManifestProject {
	sourceIdentity: string;
	resolvedIdentity: string;
	displayName: string;
}

function fail(code: LegacyTeamSetupCompletionManifestErrorCode): never {
	throw new LegacyTeamSetupCompletionManifestError(code);
}

function digest(domain: string, value: unknown): string {
	const prefixedDigest = recipientPolicyDigest(domain, value);
	const prefix = `${domain}:`;
	if (!prefixedDigest.startsWith(prefix)) fail("team_setup_completion_invalid");
	const rawDigest = prefixedDigest.slice(prefix.length);
	if (!/^[0-9a-f]{64}$/u.test(rawDigest)) fail("team_setup_completion_invalid");
	return rawDigest;
}

function manifestDigests(
	coordinatorId: string,
	groupId: string,
	manifest: Omit<
		CoordinatorLegacyTeamCompletionManifestV1,
		| "candidate_digest"
		| "team_digest"
		| "source_digest"
		| "finish_digest"
		| "access_delta_digest"
		| "completed_at"
	> & { completed_at?: string },
): Pick<
	CoordinatorLegacyTeamCompletionManifestV1,
	"candidate_digest" | "team_digest" | "source_digest" | "finish_digest" | "access_delta_digest"
> {
	const candidateDigest = digest("legacy-team-completion-candidate-v1", {
		coordinatorId,
		groupId,
		candidateRef: manifest.candidate_ref,
	});
	const teamDigest = digest("legacy-team-completion-team-v1", {
		teamId: manifest.team_id,
		displayName: manifest.team.display_name,
		deviceEligibilityMode: manifest.team.device_eligibility_mode,
	});
	const sourceDigest = digest("legacy-team-completion-source-v1", {
		deviceDecisions: manifest.device_decisions,
		projectMappings: manifest.project_mappings,
	});
	const accessDeltaDigest = digest("legacy-team-completion-access-delta-v1", {
		memberships: manifest.memberships,
		projectRecipients: manifest.project_recipients,
	});
	return {
		candidate_digest: candidateDigest,
		team_digest: teamDigest,
		source_digest: sourceDigest,
		access_delta_digest: accessDeltaDigest,
		finish_digest: digest("legacy-team-completion-finish-v1", {
			candidateDigest,
			teamDigest,
			sourceDigest,
			accessDeltaDigest,
		}),
	};
}

function loadDraft(db: Database, candidateRef: string, attemptId?: string): DraftRow {
	const row = attemptId
		? (db
				.prepare(
					`SELECT attempt_id, candidate_id, coordinator_id, group_id, state, display_name, finish_digest, completed_at
					 FROM legacy_team_setup_drafts WHERE attempt_id = ? AND candidate_id = ?`,
				)
				.get(attemptId, candidateRef) as DraftRow | undefined)
		: (db
				.prepare(
					`SELECT attempt_id, candidate_id, coordinator_id, group_id, state, display_name, finish_digest, completed_at
					 FROM legacy_team_setup_drafts WHERE candidate_id = ? ORDER BY rowid DESC LIMIT 1`,
				)
				.get(candidateRef) as DraftRow | undefined);
	if (!row) fail("team_setup_completion_invalid");
	return row;
}

function loadCompletedDraft(db: Database, candidateRef: string): DraftRow {
	const row = db
		.prepare(
			`SELECT attempt_id, candidate_id, coordinator_id, group_id, state, display_name, finish_digest, completed_at
			 FROM legacy_team_setup_drafts
			 WHERE candidate_id = ? AND state = 'completed'
			 ORDER BY rowid DESC LIMIT 1`,
		)
		.get(candidateRef) as DraftRow | undefined;
	if (!row) fail("team_setup_completion_invalid");
	return row;
}

function deriveFromDraft(
	db: Database,
	draft: DraftRow,
	completedAt: string,
): CoordinatorLegacyTeamCompletionManifestV1 {
	// Fetch one row past each cap so a pre-limit historical attempt is rejected
	// without materializing an unbounded draft first.
	const devices = db
		.prepare(
			`SELECT device_id, key_fingerprint, enabled, decision, target_identity_id
			 FROM legacy_team_setup_draft_devices WHERE attempt_id = ? ORDER BY device_id
			 LIMIT ?`,
		)
		.all(draft.attempt_id, LEGACY_TEAM_SETUP_MAX_DEVICES + 1) as DraftDeviceRow[];
	const projects = db
		.prepare(
			`SELECT project_ref, source_project_identity, resolved_project_identity, target_scope_id
			 FROM legacy_team_setup_draft_projects WHERE attempt_id = ? ORDER BY project_ref
			 LIMIT ?`,
		)
		.all(draft.attempt_id, LEGACY_TEAM_SETUP_MAX_PROJECTS + 1) as DraftProjectRow[];
	requireCompletionSnapshotWithinLimits(devices, projects);
	if (
		devices.length === 0 ||
		devices.some(
			(device) =>
				!["included", "excluded", "removed"].includes(device.decision) ||
				(device.decision === "included" && !device.target_identity_id),
		) ||
		projects.some((project) => !project.resolved_project_identity)
	) {
		fail("team_setup_completion_invalid");
	}
	const teamId = deterministicPolicyTeamId(draft.candidate_id);
	const memberships = [
		...new Set(
			devices.flatMap((device) =>
				device.decision === "included" && device.target_identity_id
					? [device.target_identity_id]
					: [],
			),
		),
	]
		.toSorted(compareCodepoints)
		.map((identityId) => ({ identity_id: identityId, role: "member" as const }));
	const deviceDecisions = devices
		.filter((device) => device.decision !== "removed")
		.map((device) => ({
			device_id: device.device_id,
			key_fingerprint: device.key_fingerprint,
			enabled: device.enabled !== 0,
			identity_id: device.decision === "included" ? device.target_identity_id : null,
			decision: device.decision === "included" ? ("included" as const) : ("excluded" as const),
		}));
	const projectMappings = projects.map((project) => {
		const matchingScopeIds = project.target_scope_id
			? [project.target_scope_id]
			: (db
					.prepare(
						`SELECT DISTINCT mapping.scope_id FROM project_scope_mappings AS mapping
						 JOIN replication_scopes AS scope ON scope.scope_id = mapping.scope_id
						 WHERE mapping.project_pattern = ? AND mapping.workspace_identity = ?
						   AND scope.coordinator_id = ? AND scope.group_id = ?
						   AND scope.authority_type = 'coordinator' AND scope.status = 'active'
						 ORDER BY mapping.scope_id`,
					)
					.pluck()
					.all(
						project.source_project_identity,
						project.resolved_project_identity,
						draft.coordinator_id,
						draft.group_id,
					) as string[]);
		if (matchingScopeIds.length !== 1) fail("team_setup_completion_invalid");
		return {
			project_ref: project.project_ref,
			resolved_project_ref: legacyTeamResolvedProjectRef(
				project.project_ref,
				project.resolved_project_identity as string,
			),
			scope_id: matchingScopeIds[0] as string,
		};
	});
	const projectRecipients = [
		...new Set(projectMappings.map((mapping) => mapping.resolved_project_ref)),
	]
		.toSorted(compareCodepoints)
		.map((resolvedProjectRef) => ({ resolved_project_ref: resolvedProjectRef, team_id: teamId }));
	const base = {
		version: 1 as const,
		coordinator_id: draft.coordinator_id,
		candidate_ref: draft.candidate_id,
		team_id: teamId,
		team: {
			display_name: draft.display_name,
			policy_revision: "",
			device_eligibility_mode: "reviewed_allowlist" as const,
		},
		memberships,
		device_decisions: deviceDecisions,
		project_mappings: projectMappings,
		project_recipients: projectRecipients,
	};
	const digests = manifestDigests(draft.coordinator_id, draft.group_id, base);
	const policyRevision = digest("legacy-team-completion-policy-revision-v1", digests.finish_digest);
	return normalizeCoordinatorLegacyTeamCompletionManifest({
		...base,
		...digests,
		team: { ...base.team, policy_revision: policyRevision },
		completed_at: completedAt,
	});
}

export function deriveLegacyTeamSetupCompletionManifest(
	db: Database,
	input: { candidateRef: string; attemptId: string; completedAt?: string },
): CoordinatorLegacyTeamCompletionManifestV1 {
	const draft = loadDraft(db, input.candidateRef, input.attemptId);
	if (draft.state !== "needs_setup" && draft.state !== "in_progress") {
		fail("team_setup_completion_invalid");
	}
	try {
		inspectLegacyTeamSetupActivation(db, {
			candidateRef: input.candidateRef,
			attemptId: input.attemptId,
		});
	} catch {
		fail("team_setup_completion_invalid");
	}
	return deriveFromDraft(db, draft, input.completedAt ?? new Date().toISOString());
}

export function reconstructLegacyTeamSetupCompletionManifest(
	db: Database,
	input: { candidateRef: string },
): CoordinatorLegacyTeamCompletionManifestV1 {
	const draft = loadCompletedDraft(db, input.candidateRef);
	if (draft.state !== "completed" || !draft.completed_at) fail("team_setup_completion_invalid");
	const manifest = deriveFromDraft(db, draft, draft.completed_at);
	const team = db
		.prepare("SELECT display_name FROM policy_teams WHERE team_id = ? AND status = 'active'")
		.get(manifest.team_id) as { display_name: string } | undefined;
	if (
		!team ||
		team.display_name !== manifest.team.display_name ||
		!isLegacyTeamCandidateSelectable(db, input.candidateRef)
	) {
		fail("team_setup_completion_conflict");
	}
	return manifest;
}

export function validateLegacyTeamSetupCompletionManifest(
	value: unknown,
	input: { coordinatorId: string; groupId: string },
): CoordinatorLegacyTeamCompletionManifestV1 {
	const manifest = validateLegacyTeamSetupCompletionManifestBinding(value, input);
	requireCompletionSnapshotWithinLimits(manifest.device_decisions, manifest.project_mappings);
	const includedIdentityIds = [
		...new Set(
			manifest.device_decisions.flatMap((decision) =>
				decision.identity_id ? [decision.identity_id] : [],
			),
		),
	].toSorted(compareCodepoints);
	const membershipIdentityIds = manifest.memberships.map((membership) => membership.identity_id);
	const expectedRecipientRefs = [
		...new Set(manifest.project_mappings.map((mapping) => mapping.resolved_project_ref)),
	].toSorted(compareCodepoints);
	const recipientRefs = manifest.project_recipients.map(
		(recipient) => recipient.resolved_project_ref,
	);
	if (
		JSON.stringify(membershipIdentityIds) !== JSON.stringify(includedIdentityIds) ||
		JSON.stringify(recipientRefs) !== JSON.stringify(expectedRecipientRefs)
	) {
		fail("team_setup_completion_invalid");
	}
	const expected = manifestDigests(input.coordinatorId, input.groupId, manifest);
	const expectedRevision = digest(
		"legacy-team-completion-policy-revision-v1",
		expected.finish_digest,
	);
	if (
		manifest.candidate_digest !== expected.candidate_digest ||
		manifest.team_digest !== expected.team_digest ||
		manifest.source_digest !== expected.source_digest ||
		manifest.finish_digest !== expected.finish_digest ||
		manifest.access_delta_digest !== expected.access_delta_digest ||
		manifest.team.policy_revision !== expectedRevision
	) {
		fail("team_setup_completion_invalid");
	}
	return manifest;
}

function requireCompletionSnapshotWithinLimits(
	devices: readonly unknown[],
	projects: readonly unknown[],
): void {
	try {
		requireLegacyTeamSetupSnapshotWithinLimits({ devices, projects });
	} catch {
		fail("team_setup_completion_invalid");
	}
}

export function validateLegacyTeamSetupCompletionManifestBinding(
	value: unknown,
	input: { coordinatorId: string; groupId: string },
): CoordinatorLegacyTeamCompletionManifestV1 {
	let manifest: CoordinatorLegacyTeamCompletionManifestV1;
	try {
		manifest = normalizeCoordinatorLegacyTeamCompletionManifest(value);
	} catch {
		fail("team_setup_completion_invalid");
	}
	if (
		manifest.coordinator_id !== input.coordinatorId ||
		manifest.candidate_ref !== legacyTeamCandidateId(input.coordinatorId, input.groupId) ||
		manifest.team_id !== deterministicPolicyTeamId(manifest.candidate_ref)
	) {
		fail("team_setup_completion_invalid");
	}
	return manifest;
}

function resolveManifestProjects(
	db: Database,
	attemptId: string,
	manifest: CoordinatorLegacyTeamCompletionManifestV1,
): Map<string, ResolvedManifestProject> {
	const projects = db
		.prepare(
			`SELECT project_ref, source_project_identity, resolved_project_identity
			 FROM legacy_team_setup_draft_projects WHERE attempt_id = ? ORDER BY project_ref
			 LIMIT ?`,
		)
		.all(attemptId, LEGACY_TEAM_SETUP_MAX_PROJECTS + 1) as DraftProjectRow[];
	if (projects.length > LEGACY_TEAM_SETUP_MAX_PROJECTS) fail("team_setup_completion_invalid");
	let localCandidates: ReturnType<typeof listProjectScopeCandidates>;
	try {
		localCandidates = listProjectScopeCandidates(db, {
			limit: null,
			maxScannedRows: LEGACY_TEAM_SETUP_MAX_PROJECT_CANDIDATE_SCAN_ROWS,
			maxMetadataRows: LEGACY_TEAM_SETUP_MAX_PROJECT_CANDIDATE_METADATA_ROWS,
			excludePeerReceived: true,
		});
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message === "project_scope_candidate_scan_too_large" ||
				error.message === "project_scope_candidate_metadata_too_large")
		) {
			throw new LegacyTeamSetupRosterCapacityError();
		}
		throw error;
	}
	if (localCandidates.length > LEGACY_TEAM_SETUP_MAX_PROJECTS) {
		throw new LegacyTeamSetupRosterCapacityError();
	}
	const identities = [
		...new Set([
			...projects.flatMap((project) => [
				project.source_project_identity,
				...(project.resolved_project_identity ? [project.resolved_project_identity] : []),
			]),
			...localCandidates.map((candidate) => candidate.workspace_identity),
		]),
	].toSorted(compareCodepoints);
	const displayNameByIdentity = new Map(
		localCandidates.map((candidate) => [candidate.workspace_identity, candidate.display_project]),
	);
	const identityByResolvedRef = new Map<string, string>();
	const identityByProjectRef = new Map(
		projects.map((project) => [project.project_ref, project.source_project_identity]),
	);
	for (const identity of identities) {
		for (const mapping of manifest.project_mappings) {
			if (legacyTeamProjectRef(manifest.candidate_ref, identity) === mapping.project_ref) {
				const existingSource = identityByProjectRef.get(mapping.project_ref);
				if (existingSource && existingSource !== identity) fail("team_setup_completion_invalid");
				identityByProjectRef.set(mapping.project_ref, identity);
			}
			if (
				legacyTeamResolvedProjectRef(mapping.project_ref, identity) !== mapping.resolved_project_ref
			) {
				continue;
			}
			const existing = identityByResolvedRef.get(mapping.resolved_project_ref);
			if (existing && existing !== identity) fail("team_setup_completion_invalid");
			identityByResolvedRef.set(mapping.resolved_project_ref, identity);
		}
	}
	const resolved = new Map<string, ResolvedManifestProject>();
	for (const mapping of manifest.project_mappings) {
		const sourceIdentity = identityByProjectRef.get(mapping.project_ref);
		const resolvedIdentity = identityByResolvedRef.get(mapping.resolved_project_ref);
		if (!sourceIdentity || !resolvedIdentity) continue;
		resolved.set(mapping.project_ref, {
			sourceIdentity,
			resolvedIdentity,
			displayName:
				displayNameByIdentity.get(sourceIdentity) ??
				displayNameByIdentity.get(resolvedIdentity) ??
				"Canonical project",
		});
	}
	return resolved;
}

function rewriteDraftFromManifest(
	db: Database,
	draft: DraftRow,
	manifest: CoordinatorLegacyTeamCompletionManifestV1,
	freshRoster: readonly LegacyTeamRosterDeviceSnapshot[],
	preservedTeamDisplayName?: string,
): void {
	db.prepare(
		"UPDATE legacy_team_setup_drafts SET display_name = ?, updated_at = ? WHERE attempt_id = ?",
	).run(
		preservedTeamDisplayName ?? manifest.team.display_name,
		manifest.completed_at,
		draft.attempt_id,
	);
	const draftDeviceIds = db
		.prepare(
			`SELECT device_id FROM legacy_team_setup_draft_devices
			 WHERE attempt_id = ? ORDER BY device_id LIMIT ?`,
		)
		.pluck()
		.all(draft.attempt_id, LEGACY_TEAM_SETUP_MAX_DEVICES + 1) as string[];
	if (draftDeviceIds.length > LEGACY_TEAM_SETUP_MAX_DEVICES) {
		fail("team_setup_completion_invalid");
	}
	const manifestDeviceIds = new Set(
		manifest.device_decisions.map((decision) => decision.device_id),
	);
	const deleteDevice = db.prepare(
		"DELETE FROM legacy_team_setup_draft_devices WHERE attempt_id = ? AND device_id = ?",
	);
	// Local roster additions postdate the winner and carry no canonical review.
	// Removing their draft rows also lets activation revoke setup-owned members
	// and decisions without growing the bounded draft to the union of rosters.
	for (const deviceId of draftDeviceIds) {
		if (!manifestDeviceIds.has(deviceId)) deleteDevice.run(draft.attempt_id, deviceId);
	}
	const updateDevice = db.prepare(
		`UPDATE legacy_team_setup_draft_devices
		 SET display_name = COALESCE(?, display_name), key_fingerprint = ?, enabled = ?, decision = ?, target_identity_id = ?, existing_identity_id = ?,
		     existing_assignment_version = ?, verified_evidence_kind = ?,
		     expected_assignment_kind = ?, expected_assignment_version = ?, updated_at = ?
		 WHERE attempt_id = ? AND device_id = ?`,
	);
	const assignmentForDevice = db.prepare(
		`SELECT identity_id, assignment_version, status FROM identity_devices
		 WHERE device_id = ? LIMIT 1`,
	);
	const assignmentsByDeviceId = new Map(
		manifest.device_decisions.map((decision) => [
			decision.device_id,
			assignmentForDevice.get(decision.device_id) as
				| { identity_id: string; assignment_version: number; status: string }
				| undefined,
		]),
	);
	// Bounded read: a pre-limit draft must be rejected before its Project rows
	// are materialized for label collection.
	const persistedProjects = db
		.prepare(
			`SELECT source_project_identity, source_fingerprint,
			        resolved_project_identity, target_scope_id
			 FROM legacy_team_setup_draft_projects WHERE attempt_id = ? LIMIT ?`,
		)
		.all(draft.attempt_id, LEGACY_TEAM_SETUP_MAX_PROJECTS + 1) as Array<{
		source_project_identity: string;
		source_fingerprint: string;
		resolved_project_identity: string | null;
		target_scope_id: string | null;
	}>;
	if (persistedProjects.length > LEGACY_TEAM_SETUP_MAX_PROJECTS) {
		fail("team_setup_completion_invalid");
	}
	const persistedProjectIds = persistedProjects.flatMap((project) => [
		project.source_project_identity,
		project.source_fingerprint,
		project.resolved_project_identity ?? "",
		project.target_scope_id ?? "",
	]);
	const insertDevice = db.prepare(
		`INSERT INTO legacy_team_setup_draft_devices(
		 attempt_id, device_id, device_ref, key_fingerprint, display_name, enabled,
		 existing_identity_id, existing_assignment_version, verified_evidence_kind,
		 decision, target_identity_id, expected_assignment_kind,
		 expected_assignment_version, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const freshDeviceById = new Map(freshRoster.map((device) => [device.deviceId, device]));
	const forbiddenLabelIds = setupLabelForbiddenIds(
		[
			draft.candidate_id,
			draft.coordinator_id,
			manifest.team_id,
			...manifest.memberships.map((membership) => membership.identity_id),
			...manifest.project_mappings.flatMap((mapping) => [
				mapping.project_ref,
				mapping.resolved_project_ref,
				mapping.scope_id,
			]),
			...persistedProjectIds,
		],
		draft.group_id,
		null,
		freshRoster,
		[],
		manifest.device_decisions.map((decision) => ({
			deviceId: decision.device_id,
			fingerprint: decision.key_fingerprint,
			existingIdentityId: assignmentsByDeviceId.get(decision.device_id)?.identity_id ?? null,
			targetIdentityId: decision.identity_id,
		})),
		[],
	);
	for (const decision of manifest.device_decisions) {
		const assignment = assignmentsByDeviceId.get(decision.device_id);
		const freshDevice = freshDeviceById.get(decision.device_id);
		const displayName = freshDevice
			? safeLabel(freshDevice.displayName, "Canonical device", forbiddenLabelIds)
			: null;
		if (!draftDeviceIds.includes(decision.device_id)) {
			insertDevice.run(
				draft.attempt_id,
				decision.device_id,
				legacyTeamDeviceRef(draft.candidate_id, decision.device_id),
				decision.key_fingerprint,
				displayName ?? "Canonical device",
				decision.enabled ? 1 : 0,
				assignment?.identity_id ?? null,
				assignment?.assignment_version ?? null,
				assignment?.status === "active" ? "active_assignment" : null,
				decision.decision,
				decision.identity_id,
				assignment ? "existing" : "absent",
				assignment?.assignment_version ?? null,
				manifest.completed_at,
			);
		}
		// The coordinator winner is authoritative. Rebase the local CAS evidence
		// onto the current assignment so applying that winner can converge a
		// pre-protocol device rather than preserving its divergent binding.
		updateDevice.run(
			displayName,
			decision.key_fingerprint,
			decision.enabled ? 1 : 0,
			decision.decision,
			decision.identity_id,
			assignment?.identity_id ?? null,
			assignment?.assignment_version ?? null,
			assignment?.status === "active" ? "active_assignment" : null,
			assignment ? "existing" : "absent",
			assignment?.assignment_version ?? null,
			manifest.completed_at,
			draft.attempt_id,
			decision.device_id,
		);
	}
	const resolvedProjects = resolveManifestProjects(db, draft.attempt_id, manifest);
	const localProjectRefs = db
		.prepare(
			`SELECT project_ref FROM legacy_team_setup_draft_projects
			 WHERE attempt_id = ? ORDER BY project_ref LIMIT ?`,
		)
		.pluck()
		.all(draft.attempt_id, LEGACY_TEAM_SETUP_MAX_PROJECTS + 1) as string[];
	if (localProjectRefs.length > LEGACY_TEAM_SETUP_MAX_PROJECTS) {
		fail("team_setup_completion_invalid");
	}
	const deleteProject = db.prepare(
		"DELETE FROM legacy_team_setup_draft_projects WHERE attempt_id = ? AND project_ref = ?",
	);
	// Activation grants every Project left in the draft. Retain only historical
	// mappings supported by this installation's local Project evidence.
	for (const projectRef of localProjectRefs) {
		if (!resolvedProjects.has(projectRef)) deleteProject.run(draft.attempt_id, projectRef);
	}
	const updateProject = db.prepare(
		`UPDATE legacy_team_setup_draft_projects
		 SET resolution_kind = 'explicit', resolved_project_identity = ?, target_scope_id = ?, updated_at = ?
		 WHERE attempt_id = ? AND project_ref = ?`,
	);
	const insertProject = db.prepare(
		`INSERT INTO legacy_team_setup_draft_projects(
		 attempt_id, project_ref, source_project_identity, display_name, source_fingerprint,
		 resolution_kind, resolved_project_identity, target_scope_id, updated_at
		 ) VALUES (?, ?, ?, ?, ?, 'explicit', ?, ?, ?)`,
	);
	for (const mapping of manifest.project_mappings) {
		const resolvedProject = resolvedProjects.get(mapping.project_ref);
		if (!resolvedProject) continue;
		const scope = db
			.prepare(
				`SELECT 1 FROM replication_scopes
				 WHERE scope_id = ? AND coordinator_id = ? AND group_id = ?
				   AND authority_type = 'coordinator' AND status = 'active'`,
			)
			.get(mapping.scope_id, draft.coordinator_id, draft.group_id);
		if (!scope) fail("team_setup_completion_invalid");
		if (!localProjectRefs.includes(mapping.project_ref)) {
			// The canonical manifest is durable evidence for this reconstructed row;
			// no local discovery fingerprint exists when a peer first materializes it.
			insertProject.run(
				draft.attempt_id,
				mapping.project_ref,
				resolvedProject.sourceIdentity,
				safeLabel(resolvedProject.displayName, "Canonical project", forbiddenLabelIds),
				digest("legacy-team-canonical-project-source-v1", mapping),
				resolvedProject.resolvedIdentity,
				mapping.scope_id,
				manifest.completed_at,
			);
		} else {
			updateProject.run(
				resolvedProject.resolvedIdentity,
				mapping.scope_id,
				manifest.completed_at,
				draft.attempt_id,
				mapping.project_ref,
			);
		}
	}
}

function appendResolvedManifestProjects(
	db: Database,
	draft: DraftRow,
	manifest: CoordinatorLegacyTeamCompletionManifestV1,
	resolvedProjects: Map<string, ResolvedManifestProject>,
	projectRefs: readonly string[],
	freshRoster: readonly LegacyTeamRosterDeviceSnapshot[],
): void {
	const existingProjects = db
		.prepare(
			`SELECT project_ref, source_project_identity, source_fingerprint,
			        resolved_project_identity, target_scope_id
			 FROM legacy_team_setup_draft_projects WHERE attempt_id = ? ORDER BY project_ref`,
		)
		.all(draft.attempt_id) as Array<{
		project_ref: string;
		source_project_identity: string;
		source_fingerprint: string;
		resolved_project_identity: string | null;
		target_scope_id: string | null;
	}>;
	const existingRefs = new Set(existingProjects.map((project) => project.project_ref));
	if (
		existingProjects.length + projectRefs.length > LEGACY_TEAM_SETUP_MAX_PROJECTS ||
		projectRefs.some((projectRef) => existingRefs.has(projectRef))
	) {
		fail("team_setup_completion_invalid");
	}
	const mappingsByRef = new Map(
		manifest.project_mappings.map((mapping) => [mapping.project_ref, mapping]),
	);
	const forbiddenLabelIds = setupLabelForbiddenIds(
		[
			draft.candidate_id,
			draft.coordinator_id,
			manifest.team_id,
			...manifest.memberships.map((membership) => membership.identity_id),
			...manifest.project_mappings.flatMap((mapping) => [
				mapping.project_ref,
				mapping.resolved_project_ref,
				mapping.scope_id,
			]),
			...existingProjects.flatMap((project) => [
				project.source_project_identity,
				project.source_fingerprint,
				project.resolved_project_identity ?? "",
				project.target_scope_id ?? "",
			]),
		],
		draft.group_id,
		null,
		freshRoster,
		[],
		[],
		[],
	);
	const insert = db.prepare(
		`INSERT INTO legacy_team_setup_draft_projects(
		 attempt_id, project_ref, source_project_identity, display_name, source_fingerprint,
		 resolution_kind, resolved_project_identity, target_scope_id, updated_at
		 ) VALUES (?, ?, ?, ?, ?, 'explicit', ?, ?, ?)`,
	);
	for (const projectRef of projectRefs) {
		const mapping = mappingsByRef.get(projectRef);
		const resolved = resolvedProjects.get(projectRef);
		if (!mapping || !resolved) fail("team_setup_completion_invalid");
		const scope = db
			.prepare(
				`SELECT 1 FROM replication_scopes
				 WHERE scope_id = ? AND coordinator_id = ? AND group_id = ?
				   AND authority_type = 'coordinator' AND status = 'active'`,
			)
			.get(mapping.scope_id, draft.coordinator_id, draft.group_id);
		if (!scope) fail("team_setup_completion_invalid");
		insert.run(
			draft.attempt_id,
			projectRef,
			resolved.sourceIdentity,
			safeLabel(resolved.displayName, "Canonical project", forbiddenLabelIds),
			digest("legacy-team-canonical-project-source-v1", mapping),
			resolved.resolvedIdentity,
			mapping.scope_id,
			manifest.completed_at,
		);
	}
}

function requireIncludedDeviceEvidence(
	manifest: CoordinatorLegacyTeamCompletionManifestV1,
	freshRoster: readonly LegacyTeamRosterDeviceSnapshot[],
): void {
	if (freshRoster.length > LEGACY_TEAM_SETUP_MAX_DEVICES) fail("team_setup_completion_invalid");
	const freshByDeviceId = new Map(freshRoster.map((device) => [device.deviceId, device]));
	if (freshByDeviceId.size !== freshRoster.length) fail("team_setup_completion_invalid");
	for (const decision of manifest.device_decisions) {
		if (decision.decision !== "included") continue;
		const fresh = freshByDeviceId.get(decision.device_id);
		if (!decision.enabled || !fresh?.enabled || fresh.fingerprint !== decision.key_fingerprint) {
			fail("team_setup_completion_invalid");
		}
	}
}

function quarantineDivergentCompletedPolicy(
	db: Database,
	binding: { candidateRef: string; teamId: string },
): void {
	db.transaction(() => {
		const team = db
			.prepare(
				`SELECT revision FROM policy_teams
				 WHERE team_id = ? AND status = 'active'
				   AND provenance = 'reviewed_team_candidate'`,
			)
			.get(binding.teamId) as { revision: string } | undefined;
		// Repeated containment is a no-op once the active setup-owned policy is gone.
		if (!team) return;
		const now = new Date().toISOString();
		db.prepare(
			`UPDATE policy_teams
			 SET status = 'inactive', migration_state = 'needs_setup', updated_at = ?
			 WHERE team_id = ? AND provenance = 'reviewed_team_candidate'`,
		).run(now, binding.teamId);
		db.prepare(
			`UPDATE project_recipients
			 SET status = 'revoked', policy_revision = ?, migration_state = 'needs_setup', updated_at = ?
			 WHERE recipient_kind = 'team' AND recipient_id = ?
			   AND provenance = 'reviewed_team_setup' AND status = 'active'`,
		).run(team.revision, now, binding.teamId);
		db.prepare(
			`UPDATE legacy_team_setup_drafts SET finish_digest = NULL
			 WHERE candidate_id = ? AND completed_team_id = ? AND state = 'completed'`,
		).run(binding.candidateRef, binding.teamId);
	}).immediate();
}

export async function containLegacyTeamSetupCompletionConflict(
	db: Database,
	input: { coordinatorId: string; groupId: string },
): Promise<void> {
	const candidateRef = legacyTeamCandidateId(input.coordinatorId, input.groupId);
	const teamId = deterministicPolicyTeamId(candidateRef);
	await serializeRecipientPolicyTeamMutation(db, teamId, () =>
		serializeRecipientPolicyCoordinatorGroupMutation(db, input.groupId, () => {
			quarantineDivergentCompletedPolicy(db, { candidateRef, teamId });
			return Promise.resolve();
		}),
	);
}

function loadCompletedActivationResult(
	db: Database,
	draft: DraftRow,
): LegacyTeamSetupActivationResultV1 {
	if (!draft.finish_digest) fail("team_setup_completion_invalid");
	const row = db
		.prepare(
			`SELECT response_json FROM legacy_team_setup_completions
			 WHERE candidate_ref = ? AND attempt_id = ? AND finish_digest = ?`,
		)
		.get(draft.candidate_id, draft.attempt_id, draft.finish_digest) as
		| { response_json: string }
		| undefined;
	if (!row) fail("team_setup_completion_invalid");
	return JSON.parse(row.response_json) as LegacyTeamSetupActivationResultV1;
}

function equivalentCompletionPolicyFacts(
	left: CoordinatorLegacyTeamCompletionManifestV1,
	right: CoordinatorLegacyTeamCompletionManifestV1,
	resolvableProjectRefs: ReadonlySet<string>,
): boolean {
	const applicationFacts = (manifest: CoordinatorLegacyTeamCompletionManifestV1) => ({
		version: manifest.version,
		candidate_ref: manifest.candidate_ref,
		team_id: manifest.team_id,
		candidate_digest: manifest.candidate_digest,
		device_eligibility_mode: manifest.team.device_eligibility_mode,
		device_decisions: manifest.device_decisions,
		memberships: manifest.memberships,
	});
	if (JSON.stringify(applicationFacts(left)) !== JSON.stringify(applicationFacts(right))) {
		return false;
	}
	const leftProjectRefs = new Set(left.project_mappings.map((mapping) => mapping.project_ref));
	const rightMappings = new Map(
		right.project_mappings.map((mapping) => [mapping.project_ref, mapping]),
	);
	const rightRecipients = new Map(
		right.project_recipients.map((recipient) => [recipient.resolved_project_ref, recipient]),
	);
	return (
		left.project_mappings.every(
			(mapping) =>
				JSON.stringify(rightMappings.get(mapping.project_ref)) === JSON.stringify(mapping),
		) &&
		left.project_recipients.every(
			(recipient) =>
				JSON.stringify(rightRecipients.get(recipient.resolved_project_ref)) ===
				JSON.stringify(recipient),
		) &&
		right.project_mappings.every(
			(mapping) =>
				leftProjectRefs.has(mapping.project_ref) || !resolvableProjectRefs.has(mapping.project_ref),
		)
	);
}

/**
 * A retry that re-applies the same policy facts onto an already-completed draft
 * must keep that draft's completion key: deriving a fresh preview from the
 * materialized policy would rotate the key on every retry and invalidate the
 * originating device's exact-replay token. A divergent manifest gets a new key
 * so stale tokens for the superseded policy fail closed.
 */
function retainedCompletionKeyForExactReapply(
	db: Database,
	draft: DraftRow,
	manifest: CoordinatorLegacyTeamCompletionManifestV1,
): string | undefined {
	if (!draft.finish_digest) return undefined;
	let current: CoordinatorLegacyTeamCompletionManifestV1;
	try {
		current = deriveFromDraft(db, draft, manifest.completed_at);
	} catch {
		return undefined;
	}
	const manifestProjectRefs = new Set(
		manifest.project_mappings.map((mapping) => mapping.project_ref),
	);
	return equivalentCompletionPolicyFacts(current, manifest, manifestProjectRefs)
		? draft.finish_digest
		: undefined;
}

export function areLegacyTeamSetupCompletionPolicyFactsAdditivelyCompatible(
	local: CoordinatorLegacyTeamCompletionManifestV1,
	canonical: CoordinatorLegacyTeamCompletionManifestV1,
): boolean {
	return equivalentCompletionPolicyFacts(local, canonical, new Set());
}

async function applyCompletionManifest(
	db: Database,
	input: ApplyCompletionManifestInput,
): Promise<{
	manifest: CoordinatorLegacyTeamCompletionManifestV1;
	result: LegacyTeamSetupActivationResultV1;
}> {
	const boundManifest = validateLegacyTeamSetupCompletionManifestBinding(input.manifest, input);
	const apply = async () => {
		let additiveConvergenceOnly = false;
		// Set while the local completion is additively compatible with the
		// winner: a failure there must preserve the active policy, whereas a
		// failed full replacement of divergent policy must quarantine it.
		let compatibleLocalPolicy = false;
		try {
			const manifest = validateLegacyTeamSetupCompletionManifest(boundManifest, input);
			return db
				.transaction(() => {
					let preservedTeamMetadata: { displayName: string; policyRevision: string } | null = null;
					const draft = loadDraft(db, manifest.candidate_ref);
					if (input.expectedDraftManifest) {
						let currentManifest: CoordinatorLegacyTeamCompletionManifestV1;
						try {
							currentManifest = deriveFromDraft(
								db,
								draft,
								input.expectedDraftManifest.completed_at,
							);
						} catch {
							throw new LegacyTeamSetupConfirmationStaleError();
						}
						if (
							canonicalCoordinatorLegacyTeamCompletionManifestJson(currentManifest) !==
							canonicalCoordinatorLegacyTeamCompletionManifestJson(input.expectedDraftManifest)
						) {
							throw new LegacyTeamSetupConfirmationStaleError();
						}
					}
					const hasCompletedDraft = draft.state === "completed";
					requireIncludedDeviceEvidence(manifest, input.freshRoster);
					if (hasCompletedDraft) {
						try {
							const local = reconstructLegacyTeamSetupCompletionManifest(db, {
								candidateRef: manifest.candidate_ref,
							});
							if (
								canonicalCoordinatorLegacyTeamCompletionManifestJson(local) ===
								canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest)
							) {
								return { manifest, result: loadCompletedActivationResult(db, draft) };
							}
							if (equivalentCompletionPolicyFacts(local, manifest, new Set())) {
								compatibleLocalPolicy = true;
								const additiveResolvedProjects = resolveManifestProjects(
									db,
									draft.attempt_id,
									manifest,
								);
								if (
									equivalentCompletionPolicyFacts(
										local,
										manifest,
										new Set(additiveResolvedProjects.keys()),
									)
								) {
									return { manifest, result: loadCompletedActivationResult(db, draft) };
								}
								additiveConvergenceOnly = true;
								const localProjectRefs = new Set(
									local.project_mappings.map((mapping) => mapping.project_ref),
								);
								const newProjectRefs = manifest.project_mappings
									.map((mapping) => mapping.project_ref)
									.filter(
										(projectRef) =>
											!localProjectRefs.has(projectRef) && additiveResolvedProjects.has(projectRef),
									);
								appendResolvedManifestProjects(
									db,
									draft,
									manifest,
									additiveResolvedProjects,
									newProjectRefs,
									input.freshRoster,
								);
								applyAdditiveCanonicalLegacyTeamSetupProjectsInTransaction(db, {
									candidateRef: manifest.candidate_ref,
									attemptId: draft.attempt_id,
									teamId: manifest.team_id,
									projectRefs: newProjectRefs,
									completedAt: manifest.completed_at,
								});
								return { manifest, result: loadCompletedActivationResult(db, draft) };
							}
						} catch (error) {
							if (additiveConvergenceOnly) {
								throw new LegacyTeamSetupAdditiveConvergenceError(error);
							}
							if (!(error instanceof LegacyTeamSetupCompletionManifestError)) throw error;
							// Falling through replaces the local completion outright.
							compatibleLocalPolicy = false;
						}
					}
					if (
						draft.coordinator_id !== input.coordinatorId ||
						draft.group_id !== input.groupId ||
						(!hasCompletedDraft &&
							draft.state !== "needs_setup" &&
							draft.state !== "in_progress" &&
							draft.state !== "stale")
					) {
						fail("team_setup_completion_invalid");
					}
					{
						// A proven Team/coordinator rename survives both a replacement draft
						// and a divergent winner re-applied over the completed draft.
						const team = db
							.prepare(
								"SELECT display_name, revision FROM policy_teams WHERE team_id = ? AND status = 'active'",
							)
							.get(manifest.team_id) as { display_name: string; revision: string } | undefined;
						const hasRenamedCompletedLink = team
							? Boolean(
									db
										.prepare(
											`SELECT 1 FROM legacy_team_setup_drafts AS draft
											 JOIN legacy_team_setup_completions AS completion
											   ON completion.attempt_id = draft.attempt_id
											  AND completion.finish_digest = draft.finish_digest
											  AND completion.candidate_ref = draft.candidate_id
											  AND completion.completed_team_id = draft.completed_team_id
											 WHERE draft.candidate_id = ? AND draft.state = 'completed'
											   AND draft.completed_team_id = ? AND draft.display_name = ? LIMIT 1`,
										)
										.pluck()
										.get(manifest.candidate_ref, manifest.team_id, team.display_name),
								)
							: false;
						// A completed draft always links to its own completion, so for the
						// re-apply path the rename must additionally be proven by a
						// rename-minted revision; a pre-protocol local name is superseded.
						const renameProven = hasCompletedDraft
							? Boolean(team && isRecipientPolicyTeamRenameRevision(team.revision))
							: true;
						if (
							team &&
							team.display_name !== manifest.team.display_name &&
							hasRenamedCompletedLink &&
							renameProven
						) {
							// Preserve the proven rename, but advance the revision because this
							// replacement apply may change policy facts from the linked completion.
							preservedTeamMetadata = {
								displayName: team.display_name,
								policyRevision: manifest.team.policy_revision,
							};
						}
					}
					const retainedCompletionKey = hasCompletedDraft
						? retainedCompletionKeyForExactReapply(db, draft, manifest)
						: undefined;
					rewriteDraftFromManifest(
						db,
						draft,
						manifest,
						input.freshRoster,
						preservedTeamMetadata?.displayName,
					);
					const result = applyCanonicalLegacyTeamSetupActivationInTransaction(db, {
						candidateRef: manifest.candidate_ref,
						attemptId: draft.attempt_id,
						policyRevision: preservedTeamMetadata?.policyRevision ?? manifest.team.policy_revision,
						completedAt: manifest.completed_at,
						completionKey: retainedCompletionKey,
						allowCompletedDraft: hasCompletedDraft,
						allowStaleDraft: draft.state === "stale",
					});
					return { manifest, result };
				})
				.immediate();
		} catch (error) {
			// A failed canonical apply must contain any active setup-owned policy,
			// including one left by a superseded completed draft. Resolution
			// capacity failures count: retrying cannot converge divergent policy.
			if (
				!additiveConvergenceOnly &&
				!compatibleLocalPolicy &&
				(error instanceof LegacyTeamSetupCompletionManifestError ||
					error instanceof LegacyTeamSetupActivationError ||
					error instanceof LegacyTeamSetupRosterCapacityError)
			) {
				quarantineDivergentCompletedPolicy(db, {
					candidateRef: boundManifest.candidate_ref,
					teamId: boundManifest.team_id,
				});
			}
			throw error;
		}
	};
	if (input.recipientPolicyLocksHeld) return apply();
	return serializeRecipientPolicyPublicationMutation(db, () =>
		serializeRecipientPolicyTeamMutation(db, boundManifest.team_id, () =>
			serializeRecipientPolicyCoordinatorGroupMutation(db, input.groupId, apply),
		),
	);
}

/** Applies a manifest obtained from an authenticated coordinator transport. */
export async function applyLegacyTeamSetupCompletionManifest(
	db: Database,
	input: ApplyCompletionManifestInput,
): Promise<CoordinatorLegacyTeamCompletionManifestV1> {
	return (await applyCompletionManifest(db, input)).manifest;
}

/** Applies a manifest obtained from an authenticated coordinator transport. */
export async function applyLegacyTeamSetupCompletionManifestAndReturnActivation(
	db: Database,
	input: ApplyCompletionManifestInput,
): Promise<LegacyTeamSetupActivationResultV1> {
	return (await applyCompletionManifest(db, input)).result;
}
