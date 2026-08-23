import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import {
	isStoredLegacyTeamAssignmentExpectationWellFormed,
	isValidLegacyTeamAssignmentVersion,
	type StoredLegacyTeamAssignmentExpectation,
} from "./legacy-team-assignment-expectation.js";
import { isLegacyTeamProjectCanonicalStateValid } from "./legacy-team-project-canonical-preflight.js";
import {
	requireLegacyTeamSetupEffectiveDevicesWithinLimit,
	requireLegacyTeamSetupSnapshotWithinLimits,
} from "./legacy-team-setup-limits.js";
import {
	compareCodepoints,
	deterministicPolicyTeamId,
	legacyTeamRosterFingerprint,
	recipientPolicyDigest,
} from "./recipient-policy-identifiers.js";
import { canonicalWorkspaceIdentity } from "./scope-resolution.js";

export type LegacyTeamSetupDraftState = "needs_setup" | "in_progress" | "stale" | "completed";
export type LegacyTeamDeviceDecision = "unresolved" | "included" | "excluded" | "removed";
export type LegacyTeamProjectResolution = "unresolved" | "deterministic" | "explicit";
export type LegacyTeamAssignmentExpectation =
	| { kind: "absent" }
	| { kind: "existing"; assignmentVersion: number; identityId: string };

export interface LegacyTeamSetupRosterDeviceInput {
	deviceId: string;
	fingerprint: string;
	displayName: string;
	enabled: boolean;
}

export interface LegacyTeamSetupProjectInput {
	projectRef: string;
	sourceProjectIdentity: string;
	displayName: string;
	sourceFingerprint: string;
	deterministicProjectIdentity: string | null;
}

export interface LegacyTeamSetupDraftSnapshotInput {
	candidateId: string;
	coordinatorId: string;
	groupId: string;
	displayName: string;
	devices: LegacyTeamSetupRosterDeviceInput[];
	projects: LegacyTeamSetupProjectInput[];
	now?: string;
}

export interface LegacyTeamSetupDraftDeviceView {
	deviceRef: string;
	displayName: string;
	enabled: boolean;
	existingIdentityId: string | null;
	suggestedIdentityId: string | null;
	verifiedEvidenceKind: "active_assignment" | null;
	decision: LegacyTeamDeviceDecision;
	targetIdentityId: string | null;
	expectation: LegacyTeamAssignmentExpectation;
}

export interface LegacyTeamSetupDraftProjectView {
	projectRef: string;
	displayName: string;
	resolution: LegacyTeamProjectResolution;
	/**
	 * Opaque reference to the persisted migration target. Resumed clients can
	 * confirm and distinguish saved mappings by recomputing the digest for a
	 * candidate value; the raw identity (a Git URL or local path) never leaves
	 * the API surface.
	 */
	resolvedProjectRef: string | null;
}

export function legacyTeamResolvedProjectRef(
	projectRef: string,
	resolvedProjectIdentity: string,
): string {
	return recipientPolicyDigest("legacy-team-resolved-project-ref-v1", [
		projectRef,
		resolvedProjectIdentity,
	]);
}

export interface LegacyTeamSetupDraftView {
	attemptId: string;
	candidateRef: string;
	state: LegacyTeamSetupDraftState;
	displayName: string;
	finishDigest: string;
	canFinish: boolean;
	unresolvedDeviceCount: number;
	unresolvedProjectCount: number;
	devices: LegacyTeamSetupDraftDeviceView[];
	projects: LegacyTeamSetupDraftProjectView[];
}

interface DraftRow {
	attempt_id: string;
	candidate_id: string;
	state: LegacyTeamSetupDraftState;
	display_name: string;
	roster_fingerprint: string;
	projection_fingerprint: string;
}

interface DeviceRow {
	device_id: string;
	device_ref: string;
	key_fingerprint: string;
	display_name: string;
	enabled: number;
	existing_identity_id: string | null;
	existing_assignment_version: number | null;
	verified_evidence_kind: "active_assignment" | null;
	decision: LegacyTeamDeviceDecision;
	target_identity_id: string | null;
	expected_assignment_kind: "absent" | "existing" | null;
	expected_assignment_version: number | null;
}

interface ProjectRow {
	project_ref: string;
	source_project_identity: string;
	display_name: string;
	source_fingerprint: string;
	resolution_kind: LegacyTeamProjectResolution;
	resolved_project_identity: string | null;
}

function projectCanonicalStateValid(
	db: Database,
	draft: { candidate_id: string; coordinator_id: string; group_id: string },
	projects: ProjectRow[],
): boolean {
	if (projects.length === 0) return true;
	const sourceProjectIdentities = [
		...new Set(projects.map((project) => project.source_project_identity)),
	];
	const resolvedProjectIdentities = [
		...new Set(
			projects.flatMap((project) =>
				project.resolved_project_identity ? [project.resolved_project_identity] : [],
			),
		),
	];
	const scopeIds = db
		.prepare(
			`SELECT scope_id FROM replication_scopes
			 WHERE coordinator_id = ? AND group_id = ? AND status = 'active'
			 ORDER BY scope_id`,
		)
		.pluck()
		.all(draft.coordinator_id, draft.group_id) as string[];
	const groupScopeIds = db
		.prepare(
			`SELECT scope_id FROM replication_scopes
			 WHERE coordinator_id = ? AND group_id = ? ORDER BY scope_id`,
		)
		.pluck()
		.all(draft.coordinator_id, draft.group_id) as string[];
	const mappings = db
		.prepare(
			`SELECT workspace_identity, project_pattern, scope_id, source
			 FROM project_scope_mappings
			 WHERE project_pattern IN (${sourceProjectIdentities.map(() => "?").join(", ")})
			 ORDER BY id`,
		)
		.all(...sourceProjectIdentities) as Array<{
		workspace_identity: string | null;
		project_pattern: string;
		scope_id: string;
		source: string | null;
	}>;
	const recipients =
		resolvedProjectIdentities.length === 0
			? []
			: (db
					.prepare(
						`SELECT canonical_project_identity, recipient_kind, recipient_id, status
						 FROM project_recipients
						 WHERE canonical_project_identity IN (${resolvedProjectIdentities.map(() => "?").join(", ")})
						 ORDER BY canonical_project_identity, recipient_kind, recipient_id`,
					)
					.all(...resolvedProjectIdentities) as Array<{
					canonical_project_identity: string;
					recipient_kind: string;
					recipient_id: string;
					status: string;
				}>);

	return isLegacyTeamProjectCanonicalStateValid({
		teamId: deterministicPolicyTeamId(draft.candidate_id),
		scopeIds,
		groupScopeIds,
		projects: projects.map((project) => ({
			sourceProjectIdentity: project.source_project_identity,
			resolvedProjectIdentity: project.resolved_project_identity,
		})),
		mappings: mappings.map((mapping) => ({
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
	});
}

/**
 * Characters a display label may contain: letters, numbers, spaces, and a
 * small set of name punctuation. Everything else — separators (`/ \ : @ ~ $
 * %`), brackets, quotes — is what paths, URLs, endpoints, and hostnames are
 * made of, so their absence removes the entire leak surface at once.
 */
const SAFE_LABEL_PATTERN = /^[\p{L}\p{N} '&,.()_-]*$/u;

/**
 * Coordinator-supplied display labels are sanitized with an allowlist, not a
 * denylist: multiple review rounds each found one more denylisted shape (bare
 * IPs, `host:port`, dot-relative paths, rooted backslash paths), and forms
 * like `home/alice/projects` vs `50/50` or a dotless internal hostname vs a
 * product name are not separable by any pattern. Labels are display-only and
 * the fallbacks are meaningful, so the cheap failure mode is showing the
 * generic name — never exporting private topology. Anything that does not
 * match a conservative name grammar falls back:
 *
 * - NFKC-normalize first so full-width or compatibility lookalikes cannot
 *   smuggle separators past the grammar; strip every control and format
 *   character (zero-width joiners, bidi overrides) rather than only C0.
 * - Reject any character outside letters/numbers/space and `' & , . ( ) _ -`.
 * - Reject `.` squeezed between letters/numbers on both sides: that single
 *   rule removes hostnames, IPs, and dotted file names while keeping ordinary
 *   sentence punctuation like `v2 release.` intact.
 * - Reject labels embedding opaque lookup identifiers (coordinator, group,
 *   device, project references).
 */
function safeLabel(value: string, fallback: string, forbiddenIds: string[] = []): string {
	const sanitized = value
		.slice(0, 512)
		.normalize("NFKC")
		// Format characters (zero-width joiners, bidi controls) are removed
		// entirely so they cannot split an address or identifier into innocent
		// halves; control characters become word separators.
		.replace(/\p{Cf}/gu, "")
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 120)
		.trim();
	if (!sanitized) return fallback;
	if (!SAFE_LABEL_PATTERN.test(sanitized)) return fallback;
	if (/[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(sanitized)) return fallback;
	// Key-material markers are pure letters/hyphens, so the grammar alone
	// would keep surrounding text; fail closed on the markers themselves.
	if (/-----|\b(?:ssh|ecdsa|sk)-[\p{L}\p{N}-]+ /iu.test(sanitized)) return fallback;
	// Case-insensitively: identifiers such as key fingerprints are the same
	// identifier in any casing, and the coordinator controls the casing of
	// both the label and the identifier it embeds.
	const comparable = sanitized.toLowerCase();
	if (forbiddenIds.some((id) => id && comparable.includes(id.toLowerCase()))) return fallback;
	return sanitized;
}

interface DeviceAssignmentSnapshot {
	identityId: string;
	assignmentVersion: number;
	active: boolean;
}

/**
 * Reads the device's assignment row regardless of status. Canonical assignment
 * CAS treats any existing row as evidence, so an inactive row must never be
 * reported as an absent assignment.
 */
function assignmentForDevice(db: Database, deviceId: string): DeviceAssignmentSnapshot | null {
	const row = db
		.prepare(
			`SELECT identity_id, assignment_version, status
			 FROM identity_devices
			 WHERE device_id = ?
			 LIMIT 1`,
		)
		.get(deviceId) as
		| { identity_id: string; assignment_version: number; status: string }
		| undefined;
	return row
		? {
				identityId: row.identity_id,
				assignmentVersion: row.assignment_version,
				active: row.status === "active",
			}
		: null;
}

/**
 * Draft-side CAS: `absent` matches only when no row exists at all; `existing`
 * matches identity and version regardless of status, so a device whose row was
 * revoked can still be reviewed (excluded or removed). Including a device with
 * an inactive row is blocked separately, because canonical assignment CAS at
 * activation accepts only active rows.
 */
function assignmentMatchesExpectation(
	assignment: DeviceAssignmentSnapshot | null,
	expectation: StoredLegacyTeamAssignmentExpectation,
): boolean {
	if (expectation.kind === "absent") return assignment == null;
	return (
		expectation.kind === "existing" &&
		assignment != null &&
		assignment.identityId === expectation.identityId &&
		assignment.assignmentVersion === expectation.assignmentVersion
	);
}

function storedAssignmentRowMatchesLive(
	stored: {
		existing_identity_id: string | null;
		existing_assignment_version: number | null;
		verified_evidence_kind: "active_assignment" | null;
		expected_assignment_kind: "absent" | "existing" | null;
		expected_assignment_version: number | null;
	},
	assignment: DeviceAssignmentSnapshot | null,
	allowUnrepresentableLiveVersion: boolean,
): boolean {
	const copiedEvidenceMatches =
		stored.existing_identity_id === (assignment?.identityId ?? null) &&
		stored.existing_assignment_version === (assignment?.assignmentVersion ?? null) &&
		stored.verified_evidence_kind === (assignment?.active ? "active_assignment" : null);
	if (!copiedEvidenceMatches) return false;
	if (
		allowUnrepresentableLiveVersion &&
		assignment != null &&
		!isValidLegacyTeamAssignmentVersion(assignment.assignmentVersion)
	) {
		// Replacing the attempt can only copy the same malformed canonical
		// version. Keep it stable and fail closed until canonical data is fixed.
		return true;
	}
	const expectation = {
		kind: stored.expected_assignment_kind,
		identityId: stored.existing_identity_id,
		assignmentVersion: stored.expected_assignment_version,
	};
	return (
		isStoredLegacyTeamAssignmentExpectationWellFormed(expectation) &&
		assignmentMatchesExpectation(assignment, expectation)
	);
}

function deviceReference(candidateId: string, deviceId: string): string {
	return recipientPolicyDigest("legacy-team-device-ref-v1", [candidateId, deviceId]);
}

/**
 * Fingerprint of the completion-bound Project inventory. Discovery compares
 * this against the persisted `projection_fingerprint`, so there must be exactly
 * one implementation shared by the draft writer and candidate discovery.
 */
export function legacyTeamProjectionFingerprint(projects: LegacyTeamSetupProjectInput[]): string {
	return recipientPolicyDigest(
		"legacy-team-project-inventory-v1",
		projects
			.map((project) => ({
				projectRef: project.projectRef,
				sourceFingerprint: project.sourceFingerprint,
				deterministicProjectIdentity: project.deterministicProjectIdentity,
			}))
			.toSorted((left, right) => compareCodepoints(left.projectRef, right.projectRef)),
	);
}

/**
 * The latest attempt is selected by insertion order (`rowid`), never by
 * `created_at`: timestamps are caller-supplied, so a backward clock or an
 * earlier `now` on a replacement attempt must not hide the newer draft.
 */
function currentDraft(db: Database, candidateId: string): DraftRow | null {
	return (
		(db
			.prepare(
				`SELECT attempt_id, candidate_id, state, display_name, roster_fingerprint,
				        projection_fingerprint
				 FROM legacy_team_setup_drafts
				 WHERE candidate_id = ?
				 ORDER BY rowid DESC
				 LIMIT 1`,
			)
			.get(candidateId) as DraftRow | undefined) ?? null
	);
}

function createAttempt(
	db: Database,
	input: LegacyTeamSetupDraftSnapshotInput,
	rosterFingerprint: string,
	projectFingerprint: string,
	previousAttemptId: string | null,
	now: string,
): string {
	const attemptId = `legacy-team-attempt:${randomUUID()}`;
	db.prepare(
		`INSERT INTO legacy_team_setup_drafts(
			attempt_id, candidate_id, coordinator_id, group_id, state, display_name,
			roster_fingerprint, projection_fingerprint, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, 'needs_setup', ?, ?, ?, ?, ?)`,
	).run(
		attemptId,
		input.candidateId,
		input.coordinatorId,
		input.groupId,
		safeLabel(input.displayName, "Legacy Team", [
			input.candidateId,
			input.coordinatorId,
			input.groupId,
		]),
		rosterFingerprint,
		projectFingerprint,
		now,
		now,
	);

	const previousDevices = previousAttemptId
		? (db
				.prepare(
					`SELECT device_id, key_fingerprint, enabled, existing_identity_id,
					        existing_assignment_version, verified_evidence_kind,
					        decision, target_identity_id,
					        expected_assignment_kind, expected_assignment_version
					 FROM legacy_team_setup_draft_devices WHERE attempt_id = ?`,
				)
				.all(previousAttemptId) as DeviceRow[])
		: [];
	const previousByDevice = new Map(previousDevices.map((device) => [device.device_id, device]));
	const currentDeviceIds = new Set(input.devices.map((device) => device.deviceId));
	const devices = [
		...input.devices,
		...previousDevices
			.filter((device) => !currentDeviceIds.has(device.device_id))
			.map((device) => ({
				deviceId: device.device_id,
				fingerprint: device.key_fingerprint,
				displayName: "Removed device",
				enabled: false,
			})),
	];
	const insertDevice = db.prepare(
		`INSERT INTO legacy_team_setup_draft_devices(
			attempt_id, device_id, device_ref, key_fingerprint, display_name, enabled,
			existing_identity_id, existing_assignment_version, verified_evidence_kind,
			decision, target_identity_id,
			expected_assignment_kind, expected_assignment_version, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const device of devices) {
		const assignment = assignmentForDevice(db, device.deviceId);
		const previous = previousByDevice.get(device.deviceId);
		const assignmentEvidenceUnchanged =
			previous != null &&
			previous.key_fingerprint === device.fingerprint &&
			storedAssignmentRowMatchesLive(previous, assignment, true);
		const unchanged =
			assignmentEvidenceUnchanged &&
			previous != null &&
			(assignment == null || assignment.active) &&
			currentDeviceIds.has(device.deviceId) &&
			previous.enabled === (device.enabled ? 1 : 0) &&
			device.enabled;
		// Reviewed decisions and pending identity selections survive replacement
		// attempts triggered by other devices or Projects while this device's
		// assignment evidence remains unchanged. Removed rows stay target-free.
		const removedCarry =
			assignmentEvidenceUnchanged &&
			previous != null &&
			previous.decision === "removed" &&
			!device.enabled;
		insertDevice.run(
			attemptId,
			device.deviceId,
			deviceReference(input.candidateId, device.deviceId),
			device.fingerprint,
			safeLabel(device.displayName, "Device", [
				device.deviceId,
				device.fingerprint,
				input.coordinatorId,
				input.groupId,
			]),
			device.enabled ? 1 : 0,
			assignment?.identityId ?? null,
			assignment?.assignmentVersion ?? null,
			assignment?.active ? "active_assignment" : null,
			unchanged || removedCarry ? previous.decision : "unresolved",
			unchanged ? previous.target_identity_id : null,
			unchanged ? previous.expected_assignment_kind : assignment ? "existing" : "absent",
			unchanged ? previous.expected_assignment_version : (assignment?.assignmentVersion ?? null),
			now,
		);
	}

	const previousProjects = previousAttemptId
		? (db
				.prepare(
					`SELECT project_ref, source_project_identity, display_name, source_fingerprint,
					        resolution_kind,
					        resolved_project_identity
					 FROM legacy_team_setup_draft_projects WHERE attempt_id = ?`,
				)
				.all(previousAttemptId) as ProjectRow[])
		: [];
	const previousByProject = new Map(
		previousProjects.map((project) => [project.project_ref, project]),
	);
	const insertProject = db.prepare(
		`INSERT INTO legacy_team_setup_draft_projects(
			attempt_id, project_ref, source_project_identity, display_name, source_fingerprint,
			resolution_kind, resolved_project_identity, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const project of input.projects) {
		const previous = previousByProject.get(project.projectRef);
		const resolution = project.deterministicProjectIdentity
			? "deterministic"
			: previous?.source_fingerprint === project.sourceFingerprint &&
					previous.resolution_kind === "explicit"
				? "explicit"
				: "unresolved";
		insertProject.run(
			attemptId,
			project.projectRef,
			project.sourceProjectIdentity,
			safeLabel(project.displayName, "Project", [
				project.projectRef,
				project.sourceProjectIdentity,
				input.candidateId,
				input.coordinatorId,
				input.groupId,
			]),
			project.sourceFingerprint,
			resolution,
			project.deterministicProjectIdentity ??
				(resolution === "explicit" ? previous?.resolved_project_identity : null),
			now,
		);
	}
	return attemptId;
}

/**
 * Timestamps are caller-supplied and persisted verbatim into ordering-relevant
 * columns and immutable completion records; the sibling reconciler validates
 * its `now` the same way (`reconciliation_time_invalid`).
 */
function validatedNow(now: string | undefined): string {
	const value = now ?? new Date().toISOString();
	if (Number.isNaN(new Date(value).getTime())) {
		throw new Error("legacy_team_setup_time_invalid");
	}
	return value;
}

function loadDraftView(db: Database, attemptId: string): LegacyTeamSetupDraftView {
	const draft = db
		.prepare(
			`SELECT attempt_id, candidate_id, coordinator_id, group_id, state, display_name,
			        roster_fingerprint, projection_fingerprint
			 FROM legacy_team_setup_drafts WHERE attempt_id = ?`,
		)
		.get(attemptId) as (DraftRow & { coordinator_id: string; group_id: string }) | undefined;
	if (!draft) throw new Error("legacy_team_setup_draft_not_found");
	const deviceRows = db
		.prepare(
			`SELECT device_id, device_ref, key_fingerprint, display_name, enabled,
			        existing_identity_id, existing_assignment_version, verified_evidence_kind, decision,
			        target_identity_id, expected_assignment_kind, expected_assignment_version
			 FROM legacy_team_setup_draft_devices WHERE attempt_id = ? ORDER BY device_ref`,
		)
		.all(attemptId) as DeviceRow[];
	const projectRows = db
		.prepare(
			`SELECT project_ref, source_project_identity, display_name, source_fingerprint, resolution_kind,
			        resolved_project_identity
			 FROM legacy_team_setup_draft_projects WHERE attempt_id = ? ORDER BY project_ref`,
		)
		.all(attemptId) as ProjectRow[];
	const unresolvedDeviceCount = deviceRows.filter((row) => row.decision === "unresolved").length;
	const unresolvedProjectCount = projectRows.filter(
		(row) => row.resolution_kind === "unresolved",
	).length;
	// Activation requires every included device to target an active, unmerged
	// person, so a person deactivated or merged after the decision was saved
	// must make the draft non-finishable rather than failing only at finish.
	const includedTargetIds = [
		...new Set(
			deviceRows
				.filter((row) => row.decision === "included" && row.target_identity_id)
				.map((row) => row.target_identity_id as string),
		),
	];
	const includedTargetsValid = includedTargetIds.every((identityId) =>
		db
			.prepare(
				`SELECT 1 FROM actors
				 WHERE actor_id = ? AND status = 'active' AND merged_into_actor_id IS NULL LIMIT 1`,
			)
			.get(identityId),
	);
	// Activation compares every stored assignment expectation, including
	// exclusions. The detail view must report the same condition instead of
	// advertising a finishable draft whose CAS evidence no longer matches.
	const assignmentExpectationsValid = deviceRows.every((row) => {
		const live = assignmentForDevice(db, row.device_id);
		return (
			(row.decision !== "included" || live == null || live.active) &&
			storedAssignmentRowMatchesLive(row, live, false)
		);
	});
	const finishDigest = recipientPolicyDigest("legacy-team-finish-v1", {
		// The digest is bound to the immutable attempt: a confirmation token from
		// a prior attempt must never be valid for a replacement review cycle.
		attemptId,
		candidateRef: draft.candidate_id,
		rosterFingerprint: draft.roster_fingerprint,
		projectionFingerprint: draft.projection_fingerprint,
		devices: deviceRows.map((row) => ({
			deviceRef: row.device_ref,
			decision: row.decision,
			targetIdentityId: row.target_identity_id,
			expectationKind: row.expected_assignment_kind,
			expectedIdentityId:
				row.expected_assignment_kind === "existing" ? row.existing_identity_id : null,
			expectationVersion: row.expected_assignment_version,
		})),
		projects: projectRows.map((row) => ({
			projectRef: row.project_ref,
			resolution: row.resolution_kind,
			resolvedProjectIdentity: row.resolved_project_identity,
		})),
	});
	const reviewComplete =
		(draft.state === "needs_setup" || draft.state === "in_progress") &&
		unresolvedDeviceCount === 0 &&
		unresolvedProjectCount === 0 &&
		includedTargetsValid &&
		assignmentExpectationsValid &&
		(projectRows.length === 0 ||
			Boolean(
				db
					.prepare(
						`SELECT 1 FROM replication_scopes
						 WHERE coordinator_id = ? AND group_id = ? AND status = 'active' LIMIT 1`,
					)
					.get(draft.coordinator_id, draft.group_id),
			)) &&
		projectCanonicalStateValid(db, draft, projectRows);
	return {
		attemptId,
		candidateRef: draft.candidate_id,
		state: draft.state,
		displayName: draft.display_name,
		finishDigest,
		canFinish: reviewComplete,
		unresolvedDeviceCount,
		unresolvedProjectCount,
		// The coordinator key fingerprint stays in persisted CAS state only:
		// it is stable security evidence that can correlate a physical device
		// across Teams, and `deviceRef` already gives clients an opaque handle.
		devices: deviceRows.map((row) => ({
			deviceRef: row.device_ref,
			displayName: row.display_name,
			enabled: row.enabled !== 0,
			existingIdentityId: row.existing_identity_id,
			suggestedIdentityId:
				row.verified_evidence_kind === "active_assignment" ? row.existing_identity_id : null,
			verifiedEvidenceKind: row.verified_evidence_kind,
			decision: row.decision,
			targetIdentityId: row.target_identity_id,
			expectation:
				row.expected_assignment_kind === "existing" &&
				row.expected_assignment_version != null &&
				row.existing_identity_id != null
					? {
							kind: "existing",
							assignmentVersion: row.expected_assignment_version,
							identityId: row.existing_identity_id,
						}
					: { kind: "absent" },
		})),
		projects: projectRows.map((row) => ({
			projectRef: row.project_ref,
			displayName: row.display_name,
			resolution: row.resolution_kind,
			resolvedProjectRef: row.resolved_project_identity
				? legacyTeamResolvedProjectRef(row.project_ref, row.resolved_project_identity)
				: null,
		})),
	};
}

function persistFinishDigest(db: Database, attemptId: string): LegacyTeamSetupDraftView {
	const view = loadDraftView(db, attemptId);
	db.prepare("UPDATE legacy_team_setup_drafts SET finish_digest = ? WHERE attempt_id = ?").run(
		view.finishDigest,
		attemptId,
	);
	return view;
}

/**
 * The roster fingerprint covers device identity, key, and enabled state, but
 * not assignment versions. A reassignment cycle (A -> B -> A) restores the
 * fingerprint while advancing the version, which would strand the attempt with
 * permanently failing CAS expectations. Reuse an attempt only when every
 * stored per-device assignment fact still matches the live rows.
 */
function storedAssignmentEvidenceMatches(
	db: Database,
	attemptId: string,
	snapshots: ReadonlyArray<{
		device: LegacyTeamSetupRosterDeviceInput;
		assignment: DeviceAssignmentSnapshot | null;
	}>,
): boolean {
	const storedRows = db
		.prepare(
			`SELECT device_id, existing_identity_id, existing_assignment_version, verified_evidence_kind,
			        expected_assignment_kind, expected_assignment_version
			 FROM legacy_team_setup_draft_devices WHERE attempt_id = ?`,
		)
		.all(attemptId) as Array<{
		device_id: string;
		existing_identity_id: string | null;
		existing_assignment_version: number | null;
		verified_evidence_kind: "active_assignment" | null;
		expected_assignment_kind: "absent" | "existing" | null;
		expected_assignment_version: number | null;
	}>;
	const storedByDevice = new Map(storedRows.map((row) => [row.device_id, row]));
	const currentMatches = snapshots.every(({ device, assignment }) => {
		const stored = storedByDevice.get(device.deviceId);
		return stored != null && storedAssignmentRowMatchesLive(stored, assignment, true);
	});
	if (!currentMatches) return false;
	// Devices carried into the attempt as removed roster rows keep CAS
	// expectations too; a stale expectation would make their `removed`
	// decision unsavable while every refresh keeps reusing the attempt.
	const snapshotDeviceIds = new Set(snapshots.map(({ device }) => device.deviceId));
	return storedRows
		.filter((row) => !snapshotDeviceIds.has(row.device_id))
		.every((row) => {
			const assignment = assignmentForDevice(db, row.device_id);
			return storedAssignmentRowMatchesLive(row, assignment, true);
		});
}

/**
 * Creates or refreshes a bounded setup attempt.
 *
 * @throws `legacy_team_setup_roster_too_large` when the supplied snapshot or
 * its effective Device union exceeds the shared activation limits.
 * @throws `legacy_team_setup_time_invalid` when `now` is not a valid timestamp.
 */
export function refreshLegacyTeamSetupDraft(
	db: Database,
	input: LegacyTeamSetupDraftSnapshotInput,
): LegacyTeamSetupDraftView {
	requireLegacyTeamSetupSnapshotWithinLimits(input);
	const now = validatedNow(input.now);
	const refresh = db.transaction(() => {
		const existing = currentDraft(db, input.candidateId);
		requireLegacyTeamSetupEffectiveDevicesWithinLimit(
			db,
			input.devices,
			existing?.attempt_id ?? null,
		);
		const assignmentSnapshots = input.devices.map((device) => ({
			device,
			assignment: assignmentForDevice(db, device.deviceId),
		}));
		const assignments = assignmentSnapshots.map(({ device, assignment }) => ({
			deviceId: device.deviceId,
			fingerprint: device.fingerprint,
			enabled: device.enabled,
			// The roster fingerprint tracks active assignments only, matching
			// candidate discovery; inactive rows are surfaced through CAS checks.
			identityId: assignment?.active ? assignment.identityId : null,
		}));
		const rosterFingerprint = legacyTeamRosterFingerprint(assignments);
		const projectFingerprint = legacyTeamProjectionFingerprint(input.projects);
		if (
			existing &&
			(existing.state === "needs_setup" || existing.state === "in_progress") &&
			existing.roster_fingerprint === rosterFingerprint &&
			existing.projection_fingerprint === projectFingerprint &&
			storedAssignmentEvidenceMatches(db, existing.attempt_id, assignmentSnapshots)
		) {
			db.prepare(
				`UPDATE legacy_team_setup_drafts SET display_name = ?, updated_at = ? WHERE attempt_id = ?`,
			).run(
				safeLabel(input.displayName, "Legacy Team", [
					input.candidateId,
					input.coordinatorId,
					input.groupId,
				]),
				now,
				existing.attempt_id,
			);
			for (const device of input.devices) {
				db.prepare(
					`UPDATE legacy_team_setup_draft_devices
					 SET display_name = ?, updated_at = ?
					 WHERE attempt_id = ? AND device_id = ?`,
				).run(
					safeLabel(device.displayName, "Device", [
						device.deviceId,
						device.fingerprint,
						input.coordinatorId,
						input.groupId,
					]),
					now,
					existing.attempt_id,
					device.deviceId,
				);
			}
			for (const project of input.projects) {
				db.prepare(
					`UPDATE legacy_team_setup_draft_projects
					 SET display_name = ?, updated_at = ?
					 WHERE attempt_id = ? AND project_ref = ?`,
				).run(
					safeLabel(project.displayName, "Project", [
						project.projectRef,
						project.sourceProjectIdentity,
						input.candidateId,
						input.coordinatorId,
						input.groupId,
					]),
					now,
					existing.attempt_id,
					project.projectRef,
				);
			}
			return loadDraftView(db, existing.attempt_id);
		}
		if (existing && (existing.state === "needs_setup" || existing.state === "in_progress")) {
			db.prepare(
				`UPDATE legacy_team_setup_drafts
				 SET state = 'stale', superseded_at = ?, updated_at = ?
				 WHERE attempt_id = ?`,
			).run(now, now, existing.attempt_id);
		} else if (existing?.state === "completed") {
			// Completion remains historical authorization evidence for migration
			// validation; insertion order makes the replacement authoritative.
			db.prepare(
				`UPDATE legacy_team_setup_drafts
				 SET superseded_at = ?, updated_at = ? WHERE attempt_id = ?`,
			).run(now, now, existing.attempt_id);
		}
		const attemptId = createAttempt(
			db,
			input,
			rosterFingerprint,
			projectFingerprint,
			existing?.attempt_id ?? null,
			now,
		);
		return persistFinishDigest(db, attemptId);
	});
	return refresh.immediate();
}

export function getLegacyTeamSetupDraft(
	db: Database,
	candidateRef: string,
): LegacyTeamSetupDraftView | null {
	const row = db
		.prepare(
			`SELECT attempt_id FROM legacy_team_setup_drafts
			 WHERE candidate_id = ?
			 ORDER BY rowid DESC LIMIT 1`,
		)
		.get(candidateRef) as { attempt_id: string } | undefined;
	return row ? loadDraftView(db, row.attempt_id) : null;
}

export function refreshLegacyTeamSetupDraftLabels(
	db: Database,
	attemptId: string,
	input: Pick<LegacyTeamSetupDraftSnapshotInput, "displayName" | "devices" | "projects" | "now">,
): LegacyTeamSetupDraftView {
	const now = validatedNow(input.now);
	const refreshLabels = db.transaction(() => {
		const context = db
			.prepare(
				"SELECT candidate_id, coordinator_id, group_id FROM legacy_team_setup_drafts WHERE attempt_id = ?",
			)
			.get(attemptId) as
			| { candidate_id: string; coordinator_id: string; group_id: string }
			| undefined;
		if (!context) throw new Error("legacy_team_setup_draft_not_found");
		const contextIds = [context.candidate_id, context.coordinator_id, context.group_id];
		const result = db
			.prepare(
				"UPDATE legacy_team_setup_drafts SET display_name = ?, updated_at = ? WHERE attempt_id = ?",
			)
			.run(safeLabel(input.displayName, "Legacy Team", contextIds), now, attemptId);
		if (result.changes !== 1) throw new Error("legacy_team_setup_draft_not_found");
		const updateDevice = db.prepare(
			`UPDATE legacy_team_setup_draft_devices SET display_name = ?, updated_at = ?
			 WHERE attempt_id = ? AND device_id = ?`,
		);
		for (const device of input.devices) {
			updateDevice.run(
				safeLabel(device.displayName, "Device", [
					device.deviceId,
					device.fingerprint,
					...contextIds,
				]),
				now,
				attemptId,
				device.deviceId,
			);
		}
		const updateProject = db.prepare(
			`UPDATE legacy_team_setup_draft_projects SET display_name = ?, updated_at = ?
			 WHERE attempt_id = ? AND project_ref = ?`,
		);
		for (const project of input.projects) {
			updateProject.run(
				safeLabel(project.displayName, "Project", [
					project.projectRef,
					project.sourceProjectIdentity,
					...contextIds,
				]),
				now,
				attemptId,
				project.projectRef,
			);
		}
		return loadDraftView(db, attemptId);
	});
	return refreshLabels.immediate();
}

function requireMutableAttempt(db: Database, attemptId: string): void {
	const row = db
		.prepare(
			`SELECT draft.state,
			        NOT EXISTS (
			          SELECT 1 FROM legacy_team_setup_drafts AS newer
			          WHERE newer.candidate_id = draft.candidate_id
			            AND newer.rowid > draft.rowid
			        ) AS is_current
			 FROM legacy_team_setup_drafts AS draft
			 WHERE draft.attempt_id = ?`,
		)
		.get(attemptId) as { state: LegacyTeamSetupDraftState; is_current: number } | undefined;
	if (!row) throw new Error("legacy_team_setup_draft_not_found");
	if (row.is_current === 0 || (row.state !== "needs_setup" && row.state !== "in_progress")) {
		throw new Error("legacy_team_setup_draft_stale");
	}
}

export function setLegacyTeamSetupDeviceAssignment(
	db: Database,
	input: {
		attemptId: string;
		deviceRef: string;
		targetIdentityId: string;
		expectation: LegacyTeamAssignmentExpectation;
		now?: string;
	},
): LegacyTeamSetupDraftView {
	const now = validatedNow(input.now);
	const mutateAssignment = db.transaction(() => {
		requireMutableAttempt(db, input.attemptId);
		const device = db
			.prepare(
				`SELECT device_id, enabled, existing_identity_id, existing_assignment_version
				 FROM legacy_team_setup_draft_devices
				 WHERE attempt_id = ? AND device_ref = ?`,
			)
			.get(input.attemptId, input.deviceRef) as
			| {
					device_id: string;
					enabled: number;
					existing_identity_id: string | null;
					existing_assignment_version: number | null;
			  }
			| undefined;
		if (!device) throw new Error("legacy_team_setup_device_not_found");
		if (device.enabled === 0) throw new Error("legacy_team_setup_device_not_eligible");
		// The submitted expectation must equal the CAS token stored when this
		// attempt snapshotted the device. Accepting a fresher live token would
		// let a stale attempt silently rebase past an intervening reassignment
		// instead of being replaced by refresh.
		const storedMatchesSubmitted =
			input.expectation.kind === "absent"
				? device.existing_identity_id == null && device.existing_assignment_version == null
				: input.expectation.identityId === device.existing_identity_id &&
					input.expectation.assignmentVersion === device.existing_assignment_version;
		if (!storedMatchesSubmitted) throw new Error("legacy_team_setup_assignment_changed");
		const assignment = assignmentForDevice(db, device.device_id);
		const matches = assignmentMatchesExpectation(assignment, {
			kind: input.expectation.kind,
			identityId: input.expectation.kind === "existing" ? input.expectation.identityId : null,
			assignmentVersion:
				input.expectation.kind === "existing" ? input.expectation.assignmentVersion : null,
		});
		if (!matches) throw new Error("legacy_team_setup_assignment_changed");
		const identity = db
			.prepare(
				`SELECT 1 FROM actors
				 WHERE actor_id = ? AND status = 'active' AND merged_into_actor_id IS NULL LIMIT 1`,
			)
			.get(input.targetIdentityId);
		if (!identity) throw new Error("legacy_team_setup_identity_invalid");
		// Changing the selected person invalidates any prior inclusion review:
		// the new target was never explicitly included.
		const result = db
			.prepare(
				`UPDATE legacy_team_setup_draft_devices
				 SET target_identity_id = ?, expected_assignment_kind = ?,
				     expected_assignment_version = ?,
				     decision = CASE WHEN target_identity_id IS ? THEN decision ELSE 'unresolved' END,
				     updated_at = ?
				 WHERE attempt_id = ? AND device_ref = ?`,
			)
			.run(
				input.targetIdentityId,
				input.expectation.kind,
				input.expectation.kind === "existing" ? input.expectation.assignmentVersion : null,
				input.targetIdentityId,
				now,
				input.attemptId,
				input.deviceRef,
			);
		if (result.changes !== 1) throw new Error("legacy_team_setup_device_not_found");
		db.prepare(
			`UPDATE legacy_team_setup_drafts SET state = 'in_progress', updated_at = ? WHERE attempt_id = ?`,
		).run(now, input.attemptId);
		return persistFinishDigest(db, input.attemptId);
	});
	return mutateAssignment.immediate();
}

export function setLegacyTeamSetupDeviceDecision(
	db: Database,
	input: {
		attemptId: string;
		deviceRef: string;
		decision: Exclude<LegacyTeamDeviceDecision, "unresolved">;
		now?: string;
	},
): LegacyTeamSetupDraftView {
	// The union type is erased at runtime: a caller outside TypeScript (or an
	// unvalidated request handler) could pass any string, and an unknown
	// decision persisted here would zero the unresolved count and unlock
	// `canFinish` with a value outside the activation contract.
	if (!["included", "excluded", "removed"].includes(input.decision)) {
		throw new Error("legacy_team_setup_decision_invalid");
	}
	const now = validatedNow(input.now);
	const mutateDecision = db.transaction(() => {
		requireMutableAttempt(db, input.attemptId);
		const device = db
			.prepare(
				`SELECT device_id, enabled, existing_identity_id, target_identity_id,
				        expected_assignment_kind, expected_assignment_version
				 FROM legacy_team_setup_draft_devices
				 WHERE attempt_id = ? AND device_ref = ?`,
			)
			.get(input.attemptId, input.deviceRef) as
			| {
					device_id: string;
					enabled: number;
					existing_identity_id: string | null;
					target_identity_id: string | null;
					expected_assignment_kind: "absent" | "existing" | null;
					expected_assignment_version: number | null;
			  }
			| undefined;
		if (!device) throw new Error("legacy_team_setup_device_not_found");
		const assignment = assignmentForDevice(db, device.device_id);
		const assignmentMatches = assignmentMatchesExpectation(assignment, {
			kind: device.expected_assignment_kind,
			identityId: device.existing_identity_id,
			assignmentVersion: device.expected_assignment_version,
		});
		if (!assignmentMatches) throw new Error("legacy_team_setup_assignment_changed");
		if (input.decision === "included" && device.enabled === 0) {
			throw new Error("legacy_team_setup_device_not_eligible");
		}
		// Canonical assignment CAS at activation accepts only active rows, so an
		// inactive row makes the device reviewable (exclude/remove) but never
		// includable until the assignment is reconciled.
		if (input.decision === "included" && assignment != null && !assignment.active) {
			throw new Error("legacy_team_setup_device_not_eligible");
		}
		if (input.decision === "included" && !device.target_identity_id) {
			throw new Error("legacy_team_setup_identity_required");
		}
		if (input.decision === "included") {
			// The person may have been deactivated or merged after the assignment
			// was saved; activation requires an active, unmerged member.
			const identityActive = db
				.prepare(
					`SELECT 1 FROM actors
					 WHERE actor_id = ? AND status = 'active' AND merged_into_actor_id IS NULL LIMIT 1`,
				)
				.get(device.target_identity_id);
			if (!identityActive) throw new Error("legacy_team_setup_identity_invalid");
		}
		if (input.decision === "removed" && device.enabled !== 0) {
			throw new Error("legacy_team_setup_device_not_removed");
		}
		db.prepare(
			`UPDATE legacy_team_setup_draft_devices
			 SET decision = ?, target_identity_id = CASE WHEN ? IN ('excluded', 'removed') THEN NULL ELSE target_identity_id END,
			     updated_at = ?
			 WHERE attempt_id = ? AND device_ref = ?`,
		).run(input.decision, input.decision, now, input.attemptId, input.deviceRef);
		db.prepare(
			`UPDATE legacy_team_setup_drafts SET state = 'in_progress', updated_at = ? WHERE attempt_id = ?`,
		).run(now, input.attemptId);
		return persistFinishDigest(db, input.attemptId);
	});
	return mutateDecision.immediate();
}

export function setLegacyTeamSetupProjectMapping(
	db: Database,
	input: {
		attemptId: string;
		projectRef: string;
		resolvedProjectIdentity: string;
		now?: string;
	},
): LegacyTeamSetupDraftView {
	const identity = input.resolvedProjectIdentity.trim();
	// The repair target becomes a mapping workspace identity and an active
	// recipient edge at activation; anything that is not itself a shareable
	// canonical identity would grant the Team access to a Project the review
	// never displayed. `canonicalWorkspaceIdentity` passes local paths through
	// unchanged, and successive review rounds each found one more path shape a
	// prefix denylist missed (absolute, dot-relative, `$HOME`, plain
	// `clients/acme`), so this validates by ALLOWLIST: a target containing a
	// path separator must be a remote form — a scheme URL or an scp-style
	// `user@host:path` / `host.tld:path` — and separator-free opaque
	// identifiers (workspace ids) pass as-is.
	// Scheme URLs are limited to shareable remote schemes: a `file:` URL is a
	// local artifact path in remote clothing. The host patterns exclude `.`
	// from each label segment so the dot-split is unambiguous — an ambiguous
	// adjacency here is polynomial-time on adversarial input (CodeQL js/
	// polynomial-redos).
	const isRemoteForm =
		// The authority (host) must be nonempty: `ssh:///home/alice` is an
		// absolute local path wearing a scheme.
		/^(?:https?|ssh|git):\/\/[^/\\\s]\S*$/iu.test(identity) ||
		/^[^/\\@\s]+@[^/\\:\s]+:\S+$/u.test(identity) ||
		/^[^/\\:\s.]+(?:\.[^/\\:\s.]+)+:\S+$/u.test(identity);
	if (
		!identity ||
		identity.length > 2048 ||
		identity.startsWith("unmapped:") ||
		/\s/u.test(identity) ||
		(/[/\\]/u.test(identity) && !isRemoteForm) ||
		/^(?:[~.$%]|[A-Za-z]:[\\/])/.test(identity) ||
		canonicalWorkspaceIdentity({ gitRemote: identity }).value !== identity
	) {
		throw new Error("legacy_team_setup_project_mapping_invalid");
	}
	const now = validatedNow(input.now);
	const mutateMapping = db.transaction(() => {
		requireMutableAttempt(db, input.attemptId);
		const project = db
			.prepare(
				`SELECT resolution_kind FROM legacy_team_setup_draft_projects
				 WHERE attempt_id = ? AND project_ref = ?`,
			)
			.get(input.attemptId, input.projectRef) as
			| { resolution_kind: LegacyTeamProjectResolution }
			| undefined;
		if (!project) throw new Error("legacy_team_setup_project_not_found");
		// Explicit repair is only for ambiguous Projects; a deterministic source
		// identity must never be redirected to an unrelated migration target.
		if (project.resolution_kind === "deterministic") {
			throw new Error("legacy_team_setup_project_not_ambiguous");
		}
		const result = db
			.prepare(
				`UPDATE legacy_team_setup_draft_projects
				 SET resolution_kind = 'explicit', resolved_project_identity = ?, updated_at = ?
				 WHERE attempt_id = ? AND project_ref = ?`,
			)
			.run(identity, now, input.attemptId, input.projectRef);
		if (result.changes !== 1) throw new Error("legacy_team_setup_project_not_found");
		db.prepare(
			`UPDATE legacy_team_setup_drafts SET state = 'in_progress', updated_at = ? WHERE attempt_id = ?`,
		).run(now, input.attemptId);
		return persistFinishDigest(db, input.attemptId);
	});
	return mutateMapping.immediate();
}
