import type { Database } from "./db.js";
import {
	assignIdentityDeviceInTransaction,
	IdentityDeviceAssignmentError,
} from "./identity-device-assignment.js";
import { selectedProjectScopeMapping } from "./legacy-recipient-policy-projection.js";
import { isStoredLegacyTeamAssignmentExpectationWellFormed } from "./legacy-team-assignment-expectation.js";
import { isLegacyTeamProjectCanonicalStateValid } from "./legacy-team-project-canonical-preflight.js";
import {
	type LegacyTeamSetupProjectInput,
	legacyTeamProjectionFingerprint,
} from "./legacy-team-setup-draft.js";
import type { LegacyTeamSetupActivationErrorCode } from "./legacy-team-setup-errors.js";
import {
	LEGACY_TEAM_SETUP_MAX_DEVICES,
	LEGACY_TEAM_SETUP_MAX_PROJECTS,
} from "./legacy-team-setup-limits.js";
import {
	activeUnmergedActorIds,
	isActiveUnmergedActorState,
} from "./recipient-policy-actor-eligibility.js";
import type {
	LegacyTeamSetupAccessDeltaV1,
	LegacyTeamSetupActivationPreviewV1,
	LegacyTeamSetupActivationResultV1,
} from "./recipient-policy-contract.js";
import {
	deterministicPolicyTeamId,
	legacyTeamProjectRef,
	legacyTeamRosterFingerprint,
	recipientPolicyDigest,
} from "./recipient-policy-identifiers.js";
import { deriveRecipientPolicyEffectiveDevices } from "./recipient-policy-reconciliation.js";
import {
	classifyTeamPolicyOwnership,
	planSetupDeviceDecisionTransition,
	planSetupMembershipTransition,
} from "./team-ownership-transitions.js";

export type { LegacyTeamSetupActivationErrorCode } from "./legacy-team-setup-errors.js";

export class LegacyTeamSetupActivationError extends Error {
	readonly code: LegacyTeamSetupActivationErrorCode;

	constructor(code: LegacyTeamSetupActivationErrorCode) {
		super(code);
		this.name = "LegacyTeamSetupActivationError";
		this.code = code;
	}
}

export interface PreviewLegacyTeamSetupActivationInput {
	candidateRef: string;
	attemptId: string;
}

export interface FinishLegacyTeamSetupActivationInput
	extends PreviewLegacyTeamSetupActivationInput {
	finishDigest: string;
	confirmedAccessDeltaDigest: string;
	loadFreshRoster: () => Promise<
		Array<{
			deviceId: string;
			fingerprint: string;
			displayName: string;
			enabled: boolean;
		}>
	>;
	/**
	 * The candidate's live displayed Project inventory (same derivation
	 * discovery uses; see `legacyTeamCandidateProjectInventory`). Displayed
	 * evidence that changed after preview — for example a newly ingested
	 * session adding a Project — must reject the finish rather than commit a
	 * completion discovery will immediately replace. The callback is invoked
	 * SYNCHRONOUSLY inside the finish transaction so the inventory is derived
	 * from the locked database state; implementations must read from the same
	 * database and must not await.
	 */
	loadProjectInventory: () => LegacyTeamSetupProjectInput[];
	now?: string;
}

interface DraftRow {
	attempt_id: string;
	candidate_id: string;
	coordinator_id: string;
	group_id: string;
	state: string;
	display_name: string;
	roster_fingerprint: string;
	projection_fingerprint: string;
	finish_digest: string | null;
	is_current: number;
}

interface DraftDeviceRow {
	device_id: string;
	device_ref: string;
	key_fingerprint: string;
	display_name: string;
	enabled: number;
	existing_identity_id: string | null;
	existing_assignment_version: number | null;
	verified_evidence_kind: "active_assignment" | null;
	decision: string;
	target_identity_id: string | null;
	expected_assignment_kind: "absent" | "existing" | null;
	expected_assignment_version: number | null;
}

interface DraftProjectRow {
	project_ref: string;
	source_project_identity: string;
	display_name: string;
	source_fingerprint: string;
	resolution_kind: string;
	resolved_project_identity: string | null;
}

interface TeamRow {
	team_id: string;
	display_name: string;
	status: string;
	device_eligibility_mode: string;
	provenance: string;
	source_fingerprint: string | null;
}

interface MembershipRow {
	identity_id: string;
	status: string;
	provenance: string;
}

interface AssignmentRow {
	device_id: string;
	identity_id: string;
	status: string;
	assignment_version: number;
}

interface DecisionRow {
	device_id: string;
	decision: string;
	assignment_version: number;
}

interface MappingRow {
	id: number;
	workspace_identity: string | null;
	project_pattern: string;
	scope_id: string;
	source: string | null;
}

interface RecipientRow {
	canonical_project_identity: string;
	recipient_kind: string;
	recipient_id: string;
	status: string;
	provenance: string;
}

interface TeamSnapshotRow {
	team_id: string;
	status: string;
	device_eligibility_mode: string;
}

interface MembershipSnapshotRow {
	team_id: string;
	identity_id: string;
	status: string;
	provenance: string;
}

interface DecisionSnapshotRow {
	team_id: string;
	device_id: string;
	decision: string;
	assignment_version: number;
	provenance: string;
}

interface IdentitySnapshotRow {
	actor_id: string;
	status: string;
	merged_into_actor_id: string | null;
}

interface HistoricalResolution {
	sourceFingerprint: string;
	memberIds: string[];
	projectIdentity: string;
}

interface ActivationModel {
	draft: DraftRow;
	devices: DraftDeviceRow[];
	projects: DraftProjectRow[];
	teamId: string;
	scopeIds: string[];
	/**
	 * Every scope this coordinator group has ever exposed, regardless of
	 * status. Ownership checks on setup-written rows must use this set: a
	 * mapping pointing at a retired scope still belongs to this group, and a
	 * mapping pointing at ANOTHER group's scope never does.
	 */
	groupScopeIds: string[];
	team: TeamRow | null;
	memberships: MembershipRow[];
	assignments: AssignmentRow[];
	decisions: DecisionRow[];
	mappings: MappingRow[];
	recipients: RecipientRow[];
	allTeams: TeamSnapshotRow[];
	allMemberships: MembershipSnapshotRow[];
	allDecisions: DecisionSnapshotRow[];
	identities: IdentitySnapshotRow[];
	historicalResolutions: HistoricalResolution[];
	desiredIdentityIds: string[];
	desiredDeviceIds: string[];
}

interface CompletionRow {
	response_json: string;
}

const SETUP_MEMBERSHIP_PROVENANCE = "reviewed_active";
/** Provenance written by the historical `choose_recipients` migration path. */
const HISTORICAL_TEAM_PROVENANCE = "reviewed_team_candidate";

function parseJsonObject(json: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(json) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function assignedIdentityIdsFromPreview(preview: Record<string, unknown>): string[] | null {
	if (!Array.isArray(preview.effectiveDevices)) return null;
	const identityIds = new Set<string>();
	for (const entry of preview.effectiveDevices) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
		const device = entry as Record<string, unknown>;
		if (device.assignment === "assigned" && typeof device.identityId === "string") {
			identityIds.add(device.identityId);
		}
	}
	return [...identityIds].toSorted(compareText);
}

function previewProjectIdentity(preview: Record<string, unknown>): string | null {
	if (!Array.isArray(preview.projects)) return null;
	const project = preview.projects[0];
	if (!project || typeof project !== "object" || Array.isArray(project)) return null;
	const identity = (project as Record<string, unknown>).canonicalIdentity;
	return typeof identity === "string" && identity ? identity : null;
}

/**
 * Loads every saved `choose_recipients` resolution that selected this Team
 * candidate. These are the only writers that materialized historical
 * `person_all_devices` Teams for the candidate; any matching resolution that
 * cannot be parsed makes the adoption evidence incomplete and fails closed.
 */
function loadHistoricalTeamResolutions(db: Database, candidateId: string): HistoricalResolution[] {
	const rows = db
		.prepare(
			`SELECT source_fingerprint, decision_input_json, preview_json
			 FROM recipient_policy_review_resolutions
			 WHERE decision = 'choose_recipients'
			 ORDER BY resolved_at, review_item_id`,
		)
		.all() as Array<{
		source_fingerprint: string;
		decision_input_json: string;
		preview_json: string;
	}>;
	const resolutions: HistoricalResolution[] = [];
	for (const row of rows) {
		const input = parseJsonObject(row.decision_input_json);
		const recipientIds = Array.isArray(input?.recipientIds) ? input.recipientIds : [];
		if (!recipientIds.includes(candidateId)) continue;
		const preview = parseJsonObject(row.preview_json);
		const memberIds = preview ? assignedIdentityIdsFromPreview(preview) : null;
		const projectIdentity = preview ? previewProjectIdentity(preview) : null;
		if (!memberIds || !projectIdentity) activationError("team_setup_conflict");
		resolutions.push({
			sourceFingerprint: row.source_fingerprint,
			memberIds,
			projectIdentity,
		});
	}
	return resolutions;
}

function activationError(code: LegacyTeamSetupActivationErrorCode): never {
	throw new LegacyTeamSetupActivationError(code);
}

function normalizedActivationError(error: unknown): LegacyTeamSetupActivationError {
	if (error instanceof LegacyTeamSetupActivationError) return error;
	if (
		error instanceof IdentityDeviceAssignmentError &&
		error.code === "team_setup_assignment_changed"
	) {
		return new LegacyTeamSetupActivationError("team_setup_assignment_changed");
	}
	return new LegacyTeamSetupActivationError("team_setup_failed");
}

function persistSafeError(
	db: Database,
	input: PreviewLegacyTeamSetupActivationInput,
	error: LegacyTeamSetupActivationError,
): void {
	// Confirmation staleness is a property of the caller's tokens (for example
	// a stale tab), not of the draft: the attempt stays valid and retryable
	// with fresh tokens. Retryable canonical conflicts can clear externally;
	// only changes to evidence captured by this review stale the draft.
	const stale = [
		"team_setup_roster_changed",
		"team_setup_projection_changed",
		"team_setup_assignment_changed",
	].includes(error.code);
	try {
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET safe_error_code = ?, state = CASE WHEN ? = 1 THEN 'stale' ELSE state END
			 WHERE attempt_id = ? AND candidate_id = ? AND state <> 'completed'`,
		).run(error.code, stale ? 1 : 0, input.attemptId, input.candidateRef);
	} catch {
		// The original safe error is more useful than a best-effort status-write failure.
	}
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function droppedSetupMappings(model: ActivationModel): MappingRow[] {
	const committedSourceIdentities = new Set(
		model.projects.map((project) => project.source_project_identity),
	);
	return model.mappings.filter(
		(mapping) =>
			mapping.source === "reviewed_team_setup" &&
			model.groupScopeIds.includes(mapping.scope_id) &&
			!committedSourceIdentities.has(mapping.project_pattern),
	);
}

function loadModel(db: Database, input: PreviewLegacyTeamSetupActivationInput): ActivationModel {
	const draft = db
		.prepare(
			`SELECT draft.attempt_id, draft.candidate_id, draft.coordinator_id, draft.group_id,
			        draft.state, draft.display_name, draft.roster_fingerprint,
			        draft.projection_fingerprint, draft.finish_digest,
			        NOT EXISTS (
			          SELECT 1 FROM legacy_team_setup_drafts AS newer
			          WHERE newer.candidate_id = draft.candidate_id AND newer.rowid > draft.rowid
			        ) AS is_current
			 FROM legacy_team_setup_drafts AS draft WHERE draft.attempt_id = ?`,
		)
		.get(input.attemptId) as DraftRow | undefined;
	if (!draft || draft.candidate_id !== input.candidateRef) {
		activationError("team_setup_confirmation_stale");
	}
	if (draft.is_current === 0 || (draft.state !== "needs_setup" && draft.state !== "in_progress")) {
		activationError("team_setup_confirmation_stale");
	}

	const devices = db
		.prepare(
			`SELECT device_id, device_ref, key_fingerprint, display_name, enabled,
			        existing_identity_id, existing_assignment_version, verified_evidence_kind,
			        decision, target_identity_id, expected_assignment_kind,
			        expected_assignment_version
			 FROM legacy_team_setup_draft_devices WHERE attempt_id = ? ORDER BY device_id`,
		)
		.all(input.attemptId) as DraftDeviceRow[];
	const projects = db
		.prepare(
			`SELECT project_ref, source_project_identity, display_name, source_fingerprint,
			        resolution_kind, resolved_project_identity
			 FROM legacy_team_setup_draft_projects WHERE attempt_id = ? ORDER BY project_ref`,
		)
		.all(input.attemptId) as DraftProjectRow[];
	if (
		devices.length === 0 ||
		devices.length > LEGACY_TEAM_SETUP_MAX_DEVICES ||
		// A configured group without displayed Projects is a valid setup: the
		// reviewed Team becomes ready for future sharing with no mappings yet.
		projects.length > LEGACY_TEAM_SETUP_MAX_PROJECTS ||
		devices.some(
			(device) =>
				device.decision === "unresolved" ||
				(device.decision === "included" && !device.target_identity_id) ||
				!["included", "excluded", "removed"].includes(device.decision),
		) ||
		projects.some(
			(project) =>
				project.resolution_kind === "unresolved" ||
				!project.resolved_project_identity ||
				project.resolved_project_identity.startsWith("unmapped:"),
		)
	) {
		activationError("team_setup_incomplete");
	}

	const activeIdentityIds = new Set(activeUnmergedActorIds(db));
	const desiredIdentityIds = [
		...new Set(
			devices
				.filter((device) => device.decision === "included")
				.map((device) => device.target_identity_id as string),
		),
	].toSorted(compareText);
	if (desiredIdentityIds.some((identityId) => !activeIdentityIds.has(identityId))) {
		activationError("team_setup_conflict");
	}

	// A coordinator group may expose multiple active scopes (per-Project
	// boundaries); each confirmed mapping must target one of them, and only a
	// Project needing a brand-new mapping requires an unambiguous scope. A
	// zero-Project completion writes no mappings, so it activates without a
	// local scope row — matching the readiness invariant, which likewise only
	// requires scopes when completion-bound Project rows exist.
	// The scope list is embedded in the finish digest; unspecified row order
	// would make preview and finish disagree on an identical database.
	const scopeIds = (
		db
			.prepare(
				`SELECT scope_id FROM replication_scopes
				 WHERE coordinator_id = ? AND group_id = ? AND status = 'active'
				 ORDER BY scope_id`,
			)
			.all(draft.coordinator_id, draft.group_id) as Array<{ scope_id: string }>
	).map((row) => row.scope_id);
	if (projects.length > 0 && scopeIds.length === 0) activationError("team_setup_conflict");
	const groupScopeIds = db
		.prepare(
			`SELECT scope_id FROM replication_scopes
			 WHERE coordinator_id = ? AND group_id = ? ORDER BY scope_id`,
		)
		.pluck()
		.all(draft.coordinator_id, draft.group_id) as string[];

	const teamId = deterministicPolicyTeamId(draft.candidate_id);
	// Enumerated columns only: the row is embedded in the confirmation
	// snapshot, so `SELECT *` would let an unrelated `updated_at` touch — or a
	// future schema migration — invalidate every outstanding confirmation.
	const team =
		(db
			.prepare(
				`SELECT team_id, display_name, status, device_eligibility_mode,
				        provenance, source_fingerprint
				 FROM policy_teams WHERE team_id = ?`,
			)
			.get(teamId) as TeamRow | undefined) ?? null;
	const memberships = db
		.prepare(
			`SELECT identity_id, status, provenance FROM policy_team_memberships
			 WHERE team_id = ? ORDER BY identity_id`,
		)
		.all(teamId) as MembershipRow[];
	const assignments = db
		.prepare(
			`SELECT device_id, identity_id, status, assignment_version FROM identity_devices
			 ORDER BY device_id`,
		)
		.all() as AssignmentRow[];
	const decisions = db
		.prepare(
			`SELECT device_id, decision, assignment_version FROM policy_team_device_decisions
			 WHERE team_id = ? ORDER BY device_id`,
		)
		.all(teamId) as DecisionRow[];
	const mappings = db
		.prepare(
			`SELECT id, workspace_identity, project_pattern, scope_id, source
			 FROM project_scope_mappings ORDER BY id`,
		)
		.all() as MappingRow[];
	const recipients = db
		.prepare(
			`SELECT canonical_project_identity, recipient_kind, recipient_id, status, provenance
			 FROM project_recipients ORDER BY canonical_project_identity, recipient_kind, recipient_id`,
		)
		.all() as RecipientRow[];
	// The confirmed delta is derived across every recipient path, so the model
	// snapshots all Teams, memberships, decisions, and identities.
	const allTeams = db
		.prepare("SELECT team_id, status, device_eligibility_mode FROM policy_teams ORDER BY team_id")
		.all() as TeamSnapshotRow[];
	const allMemberships = db
		.prepare(
			`SELECT team_id, identity_id, status, provenance
			 FROM policy_team_memberships ORDER BY team_id, identity_id`,
		)
		.all() as MembershipSnapshotRow[];
	const allDecisions = db
		.prepare(
			`SELECT team_id, device_id, decision, assignment_version, provenance
			 FROM policy_team_device_decisions ORDER BY team_id, device_id`,
		)
		.all() as DecisionSnapshotRow[];
	const identityRows = db
		.prepare("SELECT actor_id, status, merged_into_actor_id FROM actors ORDER BY actor_id")
		.all() as IdentitySnapshotRow[];

	const model: ActivationModel = {
		draft,
		devices,
		projects,
		teamId,
		scopeIds,
		groupScopeIds,
		team,
		memberships,
		assignments,
		decisions,
		mappings,
		recipients,
		allTeams,
		allMemberships,
		allDecisions,
		identities: identityRows,
		historicalResolutions:
			team?.device_eligibility_mode === "person_all_devices"
				? loadHistoricalTeamResolutions(db, draft.candidate_id)
				: [],
		desiredIdentityIds,
		desiredDeviceIds: devices
			.filter((device) => device.decision === "included")
			.map((device) => device.device_id)
			.toSorted(compareText),
	};
	validateAssignmentExpectations(model);
	validateCanonicalState(model);
	return model;
}

function validateCanonicalState(model: ActivationModel): void {
	const { groupScopeIds, memberships, projects, recipients, scopeIds, team, teamId } = model;
	if (team) {
		const baseCompatible =
			team.status === "active" && team.provenance === HISTORICAL_TEAM_PROVENANCE;
		const reviewedCompatible = team.device_eligibility_mode === "reviewed_allowlist";
		const historicalCompatible = team.device_eligibility_mode === "person_all_devices";
		if (!baseCompatible || (!reviewedCompatible && !historicalCompatible)) {
			activationError("team_setup_conflict");
		}
		if (
			reviewedCompatible &&
			memberships.some(
				(row) =>
					row.status !== "reviewed_active" &&
					row.status !== "pending" &&
					row.status !== "revoked" &&
					// Pre-reviewed production invite paths wrote `active` rows; the
					// activation sweep normalizes them to `reviewed_active`.
					!(row.status === "active" && classifyTeamPolicyOwnership(row.provenance) === "invite"),
			)
		) {
			activationError("team_setup_conflict");
		}
		if (historicalCompatible) validateHistoricalTeamAdoption(model);
		// Preserved invite members must still be active, unmerged people:
		// activating around a defunct member would immediately block the whole
		// Team in authoritative eligibility and strand discovery in needs_setup.
		const validIdentityIds = new Set(
			model.identities
				.filter((row) =>
					isActiveUnmergedActorState({
						status: row.status,
						mergedIntoActorId: row.merged_into_actor_id,
					}),
				)
				.map((row) => row.actor_id),
		);
		if (
			memberships.some(
				(row) =>
					classifyTeamPolicyOwnership(row.provenance) === "invite" &&
					(row.status === "active" || row.status === "reviewed_active") &&
					!validIdentityIds.has(row.identity_id),
			)
		) {
			activationError("team_setup_conflict");
		}
	}

	if (
		!isLegacyTeamProjectCanonicalStateValid({
			teamId,
			scopeIds,
			groupScopeIds,
			projects: projects.map((project) => ({
				sourceProjectIdentity: project.source_project_identity,
				resolvedProjectIdentity: project.resolved_project_identity,
			})),
			mappings: model.mappings.map((mapping) => ({
				workspaceIdentity: mapping.workspace_identity,
				projectPattern: mapping.project_pattern,
				scopeId: mapping.scope_id,
				source: mapping.source,
			})),
			recipients: recipients.map((recipient) => ({
				canonicalProjectIdentity: recipient.canonical_project_identity,
				recipientKind: recipient.recipient_kind,
				recipientId: recipient.recipient_id,
				status: recipient.status,
			})),
		})
	) {
		activationError("team_setup_conflict");
	}
}

/**
 * Adopts a Team materialized by the removed `choose_recipients` migration path
 * only when its exact canonical state is explained by the saved resolutions
 * that selected this candidate: the stored source fingerprint, complete active
 * membership set, and complete active recipient-edge set must all equal the
 * aggregate produced by those resolutions. Anything unexplained fails closed.
 */
function validateHistoricalTeamAdoption(model: ActivationModel): void {
	const { historicalResolutions, memberships, recipients, team, teamId } = model;
	if (!team || historicalResolutions.length === 0) activationError("team_setup_conflict");
	const resolutionFingerprints = new Set(
		historicalResolutions.map((resolution) => resolution.sourceFingerprint),
	);
	if (!team.source_fingerprint || !resolutionFingerprints.has(team.source_fingerprint)) {
		activationError("team_setup_conflict");
	}
	const expectedMembers = [
		...new Set(historicalResolutions.flatMap((resolution) => resolution.memberIds)),
	].toSorted(compareText);
	// Active invite-owned memberships added after the historical migration are
	// legitimate and preserved by activation; only the resolution-owned subset
	// must match the saved aggregate exactly.
	if (
		memberships.some(
			(row) =>
				(row.status !== "active" && row.status !== "revoked" && row.status !== "reviewed_active") ||
				((row.status === "active" || row.status === "reviewed_active") &&
					row.provenance !== HISTORICAL_TEAM_PROVENANCE &&
					classifyTeamPolicyOwnership(row.provenance) !== "invite"),
		)
	) {
		activationError("team_setup_conflict");
	}
	const activeMembers = memberships
		.filter((row) => row.status === "active" && row.provenance === HISTORICAL_TEAM_PROVENANCE)
		.map((row) => row.identity_id)
		.toSorted(compareText);
	if (JSON.stringify(activeMembers) !== JSON.stringify(expectedMembers)) {
		activationError("team_setup_conflict");
	}
	const expectedProjects = [
		...new Set(historicalResolutions.map((resolution) => resolution.projectIdentity)),
	].toSorted(compareText);
	const historicalProjects = recipients
		.filter(
			(row) =>
				row.recipient_kind === "team" && row.recipient_id === teamId && row.status === "active",
		)
		.map((row) => row.canonical_project_identity)
		.toSorted(compareText);
	if (JSON.stringify(historicalProjects) !== JSON.stringify(expectedProjects)) {
		activationError("team_setup_conflict");
	}
}

function validateAssignmentExpectations(model: ActivationModel): void {
	const assignments = new Map(model.assignments.map((row) => [row.device_id, row]));
	for (const device of model.devices) {
		const assignment = assignments.get(device.device_id);
		if (
			!isStoredLegacyTeamAssignmentExpectationWellFormed({
				kind: device.expected_assignment_kind,
				identityId: device.existing_identity_id,
				assignmentVersion: device.expected_assignment_version,
			})
		) {
			activationError("team_setup_incomplete");
		}
		if (device.expected_assignment_kind === "absent") {
			if (assignment) activationError("team_setup_assignment_changed");
			continue;
		}
		if (
			!assignment ||
			(device.decision === "included" && assignment.status !== "active") ||
			assignment.identity_id !== device.existing_identity_id ||
			assignment.assignment_version !== device.expected_assignment_version
		) {
			activationError("team_setup_assignment_changed");
		}
	}
}

interface DerivationRows {
	identities: Array<{ identityId: string; status: string; mergedIntoIdentityId: string | null }>;
	teams: Array<{ teamId: string; status: string; deviceEligibilityMode: string }>;
	teamMemberships: Array<{
		teamId: string;
		identityId: string;
		status: string;
		provenance: string;
	}>;
	teamDeviceDecisions: Array<{
		teamId: string;
		deviceId: string;
		decision: string;
		assignmentVersion: number;
		provenance: string;
	}>;
	identityDevices: Array<{
		identityId: string;
		deviceId: string;
		status: string;
		assignmentVersion: number;
	}>;
	projectRecipients: Array<{
		canonicalProjectIdentity: string;
		recipientKind: string;
		recipientId: string;
		status: string;
		provenance: string;
	}>;
}

function currentDerivationRows(model: ActivationModel): DerivationRows {
	return {
		identities: model.identities.map((row) => ({
			identityId: row.actor_id,
			status: row.status,
			mergedIntoIdentityId: row.merged_into_actor_id,
		})),
		teams: model.allTeams.map((row) => ({
			teamId: row.team_id,
			status: row.status,
			deviceEligibilityMode: row.device_eligibility_mode,
		})),
		teamMemberships: model.allMemberships.map((row) => ({
			teamId: row.team_id,
			identityId: row.identity_id,
			status: row.status,
			provenance: row.provenance,
		})),
		teamDeviceDecisions: model.allDecisions.map((row) => ({
			teamId: row.team_id,
			deviceId: row.device_id,
			decision: row.decision,
			assignmentVersion: row.assignment_version,
			provenance: row.provenance,
		})),
		identityDevices: model.assignments.map((row) => ({
			identityId: row.identity_id,
			deviceId: row.device_id,
			status: row.status,
			assignmentVersion: row.assignment_version,
		})),
		projectRecipients: model.recipients.map((row) => ({
			canonicalProjectIdentity: row.canonical_project_identity,
			recipientKind: row.recipient_kind,
			recipientId: row.recipient_id,
			status: row.status,
			provenance: row.provenance,
		})),
	};
}

/**
 * Projects the canonical rows this activation will commit: reassigned or
 * inserted assignments (the assignment trigger bumps versions on identity
 * change), the converted Team, reconciled memberships, draft decisions,
 * cross-Team included-decision invalidation, and new recipient edges.
 */
function simulatedDerivationRows(model: ActivationModel): DerivationRows {
	const current = currentDerivationRows(model);
	const identityDevices = new Map(current.identityDevices.map((row) => [row.deviceId, { ...row }]));
	const reassignedDeviceIds = new Set<string>();
	for (const device of model.devices) {
		if (device.decision !== "included" || !device.target_identity_id) continue;
		const existing = identityDevices.get(device.device_id);
		const active = existing?.status === "active" ? existing : null;
		if (active && active.identityId !== device.target_identity_id) {
			reassignedDeviceIds.add(device.device_id);
		}
		identityDevices.set(device.device_id, {
			identityId: device.target_identity_id,
			deviceId: device.device_id,
			status: "active",
			assignmentVersion: active
				? active.identityId === device.target_identity_id
					? active.assignmentVersion
					: active.assignmentVersion + 1
				: 0,
		});
	}

	const teams = current.teams.filter((team) => team.teamId !== model.teamId);
	teams.push({
		teamId: model.teamId,
		status: "active",
		deviceEligibilityMode: "reviewed_allowlist",
	});
	const reviewedModeTeamIds = new Set(
		teams
			.filter((team) => team.deviceEligibilityMode === "reviewed_allowlist")
			.map((t) => t.teamId),
	);

	const desired = new Set(model.desiredIdentityIds);
	const teamMemberships: DerivationRows["teamMemberships"] = [];
	const seenThisTeamMembers = new Set<string>();
	for (const row of model.allMemberships) {
		if (row.team_id !== model.teamId) {
			teamMemberships.push({
				teamId: row.team_id,
				identityId: row.identity_id,
				status: row.status,
				provenance: row.provenance,
			});
			continue;
		}
		seenThisTeamMembers.add(row.identity_id);
		const transition = planSetupMembershipTransition(row, desired.has(row.identity_id));
		const status =
			transition === "upsert_setup" || transition === "normalize_invite"
				? "reviewed_active"
				: transition === "revoke_setup"
					? "revoked"
					: row.status;
		teamMemberships.push({
			teamId: model.teamId,
			identityId: row.identity_id,
			status,
			provenance: row.provenance,
		});
	}
	for (const identityId of model.desiredIdentityIds) {
		if (!seenThisTeamMembers.has(identityId)) {
			teamMemberships.push({
				teamId: model.teamId,
				identityId,
				status: "reviewed_active",
				provenance: SETUP_MEMBERSHIP_PROVENANCE,
			});
		}
	}

	const decisionKey = (teamId: string, deviceId: string) => `${teamId}\u0000${deviceId}`;
	const teamDeviceDecisions = new Map(
		current.teamDeviceDecisions.map((row) => [decisionKey(row.teamId, row.deviceId), { ...row }]),
	);
	for (const row of teamDeviceDecisions.values()) {
		if (
			row.teamId !== model.teamId &&
			row.decision === "included" &&
			reassignedDeviceIds.has(row.deviceId) &&
			reviewedModeTeamIds.has(row.teamId)
		) {
			row.decision = "unresolved";
		}
	}
	const draftDevices = new Map(model.devices.map((device) => [device.device_id, device]));
	for (const row of model.allDecisions) {
		if (row.team_id !== model.teamId) continue;
		const draftDevice = draftDevices.get(row.device_id);
		if (draftDevice && draftDevice.decision !== "removed") continue;
		const transition = planSetupDeviceDecisionTransition(row, {
			belongsToRoster: Boolean(draftDevice),
		});
		const key = decisionKey(row.team_id, row.device_id);
		if (transition === "delete_setup") teamDeviceDecisions.delete(key);
		if (transition === "settle_invite_excluded") {
			const preserved = teamDeviceDecisions.get(key);
			if (preserved) preserved.decision = "excluded";
		}
	}
	for (const device of model.devices) {
		if (device.decision === "removed") continue;
		const key = decisionKey(model.teamId, device.device_id);
		const existing = teamDeviceDecisions.get(key);
		const desiredDecision = device.decision === "included" ? "included" : "excluded";
		const transition = planSetupDeviceDecisionTransition(existing, {
			desiredDecision,
			belongsToRoster: true,
		});
		if (transition === "preserve") continue;
		teamDeviceDecisions.set(key, {
			teamId: model.teamId,
			deviceId: device.device_id,
			decision: desiredDecision,
			assignmentVersion: identityDevices.get(device.device_id)?.assignmentVersion ?? 0,
			provenance:
				transition === "upsert_preserving_invite"
					? (existing?.provenance ?? "team_invite")
					: "reviewed_team_setup",
		});
	}

	const projectRecipients = current.projectRecipients.map((row) => ({ ...row }));
	for (const project of model.projects) {
		const resolvedIdentity = project.resolved_project_identity as string;
		const existing = projectRecipients.find(
			(row) =>
				row.canonicalProjectIdentity === resolvedIdentity &&
				row.recipientKind === "team" &&
				row.recipientId === model.teamId,
		);
		if (existing) existing.status = "active";
		else {
			projectRecipients.push({
				canonicalProjectIdentity: resolvedIdentity,
				recipientKind: "team",
				recipientId: model.teamId,
				status: "active",
				provenance: "reviewed_team_setup",
			});
		}
	}
	// A repeat setup whose refreshed inventory dropped or re-resolved a
	// Project must revoke the stale setup-owned edge; independently owned
	// edges (for example `review_resolution`) are preserved.
	const activeResolvedIdentities = new Set(
		model.projects.map((project) => project.resolved_project_identity as string),
	);
	for (const row of projectRecipients) {
		if (
			row.recipientKind === "team" &&
			row.recipientId === model.teamId &&
			row.provenance === "reviewed_team_setup" &&
			row.status === "active" &&
			!activeResolvedIdentities.has(row.canonicalProjectIdentity)
		) {
			row.status = "revoked";
		}
	}

	return {
		identities: current.identities,
		teams,
		teamMemberships,
		teamDeviceDecisions: [...teamDeviceDecisions.values()],
		identityDevices: [...identityDevices.values()],
		projectRecipients,
	};
}

function effectiveDeviceIds(rows: DerivationRows, canonicalProjectIdentity: string): Set<string> {
	const derivation = deriveRecipientPolicyEffectiveDevices({
		canonicalProjectIdentity,
		projectRecipients: rows.projectRecipients,
		identities: rows.identities,
		teams: rows.teams,
		teamMemberships: rows.teamMemberships,
		teamDeviceDecisions: rows.teamDeviceDecisions,
		identityDevices: rows.identityDevices,
	});
	return new Set(derivation.devices.map((device) => device.deviceId));
}

function buildAccessDelta(model: ActivationModel): LegacyTeamSetupAccessDeltaV1 {
	const accessDelta: LegacyTeamSetupAccessDeltaV1 = {
		teamChanges: [],
		membershipChanges: [],
		projectChanges: [],
		recipientChanges: [],
		deviceAccessChanges: [],
	};
	if (!model.team) {
		accessDelta.teamChanges.push({
			teamId: model.teamId,
			change: "add",
			fromDeviceEligibilityMode: null,
			toDeviceEligibilityMode: "reviewed_allowlist",
		});
	} else if (model.team.device_eligibility_mode !== "reviewed_allowlist") {
		accessDelta.teamChanges.push({
			teamId: model.teamId,
			change: "update",
			fromDeviceEligibilityMode: "person_all_devices",
			toDeviceEligibilityMode: "reviewed_allowlist",
		});
	}

	const memberships = new Map(model.memberships.map((row) => [row.identity_id, row]));
	for (const identityId of model.desiredIdentityIds) {
		const current = memberships.get(identityId);
		const transition = planSetupMembershipTransition(current, true);
		if (
			transition === "upsert_setup" &&
			(!current || !["active", "reviewed_active"].includes(current.status))
		) {
			accessDelta.membershipChanges.push({ teamId: model.teamId, identityId, change: "add" });
		} else if (
			(transition === "upsert_setup" || transition === "normalize_invite") &&
			current?.status === "active"
		) {
			accessDelta.membershipChanges.push({ teamId: model.teamId, identityId, change: "update" });
		}
	}
	for (const membership of model.memberships) {
		if (model.desiredIdentityIds.includes(membership.identity_id)) continue;
		const transition = planSetupMembershipTransition(membership, false);
		if (transition === "revoke_setup") {
			accessDelta.membershipChanges.push({
				teamId: model.teamId,
				identityId: membership.identity_id,
				change: "remove",
			});
		} else if (transition === "normalize_invite") {
			accessDelta.membershipChanges.push({
				teamId: model.teamId,
				identityId: membership.identity_id,
				change: "update",
			});
		}
	}

	// Two Project rows explicitly resolved to the same canonical identity
	// materialize a single recipient edge, so the confirmed delta must list
	// that addition once; duplicating it would misrepresent the canonical
	// mutation and change the confirmation digest.
	const plannedRecipientIdentities = new Set<string>();
	for (const project of model.projects) {
		const resolvedIdentity = project.resolved_project_identity as string;
		const mapping = model.mappings.find(
			(row) =>
				row.project_pattern === project.source_project_identity &&
				row.workspace_identity === resolvedIdentity &&
				model.scopeIds.includes(row.scope_id),
		);
		if (!mapping) {
			// A re-resolution supersedes the prior setup-owned mapping in
			// place; the confirmed payload must present it as the update it
			// is, not a fresh addition from nothing.
			const superseded = model.mappings.find(
				(row) =>
					row.project_pattern === project.source_project_identity &&
					row.source === "reviewed_team_setup" &&
					model.groupScopeIds.includes(row.scope_id) &&
					row.workspace_identity != null,
			);
			accessDelta.projectChanges.push({
				projectRef: project.project_ref,
				fromProjectIdentity: superseded?.workspace_identity ?? null,
				toProjectIdentity: resolvedIdentity,
				change: superseded ? "update" : "add",
			});
		}
		const recipient = model.recipients.find(
			(row) =>
				row.canonical_project_identity === resolvedIdentity &&
				row.recipient_kind === "team" &&
				row.recipient_id === model.teamId &&
				row.status === "active",
		);
		if (!recipient && !plannedRecipientIdentities.has(resolvedIdentity)) {
			plannedRecipientIdentities.add(resolvedIdentity);
			accessDelta.recipientChanges.push({
				canonicalProjectIdentity: resolvedIdentity,
				recipientKind: "team",
				recipientId: model.teamId,
				change: "add",
			});
		}
	}
	// Mapping cleanup is independently authorization-relevant: scope stamping
	// consults these rows without considering recipient status. Represent every
	// setup-owned deletion in the server-derived payload so it participates in
	// the same confirmation digest as the mutation it simulates.
	for (const mapping of droppedSetupMappings(model)) {
		accessDelta.projectChanges.push({
			projectRef: legacyTeamProjectRef(model.draft.candidate_id, mapping.project_pattern),
			fromProjectIdentity: mapping.workspace_identity,
			toProjectIdentity: null,
			change: "remove",
		});
	}
	// Stale setup-owned edges are revoked by this activation; the confirmed
	// delta must list the removal, or the user would approve a payload that
	// omits an access change the commit performs.
	const confirmedResolvedIdentities = new Set(
		model.projects.map((project) => project.resolved_project_identity as string),
	);
	for (const row of model.recipients) {
		if (
			row.recipient_kind === "team" &&
			row.recipient_id === model.teamId &&
			row.provenance === "reviewed_team_setup" &&
			row.status === "active" &&
			!confirmedResolvedIdentities.has(row.canonical_project_identity)
		) {
			accessDelta.recipientChanges.push({
				canonicalProjectIdentity: row.canonical_project_identity,
				recipientKind: "team",
				recipientId: model.teamId,
				change: "remove",
			});
		}
	}
	// Users confirm this payload as the effective-access delta, so device
	// changes are derived across every recipient path — direct identities,
	// this Team, and every other Team affected by reassignment invalidation —
	// using the authoritative reconciliation rules for both states.
	const beforeRows = currentDerivationRows(model);
	const afterRows = simulatedDerivationRows(model);
	const projectIdentities = new Set([
		...model.projects.map((project) => project.resolved_project_identity as string),
		...model.recipients
			.filter((row) => row.status === "active")
			.map((row) => row.canonical_project_identity),
	]);
	for (const projectIdentity of projectIdentities) {
		const before = effectiveDeviceIds(beforeRows, projectIdentity);
		const after = effectiveDeviceIds(afterRows, projectIdentity);
		for (const deviceId of after) {
			if (!before.has(deviceId)) {
				accessDelta.deviceAccessChanges.push({
					canonicalProjectIdentity: projectIdentity,
					deviceId,
					change: "add",
				});
			}
		}
		for (const deviceId of before) {
			if (!after.has(deviceId)) {
				accessDelta.deviceAccessChanges.push({
					canonicalProjectIdentity: projectIdentity,
					deviceId,
					change: "remove",
				});
			}
		}
	}
	accessDelta.membershipChanges.sort(
		(left, right) =>
			compareText(left.identityId, right.identityId) || compareText(left.change, right.change),
	);
	accessDelta.projectChanges.sort(
		(left, right) =>
			compareText(left.projectRef, right.projectRef) ||
			compareText(left.fromProjectIdentity ?? "", right.fromProjectIdentity ?? "") ||
			compareText(left.toProjectIdentity ?? "", right.toProjectIdentity ?? "") ||
			compareText(left.change, right.change),
	);
	accessDelta.recipientChanges.sort((left, right) =>
		compareText(left.canonicalProjectIdentity, right.canonicalProjectIdentity),
	);
	accessDelta.deviceAccessChanges.sort(
		(left, right) =>
			compareText(left.canonicalProjectIdentity, right.canonicalProjectIdentity) ||
			compareText(left.deviceId, right.deviceId) ||
			compareText(left.change, right.change),
	);
	return accessDelta;
}

function buildPreview(model: ActivationModel): LegacyTeamSetupActivationPreviewV1 {
	const accessDelta = buildAccessDelta(model);
	const accessDeltaDigest = recipientPolicyDigest("legacy-team-access-delta", accessDelta);
	const finishDigest = recipientPolicyDigest("legacy-team-activation-finish-v1", {
		attemptId: model.draft.attempt_id,
		candidateRef: model.draft.candidate_id,
		draftFinishDigest: model.draft.finish_digest,
		rosterFingerprint: model.draft.roster_fingerprint,
		projectionFingerprint: model.draft.projection_fingerprint,
		canonicalSnapshot: {
			// The active scope set determines where new mappings land; replacing a
			// scope between preview and finish must invalidate the confirmation.
			scopeIds: model.scopeIds,
			team: model.team,
			memberships: model.memberships,
			assignments: model.assignments,
			decisions: model.decisions,
			mappings: model.mappings,
			recipients: model.recipients,
			allTeams: model.allTeams,
			allMemberships: model.allMemberships,
			allDecisions: model.allDecisions,
			identities: model.identities,
			historicalResolutions: model.historicalResolutions,
		},
		accessDeltaDigest,
		accessDelta,
	});
	return {
		candidateRef: model.draft.candidate_id,
		attemptId: model.draft.attempt_id,
		finishDigest,
		accessDeltaDigest,
		accessDelta,
	};
}

export function previewLegacyTeamSetupActivation(
	db: Database,
	input: PreviewLegacyTeamSetupActivationInput,
): LegacyTeamSetupActivationPreviewV1 {
	try {
		return buildPreview(loadModel(db, input));
	} catch (error) {
		const normalized = normalizedActivationError(error);
		persistSafeError(db, input, normalized);
		throw normalized;
	}
}

function exactReplay(
	db: Database,
	input: Pick<
		FinishLegacyTeamSetupActivationInput,
		"candidateRef" | "attemptId" | "finishDigest" | "confirmedAccessDeltaDigest"
	>,
): LegacyTeamSetupActivationResultV1 | null {
	const row = db
		.prepare(
			`SELECT response_json FROM legacy_team_setup_completions
			 WHERE candidate_ref = ? AND attempt_id = ? AND finish_digest = ?
			   AND confirmed_access_delta_digest = ?`,
		)
		.get(
			input.candidateRef,
			input.attemptId,
			input.finishDigest,
			input.confirmedAccessDeltaDigest,
		) as CompletionRow | undefined;
	return row ? (JSON.parse(row.response_json) as LegacyTeamSetupActivationResultV1) : null;
}

function validateFreshRoster(
	model: ActivationModel,
	freshRoster: Awaited<ReturnType<FinishLegacyTeamSetupActivationInput["loadFreshRoster"]>>,
): void {
	if (freshRoster.length > LEGACY_TEAM_SETUP_MAX_DEVICES) {
		activationError("team_setup_roster_changed");
	}
	// Draft creation fingerprints a device's identity only from an active
	// assignment (`identityId: assignment?.active ? ... : null`). An inactive
	// row's stored identity must not contribute here, or an unchanged fresh
	// roster would always mismatch and finish could never succeed.
	const existingIdentities = new Map(
		model.devices.map((device) => [
			device.device_id,
			device.verified_evidence_kind === "active_assignment" ? device.existing_identity_id : null,
		]),
	);
	const freshFingerprint = legacyTeamRosterFingerprint(
		freshRoster.map((device) => ({
			deviceId: device.deviceId,
			fingerprint: device.fingerprint,
			enabled: device.enabled,
			identityId: existingIdentities.get(device.deviceId) ?? null,
		})),
	);
	if (freshFingerprint !== model.draft.roster_fingerprint) {
		activationError("team_setup_roster_changed");
	}
}

function applyActivation(
	db: Database,
	model: ActivationModel,
	preview: LegacyTeamSetupActivationPreviewV1,
	freshRoster: Awaited<ReturnType<FinishLegacyTeamSetupActivationInput["loadFreshRoster"]>>,
	now: string,
): LegacyTeamSetupActivationResultV1 {
	const revision = recipientPolicyDigest(
		"legacy-team-activation-revision-v1",
		preview.finishDigest,
	);
	if (!model.team) {
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance, revision,
			 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, 'active', 'reviewed_allowlist', 'reviewed_team_candidate', ?,
			 'completed', ?, ?, ?, ?)`,
		).run(
			model.teamId,
			model.draft.display_name,
			revision,
			model.draft.roster_fingerprint,
			recipientPolicyDigest("legacy-team-activation-team-v1", model.teamId),
			now,
			now,
		);
	} else {
		db.prepare(
			`UPDATE policy_teams
			 SET display_name = ?, status = 'active', device_eligibility_mode = 'reviewed_allowlist',
			     provenance = 'reviewed_team_candidate', revision = ?, migration_state = 'completed',
			     source_fingerprint = ?, updated_at = ?
			 WHERE team_id = ?`,
		).run(model.draft.display_name, revision, model.draft.roster_fingerprint, now, model.teamId);
	}

	const assignmentVersions = new Map<string, number>();
	for (const device of model.devices) {
		if (device.decision !== "included" || !device.target_identity_id) continue;
		const expectation =
			device.expected_assignment_kind === "existing" &&
			device.existing_identity_id &&
			device.expected_assignment_version != null
				? {
						kind: "existing" as const,
						identityId: device.existing_identity_id,
						assignmentVersion: device.expected_assignment_version,
					}
				: { kind: "absent" as const };
		const assignment = assignIdentityDeviceInTransaction(db, {
			deviceId: device.device_id,
			targetIdentityId: device.target_identity_id,
			expectation,
			insert: {
				displayName: device.display_name,
				provenance: "reviewed_team_setup",
				revision,
				migrationState: "completed",
				sourceFingerprint: device.key_fingerprint,
				idempotencyKey: recipientPolicyDigest("legacy-team-assignment-v1", device.device_id),
			},
			now,
		});
		assignmentVersions.set(device.device_id, assignment.assignmentVersion);
	}
	// The completed setup must read as Ready afterwards: assignment writes above
	// legitimately change the roster fingerprint (a newly assigned device now
	// carries its identity), and reassignment invalidation clears the Team's
	// source_fingerprint. Persist the post-activation fingerprint on both the
	// Team and (later) the completed draft so the next discovery, which
	// fingerprints the same fresh roster against the new canonical assignments,
	// matches instead of reopening a successful setup.
	const activeIdentityForDevice = db.prepare(
		"SELECT identity_id FROM identity_devices WHERE device_id = ? AND status = 'active' LIMIT 1",
	);
	const postRosterFingerprint = legacyTeamRosterFingerprint(
		freshRoster.map((device) => ({
			deviceId: device.deviceId,
			fingerprint: device.fingerprint,
			enabled: device.enabled,
			identityId:
				(activeIdentityForDevice.pluck().get(device.deviceId) as string | undefined) ?? null,
		})),
	);
	db.prepare(
		"UPDATE policy_teams SET source_fingerprint = ?, updated_at = ? WHERE team_id = ?",
	).run(postRosterFingerprint, now, model.teamId);
	const existingMemberships = new Map(
		model.allMemberships
			.filter((row) => row.team_id === model.teamId)
			.map((row) => [row.identity_id, row]),
	);
	const desiredIdentityIds = new Set(model.desiredIdentityIds);
	for (const identityId of model.desiredIdentityIds) {
		const transition = planSetupMembershipTransition(existingMemberships.get(identityId), true);
		if (transition !== "upsert_setup") continue;
		db.prepare(
			`INSERT INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, 'member', 'reviewed_active', ?, ?, 'completed', ?, ?, ?, ?)
			 ON CONFLICT(team_id, identity_id) DO UPDATE SET
			 role = 'member', status = 'reviewed_active', provenance = excluded.provenance,
			 revision = excluded.revision, migration_state = 'completed',
			 source_fingerprint = excluded.source_fingerprint,
			 updated_at = excluded.updated_at`,
		).run(
			model.teamId,
			identityId,
			SETUP_MEMBERSHIP_PROVENANCE,
			revision,
			model.draft.roster_fingerprint,
			recipientPolicyDigest("legacy-team-membership-v1", [model.teamId, identityId]),
			now,
			now,
		);
	}
	for (const membership of existingMemberships.values()) {
		const transition = planSetupMembershipTransition(
			membership,
			desiredIdentityIds.has(membership.identity_id),
		);
		if (transition === "normalize_invite") {
			db.prepare(
				`UPDATE policy_team_memberships SET status = 'reviewed_active', updated_at = ?
				 WHERE team_id = ? AND identity_id = ?`,
			).run(now, model.teamId, membership.identity_id);
		}
		if (transition === "revoke_setup") {
			db.prepare(
				`UPDATE policy_team_memberships SET status = 'revoked', revision = ?, updated_at = ?
				 WHERE team_id = ? AND identity_id = ?`,
			).run(revision, now, model.teamId, membership.identity_id);
		}
	}

	const existingDecisions = new Map(
		model.allDecisions
			.filter((row) => row.team_id === model.teamId)
			.map((row) => [row.device_id, row]),
	);
	const draftDevices = new Map(model.devices.map((device) => [device.device_id, device]));
	for (const decision of existingDecisions.values()) {
		const draftDevice = draftDevices.get(decision.device_id);
		if (draftDevice && draftDevice.decision !== "removed") continue;
		const transition = planSetupDeviceDecisionTransition(decision, {
			belongsToRoster: Boolean(draftDevice),
		});
		if (transition === "delete_setup") {
			db.prepare(
				"DELETE FROM policy_team_device_decisions WHERE team_id = ? AND device_id = ?",
			).run(model.teamId, decision.device_id);
		}
		if (transition === "settle_invite_excluded") {
			db.prepare(
				`UPDATE policy_team_device_decisions SET decision = 'excluded', updated_at = ?
				 WHERE team_id = ? AND device_id = ? AND decision <> 'excluded'`,
			).run(now, model.teamId, decision.device_id);
		}
	}
	for (const device of model.devices) {
		if (device.decision === "removed") continue;
		const desiredDecision = device.decision === "included" ? "included" : "excluded";
		const transition = planSetupDeviceDecisionTransition(existingDecisions.get(device.device_id), {
			desiredDecision,
			belongsToRoster: true,
		});
		if (transition === "preserve") continue;
		const preserveInviteOwnership = transition === "upsert_preserving_invite" ? 1 : 0;
		const assignmentVersion =
			device.decision === "included"
				? assignmentVersions.get(device.device_id)
				: (model.assignments.find((row) => row.device_id === device.device_id)
						?.assignment_version ?? 0);
		if (assignmentVersion == null) activationError("team_setup_assignment_changed");
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
			 team_id, device_id, decision, assignment_version, provenance, revision, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, 'reviewed_team_setup', ?, ?, ?)
			 ON CONFLICT(team_id, device_id) DO UPDATE SET
			 decision = excluded.decision, assignment_version = excluded.assignment_version,
			 provenance = CASE
			   WHEN ? = 1
			     THEN policy_team_device_decisions.provenance
			   ELSE excluded.provenance
			 END,
			 revision = CASE
			   WHEN ? = 1
			     THEN policy_team_device_decisions.revision
			   ELSE excluded.revision
			 END,
			 updated_at = excluded.updated_at`,
		).run(
			model.teamId,
			device.device_id,
			desiredDecision,
			assignmentVersion,
			revision,
			now,
			now,
			preserveInviteOwnership,
			preserveInviteOwnership,
		);
	}

	for (const project of model.projects) {
		const resolvedIdentity = project.resolved_project_identity as string;
		const mapping = model.mappings.find(
			(row) =>
				row.project_pattern === project.source_project_identity &&
				row.workspace_identity === resolvedIdentity &&
				model.scopeIds.includes(row.scope_id),
		);
		if (!mapping) {
			const targetScopeId = model.scopeIds.length === 1 ? model.scopeIds[0] : null;
			if (!targetScopeId) activationError("team_setup_conflict");
			// A reviewed re-resolution supersedes the prior activation's
			// setup-owned mapping in place; inserting a second row for the
			// same source would leave a stale boundary competing on priority.
			const staleSetupMapping = model.mappings.find(
				(row) =>
					row.project_pattern === project.source_project_identity &&
					row.source === "reviewed_team_setup" &&
					// Never retarget another group's setup mapping: ownership is
					// proven by the mapping's scope belonging to this group.
					model.groupScopeIds.includes(row.scope_id),
			);
			if (staleSetupMapping) {
				db.prepare(
					`UPDATE project_scope_mappings
					 SET workspace_identity = ?, scope_id = ?, updated_at = ?
					 WHERE id = ?`,
				).run(resolvedIdentity, targetScopeId, now, staleSetupMapping.id);
			} else {
				db.prepare(
					`INSERT INTO project_scope_mappings(
					 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
					 ) VALUES (?, ?, ?, 1000, 'reviewed_team_setup', ?, ?)`,
				).run(resolvedIdentity, project.source_project_identity, targetScopeId, now, now);
			}
		}
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, source_fingerprint, idempotency_key,
			 created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', ?, 'completed', ?, ?, ?, ?)
			 ON CONFLICT(canonical_project_identity, recipient_kind, recipient_id) DO UPDATE SET
			 status = 'active',
			 provenance = CASE
			   WHEN project_recipients.provenance = 'reviewed_team_setup' THEN excluded.provenance
			   ELSE project_recipients.provenance
			 END,
			 policy_revision = CASE
			   WHEN project_recipients.provenance = 'reviewed_team_setup' THEN excluded.policy_revision
			   ELSE project_recipients.policy_revision
			 END,
			 migration_state = CASE
			   WHEN project_recipients.provenance = 'reviewed_team_setup' THEN 'completed'
			   ELSE project_recipients.migration_state
			 END,
			 source_fingerprint = CASE
			   WHEN project_recipients.provenance = 'reviewed_team_setup' THEN excluded.source_fingerprint
			   ELSE project_recipients.source_fingerprint
			 END,
			 updated_at = excluded.updated_at`,
		).run(
			resolvedIdentity,
			model.teamId,
			revision,
			project.source_fingerprint,
			recipientPolicyDigest("legacy-team-project-recipient-v1", [resolvedIdentity, model.teamId]),
			now,
			now,
		);
	}

	// A repeat setup whose refreshed inventory dropped or re-resolved a
	// Project must revoke the stale setup-owned edge, mirroring the
	// simulation; independently owned edges (for example `review_resolution`)
	// are preserved.
	const committedResolvedIdentities = model.projects.map(
		(project) => project.resolved_project_identity as string,
	);
	db.prepare(
		`UPDATE project_recipients
		 SET status = 'revoked', policy_revision = ?, updated_at = ?
		 WHERE recipient_kind = 'team' AND recipient_id = ?
		   AND provenance = 'reviewed_team_setup' AND status = 'active'
		   ${
					committedResolvedIdentities.length > 0
						? `AND canonical_project_identity NOT IN (${committedResolvedIdentities.map(() => "?").join(", ")})`
						: ""
}`,
	).run(revision, now, model.teamId, ...committedResolvedIdentities);
	// The dropped Project's setup-owned mapping must go too: scope stamping
	// resolves mappings independently of recipient status, so a surviving row
	// would keep routing new sessions and memories for the dropped Project
	// into the Team's coordinator scope despite the confirmed removal — and
	// could shadow mappings retained by merged resolutions.
	// Use the same locked-snapshot plan as the confirmation simulation. It
	// includes mappings on retired group scopes, while excluding every row not
	// owned by this setup/group.
	const droppedMappingIds = droppedSetupMappings(model).map((mapping) => mapping.id);
	if (droppedMappingIds.length > 0) {
		db.prepare(
			`DELETE FROM project_scope_mappings
			 WHERE id IN (${droppedMappingIds.map(() => "?").join(", ")})`,
		).run(...droppedMappingIds);
	}

	// The completion-bound mapping must be the SELECTED mapping. A
	// pre-existing higher-priority exact mapping for the resolved identity
	// (with a foreign pattern or a scope outside the group) would win
	// selection, leaving replication directed at another boundary while this
	// activation attaches the Team recipient and reports completion — which
	// the next readiness check would immediately reject. Verified after ALL
	// mapping writes because merged resolutions map several confirmed source
	// patterns onto one identity and selection can pick only one of them: the
	// authoritative pattern is valid when it matches ANY confirmed source.
	const confirmedSourcesByResolved = new Map<string, Set<string>>();
	for (const project of model.projects) {
		const resolvedIdentity = project.resolved_project_identity as string;
		const sources = confirmedSourcesByResolved.get(resolvedIdentity) ?? new Set();
		sources.add(project.source_project_identity);
		confirmedSourcesByResolved.set(resolvedIdentity, sources);
	}
	for (const [resolvedIdentity, sources] of confirmedSourcesByResolved) {
		const selected = selectedProjectScopeMapping(db, resolvedIdentity);
		if (
			!selected ||
			selected.workspaceIdentity == null ||
			!sources.has(selected.projectPattern) ||
			!model.scopeIds.includes(selected.scopeId)
		) {
			activationError("team_setup_conflict");
		}
	}

	const result: LegacyTeamSetupActivationResultV1 = {
		status: "completed",
		teamId: model.teamId,
		attemptId: model.draft.attempt_id,
		accessDeltaDigest: preview.accessDeltaDigest,
		completedAt: now,
	};
	db.prepare(
		`UPDATE legacy_team_setup_drafts
		 SET state = 'completed', finish_digest = ?, safe_error_code = NULL,
		     roster_fingerprint = ?, completed_team_id = ?, completed_at = ?, updated_at = ?
		 WHERE attempt_id = ?`,
	).run(
		preview.finishDigest,
		postRosterFingerprint,
		model.teamId,
		now,
		now,
		model.draft.attempt_id,
	);
	db.prepare(
		`INSERT INTO legacy_team_setup_completions(
		 attempt_id, finish_digest, candidate_ref, confirmed_access_delta_digest,
		 completed_team_id, response_json, completed_at, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		model.draft.attempt_id,
		preview.finishDigest,
		model.draft.candidate_id,
		preview.accessDeltaDigest,
		model.teamId,
		JSON.stringify(result),
		now,
		now,
	);
	return result;
}

export async function finishLegacyTeamSetupActivation(
	db: Database,
	input: FinishLegacyTeamSetupActivationInput,
): Promise<LegacyTeamSetupActivationResultV1> {
	const replay = exactReplay(db, input);
	if (replay) return replay;

	let initialModel: ActivationModel;
	let initialPreview: LegacyTeamSetupActivationPreviewV1;
	try {
		initialModel = loadModel(db, input);
		initialPreview = buildPreview(initialModel);
	} catch (error) {
		const normalized = normalizedActivationError(error);
		persistSafeError(db, input, normalized);
		throw normalized;
	}

	let freshRoster: Awaited<ReturnType<FinishLegacyTeamSetupActivationInput["loadFreshRoster"]>>;
	try {
		freshRoster = await input.loadFreshRoster();
	} catch {
		const overlappingReplay = db.transaction(() => exactReplay(db, input)).immediate();
		if (overlappingReplay) return overlappingReplay;
		const error = new LegacyTeamSetupActivationError("team_setup_roster_unavailable");
		persistSafeError(db, input, error);
		throw error;
	}
	try {
		validateFreshRoster(initialModel, freshRoster);
	} catch (error) {
		const normalized = normalizedActivationError(error);
		persistSafeError(db, input, normalized);
		throw normalized;
	}
	if (
		initialPreview.finishDigest !== input.finishDigest ||
		initialPreview.accessDeltaDigest !== input.confirmedAccessDeltaDigest
	) {
		const error = new LegacyTeamSetupActivationError("team_setup_confirmation_stale");
		persistSafeError(db, input, error);
		throw error;
	}

	const now = input.now ?? new Date().toISOString();
	try {
		return db
			.transaction(() => {
				const lockedReplay = exactReplay(db, input);
				if (lockedReplay) return lockedReplay;
				const model = loadModel(db, input);
				validateFreshRoster(model, freshRoster);
				// Displayed Project evidence that changed after preview would
				// produce a confirmed digest for an inventory the user never
				// saw. The inventory is derived inside this lock so ingestion
				// between an earlier read and the transaction cannot slip a
				// Project past the check; the roster, by contrast, is external
				// coordinator evidence and is re-validated against the locked
				// model above.
				const liveProjectionFingerprint = legacyTeamProjectionFingerprint(
					input.loadProjectInventory(),
				);
				if (liveProjectionFingerprint !== model.draft.projection_fingerprint) {
					activationError("team_setup_projection_changed");
				}
				const lockedPreview = buildPreview(model);
				if (
					lockedPreview.finishDigest !== input.finishDigest ||
					lockedPreview.accessDeltaDigest !== input.confirmedAccessDeltaDigest
				) {
					activationError("team_setup_confirmation_stale");
				}
				return applyActivation(db, model, lockedPreview, freshRoster, now);
			})
			.immediate();
	} catch (error) {
		const normalized = normalizedActivationError(error);
		persistSafeError(db, input, normalized);
		throw normalized;
	}
}
