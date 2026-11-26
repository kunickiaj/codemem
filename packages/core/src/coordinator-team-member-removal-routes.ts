import type { Context, Hono } from "hono";
import type { DeviceAuthLinkDeps } from "./coordinator-device-auth-link.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";
import type {
	CoordinatorListTeamMemberRemovalsInput,
	CoordinatorRecordTeamMemberRemovalInput,
} from "./coordinator-team-member-removals.js";
import { isStrictRecipientPolicyId } from "./recipient-policy-identifiers.js";

export const TEAM_MEMBER_REMOVALS_PATH = "/v1/admin/team-member-removals";
const MAX_BODY_BYTES = 4 * 1024;
const RECORD_FIELDS = new Set(["group_id", "team_id", "identity_id", "removed_by_device_id"]);

interface TeamMemberRemovalRouteDeps extends Pick<DeviceAuthLinkDeps, "rateLimitedResponse"> {
	storeFactory(): CoordinatorStore;
	authorizeAdmin(secret: string | undefined): { ok: boolean; error: string };
	readRequestBytes(c: Context, maxBytes: number): Promise<Uint8Array | null>;
	parseJsonObject(raw: Uint8Array): Record<string, unknown> | null;
}

/** Exactly the known fields, each a strict identifier; null for anything else. */
function parseRecordBody(
	data: Record<string, unknown> | null,
): CoordinatorRecordTeamMemberRemovalInput | null {
	if (!data || Object.keys(data).some((key) => !RECORD_FIELDS.has(key))) return null;
	const { group_id: groupId, team_id: teamId, identity_id: identityId } = data;
	const removedBy = data.removed_by_device_id ?? null;
	if (
		!isStrictRecipientPolicyId(groupId) ||
		!isStrictRecipientPolicyId(teamId) ||
		!isStrictRecipientPolicyId(identityId) ||
		(removedBy !== null && !isStrictRecipientPolicyId(removedBy))
	)
		return null;
	return { groupId, teamId, identityId, removedByDeviceId: removedBy };
}

const LIST_QUERY_NAMES = new Set(["group_id", "team_id", "after_seq"]);

/** `group_id` is required; `team_id` and `after_seq` are optional. Each name may appear once. */
function parseListQuery(query: URLSearchParams): CoordinatorListTeamMemberRemovalsInput | null {
	const names = [...query.keys()];
	if (names.some((name) => !LIST_QUERY_NAMES.has(name)) || new Set(names).size !== names.length)
		return null;
	const groupId = query.get("group_id");
	const teamId = query.get("team_id");
	const afterSeq = query.get("after_seq");
	if (!isStrictRecipientPolicyId(groupId)) return null;
	if (teamId !== null && !isStrictRecipientPolicyId(teamId)) return null;
	if (afterSeq !== null && (!/^\d+$/u.test(afterSeq) || !Number.isSafeInteger(Number(afterSeq))))
		return null;
	return {
		groupId,
		teamId,
		afterSeq: afterSeq === null ? null : Number(afterSeq),
	};
}

function storeFailure(c: Context, error: unknown): Response {
	const code = error instanceof Error ? error.message : "";
	if (code === "team_member_removal_unavailable") return c.json({ error: code }, 503);
	if (code === "group_not_found") return c.json({ error: code }, 404);
	if (code === "invalid_input") return c.json({ error: code }, 400);
	throw error;
}

/** Admin-only routes that record per-Team member removals and list them with derived state. The list only reads. */
export function registerCoordinatorTeamMemberRemovalRoutes(
	app: Hono,
	deps: TeamMemberRemovalRouteDeps,
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

	app.post(TEAM_MEMBER_REMOVALS_PATH, async (c) => {
		const refusal = denied(c);
		if (refusal) return refusal;
		const raw = await deps.readRequestBytes(c, MAX_BODY_BYTES);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const input = parseRecordBody(deps.parseJsonObject(raw));
		if (!input) return c.json({ error: "invalid_input" }, 400);
		const store = deps.storeFactory();
		try {
			const { status, removal } = await store.recordTeamMemberRemoval(input);
			return c.json({ version: 1, status, removal }, status === "created" ? 201 : 200);
		} catch (error) {
			return storeFailure(c, error);
		} finally {
			await store.close();
		}
	});

	app.get(TEAM_MEMBER_REMOVALS_PATH, async (c) => {
		const refusal = denied(c);
		if (refusal) return refusal;
		const options = parseListQuery(new URL(c.req.url).searchParams);
		if (!options) return c.json({ error: "invalid_input" }, 400);
		const store = deps.storeFactory();
		try {
			const { items, next_after_seq } = await store.listTeamMemberRemovals(options);
			return c.json({ version: 1, items, next_after_seq });
		} catch (error) {
			return storeFailure(c, error);
		} finally {
			await store.close();
		}
	});
}
