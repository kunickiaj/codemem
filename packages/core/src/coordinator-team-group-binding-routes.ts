import type { Context, Hono } from "hono";
import type { DeviceAuthLinkDeps } from "./coordinator-device-auth-link.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";
import { TEAM_GROUP_BINDING_READ_LIMIT } from "./coordinator-team-group-bindings.js";
import { isStrictRecipientPolicyId } from "./recipient-policy-identifiers.js";

export const TEAM_GROUP_BINDINGS_PATH = "/v1/admin/team-group-bindings";
const MAX_BODY_BYTES = 4 * 1024;

interface TeamGroupBindingRouteDeps extends Pick<DeviceAuthLinkDeps, "rateLimitedResponse"> {
	storeFactory(): CoordinatorStore;
	authorizeAdmin(secret: string | undefined): { ok: boolean; error: string };
	readRequestBytes(c: Context, maxBytes: number): Promise<Uint8Array | null>;
	parseJsonObject(raw: Uint8Array): Record<string, unknown> | null;
}

/** Only repeated `team_id` names, 1 to the read limit, each a strict identifier. */
function parseReadQuery(query: URLSearchParams): string[] | null {
	const names = [...query.keys()];
	if (names.some((name) => name !== "team_id")) return null;
	const teamIds = query.getAll("team_id");
	if (teamIds.length === 0 || teamIds.length > TEAM_GROUP_BINDING_READ_LIMIT) return null;
	return teamIds.every((id) => isStrictRecipientPolicyId(id)) ? teamIds : null;
}

/** Exactly `team_id` and `group_id`, each a strict identifier. */
function parseBindBody(
	data: Record<string, unknown> | null,
): { teamId: string; groupId: string } | null {
	if (!data || Object.keys(data).length !== 2) return null;
	const { team_id: teamId, group_id: groupId } = data;
	if (!isStrictRecipientPolicyId(teamId) || !isStrictRecipientPolicyId(groupId)) return null;
	return { teamId, groupId };
}

function storeFailure(c: Context, error: unknown): Response {
	const code = error instanceof Error ? error.message : "";
	if (code === "team_group_binding_unavailable") return c.json({ error: code }, 503);
	if (code === "group_not_found") return c.json({ error: code }, 404);
	if (code === "team_bound_to_other_group") return c.json({ error: code }, 409);
	if (code === "invalid_input") return c.json({ error: code }, 400);
	throw error;
}

/**
 * Admin-only routes for each Team's coordinator group. The read only reads.
 * The bind route binds an unbound Team ID, such as one whose Team invitations
 * came from more than one group before bindings existed. Nothing unbinds.
 */
export function registerCoordinatorTeamGroupBindingRoutes(
	app: Hono,
	deps: TeamGroupBindingRouteDeps,
): void {
	const denied = (c: Context): Response | null => {
		const auth = deps.authorizeAdmin(c.req.header("X-Codemem-Coordinator-Admin"));
		if (!auth.ok)
			return (
				deps.rateLimitedResponse(c, c.req.path, { authenticated: false }) ??
				c.json({ error: auth.error }, 401)
			);
		return deps.rateLimitedResponse(c, "admin", { authenticated: true });
	};

	app.get(TEAM_GROUP_BINDINGS_PATH, async (c) => {
		const refusal = denied(c);
		if (refusal) return refusal;
		const teamIds = parseReadQuery(new URL(c.req.url).searchParams);
		if (!teamIds) return c.json({ error: "invalid_input" }, 400);
		const store = deps.storeFactory();
		try {
			return c.json({ version: 1, items: await store.readTeamGroupBindings(teamIds) });
		} catch (error) {
			return storeFailure(c, error);
		} finally {
			await store.close();
		}
	});

	app.post(TEAM_GROUP_BINDINGS_PATH, async (c) => {
		const refusal = denied(c);
		if (refusal) return refusal;
		const raw = await deps.readRequestBytes(c, MAX_BODY_BYTES);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const input = parseBindBody(deps.parseJsonObject(raw));
		if (!input) return c.json({ error: "invalid_input" }, 400);
		const store = deps.storeFactory();
		try {
			const { status, binding } = await store.bindTeamGroup(input);
			return c.json({ version: 1, status, binding }, status === "created" ? 201 : 200);
		} catch (error) {
			return storeFailure(c, error);
		} finally {
			await store.close();
		}
	});
}
