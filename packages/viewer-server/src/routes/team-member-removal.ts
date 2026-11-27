import {
	buildBaseUrl,
	commitTeamMemberRemoval,
	isCoordinatorAdminDevice,
	isStrictRecipientPolicyId,
	previewTeamMemberRemoval,
	readCoordinatorSyncConfig,
	revokePendingTeamInvitations,
	type TeamMemberRemovalContext,
	type TeamMemberRemovalRejection,
	teamCoordinatorLinkConflicts,
} from "@codemem/core";
import { type Context, Hono } from "hono";
import { parseViewerJsonBody, type StoreFactory } from "./sync.js";

/*
 * Viewer routes for removing a person from one Team: a preview that lists the
 * devices losing the Team's Projects and the Team's pending invitations, and a
 * commit bound to that preview's digest. Only an admin device can remove,
 * because the removal is recorded on the coordinator for every admin device.
 */

const BASE = "/api/sync/recipient-policy/v1/teams/:teamId/member-removals";

const STATUS: Record<TeamMemberRemovalRejection, 400 | 404 | 409 | 503> = {
	invalid_input: 400,
	team_not_found: 404,
	member_not_found: 404,
	team_not_linked: 409,
	team_link_conflict: 409,
	team_coordinator_not_configured: 409,
	member_already_removed: 409,
	cannot_remove_yourself: 409,
	removal_preview_stale: 409,
	invitations_unavailable: 503,
	coordinator_unavailable: 503,
};

export interface TeamMemberRemovalRouteOptions {
	readCoordinatorConfig?: typeof readCoordinatorSyncConfig;
	/** Coordinator calls, replaced in tests. */
	actions?: TeamMemberRemovalContext["actions"];
}

type Body = Record<string, unknown>;

/** The identifier format the policy layer and the coordinator accept. */
function isId(value: unknown): value is string {
	return isStrictRecipientPolicyId(value);
}

function previewBody(body: unknown): { identityId: string } | null {
	const data = body as Body | null;
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	if (Object.keys(data).length !== 1 || !isId(data.identityId)) return null;
	return { identityId: data.identityId };
}

function commitBody(
	body: unknown,
): { identityId: string; expectedDigest: string; revokeInvitationIds: string[] } | null {
	const data = body as Body | null;
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const keys = Object.keys(data).toSorted();
	if (keys.join(",") !== "expectedDigest,identityId,revokeInvitationIds") return null;
	const { identityId, expectedDigest, revokeInvitationIds } = data;
	if (!isId(identityId) || typeof expectedDigest !== "string" || expectedDigest.length > 256)
		return null;
	if (!Array.isArray(revokeInvitationIds) || revokeInvitationIds.length > 200) return null;
	if (!revokeInvitationIds.every(isId)) return null;
	return { identityId, expectedDigest, revokeInvitationIds };
}

function revokeBody(body: unknown): string[] | null {
	const data = body as Body | null;
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	if (Object.keys(data).length !== 1 || !Array.isArray(data.inviteIds)) return null;
	const ids = data.inviteIds;
	return ids.length > 0 && ids.length <= 200 && ids.every(isId) ? (ids as string[]) : null;
}

/** The removal context, or null when this device cannot change other people's access. */
function removalContext(
	getStore: StoreFactory,
	options: TeamMemberRemovalRouteOptions,
): TeamMemberRemovalContext | null {
	const config = (options.readCoordinatorConfig ?? readCoordinatorSyncConfig)();
	if (!isCoordinatorAdminDevice(config)) return null;
	const store = getStore();
	return {
		coordinator: {
			remoteUrl: buildBaseUrl(config.syncCoordinatorUrl),
			adminSecret: config.syncCoordinatorAdminSecret,
			groupIds: config.syncCoordinatorGroups,
			timeoutS: Math.max(1, config.syncCoordinatorTimeoutS),
		},
		localIdentityId: store.actorId ?? null,
		localDeviceId: store.deviceId ?? null,
		actions: options.actions,
	};
}

export function teamMemberRemovalRoutes(
	getStore: StoreFactory,
	options: TeamMemberRemovalRouteOptions = {},
) {
	const app = new Hono();
	const context = () => removalContext(getStore, options);

	const handle = async (
		c: Context,
		run: (teamId: string, body: unknown, ctx: TeamMemberRemovalContext) => Promise<unknown>,
	) => {
		const ctx = context();
		if (!ctx) return c.json({ error: "coordinator_admin_required" }, 403);
		const teamId = c.req.param("teamId");
		if (!isId(teamId)) return c.json({ error: "invalid_input" }, 400);
		const result = (await run(teamId, await parseViewerJsonBody(c), ctx)) as
			| { state: "rejected"; error: TeamMemberRemovalRejection }
			| { state: string };
		if (result.state === "rejected" && "error" in result)
			return c.json({ error: result.error }, STATUS[result.error]);
		return c.json(result);
	};

	// Teams whose coordinator group is a conflict: their removals do not apply, and the Viewer warns.
	app.get("/api/sync/recipient-policy/v1/team-coordinator-link-conflicts", (c) =>
		c.json({ teamIds: teamCoordinatorLinkConflicts(getStore().db) }),
	);

	app.post(`${BASE}/preview`, (c) =>
		handle(c, async (teamId, body, ctx) => {
			const input = previewBody(body);
			if (!input) return { state: "rejected", error: "invalid_input" };
			return previewTeamMemberRemoval(getStore().db, { teamId, ...input }, ctx);
		}),
	);

	app.post(`${BASE}/commit`, (c) =>
		handle(c, async (teamId, body, ctx) => {
			const input = commitBody(body);
			if (!input) return { state: "rejected", error: "invalid_input" };
			return commitTeamMemberRemoval(getStore().db, { teamId, ...input }, ctx);
		}),
	);

	// Retries invitation revokes that failed during a removal. Only pending ones are revoked.
	app.post("/api/sync/recipient-policy/v1/teams/:teamId/invitations/revoke", (c) =>
		handle(c, async (teamId, body, ctx) => {
			const inviteIds = revokeBody(body);
			if (!inviteIds) return { state: "rejected", error: "invalid_input" };
			return revokePendingTeamInvitations(getStore().db, { teamId, inviteIds }, ctx);
		}),
	);

	return app;
}
