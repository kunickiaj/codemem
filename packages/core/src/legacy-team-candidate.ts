import type { Database } from "./db.js";
import {
	type ListLegacyRecipientPolicyProjectionsOptions,
	listLegacyTeamProjectEvidence,
	normalizeLegacyProjectMappingIdentity,
	selectedProjectScopeMappings,
} from "./legacy-recipient-policy-projection.js";
import { planLegacyTeamAttempt } from "./legacy-team-attempt-lifecycle.js";
import {
	isFilesystemRootProjectIdentity,
	isMigratableLegacyTeamProjectIdentity,
} from "./legacy-team-project-policy.js";
import {
	type LegacyTeamSetupDraftState,
	type LegacyTeamSetupDraftView,
	type LegacyTeamSetupProjectInput,
	legacyTeamProjectionFingerprint,
	refreshLegacyTeamSetupDraft,
	refreshLegacyTeamSetupDraftLabels,
} from "./legacy-team-setup-draft.js";
import {
	requireLegacyTeamSetupEffectiveDevicesWithinLimit,
	requireLegacyTeamSetupReachableDevicesWithinLimit,
	requireLegacyTeamSetupSnapshotWithinLimits,
} from "./legacy-team-setup-limits.js";
import { derivePolicyTeamDeviceEligibility } from "./policy-team-device-eligibility.js";
import {
	compareCodepoints,
	deterministicPolicyTeamId,
	INVITE_DECISION_PROVENANCES,
	isStrictRecipientPolicyId,
	legacyTeamCandidateId,
	legacyTeamProjectRef,
	legacyTeamRosterFingerprint,
	recipientPolicyDigest,
} from "./recipient-policy-identifiers.js";
import {
	deriveRecipientPolicyEffectiveDevicesFromDatabase,
	type StrictRecipientPolicyEffectiveDeviceDerivation,
} from "./recipient-policy-reconciliation.js";

export interface LegacyTeamRosterDeviceSnapshot {
	deviceId: string;
	fingerprint: string;
	displayName: string;
	enabled: boolean;
	labelRedactionIds?: readonly string[];
}

export interface LegacyTeamConfiguredGroupSnapshot {
	coordinatorId: string;
	groupId: string;
	displayName: string;
	devices: LegacyTeamRosterDeviceSnapshot[];
}

export type LegacyTeamCandidateStatus = "needs_setup" | "in_progress" | "stale" | "ready";

export interface LegacyTeamCandidateView {
	candidateRef: string;
	displayName: string;
	status: LegacyTeamCandidateStatus;
	deviceCount: number;
	projectCount: number;
	unresolvedDeviceCount: number;
	unresolvedProjectCount: number;
}

export interface DiscoverLegacyTeamCandidatesOptions {
	projection: ListLegacyRecipientPolicyProjectionsOptions;
	groups: LegacyTeamConfiguredGroupSnapshot[];
	now?: string;
}

interface DraftFreshnessRow {
	attempt_id: string;
	coordinator_id: string;
	group_id: string;
	state: LegacyTeamSetupDraftState;
	roster_fingerprint: string;
	projection_fingerprint: string;
	completed_team_id: string | null;
}

/**
 * A coordinator snapshot can carry duplicate enrollment rows for one device;
 * the draft schema keys devices by `(attempt_id, device_id)`, so an
 * un-deduplicated roster would double-count the fingerprint and abort the
 * whole discovery pass with a raw constraint error. Exact duplicates collapse
 * (first row wins for display text), but rows that disagree on
 * security-relevant evidence — key fingerprint or enabled state — are a
 * roster conflict: silently picking one would authorize review against
 * arbitrary evidence, so the candidate is rejected instead (`null`).
 */
function dedupedRosterDevices(
	devices: LegacyTeamRosterDeviceSnapshot[],
): LegacyTeamRosterDeviceSnapshot[] | null {
	const byId = new Map<string, LegacyTeamRosterDeviceSnapshot>();
	for (const device of devices) {
		if (
			!isStrictRecipientPolicyId(device.deviceId) ||
			!isStrictRecipientPolicyId(device.fingerprint)
		) {
			return null;
		}
		const existing = byId.get(device.deviceId);
		if (!existing) {
			byId.set(device.deviceId, device);
			continue;
		}
		if (existing.fingerprint !== device.fingerprint || existing.enabled !== device.enabled) {
			return null;
		}
		byId.set(device.deviceId, {
			...existing,
			labelRedactionIds: [
				...new Set([...(existing.labelRedactionIds ?? []), ...(device.labelRedactionIds ?? [])]),
			],
		});
	}
	return [...byId.values()];
}

interface EffectiveGroupSnapshot {
	candidateId: string;
	coordinatorId: string;
	groupId: string;
	displayName: string;
	devices: LegacyTeamRosterDeviceSnapshot[];
}

function rosterDevicesAgree(
	left: LegacyTeamRosterDeviceSnapshot[],
	right: LegacyTeamRosterDeviceSnapshot[],
): boolean {
	if (left.length !== right.length) return false;
	const byId = new Map(left.map((device) => [device.deviceId, device]));
	return right.every((device) => {
		const other = byId.get(device.deviceId);
		return (
			other != null && other.fingerprint === device.fingerprint && other.enabled === device.enabled
		);
	});
}

function mergeRosterLabelRedactionIds(
	left: LegacyTeamRosterDeviceSnapshot[],
	right: LegacyTeamRosterDeviceSnapshot[],
): LegacyTeamRosterDeviceSnapshot[] {
	const rightById = new Map(right.map((device) => [device.deviceId, device]));
	return left.map((device) => ({
		...device,
		labelRedactionIds: [
			...new Set([
				...(device.labelRedactionIds ?? []),
				...(rightById.get(device.deviceId)?.labelRedactionIds ?? []),
			]),
		],
	}));
}

/**
 * A candidate may appear under multiple configured group snapshots. Exact
 * duplicates merge (first snapshot wins for display text), but snapshots that
 * disagree on security-relevant roster evidence — device membership, key
 * fingerprints, or enabled states — are contradictory evidence: silently
 * accepting whichever appears first would make the draft and its security
 * fingerprint depend on input ordering, so the candidate is rejected instead.
 */
function effectiveGroupSnapshots(groups: LegacyTeamConfiguredGroupSnapshot[]): {
	snapshots: EffectiveGroupSnapshot[];
	conflictedCandidateIds: Set<string>;
} {
	const byCandidate = new Map<string, EffectiveGroupSnapshot>();
	const conflictedCandidateIds = new Set<string>();
	for (const group of groups) {
		const { coordinatorId, groupId } = group;
		if (!isStrictRecipientPolicyId(coordinatorId) || !isStrictRecipientPolicyId(groupId)) continue;
		const candidateId = legacyTeamCandidateId(coordinatorId, groupId);
		const devices = dedupedRosterDevices(group.devices);
		if (!devices) {
			conflictedCandidateIds.add(candidateId);
			continue;
		}
		const existing = byCandidate.get(candidateId);
		if (!existing) {
			byCandidate.set(candidateId, {
				candidateId,
				coordinatorId,
				groupId,
				displayName: group.displayName,
				devices,
			});
			continue;
		}
		if (!rosterDevicesAgree(existing.devices, devices)) {
			conflictedCandidateIds.add(candidateId);
		} else {
			existing.devices = mergeRosterLabelRedactionIds(existing.devices, devices);
		}
	}
	for (const candidateId of conflictedCandidateIds) byCandidate.delete(candidateId);
	return { snapshots: [...byCandidate.values()], conflictedCandidateIds };
}

function activeAssignmentIdentityLookup(db: Database): (deviceId: string) => string | null {
	const statement = db
		.prepare(
			`SELECT identity_id FROM identity_devices
			 WHERE device_id = ? AND status = 'active' LIMIT 1`,
		)
		.pluck();
	return (deviceId) => (statement.get(deviceId) as string | undefined) ?? null;
}

function projectInventory(
	db: Database,
	candidateId: string,
	evidence: ReturnType<typeof listLegacyTeamProjectEvidence>,
): LegacyTeamSetupProjectInput[] {
	const activeCandidateScopeIds = (
		db
			.prepare(
				`SELECT scope_id, coordinator_id, group_id FROM replication_scopes
				 WHERE authority_type = 'coordinator' AND coordinator_id IS NOT NULL
				   AND group_id IS NOT NULL AND status = 'active'`,
			)
			.all() as Array<{ scope_id: string; coordinator_id: string; group_id: string }>
	)
		.filter((scope) => legacyTeamCandidateId(scope.coordinator_id, scope.group_id) === candidateId)
		.map((scope) => scope.scope_id);
	return evidence
		.filter(
			(project) =>
				isMigratableLegacyTeamProjectIdentity(project.project.canonicalIdentity, db) &&
				project.teamCandidateIds.includes(candidateId),
		)
		.map((project) => {
			const sourceProjectIdentity = project.project.canonicalIdentity;
			const evidencedTargetScopeId = project.teamCandidateScopes.find(
				(candidate) => candidate.teamCandidateId === candidateId,
			)?.targetScopeId;
			const targetScopeId =
				evidencedTargetScopeId === undefined && activeCandidateScopeIds.length === 1
					? activeCandidateScopeIds[0]
					: evidencedTargetScopeId;
			return {
				projectRef: legacyTeamProjectRef(candidateId, sourceProjectIdentity),
				sourceProjectIdentity,
				displayName: project.project.displayName,
				sourceFingerprint: project.sourceFingerprint,
				deterministicProjectIdentity: project.deterministicProjectIdentity,
				targetScopeId,
			};
		})
		.toSorted((left, right) => compareCodepoints(left.projectRef, right.projectRef));
}

/**
 * A completed attempt's Project inventory is compared by identity, not by raw
 * fingerprint equality: activation materializes explicit resolutions (an
 * `unmapped:` source mapped to its reviewed target), which legitimately
 * changes the recomputed evidence without changing what the user authorized.
 * A current Project is accounted for when it matches a completion-bound row's
 * source or resolved identity. Other inventory changes make the completion
 * incompatible for legacy reconciliation diagnostics, but never reopen the
 * terminal migration. Canonical row integrity is separately checked by
 * `isCompatibleReadyTeam` while deciding whether reconciliation is safe.
 */
function isRetiredFilesystemRootProjectRow(row: {
	source_project_identity: string;
	resolved_project_identity: string | null;
}): boolean {
	return isFilesystemRootProjectIdentity(
		row.resolved_project_identity ?? row.source_project_identity,
	);
}

function completedInventoryCompatible(
	db: Database,
	attemptId: string,
	projects: LegacyTeamSetupProjectInput[],
): boolean {
	const rows = db
		.prepare(
			`SELECT source_project_identity, resolved_project_identity
			 FROM legacy_team_setup_draft_projects WHERE attempt_id = ?`,
		)
		.all(attemptId) as Array<{
		source_project_identity: string;
		resolved_project_identity: string | null;
	}>;
	const reviewableRows = rows.filter((row) => !isRetiredFilesystemRootProjectRow(row));
	const reviewedIdentities = new Set<string>();
	for (const row of reviewableRows) {
		reviewedIdentities.add(normalizeLegacyProjectMappingIdentity(row.source_project_identity));
		if (row.resolved_project_identity) {
			reviewedIdentities.add(normalizeLegacyProjectMappingIdentity(row.resolved_project_identity));
		}
	}
	const currentIdentities = new Set(
		projects.map((project) => normalizeLegacyProjectMappingIdentity(project.sourceProjectIdentity)),
	);
	for (const identity of currentIdentities) {
		if (!reviewedIdentities.has(identity)) return false;
	}
	for (const row of reviewableRows) {
		const sourceIdentity = normalizeLegacyProjectMappingIdentity(row.source_project_identity);
		const materialized = normalizeLegacyProjectMappingIdentity(
			row.resolved_project_identity ?? row.source_project_identity,
		);
		if (!currentIdentities.has(materialized) && !currentIdentities.has(sourceIdentity)) {
			return false;
		}
	}
	return true;
}

function currentDraftRow(db: Database, candidateId: string): DraftFreshnessRow | null {
	return (
		(db
			.prepare(
				`SELECT attempt_id, coordinator_id, group_id, state, roster_fingerprint,
				        projection_fingerprint, completed_team_id
				 FROM legacy_team_setup_drafts
				 WHERE candidate_id = ?
				 ORDER BY rowid DESC LIMIT 1`,
			)
			.get(candidateId) as DraftFreshnessRow | undefined) ?? null
	);
}

function canonicalCompletedDraftRow(db: Database, candidateId: string): DraftFreshnessRow | null {
	return (
		(db
			.prepare(
				`SELECT draft.attempt_id, draft.coordinator_id, draft.group_id, draft.state,
				        draft.roster_fingerprint, draft.projection_fingerprint,
				        draft.completed_team_id
				 FROM legacy_team_setup_drafts AS draft
				 JOIN policy_teams AS team ON team.team_id = draft.completed_team_id
				 WHERE draft.candidate_id = ? AND draft.state = 'completed'
				   AND draft.completed_team_id = ? AND team.status = 'active'
				   AND team.provenance = 'reviewed_team_candidate'
				   AND team.migration_state = 'completed'
				 ORDER BY draft.rowid DESC LIMIT 1`,
			)
			.get(candidateId, deterministicPolicyTeamId(candidateId)) as DraftFreshnessRow | undefined) ??
		null
	);
}

/**
 * A completed setup is Ready only while every canonical row it committed still
 * holds: the Team header, each included device's assignment, decision, and
 * membership, and every confirmed Project mapping and recipient edge. Checking
 * the header alone would keep advertising Ready while authoritative
 * eligibility already denies the Team's devices.
 */
function isCompatibleReadyTeam(
	db: Database,
	candidateId: string,
	draftRow: DraftFreshnessRow,
	rosterFingerprint: string,
	options: { allowMissingSetupRecipients?: boolean } = {},
): boolean {
	const { attempt_id: attemptId, completed_team_id: completedTeamId } = draftRow;
	const expectedTeamId = deterministicPolicyTeamId(candidateId);
	if (completedTeamId !== expectedTeamId) return false;
	// Confirmed mappings are bound to their completion-reviewed target scopes.
	// A group may expose multiple active scopes (for example per-Project
	// boundaries), but moving a mapping between them is still drift. Scopes are
	// only required when the completed draft has Project rows to validate: a
	// configured group with no displayed Projects has no mapping whose scope
	// could drift, so its completion stays Ready without a local scope row.
	const completionProjectRows = (
		db
			.prepare(
				`SELECT source_project_identity, resolved_project_identity, target_scope_id
				 FROM legacy_team_setup_draft_projects WHERE attempt_id = ?`,
			)
			.all(attemptId) as Array<{
			source_project_identity: string;
			resolved_project_identity: string | null;
			target_scope_id: string | null;
		}>
	).filter((row) => !isRetiredFilesystemRootProjectRow(row));
	const setupScopeIds = db
		.prepare(
			`SELECT scope_id FROM replication_scopes
			 WHERE coordinator_id = ? AND group_id = ? AND authority_type = 'coordinator'
			   AND status = 'active'`,
		)
		.pluck()
		.all(draftRow.coordinator_id, draftRow.group_id) as string[];
	if (completionProjectRows.length > 0 && setupScopeIds.length === 0) return false;
	const team = db
		.prepare(
			`SELECT status, device_eligibility_mode, source_fingerprint
			 FROM policy_teams WHERE team_id = ? LIMIT 1`,
		)
		.get(completedTeamId) as
		| { status: string; device_eligibility_mode: string; source_fingerprint: string }
		| undefined;
	if (
		team?.status !== "active" ||
		team.device_eligibility_mode !== "reviewed_allowlist" ||
		team.source_fingerprint !== rosterFingerprint
	) {
		return false;
	}
	const membershipRows = db
		.prepare(
			`SELECT identity_id, status FROM policy_team_memberships
			 WHERE team_id = ?`,
		)
		.all(completedTeamId) as Array<{ identity_id: string; status: string }>;
	const deviceRows = db
		.prepare(
			`SELECT device_id, decision, target_identity_id
			 FROM legacy_team_setup_draft_devices WHERE attempt_id = ?`,
		)
		.all(attemptId) as Array<{
		device_id: string;
		decision: string;
		target_identity_id: string | null;
	}>;
	// The canonical decision set must equal the completion-bound set exactly:
	// a decision row added after completion for a device outside the completed
	// draft could grant unreviewed access while discovery still shows Ready.
	// Invite-owned decisions are the one sanctioned addition — activation
	// deliberately preserves them — so they stay compatible with Ready.
	const expectedDecisionDeviceIds = new Set(
		deviceRows
			.filter((device) => device.decision === "included" || device.decision === "excluded")
			.map((device) => device.device_id),
	);
	const canonicalDecisions = db
		.prepare(
			`SELECT device_id, provenance, decision, assignment_version
			 FROM policy_team_device_decisions WHERE team_id = ?`,
		)
		.all(completedTeamId) as Array<{
		device_id: string;
		provenance: string;
		decision: string;
		assignment_version: number;
	}>;
	const identities = db
		.prepare(
			`SELECT actor.actor_id, actor.status, actor.merged_into_actor_id
			 FROM actors AS actor
			 JOIN policy_team_memberships AS membership ON membership.identity_id = actor.actor_id
			 WHERE membership.team_id = ?`,
		)
		.all(completedTeamId) as Array<{
		actor_id: string;
		status: string;
		merged_into_actor_id: string | null;
	}>;
	const identityDevices = db
		.prepare(
			`SELECT device.identity_id, device.device_id, device.status, device.assignment_version
			 FROM identity_devices AS device
			 JOIN policy_team_memberships AS membership ON membership.identity_id = device.identity_id
			 WHERE membership.team_id = ?`,
		)
		.all(completedTeamId) as Array<{
		identity_id: string;
		device_id: string;
		status: string;
		assignment_version: number;
	}>;
	const eligibility = derivePolicyTeamDeviceEligibility({
		teamId: completedTeamId,
		mode: team.device_eligibility_mode,
		memberships: membershipRows.map((row) => ({
			identityId: row.identity_id,
			status: row.status,
		})),
		identities: identities.map((row) => ({
			identityId: row.actor_id,
			status: row.status,
			mergedIntoIdentityId: row.merged_into_actor_id,
		})),
		devices: identityDevices.map((row) => ({
			identityId: row.identity_id,
			deviceId: row.device_id,
			status: row.status,
			assignmentVersion: row.assignment_version,
		})),
		decisions: canonicalDecisions.map((row) => ({
			deviceId: row.device_id,
			decision: row.decision,
			assignmentVersion: row.assignment_version,
		})),
	});
	if (eligibility.status === "blocked") return false;
	const eligibleDeviceIds = new Set(eligibility.eligibleDeviceIds);
	const decisionsByDeviceId = new Map(canonicalDecisions.map((row) => [row.device_id, row]));
	const expectedEffectiveDevices = new Map<string, string>();
	const activeAssignment = db.prepare(
		`SELECT identity_id, assignment_version FROM identity_devices
		 WHERE device_id = ? AND status = 'active' LIMIT 1`,
	);
	const hasUnexplainedDecision = canonicalDecisions.some((row) => {
		if (expectedDecisionDeviceIds.has(row.device_id)) return false;
		if (!(INVITE_DECISION_PROVENANCES as readonly string[]).includes(row.provenance)) return true;
		// An unresolved invite is review work, not a compatible completion.
		if (!["included", "excluded"].includes(row.decision)) return true;
		if (row.decision === "excluded") return false;
		// Invite-owned decisions can precede canonical Team membership. Their
		// completion binding is therefore the live assignment version rather
		// than membership-derived eligibility.
		const liveAssignment = activeAssignment.get(row.device_id) as
			| { assignment_version: number }
			| undefined;
		return !liveAssignment || liveAssignment.assignment_version !== row.assignment_version;
	});
	if (hasUnexplainedDecision) return false;
	for (const device of deviceRows) {
		const decision = decisionsByDeviceId.get(device.device_id);
		// Excluded and removed reviews must also hold canonically: a decision
		// row drifting to `included` could grant access contrary to the review.
		if (device.decision === "excluded") {
			if (decision?.decision !== "excluded") return false;
			continue;
		}
		if (device.decision === "removed") {
			// A reviewed removal retires the device's access. A surviving
			// invite-owned decision is sanctioned only in its settled
			// non-granting state (activation settles them to `excluded`): an
			// `included` decision would keep granting Project access to the
			// removed device through reviewed-allowlist eligibility while
			// discovery reports Ready. Any other surviving decision
			// contradicts the reviewed removal.
			if (
				decision &&
				!(
					(INVITE_DECISION_PROVENANCES as readonly string[]).includes(decision.provenance) &&
					decision.decision === "excluded"
				)
			) {
				return false;
			}
			continue;
		}
		if (device.decision === "included" && !device.target_identity_id) return false;
		if (device.decision !== "included") continue;
		const assignment = activeAssignment.get(device.device_id) as
			| { identity_id: string }
			| undefined;
		if (!assignment || assignment.identity_id !== device.target_identity_id) return false;
		if (decision?.decision !== "included" || !eligibleDeviceIds.has(device.device_id)) return false;
		expectedEffectiveDevices.set(device.device_id, device.target_identity_id);
	}
	// Merged resolutions map several confirmed source patterns onto one
	// canonical identity; selection can pick only one of those mappings. Keep
	// each source's completion-bound target so the selected pattern is checked
	// against its own reviewed scope rather than another merged source's scope.
	const confirmedProjectsByResolved = new Map<string, Map<string, string | null>>();
	for (const project of completionProjectRows) {
		if (!project.resolved_project_identity) return false;
		const sources =
			confirmedProjectsByResolved.get(project.resolved_project_identity) ??
			new Map<string, string | null>();
		sources.set(project.source_project_identity, project.target_scope_id);
		confirmedProjectsByResolved.set(project.resolved_project_identity, sources);
	}
	// Several confirmed sources may resolve to the same canonical Project. Keep
	// the expensive live-policy derivation scoped to this compatibility check so
	// those sources share one result without retaining authorization state across
	// calls that may observe later membership, decision, or assignment changes.
	const effectiveDevicesByProject = new Map<
		string,
		StrictRecipientPolicyEffectiveDeviceDerivation
	>();
	const activeTeamRecipient = db.prepare(
		`SELECT 1 FROM project_recipients
		 WHERE canonical_project_identity = ? AND recipient_kind = 'team'
		   AND recipient_id = ? AND status = 'active' LIMIT 1`,
	);
	const selectedMappings = selectedProjectScopeMappings(db, [
		...confirmedProjectsByResolved.keys(),
	]);
	for (const project of completionProjectRows) {
		const resolvedIdentity = project.resolved_project_identity as string;
		const recipientActive = activeTeamRecipient.get(resolvedIdentity, completedTeamId);
		if (!recipientActive && !options.allowMissingSetupRecipients) return false;
		let effectiveDevices = effectiveDevicesByProject.get(resolvedIdentity);
		if (!effectiveDevices) {
			effectiveDevices = deriveRecipientPolicyEffectiveDevicesFromDatabase(db, resolvedIdentity);
			effectiveDevicesByProject.set(resolvedIdentity, effectiveDevices);
		}
		// Missing this Team's edge cannot excuse unrelated malformed or dangling
		// recipients on the same Project. Reconciliation must never commit a new
		// grant that the strict post-write readiness derivation would reject.
		if (effectiveDevices.status === "blocked") return false;
		if (recipientActive) {
			for (const [deviceId, identityId] of expectedEffectiveDevices) {
				if (
					!effectiveDevices.devices.some(
						(device) => device.deviceId === deviceId && device.identityId === identityId,
					)
				) {
					return false;
				}
			}
		}
		// The completion-bound mapping must still be the SELECTED mapping for
		// the Project. A later higher-priority mapping pointing outside the
		// group leaves the setup-created row in the table but redirects
		// enforcement to another boundary; mere existence of the shadowed row
		// is not evidence that the completion still governs the Project.
		const selected = selectedMappings.get(resolvedIdentity);
		const confirmedSources = confirmedProjectsByResolved.get(resolvedIdentity);
		const normalizedSelectedPattern = selected
			? normalizeLegacyProjectMappingIdentity(selected.projectPattern)
			: null;
		const confirmedSourceTargetScopeIds = new Set(
			[...(confirmedSources?.entries() ?? [])]
				.filter(
					([sourceIdentity]) =>
						normalizedSelectedPattern !== null &&
						normalizeLegacyProjectMappingIdentity(sourceIdentity) === normalizedSelectedPattern,
				)
				.map(([, scopeId]) => scopeId),
		);
		if (confirmedSourceTargetScopeIds.size > 1) return false;
		const hasConfirmedSource = confirmedSourceTargetScopeIds.size === 1;
		const confirmedSourceTargetScopeId = [...confirmedSourceTargetScopeIds][0];
		const confirmedTargetScopeIds = new Set(
			[...(confirmedSources?.values() ?? [])].filter((scopeId): scopeId is string =>
				Boolean(scopeId),
			),
		);
		const confirmedTargetScopeId = hasConfirmedSource
			? (confirmedSourceTargetScopeId ?? selected?.scopeId)
			: selected?.workspaceIdentity &&
					normalizeLegacyProjectMappingIdentity(selected.workspaceIdentity) ===
						normalizeLegacyProjectMappingIdentity(resolvedIdentity) &&
					confirmedTargetScopeIds.size === 1
				? [...confirmedTargetScopeIds][0]
				: undefined;
		if (
			!selected ||
			selected.workspaceIdentity == null ||
			!confirmedTargetScopeId ||
			selected.scopeId !== confirmedTargetScopeId ||
			!setupScopeIds.includes(confirmedTargetScopeId)
		) {
			return false;
		}
	}
	return true;
}

interface CompletionProjectRecipientRow {
	project_ref: string;
	source_project_identity: string;
	resolved_project_identity: string | null;
	source_fingerprint: string;
}

interface ExistingProjectRecipientRow {
	status: string;
	provenance: string;
}

function reconcileMissingCompletedProjectRecipients(
	db: Database,
	candidateId: string,
	draftRow: DraftFreshnessRow,
	rosterFingerprint: string,
	currentProjects: LegacyTeamSetupProjectInput[],
	now: string,
): number {
	if (
		draftRow.state !== "completed" ||
		!draftRow.completed_team_id ||
		!completedInventoryCompatible(db, draftRow.attempt_id, currentProjects) ||
		!isCompatibleReadyTeam(db, candidateId, draftRow, rosterFingerprint, {
			allowMissingSetupRecipients: true,
		})
	) {
		return 0;
	}
	const team = db
		.prepare("SELECT revision FROM policy_teams WHERE team_id = ? AND status = 'active'")
		.get(draftRow.completed_team_id) as { revision: string } | undefined;
	if (!team) return 0;
	const completionProjects = (
		db
			.prepare(
				`SELECT project_ref, source_project_identity, resolved_project_identity,
				        source_fingerprint
				 FROM legacy_team_setup_draft_projects WHERE attempt_id = ? ORDER BY project_ref`,
			)
			.all(draftRow.attempt_id) as CompletionProjectRecipientRow[]
	).filter((row) => !isRetiredFilesystemRootProjectRow(row));
	const existingRecipient = db.prepare(
		`SELECT status, provenance FROM project_recipients
		 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
	);
	const planned = new Map<string, { mode: "insert" | "reactivate"; sourceFingerprint: string }>();
	for (const project of completionProjects) {
		const resolvedIdentity = project.resolved_project_identity;
		if (!resolvedIdentity || !isMigratableLegacyTeamProjectIdentity(resolvedIdentity, db)) return 0;
		const existing = existingRecipient.get(resolvedIdentity, draftRow.completed_team_id) as
			| ExistingProjectRecipientRow
			| undefined;
		if (existing?.status === "active") continue;
		if (existing && existing.provenance !== "reviewed_team_setup") return 0;
		planned.set(resolvedIdentity, {
			mode: existing ? "reactivate" : "insert",
			sourceFingerprint: project.source_fingerprint,
		});
	}
	const insert = db.prepare(
		`INSERT INTO project_recipients(
		 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
		 policy_revision, migration_state, source_fingerprint, idempotency_key,
		 created_at, updated_at
		 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', ?, 'completed', ?, ?, ?, ?)`,
	);
	const reactivate = db.prepare(
		`UPDATE project_recipients
		 SET status = 'active', policy_revision = ?, migration_state = 'completed',
		     source_fingerprint = ?, updated_at = ?
		 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?
		   AND provenance = 'reviewed_team_setup' AND status <> 'active'`,
	);
	let writeCount = 0;
	for (const [resolvedIdentity, plan] of planned) {
		if (plan.mode === "insert") {
			insert.run(
				resolvedIdentity,
				draftRow.completed_team_id,
				team.revision,
				plan.sourceFingerprint,
				recipientPolicyDigest("legacy-team-project-recipient-v1", [
					resolvedIdentity,
					draftRow.completed_team_id,
				]),
				now,
				now,
			);
			writeCount += 1;
			continue;
		}
		writeCount += reactivate.run(
			team.revision,
			plan.sourceFingerprint,
			now,
			resolvedIdentity,
			draftRow.completed_team_id,
		).changes;
	}
	return writeCount;
}

function hasTerminalLegacyTeamCompletion(
	db: Database,
	candidateId: string,
	completedTeamId: string,
): boolean {
	if (completedTeamId !== deterministicPolicyTeamId(candidateId)) return false;
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM policy_teams
				 WHERE team_id = ? AND status = 'active'
				   AND provenance = 'reviewed_team_candidate'
				   AND migration_state = 'completed' LIMIT 1`,
			)
			.pluck()
			.get(completedTeamId),
	);
}

/** A completed guided migration stays selectable as an active canonical Team.
 * Later roster, Project, and policy changes belong to normal Team management;
 * they must not reopen or revoke the one-time migration completion.
 */
export function isLegacyTeamCandidateSelectable(
	db: Database,
	candidateId: string,
	current?: {
		rosterFingerprint?: string;
		projects?: LegacyTeamSetupProjectInput[];
	},
): boolean {
	const canonicalCompletedRow = canonicalCompletedDraftRow(db, candidateId);
	if (
		canonicalCompletedRow?.completed_team_id &&
		hasTerminalLegacyTeamCompletion(db, candidateId, canonicalCompletedRow.completed_team_id)
	) {
		return true;
	}
	const row = currentDraftRow(db, candidateId);
	if (row?.state !== "completed" || !row.completed_team_id) return false;
	// Keep compatibility with older canonical completions that predate the
	// terminal provenance markers; their full completion evidence remains the gate.
	const rosterFingerprint = current?.rosterFingerprint ?? row.roster_fingerprint;
	return (
		(current?.projects === undefined ||
			completedInventoryCompatible(db, row.attempt_id, current.projects)) &&
		isCompatibleReadyTeam(db, candidateId, row, rosterFingerprint)
	);
}

function candidateStatus(
	draft: LegacyTeamSetupDraftView,
	ready: boolean,
): LegacyTeamCandidateStatus {
	if (ready) return "ready";
	if (draft.state === "stale") return "stale";
	if (draft.state === "in_progress") return "in_progress";
	return "needs_setup";
}

function isRosterTooLargeError(error: unknown): boolean {
	return error instanceof Error && error.message === "legacy_team_setup_roster_too_large";
}

function isCompletionReconciliationError(error: unknown): boolean {
	return (
		error instanceof Error && error.message === "legacy_team_completion_reconciliation_invalid"
	);
}

function validatedNow(now: string | undefined): string {
	const value = now ?? new Date().toISOString();
	if (Number.isNaN(new Date(value).getTime())) throw new Error("legacy_team_setup_time_invalid");
	return value;
}

// Must run under the caller's top-level immediate transaction. Guard ordering
// is intentional: reject oversized evidence before fingerprint assignment reads.
function candidateAuthority(
	db: Database,
	candidateId: string,
	rosterDevices: LegacyTeamRosterDeviceSnapshot[],
	projects: LegacyTeamSetupProjectInput[],
	now: string,
): {
	row: DraftFreshnessRow | null;
	rosterFingerprint: string;
	ready: boolean;
	terminal: boolean;
} {
	const row = currentDraftRow(db, candidateId);
	const canonicalCompletedRow = canonicalCompletedDraftRow(db, candidateId);
	const terminal = Boolean(
		canonicalCompletedRow?.completed_team_id &&
			hasTerminalLegacyTeamCompletion(db, candidateId, canonicalCompletedRow.completed_team_id),
	);
	const authorityRow = terminal ? canonicalCompletedRow : row;
	requireLegacyTeamSetupSnapshotWithinLimits({ devices: rosterDevices, projects });
	requireLegacyTeamSetupEffectiveDevicesWithinLimit(
		db,
		rosterDevices,
		projects,
		authorityRow?.attempt_id ?? null,
	);
	const activeAssignmentIdentity = activeAssignmentIdentityLookup(db);
	const rosterFingerprint = legacyTeamRosterFingerprint(
		rosterDevices.map((device) => ({
			deviceId: device.deviceId,
			fingerprint: device.fingerprint,
			enabled: device.enabled,
			identityId: activeAssignmentIdentity(device.deviceId),
		})),
	);
	const completedRow = authorityRow?.state === "completed" ? authorityRow : canonicalCompletedRow;
	const completionEvidenceMatches =
		completedRow !== null &&
		completedRow.roster_fingerprint === rosterFingerprint &&
		completedInventoryCompatible(db, completedRow.attempt_id, projects);
	// Only the completed-candidate compatibility derivation fans out across
	// every assignment row; a fresh or in-progress candidate never runs it.
	if (completionEvidenceMatches) {
		requireLegacyTeamSetupReachableDevicesWithinLimit(db, rosterDevices, projects);
	}
	let ready =
		completionEvidenceMatches &&
		isCompatibleReadyTeam(db, candidateId, completedRow, rosterFingerprint);
	const reconciledWriteCount =
		completionEvidenceMatches && completedRow && !ready
			? reconcileMissingCompletedProjectRecipients(
					db,
					candidateId,
					completedRow,
					rosterFingerprint,
					projects,
					now,
				)
			: 0;
	if (reconciledWriteCount > 0 && completedRow) {
		ready = isCompatibleReadyTeam(db, candidateId, completedRow, rosterFingerprint);
		if (!ready) throw new Error("legacy_team_completion_reconciliation_invalid");
	}
	return { row: authorityRow, rosterFingerprint, ready, terminal };
}

function candidateDisplayName(db: Database, candidateId: string, fallback: string): string {
	const team = db
		.prepare("SELECT display_name FROM policy_teams WHERE team_id = ? AND status = 'active'")
		.get(deterministicPolicyTeamId(candidateId)) as { display_name: string } | undefined;
	if (team?.display_name) return team.display_name;
	const historical = db
		.prepare(
			`SELECT display_name FROM legacy_team_setup_drafts
			 WHERE candidate_id = ? AND display_name <> 'Legacy Team'
			 ORDER BY rowid DESC LIMIT 1`,
		)
		.get(candidateId) as { display_name: string } | undefined;
	return historical?.display_name ?? fallback;
}

function resolveDiscoveredCandidate(
	db: Database,
	group: EffectiveGroupSnapshot,
	projection: ListLegacyRecipientPolicyProjectionsOptions,
	now: string,
): { draft: LegacyTeamSetupDraftView; ready: boolean; projectCount: number } {
	const discover = db.transaction(() => {
		const { candidateId, coordinatorId, groupId, devices: rosterDevices } = group;
		const projects = legacyTeamCandidateProjectInventory(db, projection, candidateId);
		const { row, rosterFingerprint, ready, terminal } = candidateAuthority(
			db,
			candidateId,
			rosterDevices,
			projects,
			now,
		);
		const displayName = candidateDisplayName(db, candidateId, group.displayName);
		const expectedProjectionFingerprint = legacyTeamProjectionFingerprint(projects);
		const plan = planLegacyTeamAttempt({
			state: row?.state ?? null,
			evidenceMatches:
				row?.roster_fingerprint === rosterFingerprint &&
				row.projection_fingerprint === expectedProjectionFingerprint,
			completionReady: ready || terminal,
		});
		const draft =
			plan.kind === "preserve_completion" && row
				? refreshLegacyTeamSetupDraftLabels(db, row.attempt_id, {
						displayName,
						devices: rosterDevices,
						projects,
						now,
					})
				: refreshLegacyTeamSetupDraft(db, {
						candidateId,
						coordinatorId,
						groupId,
						displayName,
						devices: rosterDevices,
						projects,
						now,
					});
		return { draft, ready, projectCount: projects.length };
	});
	return discover.immediate();
}

export function discoverLegacyTeamCandidates(
	db: Database,
	options: DiscoverLegacyTeamCandidatesOptions,
): LegacyTeamCandidateView[] {
	const now = validatedNow(options.now);
	// Discovery persists this timestamp directly (stale transitions) and
	// forwards it to every draft write; garbage here corrupts ordering columns.
	const candidates: LegacyTeamCandidateView[] = [];
	// A conflicting roster is not reviewable evidence; conflicted candidates
	// are dropped rather than aborting discovery for every other group.
	const { snapshots } = effectiveGroupSnapshots(options.groups);
	for (const group of snapshots) {
		const { candidateId } = group;
		// Candidate discovery is driven by configured groups: a group with no
		// currently displayed Project still needs a reviewable roster so the
		// Team can become ready for future sharing.
		let result: { draft: LegacyTeamSetupDraftView; ready: boolean; projectCount: number };
		try {
			result = resolveDiscoveredCandidate(db, group, options.projection, now);
		} catch (error) {
			// Oversized evidence is local to this coordinator group. It must not
			// hide otherwise reviewable candidates discovered in the same pass.
			if (isRosterTooLargeError(error) || isCompletionReconciliationError(error)) continue;
			throw error;
		}
		candidates.push({
			candidateRef: candidateId,
			displayName: result.draft.displayName,
			status: candidateStatus(result.draft, result.ready),
			deviceCount: result.draft.devices.length,
			projectCount: result.projectCount,
			unresolvedDeviceCount: result.draft.unresolvedDeviceCount,
			unresolvedProjectCount: result.draft.unresolvedProjectCount,
		});
	}
	return candidates.toSorted((left, right) =>
		compareCodepoints(left.candidateRef, right.candidateRef),
	);
}

/**
 * The candidate's CURRENT displayed Project inventory, derived exactly the
 * way discovery derives it. Activation's finish path takes this as its
 * `loadProjectInventory` input and compares its fingerprint against the
 * draft's persisted one: evidence that changed after preview (for example a
 * newly ingested session adding a Project) must reject the finish rather
 * than commit a completion that discovery will immediately replace.
 */
export function legacyTeamCandidateProjectInventory(
	db: Database,
	projection: ListLegacyRecipientPolicyProjectionsOptions,
	candidateRef: string,
): LegacyTeamSetupProjectInput[] {
	const evidence = listLegacyTeamProjectEvidence(db, projection);
	return projectInventory(db, candidateRef, evidence);
}

export function refreshLegacyTeamCandidate(
	db: Database,
	options: DiscoverLegacyTeamCandidatesOptions,
	candidateRef: string,
): LegacyTeamSetupDraftView {
	const { snapshots, conflictedCandidateIds } = effectiveGroupSnapshots(options.groups);
	if (conflictedCandidateIds.has(candidateRef)) {
		throw new Error("legacy_team_setup_roster_conflict");
	}
	for (const group of snapshots) {
		const { candidateId, coordinatorId, groupId, devices: rosterDevices } = group;
		if (candidateId !== candidateRef) continue;
		const refresh = db.transaction(() => {
			const projects = legacyTeamCandidateProjectInventory(db, options.projection, candidateId);
			const { row } = candidateAuthority(
				db,
				candidateId,
				rosterDevices,
				projects,
				validatedNow(options.now),
			);
			const displayName = candidateDisplayName(db, candidateId, group.displayName);
			// Completion is terminal. Explicit refresh may reconcile compatible
			// setup-owned edges and labels, but later drift never creates a new attempt.
			if (row?.state === "completed") {
				return refreshLegacyTeamSetupDraftLabels(db, row.attempt_id, {
					displayName,
					devices: rosterDevices,
					projects,
					now: options.now,
				});
			}
			return refreshLegacyTeamSetupDraft(db, {
				candidateId,
				coordinatorId,
				groupId,
				displayName,
				devices: rosterDevices,
				projects,
				now: options.now,
			});
		});
		return refresh.immediate();
	}
	throw new Error("legacy_team_candidate_not_found");
}
