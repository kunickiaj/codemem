import type { Database } from "./db.js";
import { deterministicPolicyTeamId } from "./recipient-policy-identifiers.js";
import { buildBaseUrl } from "./sync-http-client.js";

/*
 * Reading this machine's copy of per-Team member removals. A copy is keyed by
 * the coordinator group that recorded it and applies only to a Team that group
 * set up, so a group cannot remove members of a Team it does not hold.
 */

/**
 * A coordinator ID in the form two spellings of the same coordinator share,
 * or null when it is not a usable coordinator URL.
 */
export function teamMemberRemovalCoordinatorKey(value: string): string | null {
	try {
		const normalized = buildBaseUrl(value);
		if (!normalized) return null;
		const parsed = new URL(normalized);
		if (
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			!parsed.host ||
			parsed.username ||
			parsed.password
		)
			return null;
		const path = parsed.pathname === "/" ? "" : parsed.pathname;
		return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
	} catch {
		return null;
	}
}

export const teamMemberRemovalLinkKey = (coordinatorId: string, groupId: string): string | null => {
	const coordinator = teamMemberRemovalCoordinatorKey(coordinatorId);
	return coordinator === null ? null : `${coordinator}\u0000${groupId}`;
};

/**
 * The coordinator groups the Team was set up from: each completed setup of the
 * Team names one. Only a removal recorded by one of these groups applies to
 * the Team. A Team with no completed setup has no proven group.
 */
export function teamCoordinatorLinks(db: Database, teamId: string): Set<string> {
	const rows = db
		.prepare(
			`SELECT DISTINCT draft.candidate_id, draft.coordinator_id, draft.group_id
			 FROM legacy_team_setup_drafts AS draft
			 JOIN legacy_team_setup_completions AS completion
			   ON completion.attempt_id = draft.attempt_id
			  AND completion.finish_digest = draft.finish_digest
			  AND completion.candidate_ref = draft.candidate_id
			  AND completion.completed_team_id = draft.completed_team_id
			 WHERE draft.state = 'completed' AND draft.completed_team_id = ?`,
		)
		.all(teamId) as Array<{ candidate_id: string; coordinator_id: string; group_id: string }>;
	return new Set(
		rows
			.filter((row) => deterministicPolicyTeamId(row.candidate_id) === teamId)
			.map((row) => teamMemberRemovalLinkKey(row.coordinator_id, row.group_id))
			.filter((key): key is string => key !== null),
	);
}

/**
 * Identities removed from the Team by one of its own coordinator groups. A
 * record from any other group is kept but never applies, so a group cannot
 * remove members of a Team it does not hold. `settingUpFrom` names the group
 * of a setup that is completing the Team now.
 */
export function removedTeamMemberIdentityIds(
	db: Database,
	teamId: string,
	options: { settingUpFrom?: { coordinatorId: string; groupId: string } } = {},
): Set<string> {
	const links = teamCoordinatorLinks(db, teamId);
	// A setup in progress counts its own group, so a removal that arrived first applies to it.
	const setup = options.settingUpFrom;
	const setupLink = setup && teamMemberRemovalLinkKey(setup.coordinatorId, setup.groupId);
	if (setupLink) links.add(setupLink);
	if (links.size === 0) return new Set();
	const rows = db
		.prepare(
			"SELECT identity_id, coordinator_id, group_id FROM policy_team_member_removals WHERE team_id = ?",
		)
		.all(teamId) as Array<{ identity_id: string; coordinator_id: string; group_id: string }>;
	return new Set(
		rows
			.filter((row) => links.has(teamMemberRemovalLinkKey(row.coordinator_id, row.group_id) ?? ""))
			.map((row) => row.identity_id),
	);
}

/** Whether one of the Team's own coordinator groups removed the identity from it. */
export function isTeamMemberRemoved(db: Database, teamId: string, identityId: string): boolean {
	return removedTeamMemberIdentityIds(db, teamId).has(identityId);
}
