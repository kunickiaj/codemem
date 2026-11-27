import { RemoteCoordinatorRequestError } from "./coordinator-actions.js";
import { TEAM_GROUP_BINDING_READ_LIMIT } from "./coordinator-team-group-bindings.js";
import { isStrictRecipientPolicyId } from "./recipient-policy-identifiers.js";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";
import type { CoordinatorTeamGroupBindingReport } from "./team-member-removal-lookup.js";

/*
 * Reading each Team's coordinator group from the coordinator, with the admin
 * secret. The answer must name exactly the Teams asked for, each once, or the
 * whole read fails: a client takes a Team's group only from a read it can
 * trust, so it never guesses one from a partial answer.
 */

const MAX_RESPONSE_BYTES = 200_000;
const KNOWN_ERRORS = new Set([
	"unauthorized",
	"rate_limited",
	"invalid_input",
	"team_group_binding_unavailable",
]);

export interface CoordinatorReadTeamGroupBindingsOptions {
	remoteUrl: string;
	adminSecret: string;
	teamIds: readonly string[];
	timeoutS?: number;
}

function invalid(): never {
	throw new Error("team_group_binding_response_invalid");
}

function parseItem(value: unknown): CoordinatorTeamGroupBindingReport {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const item = value as Record<string, unknown>;
	if (!isStrictRecipientPolicyId(item.team_id)) invalid();
	if (item.state === "bound") {
		if (Object.keys(item).length !== 3 || !isStrictRecipientPolicyId(item.group_id)) invalid();
		return { team_id: item.team_id, state: "bound", group_id: item.group_id };
	}
	if ((item.state !== "unbound" && item.state !== "conflict") || Object.keys(item).length !== 2)
		invalid();
	return { team_id: item.team_id, state: item.state };
}

async function readChunk(
	opts: CoordinatorReadTeamGroupBindingsOptions,
	teamIds: readonly string[],
): Promise<CoordinatorTeamGroupBindingReport[]> {
	const query = teamIds.map((id) => `team_id=${encodeURIComponent(id)}`).join("&");
	const [status, payload] = await requestJson(
		"GET",
		`${buildBaseUrl(opts.remoteUrl)}/v1/admin/team-group-bindings?${query}`,
		{
			headers: { "X-Codemem-Coordinator-Admin": opts.adminSecret },
			timeoutS: opts.timeoutS ?? 5,
			maxResponseBytes: MAX_RESPONSE_BYTES,
		},
	);
	if (status !== 200) {
		const error = payload?.error;
		const code =
			typeof error === "string" && KNOWN_ERRORS.has(error) ? error : "coordinator_unavailable";
		throw new RemoteCoordinatorRequestError(status, code);
	}
	if (payload?.version !== 1 || !Array.isArray(payload.items)) invalid();
	const items = payload.items.map(parseItem);
	const answered = items.map((item) => item.team_id);
	if (answered.length !== teamIds.length || answered.some((id, index) => id !== teamIds[index]))
		invalid();
	return items;
}

/** The binding of each Team, in the order asked. Throws unless every Team is answered. */
export async function coordinatorReadTeamGroupBindingsAction(
	opts: CoordinatorReadTeamGroupBindingsOptions,
): Promise<CoordinatorTeamGroupBindingReport[]> {
	if (!opts.adminSecret) throw new Error("Admin secret required.");
	const teamIds = [...new Set(opts.teamIds)];
	if (!teamIds.every((id) => isStrictRecipientPolicyId(id))) throw new Error("invalid_input");
	const bindings: CoordinatorTeamGroupBindingReport[] = [];
	for (let start = 0; start < teamIds.length; start += TEAM_GROUP_BINDING_READ_LIMIT)
		bindings.push(
			...(await readChunk(opts, teamIds.slice(start, start + TEAM_GROUP_BINDING_READ_LIMIT))),
		);
	return bindings;
}
