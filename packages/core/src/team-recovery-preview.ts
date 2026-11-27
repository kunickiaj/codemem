import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import type { CoordinatorTeamGroupBinding } from "./coordinator-team-group-bindings.js";
import type { CoordinatorTeamMemberRemoval } from "./coordinator-team-member-removals.js";
import type { Database } from "./db.js";
import type { LegacyTeamRosterDeviceSnapshot } from "./legacy-team-candidate.js";
import {
	areLegacyTeamSetupCompletionPolicyFactsAdditivelyCompatible,
	deriveCompletedLegacyTeamSetupDraftManifest,
	LegacyTeamSetupCompletionManifestError,
	quarantineLegacyTeamSetupPolicyInTransaction,
	validateLegacyTeamSetupCompletionManifest,
} from "./legacy-team-setup-completion-manifest.js";
import { LEGACY_TEAM_SETUP_MAX_DEVICES } from "./legacy-team-setup-limits.js";
import { isWithdrawnPolicyIdentity } from "./policy-team-device-eligibility.js";
import {
	compareCodepoints,
	deterministicPolicyTeamId,
	isStrictRecipientPolicyId,
	legacyTeamCandidateId,
	recipientPolicyDigest,
} from "./recipient-policy-identifiers.js";
import {
	removedTeamMemberIdentityIds,
	teamCoordinatorLinkStateWithSetup,
} from "./team-member-removal-lookup.js";
import {
	planTeamRecoveryDevices,
	type TeamRecoveryDevice,
	type TeamRecoveryDeviceBlockCheck,
	type TeamRecoveryDeviceRefusal,
	type TeamRecoveryDeviceRemoval,
} from "./team-recovery-devices.js";
import type { TeamRecoveryExclusion } from "./team-recovery-exclusions.js";
import { isTeamRecoveryHoldAbandoned } from "./team-recovery-holds.js";
import { planTeamRecoveryProjects, type TeamRecoveryProject } from "./team-recovery-projects.js";

/*
 * Recovering a reviewed Team that was disabled (quarantined), reviewed first.
 * This is the preview: it reads this machine's state and evidence the caller
 * just read from the coordinator, writes nothing, and either names the one
 * reason recovery cannot run or lists exactly what a recovery would do, bound
 * in a digest. A later commit runs only for an unchanged digest.
 *
 * Recovery makes the Team active again as its completed setup left it, minus
 * everything that must stay out. It never makes a person a member, never sets
 * a device decision to included, and never binds a device to a person:
 * quarantine left those rows alone, so whatever is revoked or excluded now was
 * decided by something else and stays that way. At the person and device level
 * recovery only takes away: it ends the membership of a person who was removed
 * from the Team or whose identity is no longer usable, and it leaves out a
 * device the coordinator removed.
 */

const PREVIEW_DIGEST_DOMAIN = "team-recovery-preview-v1";

/** Coordinator evidence, or the fact that the read failed. */
type Read<T> = ({ status: "read" } & T) | { status: "unavailable" };

/** The coordinator a read was sent to, as the reader recorded it from its own request. */
interface CoordinatorSource {
	coordinatorId: string;
}

/** The coordinator and the group a read was made for, as the reader recorded them. */
interface GroupSource extends CoordinatorSource {
	groupId: string;
}

/**
 * What the caller read from the coordinator for this request. Every part is
 * required, and each names where it was read from: a part read from another
 * coordinator, or for another group, counts as not read.
 */
export interface TeamRecoveryEvidence {
	/** The setup group's devices. */
	roster: Read<{ source: GroupSource; devices: readonly LegacyTeamRosterDeviceSnapshot[] }>;
	/** Device removal records, including blocked devices. */
	deviceRemovals: Read<{
		source: CoordinatorSource;
		removals: readonly TeamRecoveryDeviceRemoval[];
	}>;
	/**
	 * Whether the coordinator blocks each enrolled device, asked by device ID and
	 * key. A block can leave the enrollment in place and write no removal record,
	 * so neither the roster nor the removal records show it. The reader stamps
	 * the source, and each answer's device and key, from the request it sent,
	 * signed as a member of this group. Nothing here is copied from the reply.
	 */
	deviceBlocks: Read<{
		source: GroupSource;
		checks: readonly TeamRecoveryDeviceBlockCheck[];
	}>;
	/** The coordinator's copy of the completed setup, or null when it holds none. */
	completion: Read<{ source: GroupSource; manifest: unknown }>;
	/** The setup group's Team member removals. */
	memberRemovals: Read<{
		source: GroupSource;
		removals: readonly CoordinatorTeamMemberRemoval[];
	}>;
	/** The Team's group binding. */
	groupBinding: Read<{ source: CoordinatorSource; binding: CoordinatorTeamGroupBinding }>;
}

export type TeamRecoveryRefusal =
	| "invalid_input"
	| "team_not_found"
	| "team_not_quarantined"
	| "setup_record_missing"
	| "roster_unavailable"
	| "device_removals_unavailable"
	| "device_blocks_unavailable"
	| "completion_unavailable"
	| "member_removals_unavailable"
	| "team_group_unavailable"
	| "completion_missing"
	| "completion_invalid"
	| "setup_differs_from_completion"
	| "team_group_conflict"
	| "team_group_mismatch"
	| "team_policy_blocked"
	| TeamRecoveryDeviceRefusal;

export type TeamRecoveryPersonReason =
	| "removed_from_team"
	| "identity_missing"
	| "merged"
	| "deactivated"
	| "identity_not_active"
	| "not_a_member";

export interface TeamRecoveryPerson {
	identityId: string;
	displayName: string | null;
	/** `member`: an active member once the Team is recovered. */
	outcome: "member" | "left_out";
	/** Why the person stays out. `not_a_member`: the membership had already ended. */
	reason?: TeamRecoveryPersonReason;
}

export interface TeamRecoveryPreview {
	state: "ready";
	teamId: string;
	teamName: string;
	candidateRef: string;
	people: TeamRecoveryPerson[];
	devices: TeamRecoveryDevice[];
	projects: TeamRecoveryProject[];
	/** Unfinished setup attempts started after the Team was disabled. Recovery discards them. */
	discardedSetupAttempts: number;
	expectedDigest: string;
}

export type TeamRecoveryPreviewResult =
	| TeamRecoveryPreview
	| { state: "refused"; reason: TeamRecoveryRefusal; deviceIds?: string[] };

interface Subject {
	teamId: string;
	teamName: string;
	candidateRef: string;
	coordinatorId: string;
	groupId: string;
	attemptId: string;
	/** The completion key recovery puts back on the completed draft. */
	finishKey: string;
	newerAttemptIds: string[];
	localManifest: CoordinatorLegacyTeamCompletionManifestV1;
}

interface CheckedEvidence {
	roster: Map<string, LegacyTeamRosterDeviceSnapshot>;
	deviceRemovals: readonly TeamRecoveryDeviceRemoval[];
	deviceBlocks: readonly TeamRecoveryDeviceBlockCheck[];
	manifest: CoordinatorLegacyTeamCompletionManifestV1;
	removedIdentityIds: Set<string>;
	memberRemovals: CoordinatorTeamMemberRemoval[];
}

type Refused = Exclude<TeamRecoveryPreviewResult, TeamRecoveryPreview>;

const refuse = (reason: TeamRecoveryRefusal, deviceIds?: string[]): Refused =>
	deviceIds ? { state: "refused", reason, deviceIds } : { state: "refused", reason };

/** The quarantined reviewed Team, or the reason this Team cannot be recovered. */
function readQuarantinedTeam(
	db: Database,
	teamId: string,
): { teamName: string } | TeamRecoveryRefusal {
	const team = db
		.prepare(
			`SELECT display_name, status, migration_state, provenance, device_eligibility_mode
			 FROM policy_teams WHERE team_id = ?`,
		)
		.get(teamId) as
		| {
				display_name: string;
				status: string;
				migration_state: string;
				provenance: string;
				device_eligibility_mode: string;
		  }
		| undefined;
	if (!team) return "team_not_found";
	const quarantined =
		team.status === "inactive" &&
		team.migration_state === "needs_setup" &&
		team.provenance === "reviewed_team_candidate" &&
		team.device_eligibility_mode === "reviewed_allowlist";
	return quarantined ? { teamName: team.display_name } : "team_not_quarantined";
}

/**
 * The completed setup recovery restores: its draft, the completion key that
 * quarantine cleared from it, and the unfinished attempts started since.
 */
function readCompletedSetup(
	db: Database,
	input: { candidateRef: string; teamId: string; coordinatorId: string; groupId: string },
): Pick<Subject, "attemptId" | "finishKey" | "newerAttemptIds" | "localManifest"> | null {
	let derived: ReturnType<typeof deriveCompletedLegacyTeamSetupDraftManifest>;
	try {
		derived = deriveCompletedLegacyTeamSetupDraftManifest(db, input);
	} catch (error) {
		if (error instanceof LegacyTeamSetupCompletionManifestError) return null;
		throw error;
	}
	const draft = db
		.prepare(
			`SELECT rowid AS row_id, coordinator_id, group_id, completed_team_id, finish_digest
			 FROM legacy_team_setup_drafts WHERE attempt_id = ?`,
		)
		.get(derived.attemptId) as {
		row_id: number;
		coordinator_id: string;
		group_id: string;
		completed_team_id: string | null;
		finish_digest: string | null;
	};
	if (
		draft.completed_team_id !== input.teamId ||
		draft.coordinator_id !== input.coordinatorId ||
		draft.group_id !== input.groupId
	)
		return null;
	const finishKey = db
		.prepare(
			`SELECT finish_digest FROM legacy_team_setup_completions
			 WHERE attempt_id = ? AND candidate_ref = ? AND completed_team_id = ?
			   AND (? IS NULL OR finish_digest = ?)
			 ORDER BY rowid DESC LIMIT 1`,
		)
		.pluck()
		.get(
			derived.attemptId,
			input.candidateRef,
			input.teamId,
			draft.finish_digest,
			draft.finish_digest,
		) as string | undefined;
	if (!finishKey) return null;
	const newerAttemptIds = db
		.prepare(
			"SELECT attempt_id FROM legacy_team_setup_drafts WHERE candidate_id = ? AND rowid > ? ORDER BY rowid",
		)
		.pluck()
		.all(input.candidateRef, draft.row_id) as string[];
	return {
		attemptId: derived.attemptId,
		finishKey,
		newerAttemptIds,
		localManifest: derived.manifest,
	};
}

function readSubject(
	db: Database,
	input: { coordinatorId: string; groupId: string },
): Subject | TeamRecoveryRefusal {
	if (!input.coordinatorId || !isStrictRecipientPolicyId(input.groupId)) return "invalid_input";
	const candidateRef = legacyTeamCandidateId(input.coordinatorId, input.groupId);
	const teamId = deterministicPolicyTeamId(candidateRef);
	const team = readQuarantinedTeam(db, teamId);
	if (typeof team === "string") return team;
	const setup = readCompletedSetup(db, { ...input, candidateRef, teamId });
	if (!setup) return "setup_record_missing";
	return { ...input, candidateRef, teamId, ...team, ...setup };
}

/**
 * Every part of the evidence, each read from this coordinator and, where the
 * read is for one group, for this group. Otherwise the first part that was not,
 * in a fixed order.
 */
function readEvidence(subject: Subject, evidence: TeamRecoveryEvidence) {
	const { roster, deviceRemovals, deviceBlocks, completion, memberRemovals, groupBinding } =
		evidence;
	const here = (source: CoordinatorSource) => source?.coordinatorId === subject.coordinatorId;
	const forGroup = (source: GroupSource) => here(source) && source.groupId === subject.groupId;
	if (roster.status !== "read" || !forGroup(roster.source)) return "roster_unavailable" as const;
	if (deviceRemovals.status !== "read" || !here(deviceRemovals.source))
		return "device_removals_unavailable" as const;
	if (deviceBlocks?.status !== "read" || !forGroup(deviceBlocks.source))
		return "device_blocks_unavailable" as const;
	if (completion.status !== "read" || !forGroup(completion.source))
		return "completion_unavailable" as const;
	if (memberRemovals.status !== "read" || !forGroup(memberRemovals.source))
		return "member_removals_unavailable" as const;
	if (groupBinding.status !== "read" || !here(groupBinding.source))
		return "team_group_unavailable" as const;
	return { roster, deviceRemovals, deviceBlocks, completion, memberRemovals, groupBinding };
}

/** The coordinator's copy, when it is valid for this group and the local setup matches it. */
function checkedManifest(
	subject: Subject,
	value: unknown,
): CoordinatorLegacyTeamCompletionManifestV1 | TeamRecoveryRefusal {
	if (value == null) return "completion_missing";
	let manifest: CoordinatorLegacyTeamCompletionManifestV1;
	try {
		manifest = validateLegacyTeamSetupCompletionManifest(value, subject);
	} catch (error) {
		if (error instanceof LegacyTeamSetupCompletionManifestError) return "completion_invalid";
		throw error;
	}
	// The same people and devices, and no local Project the coordinator's copy lacks.
	return areLegacyTeamSetupCompletionPolicyFactsAdditivelyCompatible(
		subject.localManifest,
		manifest,
	)
		? manifest
		: "setup_differs_from_completion";
}

/**
 * Whether the Team would have exactly the setup's group once recovered: what
 * this machine recorded, and what the coordinator reports now.
 */
function groupRefusal(
	db: Database,
	subject: Subject,
	binding: CoordinatorTeamGroupBinding,
): TeamRecoveryRefusal | null {
	if (binding.team_id !== subject.teamId) return "team_group_unavailable";
	if (binding.state === "conflict") return "team_group_conflict";
	if (binding.state === "bound" && binding.group_id !== subject.groupId)
		return "team_group_mismatch";
	// A recorded group that disagrees with the setup's makes the pair a conflict.
	const local = teamCoordinatorLinkStateWithSetup(db, subject.teamId, subject);
	return local.state === "linked" ? null : "team_group_conflict";
}

/** People removed from the Team: recorded here, or in the removals just read. */
function removedIdentities(
	db: Database,
	subject: Subject,
	removals: readonly CoordinatorTeamMemberRemoval[],
): Set<string> | TeamRecoveryRefusal {
	// A list naming another group is not this group's list.
	if (removals.some((record) => record.group_id !== subject.groupId))
		return "member_removals_unavailable";
	const removed = removedTeamMemberIdentityIds(db, subject.teamId, { settingUpFrom: subject });
	for (const record of removals)
		if (record.team_id === subject.teamId) removed.add(record.identity_id);
	return removed;
}

function checkedRoster(
	devices: readonly LegacyTeamRosterDeviceSnapshot[],
): Map<string, LegacyTeamRosterDeviceSnapshot> | TeamRecoveryRefusal {
	const roster = new Map(devices.map((device) => [device.deviceId, device]));
	// A duplicate or oversized roster is not evidence of who is enrolled.
	if (roster.size !== devices.length || roster.size > LEGACY_TEAM_SETUP_MAX_DEVICES)
		return "roster_unavailable";
	return roster;
}

function checkEvidence(
	db: Database,
	subject: Subject,
	evidence: TeamRecoveryEvidence,
): CheckedEvidence | TeamRecoveryRefusal {
	const read = readEvidence(subject, evidence);
	if (typeof read === "string") return read;
	const { roster, deviceRemovals, deviceBlocks, completion, memberRemovals, groupBinding } = read;
	const devices = checkedRoster(roster.devices);
	if (typeof devices === "string") return devices;
	const manifest = checkedManifest(subject, completion.manifest);
	if (typeof manifest === "string") return manifest;
	const group = groupRefusal(db, subject, groupBinding.binding);
	if (group) return group;
	const removedIdentityIds = removedIdentities(db, subject, memberRemovals.removals);
	if (typeof removedIdentityIds === "string") return removedIdentityIds;
	return {
		roster: devices,
		deviceRemovals: deviceRemovals.removals,
		deviceBlocks: deviceBlocks.checks,
		manifest,
		removedIdentityIds,
		// Recovery writes for this Team only. Another Team's removals stay with reconciliation.
		memberRemovals: memberRemovals.removals.filter((record) => record.team_id === subject.teamId),
	};
}

interface ActorRow {
	display_name: string;
	status: string;
	merged_into_actor_id: string | null;
}

/** Why an active member cannot stay one, or null when the person can. */
function memberLeftOutReason(
	identityId: string,
	actor: ActorRow | undefined,
	removed: ReadonlySet<string>,
): TeamRecoveryPersonReason | null {
	if (removed.has(identityId)) return "removed_from_team";
	if (!actor) return "identity_missing";
	if (actor.status === "merged" || actor.merged_into_actor_id) return "merged";
	if (
		isWithdrawnPolicyIdentity({
			status: actor.status,
			mergedIntoIdentityId: actor.merged_into_actor_id,
		})
	)
		return "deactivated";
	return actor.status === "active" ? null : "identity_not_active";
}

/**
 * Every person with a membership row, and every person the setup made a
 * member. Only a membership that is active now can stay active, and it ends
 * when the person was removed or their identity is no longer usable.
 */
function planPeople(db: Database, subject: Subject, checked: CheckedEvidence) {
	const rows = db
		.prepare("SELECT identity_id, status FROM policy_team_memberships WHERE team_id = ?")
		.all(subject.teamId) as Array<{ identity_id: string; status: string }>;
	const statusById = new Map(rows.map((row) => [row.identity_id, row.status]));
	const actor = db.prepare(
		"SELECT display_name, status, merged_into_actor_id FROM actors WHERE actor_id = ?",
	);
	const identityIds = new Set([
		...statusById.keys(),
		...checked.manifest.memberships.map((membership) => membership.identity_id),
	]);
	const people = [...identityIds].toSorted(compareCodepoints).map((identityId) => {
		const row = actor.get(identityId) as ActorRow | undefined;
		const status = statusById.get(identityId);
		// Pending and revoked memberships grant nothing, and recovery never starts one.
		const inactive = status === undefined || status === "pending" || status === "revoked";
		const reason = inactive
			? "not_a_member"
			: memberLeftOutReason(identityId, row, checked.removedIdentityIds);
		const person: TeamRecoveryPerson = {
			identityId,
			displayName: row?.display_name ?? null,
			outcome: reason ? "left_out" : "member",
		};
		return reason ? { ...person, reason } : person;
	});
	// The memberships as recovery would leave them, for deriving device eligibility.
	const memberships = people.map((person) => ({
		identityId: person.identityId,
		status: person.outcome === "member" ? (statusById.get(person.identityId) as string) : "revoked",
	}));
	return { people, memberships };
}

/**
 * The exact policy rows the plan was made on. A row that changes between the
 * preview and the commit changes the digest, even when the outcome it leads to
 * would read the same.
 */
function boundRows(db: Database, teamId: string): unknown[][] {
	const members = "SELECT identity_id FROM policy_team_memberships WHERE team_id = ?";
	const decided = "SELECT device_id FROM policy_team_device_decisions WHERE team_id = ?";
	const rows = (sql: string, ...values: string[]) =>
		db
			.prepare(sql)
			.raw()
			.all(...values);
	return [
		rows(
			`SELECT status, migration_state, provenance, revision, display_name
			 FROM policy_teams WHERE team_id = ?`,
			teamId,
		),
		rows(
			`SELECT identity_id, status, provenance, revision FROM policy_team_memberships
			 WHERE team_id = ? ORDER BY identity_id`,
			teamId,
		),
		rows(
			`SELECT device_id, decision, assignment_version, provenance, revision
			 FROM policy_team_device_decisions WHERE team_id = ? ORDER BY device_id`,
			teamId,
		),
		rows(
			`SELECT device_id, identity_id, status, assignment_version, source_fingerprint
			 FROM identity_devices WHERE identity_id IN (${members}) OR device_id IN (${decided})
			 ORDER BY device_id`,
			teamId,
			teamId,
		),
		rows(
			`SELECT canonical_project_identity, status, provenance, policy_revision, migration_state
			 FROM project_recipients WHERE recipient_kind = 'team' AND recipient_id = ?
			 ORDER BY canonical_project_identity`,
			teamId,
		),
		rows(
			`SELECT device_id, key_fingerprint, reason FROM policy_team_recovery_exclusions
			 WHERE team_id = ? ORDER BY device_id`,
			teamId,
		),
	];
}

/**
 * The completed setup attempt and each newer attempt the recovery discards,
 * with every device and Project row of theirs. An attempt edited in place
 * after the preview is not the attempt the admin agreed to discard.
 */
function boundSetupAttempts(db: Database, attemptIds: readonly string[]): unknown[][] {
	const ids = JSON.stringify(attemptIds);
	const rows = (table: string, order: string) =>
		db
			.prepare(
				`SELECT * FROM ${table} WHERE attempt_id IN (SELECT value FROM json_each(?))
				 ORDER BY ${order}`,
			)
			.raw()
			.all(ids);
	return [
		rows("legacy_team_setup_drafts", "attempt_id"),
		rows("legacy_team_setup_draft_devices", "attempt_id, device_id"),
		rows("legacy_team_setup_draft_projects", "attempt_id, project_ref"),
	];
}

function previewDigest(
	db: Database,
	subject: Subject,
	checked: CheckedEvidence,
	plan: Pick<TeamRecoveryPreview, "people" | "projects"> & {
		devices: ReturnType<typeof planTeamRecoveryDevices> & { state: "planned" };
	},
): string {
	return recipientPolicyDigest(PREVIEW_DIGEST_DOMAIN, {
		candidateRef: subject.candidateRef,
		teamId: subject.teamId,
		coordinatorId: subject.coordinatorId,
		groupId: subject.groupId,
		completionFinishDigest: checked.manifest.finish_digest,
		attemptId: subject.attemptId,
		finishKey: subject.finishKey,
		discardedAttemptIds: subject.newerAttemptIds,
		removedIdentityIds: [...checked.removedIdentityIds].toSorted(compareCodepoints),
		people: plan.people.map((person) => [person.identityId, person.outcome, person.reason ?? null]),
		devices: plan.devices.devices.map((device) => [
			device.deviceId,
			device.identityId,
			device.outcome,
			device.reason ?? null,
		]),
		deviceExclusions: plan.devices.exclusions,
		survivingKeys: plan.devices.survivingKeys,
		rows: boundRows(db, subject.teamId),
		setupAttempts: boundSetupAttempts(db, [subject.attemptId, ...subject.newerAttemptIds]),
		projects: plan.projects.map((project) => [
			project.projectIdentity,
			project.outcome,
			project.reason ?? null,
			project.routedScopeIds,
			project.restoredMappings,
		]),
	});
}

/** Everything a commit needs to write a recovery: the preview and what it does not show. */
export interface TeamRecoveryPlan {
	state: "planned";
	preview: TeamRecoveryPreview;
	coordinatorId: string;
	groupId: string;
	/** The completed setup attempt, and the completion key that goes back on it. */
	attemptId: string;
	finishKey: string;
	discardedAttemptIds: string[];
	/** Devices to leave out, each with the key it was removed or blocked under. */
	exclusions: TeamRecoveryExclusion[];
	/** This Team's member removals as just read from its group, to record and apply. */
	memberRemovals: CoordinatorTeamMemberRemoval[];
}

/**
 * Plans recovering the quarantined Team that the coordinator group set up,
 * or one an abandoned recovery left active and held. Writes nothing. `evidence` is what the caller read from the coordinator for this
 * request: if any part is unavailable or does not fit, the result is a refusal
 * that names it, and nothing can be recovered from it.
 */
export function planTeamRecovery(
	db: Database,
	input: { coordinatorId: string; groupId: string },
	evidence: TeamRecoveryEvidence,
	options: { nowMs?: number } = {},
): TeamRecoveryPlan | Refused {
	const nowMs = options.nowMs ?? Date.now();
	if (db.readonly || !abandonedRecoveryTeam(db, input, nowMs))
		return planDisabledTeamRecovery(db, input, evidence);
	// Planned on the rows a takeover would leave, then undone: planning writes nothing.
	const planned: { plan?: TeamRecoveryPlan | Refused } = {};
	try {
		db.transaction(() => {
			disableAbandonedTeamRecovery(db, input, nowMs);
			planned.plan = planDisabledTeamRecovery(db, input, evidence);
			throw PLAN_ONLY;
		})();
	} catch (error) {
		if (error !== PLAN_ONLY) throw error;
	}
	return planned.plan ?? refuse("team_not_quarantined");
}

const PLAN_ONLY = new Error("team recovery plan only");

/**
 * The Team when it is active and held by a recovery that was left behind. A
 * recovery that stopped after its first transaction leaves the Team that way,
 * serving nothing, and nothing but another recovery can settle it.
 */
function abandonedRecoveryTeam(
	db: Database,
	input: { coordinatorId: string; groupId: string },
	nowMs: number,
): { candidateRef: string; teamId: string } | null {
	if (!input.coordinatorId || !isStrictRecipientPolicyId(input.groupId)) return null;
	const candidateRef = legacyTeamCandidateId(input.coordinatorId, input.groupId);
	const teamId = deterministicPolicyTeamId(candidateRef);
	const active = db
		.prepare(
			`SELECT 1 FROM policy_teams WHERE team_id = ? AND status = 'active'
			   AND provenance = 'reviewed_team_candidate'
			   AND device_eligibility_mode = 'reviewed_allowlist'`,
		)
		.get(teamId);
	if (!active || !isTeamRecoveryHoldAbandoned(db, teamId, nowMs)) return null;
	return { candidateRef, teamId };
}

/**
 * Lets an explicit recovery take over a Team an abandoned recovery left active
 * and held. It disables the Team as quarantine does, in the caller's
 * transaction, so the Team is planned and recovered like any disabled Team. The
 * hold stays on throughout, so the Team serves nothing meanwhile. Returns
 * whether there was such a Team.
 */
export function disableAbandonedTeamRecovery(
	db: Database,
	input: { coordinatorId: string; groupId: string },
	nowMs: number,
): boolean {
	const team = abandonedRecoveryTeam(db, input, nowMs);
	if (team) quarantineLegacyTeamSetupPolicyInTransaction(db, team);
	return team !== null;
}

function planDisabledTeamRecovery(
	db: Database,
	input: { coordinatorId: string; groupId: string },
	evidence: TeamRecoveryEvidence,
): TeamRecoveryPlan | Refused {
	const subject = readSubject(db, input);
	if (typeof subject === "string") return refuse(subject);
	const checked = checkEvidence(db, subject, evidence);
	if (typeof checked === "string") return refuse(checked);
	const { people, memberships } = planPeople(db, subject, checked);
	const devices = planTeamRecoveryDevices(db, { ...subject, ...checked, memberships });
	if (devices.state === "refused") return refuse(devices.reason, devices.deviceIds);
	if (devices.state === "blocked") return refuse("team_policy_blocked");
	const projects = planTeamRecoveryProjects(db, subject);
	const preview: TeamRecoveryPreview = {
		state: "ready",
		teamId: subject.teamId,
		teamName: subject.teamName,
		candidateRef: subject.candidateRef,
		people,
		devices: devices.devices,
		projects,
		discardedSetupAttempts: subject.newerAttemptIds.length,
		expectedDigest: previewDigest(db, subject, checked, { people, devices, projects }),
	};
	return {
		state: "planned",
		preview,
		coordinatorId: subject.coordinatorId,
		groupId: subject.groupId,
		attemptId: subject.attemptId,
		finishKey: subject.finishKey,
		discardedAttemptIds: subject.newerAttemptIds,
		exclusions: devices.exclusions,
		memberRemovals: checked.memberRemovals,
	};
}

/** The preview of a Team recovery: what `planTeamRecovery` would do, or why it cannot run. */
export function previewTeamRecovery(
	db: Database,
	input: { coordinatorId: string; groupId: string },
	evidence: TeamRecoveryEvidence,
	options: { nowMs?: number } = {},
): TeamRecoveryPreviewResult {
	const plan = planTeamRecovery(db, input, evidence, options);
	return plan.state === "planned" ? plan.preview : plan;
}
