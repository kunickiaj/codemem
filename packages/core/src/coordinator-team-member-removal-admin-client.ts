import { RemoteCoordinatorRequestError } from "./coordinator-actions.js";
import { capture } from "./coordinator-auth-link-input.js";
import type { CoordinatorTeamMemberRemoval } from "./coordinator-team-member-removals.js";
import { isStrictRecipientPolicyId } from "./recipient-policy-identifiers.js";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";

/*
 * Admin writes for removing a person from a Team: recording the removal on the
 * coordinator, listing the Team's invitations nobody has used yet, and revoking
 * them. Every answer is checked against what was asked, and only known error
 * codes are passed on, so remote text never reaches diagnostics.
 */

export interface CoordinatorAdminTarget {
	remoteUrl: string;
	adminSecret: string;
	timeoutS?: number;
}

const MAX_RESPONSE_BYTES = 2_000_000;
const KNOWN_ERRORS = new Set([
	"unauthorized",
	"rate_limited",
	"group_not_found",
	"invalid_input",
	"team_member_removal_unavailable",
	"invite_not_found",
	"invite_consumed",
	"invite_kind_unsupported",
]);

async function adminRequest(
	target: CoordinatorAdminTarget,
	method: "GET" | "POST",
	path: string,
	body?: Record<string, unknown>,
): Promise<{ status: number; payload: Record<string, unknown> | null }> {
	if (!target.adminSecret) throw new Error("Admin secret required.");
	const [status, payload] = await requestJson(method, `${buildBaseUrl(target.remoteUrl)}${path}`, {
		headers: { "X-Codemem-Coordinator-Admin": target.adminSecret },
		body,
		timeoutS: target.timeoutS ?? 5,
		maxResponseBytes: MAX_RESPONSE_BYTES,
	});
	return { status, payload };
}

function remoteFailure(status: number, payload: Record<string, unknown> | null): never {
	const error = payload?.error;
	const code =
		typeof error === "string" && KNOWN_ERRORS.has(error) ? error : "coordinator_unavailable";
	throw new RemoteCoordinatorRequestError(status, code);
}

function invalid(): never {
	throw new Error("team_member_removal_response_invalid");
}

/**
 * Records that the person was removed from the Team. Recording the same removal
 * again answers with the first one. Returns the removal as the coordinator
 * stores it.
 */
export async function coordinatorRecordTeamMemberRemovalAction(
	target: CoordinatorAdminTarget,
	input: { groupId: string; teamId: string; identityId: string; removedByDeviceId: string | null },
): Promise<{ status: "created" | "existing"; removal: CoordinatorTeamMemberRemoval }> {
	const { status, payload } = await adminRequest(target, "POST", "/v1/admin/team-member-removals", {
		group_id: input.groupId,
		team_id: input.teamId,
		identity_id: input.identityId,
		removed_by_device_id: input.removedByDeviceId,
	});
	if (status !== 200 && status !== 201) remoteFailure(status, payload);
	const reply = capture(payload, ["version", "status", "removal"]);
	const removal = capture(reply?.removal, [
		"removal_seq",
		"group_id",
		"team_id",
		"identity_id",
		"removed_by_device_id",
		"removed_at",
	]);
	if (
		reply?.version !== 1 ||
		(reply.status !== "created" && reply.status !== "existing") ||
		!removal ||
		removal.group_id !== input.groupId ||
		removal.team_id !== input.teamId ||
		removal.identity_id !== input.identityId ||
		typeof removal.removal_seq !== "number" ||
		!Number.isSafeInteger(removal.removal_seq) ||
		removal.removal_seq < 1 ||
		typeof removal.removed_at !== "string" ||
		!Number.isFinite(Date.parse(removal.removed_at)) ||
		!(
			removal.removed_by_device_id === null ||
			isStrictRecipientPolicyId(removal.removed_by_device_id)
		)
	)
		invalid();
	return {
		status: reply.status,
		removal: removal as unknown as CoordinatorTeamMemberRemoval,
	};
}

/** A Team invitation nobody has accepted, revoked or let expire. No token is kept. */
export interface PendingTeamInvitation {
	inviteId: string;
	createdAt: string;
	expiresAt: string;
}

/** The invitation when it is one of the Team's and still pending; null for any other row. */
function pendingInvitation(
	item: unknown,
	input: { groupId: string; teamId: string },
	now: number,
): PendingTeamInvitation | null {
	const row = (item ?? {}) as Record<string, unknown>;
	if (row.group_id !== input.groupId) invalid();
	if (row.invite_kind !== "team_member" || row.policy_team_id !== input.teamId) return null;
	if (row.consumed_at != null || row.revoked_at != null) return null;
	const { invite_id: inviteId, expires_at: expiresAt, created_at: createdAt } = row;
	if (
		!isStrictRecipientPolicyId(inviteId) ||
		typeof expiresAt !== "string" ||
		typeof createdAt !== "string" ||
		!Number.isFinite(Date.parse(expiresAt))
	)
		invalid();
	return Date.parse(expiresAt) > now ? { inviteId, createdAt, expiresAt } : null;
}

/** The Team's pending invitations in the group, oldest first. */
export async function coordinatorListPendingTeamInvitationsAction(
	target: CoordinatorAdminTarget,
	input: { groupId: string; teamId: string; now: string },
): Promise<PendingTeamInvitation[]> {
	const { status, payload } = await adminRequest(
		target,
		"GET",
		`/v1/admin/invites?group_id=${encodeURIComponent(input.groupId)}`,
	);
	if (status !== 200) remoteFailure(status, payload);
	const items = payload?.items;
	if (!Array.isArray(items)) invalid();
	const now = Date.parse(input.now);
	const pending = items
		.map((item) => pendingInvitation(item, input, now))
		.filter((invitation): invitation is PendingTeamInvitation => invitation !== null);
	return pending.toSorted(
		(a, b) => a.createdAt.localeCompare(b.createdAt) || a.inviteId.localeCompare(b.inviteId),
	);
}

export type TeamInvitationRevocation = "revoked" | "already_revoked" | "accepted" | "not_found";

/** Revokes one Team invitation. An invitation accepted meanwhile is reported, not an error. */
export async function coordinatorRevokeTeamInvitationAction(
	target: CoordinatorAdminTarget,
	input: { groupId: string; inviteId: string },
): Promise<TeamInvitationRevocation> {
	const { status, payload } = await adminRequest(target, "POST", "/v1/admin/invites/revoke", {
		group_id: input.groupId,
		invite_id: input.inviteId,
	});
	if (status === 409 && payload?.error === "invite_consumed") return "accepted";
	if (status === 404 && payload?.error === "invite_not_found") return "not_found";
	if (status !== 200) remoteFailure(status, payload);
	const reply = capture(payload, ["version", "status", "invite_id"]);
	if (
		reply?.version !== 1 ||
		reply.invite_id !== input.inviteId ||
		(reply.status !== "revoked" && reply.status !== "already_revoked")
	)
		invalid();
	return reply.status;
}
