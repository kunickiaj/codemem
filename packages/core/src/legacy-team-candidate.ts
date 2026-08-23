import type { Database } from "./db.js";
import {
	type ListLegacyRecipientPolicyProjectionsOptions,
	listLegacyTeamProjectEvidence,
	selectedProjectScopeMapping,
} from "./legacy-recipient-policy-projection.js";
import {
	getLegacyTeamSetupDraft,
	type LegacyTeamSetupDraftView,
	type LegacyTeamSetupProjectInput,
	legacyTeamProjectionFingerprint,
	refreshLegacyTeamSetupDraft,
	refreshLegacyTeamSetupDraftLabels,
} from "./legacy-team-setup-draft.js";
import {
	requireLegacyTeamSetupEffectiveDevicesWithinLimit,
	requireLegacyTeamSetupSnapshotWithinLimits,
} from "./legacy-team-setup-limits.js";
import { derivePolicyTeamDeviceEligibility } from "./policy-team-device-eligibility.js";
import {
	compareCodepoints,
	deterministicPolicyTeamId,
	INVITE_DECISION_PROVENANCES,
	legacyTeamCandidateId,
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
	state: "needs_setup" | "in_progress" | "stale" | "completed";
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
		const existing = byId.get(device.deviceId);
		if (!existing) {
			byId.set(device.deviceId, device);
			continue;
		}
		if (existing.fingerprint !== device.fingerprint || existing.enabled !== device.enabled) {
			return null;
		}
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
		const coordinatorId = group.coordinatorId.trim();
		const groupId = group.groupId.trim();
		if (!coordinatorId || !groupId) continue;
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
		if (!rosterDevicesAgree(existing.devices, devices)) conflictedCandidateIds.add(candidateId);
	}
	for (const candidateId of conflictedCandidateIds) byCandidate.delete(candidateId);
	return { snapshots: [...byCandidate.values()], conflictedCandidateIds };
}

function activeAssignmentIdentity(db: Database, deviceId: string): string | null {
	return (
		(db
			.prepare(
				`SELECT identity_id FROM identity_devices
				 WHERE device_id = ? AND status = 'active' LIMIT 1`,
			)
			.pluck()
			.get(deviceId) as string | undefined) ?? null
	);
}

function projectInventory(
	candidateId: string,
	evidence: ReturnType<typeof listLegacyTeamProjectEvidence>,
): LegacyTeamSetupProjectInput[] {
	return evidence
		.filter((project) => project.teamCandidateIds.includes(candidateId))
		.map((project) => {
			const sourceProjectIdentity = project.project.canonicalIdentity;
			return {
				projectRef: recipientPolicyDigest("legacy-team-project-ref-v1", [
					candidateId,
					sourceProjectIdentity,
				]),
				sourceProjectIdentity,
				displayName: project.project.displayName,
				sourceFingerprint: project.sourceFingerprint,
				deterministicProjectIdentity: project.deterministicProjectIdentity,
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
 * source or resolved identity; anything else — a new Project, or a reviewed
 * Project that disappeared — reopens setup. Canonical row integrity (teams,
 * decisions, memberships, mappings, recipients) is separately enforced by
 * `isCompatibleReadyTeam`.
 */
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
	const reviewedIdentities = new Set<string>();
	for (const row of rows) {
		reviewedIdentities.add(row.source_project_identity);
		if (row.resolved_project_identity) reviewedIdentities.add(row.resolved_project_identity);
	}
	const currentIdentities = new Set(projects.map((project) => project.sourceProjectIdentity));
	for (const identity of currentIdentities) {
		if (!reviewedIdentities.has(identity)) return false;
	}
	for (const row of rows) {
		const materialized = row.resolved_project_identity ?? row.source_project_identity;
		if (
			!currentIdentities.has(materialized) &&
			!currentIdentities.has(row.source_project_identity)
		) {
			return false;
		}
	}
	return true;
}

function requireLegacyTeamSetupDraft(db: Database, candidateId: string): LegacyTeamSetupDraftView {
	const draft = getLegacyTeamSetupDraft(db, candidateId);
	// The row was just observed by discovery; its disappearance mid-pass is
	// drifted state, not a valid empty result.
	if (!draft) throw new Error("legacy_team_setup_draft_not_found");
	return draft;
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
): boolean {
	const { attempt_id: attemptId, completed_team_id: completedTeamId } = draftRow;
	const expectedTeamId = deterministicPolicyTeamId(candidateId);
	if (completedTeamId !== expectedTeamId) return false;
	// Confirmed mappings are bound to the setup's coordinator group. A group
	// may expose multiple active scopes (for example per-Project boundaries),
	// so a mapping targeting any of them is valid; a mapping with the same
	// identities but a scope outside the group is drifted state. Scopes are
	// only required when the completed draft has Project rows to validate: a
	// configured group with no displayed Projects has no mapping whose scope
	// could drift, so its completion stays Ready without a local scope row.
	const completionProjectRows = db
		.prepare(
			`SELECT source_project_identity, resolved_project_identity
			 FROM legacy_team_setup_draft_projects WHERE attempt_id = ?`,
		)
		.all(attemptId) as Array<{
		source_project_identity: string;
		resolved_project_identity: string | null;
	}>;
	const setupScopeIds = db
		.prepare(
			`SELECT scope_id FROM replication_scopes
			 WHERE coordinator_id = ? AND group_id = ? AND status = 'active'`,
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
	const hasUnexplainedDecision = canonicalDecisions.some((row) => {
		if (expectedDecisionDeviceIds.has(row.device_id)) return false;
		if (!(INVITE_DECISION_PROVENANCES as readonly string[]).includes(row.provenance)) return true;
		// An unresolved invite is review work, not a compatible completion.
		if (!["included", "excluded"].includes(row.decision)) return true;
		if (row.decision === "excluded") return false;
		// Invite-owned decisions can precede canonical Team membership. Their
		// completion binding is therefore the live assignment version rather
		// than membership-derived eligibility.
		const liveAssignment = db
			.prepare(
				`SELECT assignment_version FROM identity_devices
				 WHERE device_id = ? AND status = 'active' LIMIT 1`,
			)
			.get(row.device_id) as { assignment_version: number } | undefined;
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
		const assignment = db
			.prepare(
				`SELECT identity_id FROM identity_devices
				 WHERE device_id = ? AND status = 'active' LIMIT 1`,
			)
			.get(device.device_id) as { identity_id: string } | undefined;
		if (!assignment || assignment.identity_id !== device.target_identity_id) return false;
		if (decision?.decision !== "included" || !eligibleDeviceIds.has(device.device_id)) return false;
		expectedEffectiveDevices.set(device.device_id, device.target_identity_id);
	}
	// Merged resolutions map several confirmed source patterns onto one
	// canonical identity; selection can pick only one of those mappings, so
	// the authoritative pattern is valid when it matches ANY confirmed source
	// for that identity.
	const confirmedSourcesByResolved = new Map<string, Set<string>>();
	for (const project of completionProjectRows) {
		if (!project.resolved_project_identity) return false;
		const sources = confirmedSourcesByResolved.get(project.resolved_project_identity) ?? new Set();
		sources.add(project.source_project_identity);
		confirmedSourcesByResolved.set(project.resolved_project_identity, sources);
	}
	// Several confirmed sources may resolve to the same canonical Project. Keep
	// the expensive live-policy derivation scoped to this compatibility check so
	// those sources share one result without retaining authorization state across
	// calls that may observe later membership, decision, or assignment changes.
	const effectiveDevicesByProject = new Map<
		string,
		StrictRecipientPolicyEffectiveDeviceDerivation
	>();
	for (const project of completionProjectRows) {
		const resolvedIdentity = project.resolved_project_identity as string;
		const recipientActive = db
			.prepare(
				`SELECT 1 FROM project_recipients
				 WHERE canonical_project_identity = ? AND recipient_kind = 'team'
				   AND recipient_id = ? AND status = 'active' LIMIT 1`,
			)
			.get(resolvedIdentity, completedTeamId);
		if (!recipientActive) return false;
		let effectiveDevices = effectiveDevicesByProject.get(resolvedIdentity);
		if (!effectiveDevices) {
			effectiveDevices = deriveRecipientPolicyEffectiveDevicesFromDatabase(db, resolvedIdentity);
			effectiveDevicesByProject.set(resolvedIdentity, effectiveDevices);
		}
		if (effectiveDevices.status === "blocked") return false;
		for (const [deviceId, identityId] of expectedEffectiveDevices) {
			if (
				!effectiveDevices.devices.some(
					(device) => device.deviceId === deviceId && device.identityId === identityId,
				)
			) {
				return false;
			}
		}
		// The completion-bound mapping must still be the SELECTED mapping for
		// the Project. A later higher-priority mapping pointing outside the
		// group leaves the setup-created row in the table but redirects
		// enforcement to another boundary; mere existence of the shadowed row
		// is not evidence that the completion still governs the Project.
		const selected = selectedProjectScopeMapping(db, resolvedIdentity);
		if (
			!selected ||
			selected.workspaceIdentity == null ||
			!confirmedSourcesByResolved.get(resolvedIdentity)?.has(selected.projectPattern) ||
			!setupScopeIds.includes(selected.scopeId)
		) {
			return false;
		}
	}
	return true;
}

/**
 * A completed guided setup is selectable (for example by `choose_recipients`)
 * only while its full completion-bound canonical state is intact. Production
 * writers such as `commitDeviceIdentityBindings` can invalidate decisions
 * without clearing the Team fingerprint, so a header-only check is not enough.
 *
 * The stored draft cannot prove freshness against evidence it does not hold:
 * callers that can compute the current Project inventory or a current
 * coordinator roster fingerprint must pass them so that drift the next
 * discovery would reopen setup for also blocks selection. When a caller has
 * no coordinator snapshot (review/migration contexts run without coordinator
 * connectivity), roster drift admits no unreviewed grants — new devices have
 * no canonical decisions — and discovery reopens setup on its next pass.
 */
export function isLegacyTeamCandidateSelectable(
	db: Database,
	candidateId: string,
	current?: {
		rosterFingerprint?: string;
		projects?: LegacyTeamSetupProjectInput[];
	},
): boolean {
	const row = currentDraftRow(db, candidateId);
	if (row?.state !== "completed" || !row.completed_team_id) return false;
	if (current?.rosterFingerprint != null && current.rosterFingerprint !== row.roster_fingerprint) {
		return false;
	}
	if (current?.projects && !completedInventoryCompatible(db, row.attempt_id, current.projects)) {
		return false;
	}
	return isCompatibleReadyTeam(db, candidateId, row, row.roster_fingerprint);
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

export function discoverLegacyTeamCandidates(
	db: Database,
	options: DiscoverLegacyTeamCandidatesOptions,
): LegacyTeamCandidateView[] {
	const evidence = listLegacyTeamProjectEvidence(db, options.projection);
	const now = options.now ?? new Date().toISOString();
	// Discovery persists this timestamp directly (stale transitions) and
	// forwards it to every draft write; garbage here corrupts ordering columns.
	if (Number.isNaN(new Date(now).getTime())) throw new Error("legacy_team_setup_time_invalid");
	const candidates: LegacyTeamCandidateView[] = [];
	// A conflicting roster is not reviewable evidence; conflicted candidates
	// are dropped rather than aborting discovery for every other group.
	const { snapshots } = effectiveGroupSnapshots(options.groups);
	for (const group of snapshots) {
		const { candidateId, coordinatorId, groupId, devices: rosterDevices } = group;
		// Candidate discovery is driven by configured groups: a group with no
		// currently displayed Project still needs a reviewable roster so the
		// Team can become ready for future sharing.
		const projects = projectInventory(candidateId, evidence);
		const row = currentDraftRow(db, candidateId);
		let draft: LegacyTeamSetupDraftView;
		let ready = false;
		try {
			requireLegacyTeamSetupSnapshotWithinLimits({ devices: rosterDevices, projects });
			requireLegacyTeamSetupEffectiveDevicesWithinLimit(db, rosterDevices, row?.attempt_id ?? null);
			const rosterFingerprint = legacyTeamRosterFingerprint(
				rosterDevices.map((device) => ({
					deviceId: device.deviceId,
					fingerprint: device.fingerprint,
					enabled: device.enabled,
					identityId: activeAssignmentIdentity(db, device.deviceId),
				})),
			);
			const expectedProjectionFingerprint = legacyTeamProjectionFingerprint(projects);
			ready =
				row?.state === "completed" &&
				row.roster_fingerprint === rosterFingerprint &&
				completedInventoryCompatible(db, row.attempt_id, projects) &&
				isCompatibleReadyTeam(db, candidateId, row, rosterFingerprint);
			if (!row || (row.state === "completed" && !ready)) {
				draft = refreshLegacyTeamSetupDraft(db, {
					candidateId,
					coordinatorId,
					groupId,
					displayName: group.displayName,
					devices: rosterDevices,
					projects,
					now,
				});
			} else if (row.state === "completed") {
				draft = refreshLegacyTeamSetupDraftLabels(db, row.attempt_id, {
					displayName: group.displayName,
					devices: rosterDevices,
					projects,
					now,
				});
			} else if (row.state === "stale") {
				draft = requireLegacyTeamSetupDraft(db, candidateId);
			} else if (
				row.roster_fingerprint !== rosterFingerprint ||
				row.projection_fingerprint !== expectedProjectionFingerprint
			) {
				if (row.state === "needs_setup" || row.state === "in_progress") {
					db.prepare(
						`UPDATE legacy_team_setup_drafts SET state = 'stale', updated_at = ?
						 WHERE attempt_id = ?`,
					).run(now, row.attempt_id);
				}
				draft = requireLegacyTeamSetupDraft(db, candidateId);
			} else {
				draft = refreshLegacyTeamSetupDraft(db, {
					candidateId,
					coordinatorId,
					groupId,
					displayName: group.displayName,
					devices: rosterDevices,
					projects,
					now,
				});
			}
		} catch (error) {
			// Oversized evidence is local to this coordinator group. It must not
			// hide otherwise reviewable candidates discovered in the same pass.
			if (isRosterTooLargeError(error)) continue;
			throw error;
		}
		candidates.push({
			candidateRef: candidateId,
			displayName: draft.displayName,
			status: candidateStatus(draft, ready),
			deviceCount: draft.devices.length,
			projectCount: projects.length,
			unresolvedDeviceCount: draft.unresolvedDeviceCount,
			unresolvedProjectCount: draft.unresolvedProjectCount,
		});
	}
	return candidates.toSorted((left, right) => left.candidateRef.localeCompare(right.candidateRef));
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
	return projectInventory(candidateRef, evidence);
}

export function refreshLegacyTeamCandidate(
	db: Database,
	options: DiscoverLegacyTeamCandidatesOptions,
	candidateRef: string,
): LegacyTeamSetupDraftView {
	const evidence = listLegacyTeamProjectEvidence(db, options.projection);
	const { snapshots, conflictedCandidateIds } = effectiveGroupSnapshots(options.groups);
	if (conflictedCandidateIds.has(candidateRef)) {
		throw new Error("legacy_team_setup_roster_conflict");
	}
	for (const group of snapshots) {
		const { candidateId, coordinatorId, groupId, devices: rosterDevices } = group;
		if (candidateId !== candidateRef) continue;
		const projects = projectInventory(candidateId, evidence);
		const row = currentDraftRow(db, candidateId);
		requireLegacyTeamSetupSnapshotWithinLimits({ devices: rosterDevices, projects });
		requireLegacyTeamSetupEffectiveDevicesWithinLimit(db, rosterDevices, row?.attempt_id ?? null);
		// A compatible Ready completion with unchanged evidence survives an
		// explicit refresh: only labels update. Creating a replacement attempt
		// here would immediately drop Ready and force a redundant review cycle.
		const rosterFingerprint = legacyTeamRosterFingerprint(
			rosterDevices.map((device) => ({
				deviceId: device.deviceId,
				fingerprint: device.fingerprint,
				enabled: device.enabled,
				identityId: activeAssignmentIdentity(db, device.deviceId),
			})),
		);
		if (
			row?.state === "completed" &&
			row.roster_fingerprint === rosterFingerprint &&
			completedInventoryCompatible(db, row.attempt_id, projects) &&
			isCompatibleReadyTeam(db, candidateId, row, rosterFingerprint)
		) {
			return refreshLegacyTeamSetupDraftLabels(db, row.attempt_id, {
				displayName: group.displayName,
				devices: rosterDevices,
				projects,
				now: options.now,
			});
		}
		return refreshLegacyTeamSetupDraft(db, {
			candidateId,
			coordinatorId,
			groupId,
			displayName: group.displayName,
			devices: rosterDevices,
			projects,
			now: options.now,
		});
	}
	throw new Error("legacy_team_candidate_not_found");
}
