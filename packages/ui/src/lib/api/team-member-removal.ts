/* Viewer calls for removing a person from one Team, and for Teams whose
 * coordinator group is a conflict. Answers are checked before use, and only
 * known error codes reach the UI. */

import { readJsonPayload } from "./internal";

export const TEAM_MEMBER_REMOVAL_ERROR_CODES = [
	"invalid_input",
	"coordinator_admin_required",
	"team_not_found",
	"team_not_linked",
	"team_link_conflict",
	"team_coordinator_not_configured",
	"member_not_found",
	"member_already_removed",
	"cannot_remove_yourself",
	"invitations_unavailable",
	"removal_preview_stale",
	"coordinator_unavailable",
	"team_member_removal_failed",
] as const;

export type TeamMemberRemovalErrorCode = (typeof TEAM_MEMBER_REMOVAL_ERROR_CODES)[number];

const KNOWN_ERRORS = new Set<string>(TEAM_MEMBER_REMOVAL_ERROR_CODES);

export class TeamMemberRemovalApiError extends Error {
	constructor(
		readonly statusCode: number,
		readonly errorCode: TeamMemberRemovalErrorCode,
	) {
		super(errorCode);
		this.name = "TeamMemberRemovalApiError";
	}
}

export interface TeamMemberRemovalPreview {
	teamName: string;
	identityId: string;
	displayName: string;
	devices: Array<{ deviceId: string; displayName: string }>;
	pendingInvitations: Array<{ inviteId: string; createdAt: string; expiresAt: string }>;
	expectedDigest: string;
}

/** What happened to one invitation. `unknown`: the revoke failed and can be retried. */
export type TeamInvitationRevokeResult =
	| "revoked"
	| "already_revoked"
	| "accepted"
	| "not_found"
	| "not_pending"
	| "unknown";

const REVOKE_RESULTS = new Set<string>([
	"revoked",
	"already_revoked",
	"accepted",
	"not_found",
	"not_pending",
	"unknown",
]);

export interface TeamMemberRemovalCommit {
	invitations: Array<{ inviteId: string; result: TeamInvitationRevokeResult }>;
	/** False when this device could not enforce the removal yet. */
	appliedHere: boolean;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

function failed(status: number): never {
	throw new TeamMemberRemovalApiError(status, "team_member_removal_failed");
}

async function post(path: string, body: unknown): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch {
		failed(0);
	}
	const { payload } = await readJsonPayload<unknown>(response);
	if (!response.ok) {
		const code = isObject(payload) && typeof payload.error === "string" ? payload.error : "";
		throw new TeamMemberRemovalApiError(
			response.status,
			KNOWN_ERRORS.has(code) ? (code as TeamMemberRemovalErrorCode) : "team_member_removal_failed",
		);
	}
	return payload;
}

const teamPath = (teamId: string) =>
	`/api/sync/recipient-policy/v1/teams/${encodeURIComponent(teamId)}`;

function parseInvitationResults(value: unknown): TeamMemberRemovalCommit["invitations"] | null {
	if (!Array.isArray(value)) return null;
	const rows = value.filter(
		(row): row is { inviteId: string; result: TeamInvitationRevokeResult } =>
			isObject(row) && isText(row.inviteId) && REVOKE_RESULTS.has(String(row.result)),
	);
	return rows.length === value.length ? rows : null;
}

/** Reviews removing the person: their devices, the Team's pending invitations and a digest. */
export async function previewTeamMemberRemoval(input: {
	teamId: string;
	identityId: string;
}): Promise<TeamMemberRemovalPreview> {
	const payload = await post(`${teamPath(input.teamId)}/member-removals/preview`, {
		identityId: input.identityId,
	});
	if (
		!isObject(payload) ||
		payload.state !== "ready" ||
		payload.identityId !== input.identityId ||
		!isText(payload.teamName) ||
		!isText(payload.displayName) ||
		!isText(payload.expectedDigest) ||
		!Array.isArray(payload.devices) ||
		!Array.isArray(payload.pendingInvitations)
	)
		failed(200);
	const devices = payload.devices.filter(
		(device): device is TeamMemberRemovalPreview["devices"][number] =>
			isObject(device) && isText(device.deviceId) && typeof device.displayName === "string",
	);
	const pendingInvitations = payload.pendingInvitations.filter(
		(invite): invite is TeamMemberRemovalPreview["pendingInvitations"][number] =>
			isObject(invite) &&
			isText(invite.inviteId) &&
			isText(invite.createdAt) &&
			isText(invite.expiresAt),
	);
	if (
		devices.length !== payload.devices.length ||
		pendingInvitations.length !== payload.pendingInvitations.length
	)
		failed(200);
	return {
		teamName: payload.teamName,
		identityId: input.identityId,
		displayName: payload.displayName,
		devices,
		pendingInvitations,
		expectedDigest: payload.expectedDigest,
	};
}

/** Removes the person if the reviewed preview is unchanged, and revokes the chosen invitations. */
export async function commitTeamMemberRemoval(input: {
	teamId: string;
	identityId: string;
	expectedDigest: string;
	revokeInvitationIds: string[];
}): Promise<TeamMemberRemovalCommit> {
	const payload = await post(`${teamPath(input.teamId)}/member-removals/commit`, {
		identityId: input.identityId,
		expectedDigest: input.expectedDigest,
		revokeInvitationIds: input.revokeInvitationIds,
	});
	if (!isObject(payload) || payload.state !== "removed" || typeof payload.appliedHere !== "boolean")
		failed(200);
	const invitations = parseInvitationResults(payload.invitations);
	if (!invitations) failed(200);
	return { invitations, appliedHere: payload.appliedHere };
}

/** Retries revoking invitations whose revoke failed. Only ones still pending are revoked. */
export async function retryTeamInvitationRevokes(input: {
	teamId: string;
	inviteIds: string[];
}): Promise<TeamMemberRemovalCommit["invitations"]> {
	const payload = await post(`${teamPath(input.teamId)}/invitations/revoke`, {
		inviteIds: input.inviteIds,
	});
	if (!isObject(payload) || payload.state !== "revoked") failed(200);
	const invitations = parseInvitationResults(payload.invitations);
	if (!invitations) failed(200);
	return invitations;
}

/** Teams whose coordinator group is a conflict. Throws when the list cannot be read. */
export async function loadTeamGroupConflicts(
	options: { signal?: AbortSignal } = {},
): Promise<string[]> {
	const response = await fetch("/api/sync/recipient-policy/v1/team-coordinator-link-conflicts", {
		signal: options.signal,
	});
	const { payload } = await readJsonPayload<unknown>(response);
	if (!response.ok || !isObject(payload) || !Array.isArray(payload.teamIds))
		throw new Error("team_group_conflicts_unavailable");
	return payload.teamIds.filter(isText);
}
