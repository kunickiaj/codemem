import {
	type CoordinatorAdminTarget,
	coordinatorListPendingTeamInvitationsAction,
	coordinatorRecordTeamMemberRemovalAction,
	coordinatorRevokeTeamInvitationAction,
	type PendingTeamInvitation,
	type TeamInvitationRevocation,
} from "./coordinator-team-member-removal-admin-client.js";
import type { CoordinatorTeamMemberRemoval } from "./coordinator-team-member-removals.js";
import type { Database } from "./db.js";
import { recipientPolicyDigest } from "./recipient-policy-identifiers.js";
import {
	isTeamMemberRemoved,
	teamMemberRemovalCoordinatorKey,
	teamRemovalCoordinatorGroup,
} from "./team-member-removal-lookup.js";
import { applyTeamMemberRemovals } from "./team-member-removal-policy.js";

/*
 * Removing a person from one Team, reviewed first. The preview names the
 * person, the devices that lose the Team's Projects and the Team's pending
 * invitations, and binds them in a digest. The commit runs only for an
 * unchanged preview: it records the removal on the coordinator, revokes the
 * invitations the admin chose, and applies the removal on this machine. A
 * removal is permanent for that identity, so the person can come back only
 * through a new Team invitation, under a new identity.
 */

const PREVIEW_DIGEST_DOMAIN = "team-member-removal-preview-v1";

export type TeamMemberRemovalRejection =
	| "invalid_input"
	| "team_not_found"
	| "team_not_linked"
	| "team_coordinator_not_configured"
	| "member_not_found"
	| "member_already_removed"
	| "cannot_remove_yourself"
	| "invitations_unavailable"
	| "removal_preview_stale"
	| "coordinator_unavailable";

export interface TeamMemberRemovalPreview {
	state: "ready";
	teamId: string;
	teamName: string;
	identityId: string;
	displayName: string;
	devices: Array<{ deviceId: string; displayName: string }>;
	pendingInvitations: PendingTeamInvitation[];
	expectedDigest: string;
}

export interface TeamMemberRemovalContext {
	/** The configured coordinator. Removal needs the admin secret. */
	coordinator: CoordinatorAdminTarget & { groupIds: readonly string[] };
	localIdentityId: string | null;
	localDeviceId: string | null;
	now?: () => string;
	actions?: {
		listPendingInvitations?: typeof coordinatorListPendingTeamInvitationsAction;
		recordRemoval?: typeof coordinatorRecordTeamMemberRemovalAction;
		revokeInvitation?: typeof coordinatorRevokeTeamInvitationAction;
	};
}

export type TeamMemberRemovalPreviewResult =
	| TeamMemberRemovalPreview
	| { state: "rejected"; error: TeamMemberRemovalRejection };

export type TeamMemberRemovalCommitResult =
	| { state: "rejected"; error: TeamMemberRemovalRejection }
	| {
			state: "removed";
			removal: CoordinatorTeamMemberRemoval;
			invitations: Array<{ inviteId: string; result: TeamInvitationRevocation | "unknown" }>;
			/** False when this machine could not apply it yet; the next enrollment check does. */
			appliedHere: boolean;
	  };

const reject = (error: TeamMemberRemovalRejection) => ({ state: "rejected" as const, error });

interface Subject {
	teamName: string;
	link: { coordinatorId: string; groupId: string };
	displayName: string;
	devices: Array<{ deviceId: string; displayName: string }>;
}

/** The Team, its coordinator group and the member, or the reason removal cannot start. */
function readSubject(
	db: Database,
	input: { teamId: string; identityId: string },
	context: TeamMemberRemovalContext,
): Subject | TeamMemberRemovalRejection {
	const team = db
		.prepare("SELECT display_name, status FROM policy_teams WHERE team_id = ?")
		.get(input.teamId) as { display_name: string; status: string } | undefined;
	if (team?.status !== "active") return "team_not_found";
	const link = teamRemovalCoordinatorGroup(db, input.teamId);
	if (!link) return "team_not_linked";
	const configured = teamMemberRemovalCoordinatorKey(context.coordinator.remoteUrl);
	if (
		configured === null ||
		configured !== teamMemberRemovalCoordinatorKey(link.coordinatorId) ||
		!context.coordinator.groupIds.includes(link.groupId)
	)
		return "team_coordinator_not_configured";
	if (input.identityId === context.localIdentityId) return "cannot_remove_yourself";
	if (isTeamMemberRemoved(db, input.teamId, input.identityId)) return "member_already_removed";
	const member = db
		.prepare(
			`SELECT actor.display_name FROM policy_team_memberships AS membership
			 JOIN actors AS actor ON actor.actor_id = membership.identity_id
			 WHERE membership.team_id = ? AND membership.identity_id = ?
			   AND membership.status IN ('active', 'reviewed_active')`,
		)
		.get(input.teamId, input.identityId) as { display_name: string } | undefined;
	if (!member) return "member_not_found";
	const devices = db
		.prepare(
			`SELECT device_id AS deviceId, display_name AS displayName FROM identity_devices
			 WHERE identity_id = ? AND status = 'active' ORDER BY device_id`,
		)
		.all(input.identityId) as Subject["devices"];
	return { teamName: team.display_name, link, displayName: member.display_name, devices };
}

function previewDigest(
	input: { teamId: string; identityId: string },
	subject: Subject,
	pending: readonly PendingTeamInvitation[],
): string {
	return recipientPolicyDigest(PREVIEW_DIGEST_DOMAIN, {
		groupId: subject.link.groupId,
		teamId: input.teamId,
		identityId: input.identityId,
		devices: subject.devices.map((device) => device.deviceId),
		invitations: pending.map((invitation) => invitation.inviteId),
	});
}

async function buildPreview(
	db: Database,
	input: { teamId: string; identityId: string },
	context: TeamMemberRemovalContext,
): Promise<{ preview: TeamMemberRemovalPreview; subject: Subject } | TeamMemberRemovalRejection> {
	const subject = readSubject(db, input, context);
	if (typeof subject === "string") return subject;
	const list =
		context.actions?.listPendingInvitations ?? coordinatorListPendingTeamInvitationsAction;
	let pending: PendingTeamInvitation[];
	try {
		pending = await list(context.coordinator, {
			groupId: subject.link.groupId,
			teamId: input.teamId,
			now: (context.now ?? (() => new Date().toISOString()))(),
		});
	} catch {
		return "invitations_unavailable";
	}
	return {
		subject,
		preview: {
			state: "ready",
			teamId: input.teamId,
			teamName: subject.teamName,
			identityId: input.identityId,
			displayName: subject.displayName,
			devices: subject.devices,
			pendingInvitations: pending,
			expectedDigest: previewDigest(input, subject, pending),
		},
	};
}

export async function previewTeamMemberRemoval(
	db: Database,
	input: { teamId: string; identityId: string },
	context: TeamMemberRemovalContext,
): Promise<TeamMemberRemovalPreviewResult> {
	const built = await buildPreview(db, input, context);
	return typeof built === "string" ? reject(built) : built.preview;
}

async function revokeChosen(
	context: TeamMemberRemovalContext,
	groupId: string,
	inviteIds: readonly string[],
) {
	const revoke = context.actions?.revokeInvitation ?? coordinatorRevokeTeamInvitationAction;
	const results: Array<{ inviteId: string; result: TeamInvitationRevocation | "unknown" }> = [];
	for (const inviteId of inviteIds) {
		try {
			results.push({ inviteId, result: await revoke(context.coordinator, { groupId, inviteId }) });
		} catch {
			results.push({ inviteId, result: "unknown" });
		}
	}
	return results;
}

/**
 * Removes the person if the preview is unchanged. The coordinator records the
 * removal first, so every admin device learns of it even if a later step fails.
 */
export async function commitTeamMemberRemoval(
	db: Database,
	input: {
		teamId: string;
		identityId: string;
		expectedDigest: string;
		revokeInvitationIds: readonly string[];
	},
	context: TeamMemberRemovalContext,
): Promise<TeamMemberRemovalCommitResult> {
	const built = await buildPreview(db, input, context);
	if (typeof built === "string") return reject(built);
	const { preview, subject } = built;
	if (preview.expectedDigest !== input.expectedDigest) return reject("removal_preview_stale");
	const pendingIds = new Set(preview.pendingInvitations.map((invitation) => invitation.inviteId));
	const chosen = [...new Set(input.revokeInvitationIds)];
	if (chosen.some((inviteId) => !pendingIds.has(inviteId))) return reject("invalid_input");
	const record = context.actions?.recordRemoval ?? coordinatorRecordTeamMemberRemovalAction;
	let removal: CoordinatorTeamMemberRemoval;
	try {
		({ removal } = await record(context.coordinator, {
			groupId: subject.link.groupId,
			teamId: input.teamId,
			identityId: input.identityId,
			removedByDeviceId: context.localDeviceId,
		}));
	} catch {
		return reject("coordinator_unavailable");
	}
	const invitations = await revokeChosen(context, subject.link.groupId, chosen);
	let appliedHere = true;
	try {
		applyTeamMemberRemovals(db, {
			coordinatorId: subject.link.coordinatorId,
			groupId: subject.link.groupId,
			removals: [removal],
			now: (context.now ?? (() => new Date().toISOString()))(),
		});
	} catch {
		appliedHere = false;
	}
	return { state: "removed", removal, invitations, appliedHere };
}
