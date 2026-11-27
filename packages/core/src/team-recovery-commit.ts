import { randomUUID } from "node:crypto";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "./coordinator-legacy-team-completion.js";
import type { Database } from "./db.js";
import { wakeRecipientPoliciesForProjectIdentities } from "./device-identity-binding.js";
import { quarantineLegacyTeamSetupPolicyInTransaction } from "./legacy-team-setup-completion-manifest.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
	recipientPolicyDigest,
} from "./recipient-policy-identifiers.js";
import {
	serializeRecipientPolicyActorMutations,
	serializeRecipientPolicyCoordinatorGroupMutation,
	serializeRecipientPolicyPublicationMutation,
	serializeRecipientPolicyTeamMutation,
} from "./recipient-policy-team-metadata.js";
import { resolveRepositoryIdentityScope } from "./scope-stamping.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import {
	applyTeamMemberRemovals,
	recordTeamMemberRemovalEnforcements,
} from "./team-member-removal-policy.js";
import { recordTeamRecoveryExclusions } from "./team-recovery-exclusions.js";
import {
	isTeamRecoveryHeldBy,
	liftTeamRecoveryHold,
	placeTeamRecoveryHold,
	recordTeamRecoveryHoldReason,
	TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS,
	trackLiveTeamRecovery,
} from "./team-recovery-holds.js";
import {
	disableAbandonedTeamRecovery,
	planTeamRecovery,
	type TeamRecoveryEvidence,
	type TeamRecoveryPlan,
	type TeamRecoveryPreview,
	type TeamRecoveryRefusal,
} from "./team-recovery-preview.js";
import { recordTeamRecoverySkippedProjects } from "./team-recovery-skipped-projects.js";

/*
 * Committing a reviewed Team recovery. The commit reads the coordinator
 * evidence itself, recomputes the preview inside one immediate transaction,
 * and writes only when the digest the admin reviewed still matches.
 *
 * A local transaction cannot stop the coordinator from changing between the
 * evidence read and the local write. Three things keep that window small and
 * its effect short:
 * - evidence older than a short limit is refused;
 * - the evidence is read again right after the commit, and the Team is
 *   quarantined again when anything that mattered changed or cannot be read;
 * - sync admission checks each device's current eligibility on its own.
 *
 * The commit places a hold on the Team in its transaction, and only that
 * second read lifts it. A held Team serves no device, so nothing is served on
 * evidence that was read once. A hold that is not lifted stays through the
 * quarantine: applying the coordinator's copy of the setup again cannot make
 * the Team active, only another recovery can. The hold names this recovery,
 * so a second read that comes back late changes nothing a later recovery did.
 */

// A commit that cannot gather its evidence within the limit is refused and can be tried again.
export { TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS };

export interface TeamRecoveryEvidenceReading {
	evidence: TeamRecoveryEvidence;
	/**
	 * When this machine sent the first of the reads, on its own clock, in
	 * milliseconds. Never taken from a reply.
	 */
	startedAtMs: number;
}

export interface TeamRecoveryCommitContext {
	/** Reads every part of the evidence from the coordinator. Called before the commit and right after it. */
	readEvidence(): Promise<TeamRecoveryEvidenceReading>;
	/** This machine's clock, in milliseconds. */
	nowMs?: () => number;
	/**
	 * Whether this machine may still recover the Team, from its configuration as
	 * it is now. Asked inside the transaction that writes the recovery and inside
	 * the one that settles it, because the reads before each can take a while
	 * and the administrator's authority can end meanwhile.
	 */
	stillAuthorized?: () => boolean;
}

export type TeamRecoveryCommitRefusal =
	| TeamRecoveryRefusal
	| "evidence_stale"
	| "admin_authority_changed"
	| "recovery_preview_stale"
	| "recovery_state_changed";

export type TeamRecoveryCommitResult =
	| { state: "refused"; reason: TeamRecoveryCommitRefusal; deviceIds?: string[] }
	| { state: "recovered"; preview: TeamRecoveryPreview }
	/**
	 * The recovery was written and the Team is disabled again, still held: the
	 * evidence read right after had changed or failed, or something else
	 * disabled the Team before that read came back.
	 */
	| {
			state: "quarantined_again";
			reason: "evidence_changed" | "evidence_unavailable" | "disabled_before_verification";
	  }
	/**
	 * The recovery was written and the Team is still held, serving nothing: the
	 * read after it was too old by the time this machine could act on it, or
	 * this machine's authority to recover the Team ended meanwhile. The recovery
	 * can be tried again by an administrator, and takes this hold over.
	 */
	| { state: "unverified"; reason: "evidence_stale" | "admin_authority_changed" }
	/** The recovery was written, and a later recovery took the Team over before this one was verified. */
	| { state: "superseded" };

/** A write found the rows it was planned on gone. The transaction rolls back. */
class RecoveryStateChanged extends Error {}

function requireOneRow(changes: number): void {
	if (changes !== 1) throw new RecoveryStateChanged();
}

/** The Team active again as its completed setup left it, with nothing newer in its way. */
function reactivateTeam(db: Database, plan: TeamRecoveryPlan, now: string): void {
	requireOneRow(
		db
			.prepare(
				`UPDATE policy_teams SET status = 'active', migration_state = 'completed', updated_at = ?
				 WHERE team_id = ? AND status = 'inactive' AND migration_state = 'needs_setup'`,
			)
			.run(now, plan.preview.teamId).changes,
	);
	// Later reconciliation reads the newest attempt, so the completed one must be it again.
	const discard = plan.discardedAttemptIds.map(() => "?").join(", ");
	for (const table of ["legacy_team_setup_draft_devices", "legacy_team_setup_draft_projects"])
		db.prepare(`DELETE FROM ${table} WHERE attempt_id IN (${discard})`).run(
			...plan.discardedAttemptIds,
		);
	db.prepare(`DELETE FROM legacy_team_setup_drafts WHERE attempt_id IN (${discard})`).run(
		...plan.discardedAttemptIds,
	);
	// The completion key ties the setup to its completion record, and with it to the Team's group.
	requireOneRow(
		db
			.prepare(
				`UPDATE legacy_team_setup_drafts SET finish_digest = ?, superseded_at = NULL
				 WHERE attempt_id = ? AND state = 'completed'`,
			)
			.run(plan.finishKey, plan.attemptId).changes,
	);
}

/** Only recipients still exactly as quarantine left them, and mappings where nothing routes the Project. */
function restoreProjects(db: Database, plan: TeamRecoveryPlan, now: string): void {
	const insertMapping = db.prepare(
		`INSERT INTO project_scope_mappings(
		 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
		 ) VALUES (?, ?, ?, 1000, 'reviewed_team_setup', ?, ?)`,
	);
	const restoreRecipient = db.prepare(
		`UPDATE project_recipients SET status = 'active', migration_state = 'completed', updated_at = ?
		 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?
		   AND status = 'revoked' AND provenance = 'reviewed_team_setup'
		   AND migration_state = 'needs_setup'`,
	);
	for (const project of plan.preview.projects) {
		if (project.outcome !== "restored") continue;
		for (const mapping of project.restoredMappings)
			insertMapping.run(
				project.projectIdentity,
				mapping.sourceProjectIdentity,
				mapping.scopeId,
				now,
				now,
			);
		requireOneRow(restoreRecipient.run(now, project.projectIdentity, plan.preview.teamId).changes);
		// A re-created mapping must be the one that routes the Project now.
		const reviewed = new Set(project.restoredMappings.map((mapping) => mapping.scopeId));
		const routed = resolveRepositoryIdentityScope(db, project.projectIdentity);
		if (reviewed.size > 0 && !reviewed.has(routed.scopeId)) throw new RecoveryStateChanged();
	}
}

/**
 * Everything recovery takes away: the devices it leaves out, the Team member
 * removals it now applies, and the memberships of people who cannot stay.
 */
function leaveOut(db: Database, plan: TeamRecoveryPlan, now: string): void {
	const { teamId } = plan.preview;
	recordTeamRecoveryExclusions(db, { teamId, devices: plan.exclusions, now });
	// The Team has its group again, so the group's removals apply to it from here on.
	applyTeamMemberRemovals(db, {
		coordinatorId: plan.coordinatorId,
		groupId: plan.groupId,
		removals: plan.memberRemovals,
		now,
	});
	const leaving = plan.preview.people.filter(
		(person) => person.outcome === "left_out" && person.reason !== "not_a_member",
	);
	recordTeamMemberRemovalEnforcements(db, {
		teamId,
		identityIds: leaving
			.filter((person) => person.reason === "removed_from_team")
			.map((person) => person.identityId),
		now,
	});
	const revoke = db.prepare(
		`UPDATE policy_team_memberships SET status = 'revoked', updated_at = ?
		 WHERE team_id = ? AND identity_id = ?`,
	);
	for (const person of leaving) revoke.run(now, teamId, person.identityId);
}

type Refusal = { state: "refused"; reason: TeamRecoveryCommitRefusal; deviceIds?: string[] };

interface Written {
	state: "written";
	plan: TeamRecoveryPlan;
	recoveryId: string;
	/** Ends this process's claim on the hold, once the recovery is settled. */
	finished: () => void;
}

type Applied = Refusal | Written;

/** The commit was refused after it had written. The transaction rolls back. */
class RecoveryRefused extends Error {
	constructor(readonly refusal: Refusal) {
		super(refusal.reason);
	}
}

/** The Projects this recovery does not share with the Team again, for admission to check. */
function recordSkippedProjects(
	db: Database,
	plan: TeamRecoveryPlan,
	recoveryId: string,
	now: string,
): void {
	recordTeamRecoverySkippedProjects(db, {
		teamId: plan.preview.teamId,
		recoveryId,
		projects: plan.preview.projects
			.filter((project) => project.outcome === "skipped")
			.map((project) => ({
				projectIdentity: project.projectIdentity,
				reason: project.reason ?? "skipped",
			})),
		now,
	});
}

/** Recomputes the plan and writes it, in the caller's immediate transaction. */
function applyRecovery(
	db: Database,
	input: { coordinatorId: string; groupId: string; expectedDigest: string },
	reading: TeamRecoveryEvidenceReading,
	{ nowMs, authorized }: { nowMs: number; authorized: boolean },
): Applied {
	if (!authorized) return { state: "refused", reason: "admin_authority_changed" };
	if (isTeamRecoveryEvidenceStale(reading.startedAtMs, nowMs))
		return { state: "refused", reason: "evidence_stale" };
	// A Team an abandoned recovery left active and held is disabled first, hold and all,
	// and then recovered like any disabled Team. A refusal undoes that with the rest.
	const tookOver = disableAbandonedTeamRecovery(db, input, nowMs);
	const refused = (refusal: Refusal): Refusal => {
		if (tookOver) throw new RecoveryRefused(refusal);
		return refusal;
	};
	const plan = planTeamRecovery(db, input, reading.evidence, { nowMs });
	if (plan.state === "refused") return refused(plan);
	if (plan.preview.expectedDigest !== input.expectedDigest)
		return refused({ state: "refused", reason: "recovery_preview_stale" });
	const now = new Date(nowMs).toISOString();
	const recoveryId = randomUUID();
	reactivateTeam(db, plan, now);
	restoreProjects(db, plan, now);
	leaveOut(db, plan, now);
	recordSkippedProjects(db, plan, recoveryId, now);
	// Held until the evidence is read again: the Team is active, and serves no device yet.
	// Its Projects are woken for reconciliation only once the hold is lifted.
	placeTeamRecoveryHold(db, { teamId: plan.preview.teamId, recoveryId, now });
	// From here until it is settled, the hold is this process's and not abandoned.
	return { state: "written", plan, recoveryId, finished: trackLiveTeamRecovery(recoveryId) };
}

/** The same serialization order as applying a completion: publication, people, Team, group. */
function serializeRecovery<T>(
	db: Database,
	input: { teamId: string; groupId: string },
	operation: () => Promise<T>,
): Promise<T> {
	return serializeRecipientPolicyPublicationMutation(db, () => {
		const actorIds = db
			.prepare("SELECT identity_id FROM policy_team_memberships WHERE team_id = ?")
			.pluck()
			.all(input.teamId) as string[];
		return serializeRecipientPolicyActorMutations(db, actorIds, () =>
			serializeRecipientPolicyTeamMutation(db, input.teamId, () =>
				serializeRecipientPolicyCoordinatorGroupMutation(db, input.groupId, operation),
			),
		);
	});
}

/** Every part of the evidence when all were read, with the completed setup in canonical form. */
function readParts(evidence: TeamRecoveryEvidence) {
	const { roster, deviceRemovals, deviceBlocks, completion, memberRemovals, groupBinding } =
		evidence;
	if (
		roster.status !== "read" ||
		deviceRemovals.status !== "read" ||
		deviceBlocks?.status !== "read" ||
		completion.status !== "read" ||
		memberRemovals.status !== "read" ||
		groupBinding.status !== "read"
	)
		return null;
	try {
		const manifest = canonicalCoordinatorLegacyTeamCompletionManifestJson(
			normalizeCoordinatorLegacyTeamCompletionManifest(completion.manifest),
		);
		return {
			roster,
			deviceRemovals,
			deviceBlocks,
			completion,
			memberRemovals,
			groupBinding,
			manifest,
		};
	} catch {
		return null;
	}
}

const sortedRows = (rows: string[][]) => rows.map((row) => row.join("\u0000")).toSorted();

/**
 * What the evidence says about the things this recovery decided on: its
 * devices and their keys, the Team's removed members, its group and its
 * completed setup. Null when any part could not be read.
 */
function decidingEvidence(evidence: TeamRecoveryEvidence, plan: TeamRecoveryPlan): string | null {
	const parts = readParts(evidence);
	if (!parts) return null;
	const { roster, deviceRemovals, deviceBlocks, completion, memberRemovals, groupBinding } = parts;
	const deviceIds = new Set(plan.preview.devices.map((device) => device.deviceId));
	const listed = roster.devices.filter((device) => deviceIds.has(device.deviceId));
	const keys = new Set([
		...listed.map((device) => device.fingerprint),
		...plan.exclusions.map((exclusion) => exclusion.fingerprint),
	]);
	const decides = (deviceId: string, key: string) => deviceIds.has(deviceId) || keys.has(key);
	const checkedKey = (publicKey: unknown) =>
		typeof publicKey === "string" ? fingerprintPublicKey(publicKey) : "";
	return recipientPolicyDigest("team-recovery-deciding-evidence-v1", {
		// Every part, the completed setup included: the same answer from another
		// coordinator or group is not the answer this recovery was planned on.
		sources: [roster, deviceRemovals, deviceBlocks, completion, memberRemovals, groupBinding].map(
			(part) => part.source,
		),
		roster: sortedRows(
			listed.map((device) => [device.deviceId, device.fingerprint, String(device.enabled)]),
		),
		removals: sortedRows(
			deviceRemovals.removals
				.filter((record) => decides(record.device_id, record.fingerprint))
				.map((record) => [
					record.group_id,
					record.device_id,
					record.fingerprint,
					String(record.revoked === true),
				]),
		),
		blocks: sortedRows(
			deviceBlocks.checks
				.filter((check) => decides(check.deviceId, checkedKey(check.publicKey)))
				.map((check) => [
					check.deviceId,
					checkedKey(check.publicKey),
					String(check.blocked !== false),
					String(check.removal),
				]),
		),
		removedMembers: memberRemovals.removals
			.filter((record) => record.team_id === plan.preview.teamId)
			.map((record) => record.identity_id)
			.toSorted(),
		binding: groupBinding.binding,
		manifest: parts.manifest,
	});
}

type Reread = "verified" | "evidence_changed" | "evidence_unavailable";

/**
 * A read that started too long before `nowMs`, or after it, says nothing that
 * can be acted on now. The preview applies the same rule, so it never offers a
 * plan the commit would refuse for its age.
 */
export function isTeamRecoveryEvidenceStale(startedAtMs: number, nowMs: number): boolean {
	const age = nowMs - startedAtMs;
	return !Number.isFinite(age) || age < 0 || age > TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS;
}

/**
 * Acts on the second read, in one transaction, and only for the recovery it
 * verified: its hold must still be the Team's. A machine that may no longer
 * recover the Team changes nothing here, whatever the read showed: the hold
 * stays and the Team keeps serving nothing, for an administrator to try again.
 * Otherwise a read that failed or showed a change quarantines the Team and
 * leaves the hold on it, so that only another recovery makes the Team active
 * again. A verified read lifts the hold, unless it is older than the evidence
 * limit by now, where waiting for the write lock counts. Then the hold stays
 * for a retry.
 */
function settleRecovery(
	db: Database,
	written: Written,
	second: { reread: Reread; stale: boolean; authorized: boolean },
): TeamRecoveryCommitResult {
	const { plan, recoveryId } = written;
	const { teamId, candidateRef } = plan.preview;
	const hold = { teamId, recoveryId };
	if (!isTeamRecoveryHeldBy(db, hold)) return { state: "superseded" };
	if (!second.authorized) return { state: "unverified", reason: "admin_authority_changed" };
	if (second.reread !== "verified") {
		recordTeamRecoveryHoldReason(db, { ...hold, reason: second.reread });
		quarantineLegacyTeamSetupPolicyInTransaction(db, { candidateRef, teamId });
		return { state: "quarantined_again", reason: second.reread };
	}
	const active = db
		.prepare("SELECT 1 FROM policy_teams WHERE team_id = ? AND status = 'active'")
		.get(teamId);
	// Something else disabled the Team meanwhile. Its hold stays, so only a recovery reopens it.
	if (!active) return { state: "quarantined_again", reason: "disabled_before_verification" };
	if (second.stale) return { state: "unverified", reason: "evidence_stale" };
	liftTeamRecoveryHold(db, hold);
	// Verified: from here recipient policy reads the Team as active, so its Projects reconcile.
	wakeRecipientPoliciesForProjectIdentities(
		db,
		plan.preview.projects.map((project) => project.projectIdentity),
		new Date().toISOString(),
	);
	return { state: "recovered", preview: plan.preview };
}

/**
 * Reads the evidence again right after the commit. When anything this
 * recovery decided on changed meanwhile, or cannot be read, the Team is
 * quarantined again. What recovery took away stays taken away.
 */
async function verifyAfterCommit(
	db: Database,
	context: TeamRecoveryCommitContext,
	written: Written,
	committedOn: TeamRecoveryEvidence,
): Promise<TeamRecoveryCommitResult> {
	const { plan } = written;
	const nowMs = context.nowMs ?? Date.now;
	const before = decidingEvidence(committedOn, plan);
	let after: string | null = null;
	let startedAtMs = Number.NaN;
	try {
		const second = await context.readEvidence();
		after = decidingEvidence(second.evidence, plan);
		startedAtMs = second.startedAtMs;
	} catch {
		after = null;
	}
	let reread: Reread = after === null ? "evidence_unavailable" : "evidence_changed";
	if (before !== null && after === before) reread = "verified";
	// The age and the authority are taken inside the transaction, once the write lock is held.
	const settle = () =>
		settleRecovery(db, written, {
			reread,
			stale: isTeamRecoveryEvidenceStale(startedAtMs, nowMs()),
			authorized: (context.stillAuthorized ?? (() => true))(),
		});
	return serializeRecovery(db, { teamId: plan.preview.teamId, groupId: plan.groupId }, () =>
		Promise.resolve(db.transaction(settle).immediate()),
	);
}

/**
 * Recovers the quarantined Team that the coordinator group set up, if the
 * preview the admin reviewed still holds on evidence read now.
 */
export async function commitTeamRecovery(
	db: Database,
	input: { coordinatorId: string; groupId: string; expectedDigest: string },
	context: TeamRecoveryCommitContext,
): Promise<TeamRecoveryCommitResult> {
	const nowMs = context.nowMs ?? Date.now;
	const stillAuthorized = context.stillAuthorized ?? (() => true);
	let reading: TeamRecoveryEvidenceReading;
	try {
		reading = await context.readEvidence();
	} catch {
		return { state: "refused", reason: "roster_unavailable" };
	}
	// Both are taken inside the transaction, after the read and with the write lock held.
	const apply = () =>
		applyRecovery(db, input, reading, { nowMs: nowMs(), authorized: stillAuthorized() });
	const teamId = deterministicPolicyTeamId(
		legacyTeamCandidateId(input.coordinatorId, input.groupId),
	);
	let applied: Applied;
	try {
		applied = await serializeRecovery(db, { teamId, groupId: input.groupId }, () =>
			Promise.resolve(db.transaction(apply).immediate()),
		);
	} catch (error) {
		if (error instanceof RecoveryRefused) return error.refusal;
		if (!(error instanceof RecoveryStateChanged)) throw error;
		return { state: "refused", reason: "recovery_state_changed" };
	}
	if (applied.state === "refused") return applied;
	try {
		return await verifyAfterCommit(db, context, applied, reading.evidence);
	} finally {
		applied.finished();
	}
}
