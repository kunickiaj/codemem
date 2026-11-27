import { RemoteCoordinatorRequestError } from "./coordinator-actions.js";
import { capture } from "./coordinator-auth-link-input.js";
import {
	type CoordinatorTeamMemberRemoval,
	TEAM_MEMBER_REMOVAL_PAGE_SIZE,
} from "./coordinator-team-member-removals.js";
import { isStrictRecipientPolicyId } from "./recipient-policy-identifiers.js";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";

/*
 * Admin client for the coordinator's per-Team member removals. Admin devices
 * read the full list for a group and keep a local copy, so Team setups and
 * invitations on this machine never restore a removed member.
 */

const TEAM_MEMBER_REMOVALS_PATH = "/v1/admin/team-member-removals";
/** 50 pages of 200 removals. A longer list is refused instead of read without end. */
const MAX_PAGES = 50;
const MAX_RESPONSE_BYTES = 256 * 1024;
/** Remote error codes passed on as they are. Any other text is never carried into diagnostics. */
const KNOWN_ERRORS = new Set([
	"unauthorized",
	"rate_limited",
	"group_not_found",
	"invalid_input",
	"team_member_removal_unavailable",
]);

export interface CoordinatorListTeamMemberRemovalsActionOptions {
	groupId: string;
	remoteUrl: string;
	adminSecret: string;
	timeoutS?: number;
	/** When the whole list must be read, on this machine's clock. Each page gets what is left. */
	deadlineMs?: number;
}

/** The options for one page: the timeout cut to what the deadline leaves. */
function pageOptions(
	opts: CoordinatorListTeamMemberRemovalsActionOptions,
): CoordinatorListTeamMemberRemovalsActionOptions {
	if (opts.deadlineMs === undefined) return opts;
	const leftS = (opts.deadlineMs - Date.now()) / 1000;
	if (leftS <= 0) throw new Error("team_member_removal_unavailable");
	return { ...opts, timeoutS: Math.min(opts.timeoutS ?? 3, leftS) };
}

function invalid(): never {
	throw new Error("team_member_removal_list_invalid");
}

function parseRemoval(value: unknown, groupId: string, afterSeq: number) {
	const row = capture(value, [
		"removal_seq",
		"group_id",
		"team_id",
		"identity_id",
		"removed_by_device_id",
		"removed_at",
	]);
	if (
		!row ||
		row.group_id !== groupId ||
		!isStrictRecipientPolicyId(row.team_id) ||
		!isStrictRecipientPolicyId(row.identity_id) ||
		!(row.removed_by_device_id === null || isStrictRecipientPolicyId(row.removed_by_device_id)) ||
		typeof row.removal_seq !== "number" ||
		!Number.isSafeInteger(row.removal_seq) ||
		row.removal_seq <= afterSeq ||
		typeof row.removed_at !== "string" ||
		!Number.isFinite(Date.parse(row.removed_at))
	)
		invalid();
	return {
		removal_seq: row.removal_seq,
		group_id: groupId,
		team_id: row.team_id,
		identity_id: row.identity_id,
		removed_by_device_id: row.removed_by_device_id,
		removed_at: row.removed_at,
	} satisfies CoordinatorTeamMemberRemoval;
}

/** Items in increasing sequence after `afterSeq`, and a cursor that moves forward. */
function parsePage(payload: Record<string, unknown> | null, groupId: string, afterSeq: number) {
	const page = capture(payload, ["version", "items", "next_after_seq"]);
	if (page?.version !== 1 || !Array.isArray(page.items)) invalid();
	if (page.items.length > TEAM_MEMBER_REMOVAL_PAGE_SIZE) invalid();
	const items: CoordinatorTeamMemberRemoval[] = [];
	let lastSeq = afterSeq;
	for (const value of page.items) {
		const item = parseRemoval(value, groupId, lastSeq);
		lastSeq = item.removal_seq;
		items.push(item);
	}
	const next = page.next_after_seq;
	if (next !== null && (next !== lastSeq || items.length === 0)) invalid();
	return { items, next: next as number | null };
}

/** One page. Any failure throws a safe code. */
async function readPage(
	opts: CoordinatorListTeamMemberRemovalsActionOptions,
	afterSeq: number,
): Promise<Record<string, unknown> | null> {
	const endpoint = new URL(`${buildBaseUrl(opts.remoteUrl)}${TEAM_MEMBER_REMOVALS_PATH}`);
	endpoint.searchParams.set("group_id", opts.groupId);
	if (afterSeq > 0) endpoint.searchParams.set("after_seq", String(afterSeq));
	const [status, payload] = await requestJson("GET", endpoint.toString(), {
		headers: { "X-Codemem-Coordinator-Admin": opts.adminSecret },
		timeoutS: opts.timeoutS ?? 3,
		maxResponseBytes: MAX_RESPONSE_BYTES,
	});
	if (status >= 200 && status < 300) return payload;
	const error = payload?.error;
	const code =
		typeof error === "string" && KNOWN_ERRORS.has(error)
			? error
			: "team_member_removal_unavailable";
	throw new RemoteCoordinatorRequestError(status, code);
}

/**
 * Every removal the coordinator holds for the group, oldest first. Any
 * failure throws, so callers never act on a partial or missing list. A
 * not-found answer is a failure too: the coordinator exposes no version or
 * capability that proves it predates removals, and a proxy can answer the
 * same way.
 */
export async function coordinatorListTeamMemberRemovalsAction(
	opts: CoordinatorListTeamMemberRemovalsActionOptions,
): Promise<CoordinatorTeamMemberRemoval[]> {
	if (!isStrictRecipientPolicyId(opts.groupId)) throw new Error("Group id required.");
	if (!opts.adminSecret) throw new Error("Admin secret required.");
	const removals: CoordinatorTeamMemberRemoval[] = [];
	let afterSeq = 0;
	for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
		const page = parsePage(await readPage(pageOptions(opts), afterSeq), opts.groupId, afterSeq);
		removals.push(...page.items);
		if (page.next === null) return removals;
		afterSeq = page.next;
	}
	throw new Error("team_member_removal_list_too_long");
}
