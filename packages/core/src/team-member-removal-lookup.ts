import type { CoordinatorTeamGroupBinding } from "./coordinator-team-group-bindings.js";
import type { Database } from "./db.js";
import { deterministicPolicyTeamId } from "./recipient-policy-identifiers.js";
import { buildBaseUrl } from "./sync-http-client.js";

/*
 * Reading this machine's copy of per-Team member removals. A copy is keyed by
 * the coordinator group that recorded it and applies only to the Team's own
 * coordinator group, so a group cannot remove members of a Team it does not
 * hold. Kept free of policy writers so sync admission can read it.
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

export type TeamCoordinatorLinkState =
	| { state: "none" }
	| { state: "linked"; coordinatorId: string; groupId: string }
	| { state: "conflict" };

interface LinkCandidate {
	coordinatorId: string;
	groupId: string;
}

/**
 * Recorded group sources. `team_create`: an admin device created the Team for
 * its one configured group. `coordinator_binding`: the Team's coordinator
 * reported the group the Team is bound to. `coordinator_conflict`: the
 * coordinator holds no binding and more than one group has Team invitations
 * for the Team, and the row names no group.
 */
export type TeamCoordinatorLinkSource =
	| "team_create"
	| "coordinator_binding"
	| "coordinator_conflict";

/**
 * Every group that claims the Team: its completed setups, the group recorded
 * when it was created here, and the group its coordinator bound it to.
 */
function linkCandidates(
	db: Database,
	teamId: string,
): { candidates: LinkCandidate[]; reportedConflict: boolean } {
	const recorded = db
		.prepare(
			"SELECT coordinator_id, group_id, source FROM policy_team_coordinator_links WHERE team_id = ?",
		)
		.all(teamId) as Array<{ coordinator_id: string; group_id: string; source: string }>;
	const groups = recorded.filter((row) => row.source !== "coordinator_conflict");
	return {
		candidates: [...completedSetupGroups(db, teamId), ...groups].map((row) => ({
			coordinatorId: row.coordinator_id,
			groupId: row.group_id,
		})),
		reportedConflict: groups.length < recorded.length,
	};
}

function stateOf(
	candidates: readonly LinkCandidate[],
	reportedConflict: boolean,
): TeamCoordinatorLinkState {
	const keys = new Set(
		candidates.map((row) => teamMemberRemovalLinkKey(row.coordinatorId, row.groupId)),
	);
	const first = candidates[0];
	// Several groups invited people to it, the coordinator bound none, and nothing here names one.
	if (!first) return reportedConflict ? { state: "conflict" } : { state: "none" };
	if (keys.size !== 1 || keys.has(null)) return { state: "conflict" };
	return { state: "linked", coordinatorId: first.coordinatorId, groupId: first.groupId };
}

/**
 * The Team's coordinator group, where its removals are recorded. It comes only
 * from the Team's completed setup, the group recorded when an admin device
 * created it, and the group the Team's coordinator bound it to. Accepted
 * invitations are not evidence. It is a conflict, and no group is picked, when
 * these disagree, or when nothing names a group and the coordinator reported
 * Team invitations from more than one group. A Team its coordinator has not
 * bound yet, with nothing else naming a group, has no group: nothing applies
 * from any group, but it is not a conflict.
 */
export function teamCoordinatorLinkState(db: Database, teamId: string): TeamCoordinatorLinkState {
	const { candidates, reportedConflict } = linkCandidates(db, teamId);
	return stateOf(candidates, reportedConflict);
}

/**
 * The Team's coordinator group when a setup from `setup` counts as one of its
 * sources. A quarantined Team's setup no longer counts on its own, because
 * quarantine clears the finish digest that ties the setup to its completion.
 * Team recovery asks this to learn whether restoring that setup would leave the
 * Team with one group or with a conflict.
 */
export function teamCoordinatorLinkStateWithSetup(
	db: Database,
	teamId: string,
	setup: { coordinatorId: string; groupId: string },
): TeamCoordinatorLinkState {
	const { candidates, reportedConflict } = linkCandidates(db, teamId);
	return stateOf([...candidates, setup], reportedConflict);
}

/**
 * The Team's coordinator group as a removal key: a set with one entry when the
 * Team has one group, and empty when it has none or a conflict. Only a removal
 * recorded by that group applies to the Team.
 */
export function teamCoordinatorLinks(db: Database, teamId: string): Set<string> {
	const link = teamCoordinatorLinkState(db, teamId);
	if (link.state !== "linked") return new Set();
	const key = teamMemberRemovalLinkKey(link.coordinatorId, link.groupId);
	return new Set(key ? [key] : []);
}

/** Records the group an admin device created the Team for. */
export function recordTeamCoordinatorLink(
	db: Database,
	input: { teamId: string; coordinatorId: string; groupId: string; now: string },
): void {
	insertLink(db, { ...input, source: "team_create" });
}

function insertLink(
	db: Database,
	input: {
		teamId: string;
		coordinatorId: string;
		groupId: string;
		source: TeamCoordinatorLinkSource;
		now: string;
	},
): void {
	if (teamMemberRemovalCoordinatorKey(input.coordinatorId) === null) return;
	db.prepare(
		`INSERT INTO policy_team_coordinator_links(team_id, coordinator_id, group_id, source, recorded_at)
		 VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_id, coordinator_id, group_id) DO NOTHING`,
	).run(input.teamId, input.coordinatorId, input.groupId, input.source, input.now);
}

/**
 * The group a new Team invitation for the Team must go through. The first Team
 * invitation binds the Team on the coordinator for good, so a Team whose group
 * is known here is invited only through that group, and only while this device
 * is configured for it. A Team with no known group returns null, and the
 * caller's configured group is used. Throws `team_link_conflict` or
 * `team_group_mismatch` instead of minting through another group.
 */
export function teamInvitationGroup(
	db: Database,
	input: {
		teamId: string;
		coordinatorId: string;
		configuredGroupIds: readonly string[];
		requestedGroupId: string | null;
	},
): string | null {
	const link = teamCoordinatorLinkState(db, input.teamId);
	if (link.state === "none") return null;
	if (link.state === "conflict") throw new Error("team_link_conflict");
	const configured = teamMemberRemovalCoordinatorKey(input.coordinatorId);
	if (
		configured === null ||
		configured !== teamMemberRemovalCoordinatorKey(link.coordinatorId) ||
		!input.configuredGroupIds.includes(link.groupId) ||
		(input.requestedGroupId !== null && input.requestedGroupId !== link.groupId)
	)
		throw new Error("team_group_mismatch");
	return link.groupId;
}

/** One Team's binding as its coordinator reported it. */
export type CoordinatorTeamGroupBindingReport = CoordinatorTeamGroupBinding;

/**
 * Records the bindings a coordinator reported for its Teams. A bound Team gets
 * that group as a candidate. A Team the coordinator reports as a conflict, with
 * Team invitations from more than one group and no binding, is recorded as
 * such; it counts only while nothing names a group for it, so a later binding
 * resolves it. A Team that is merely not bound yet records nothing.
 */
export function recordTeamGroupBindings(
	db: Database,
	input: {
		coordinatorId: string;
		bindings: readonly CoordinatorTeamGroupBindingReport[];
		now: string;
	},
): void {
	db.transaction(() => {
		for (const binding of input.bindings) {
			const base = { teamId: binding.team_id, coordinatorId: input.coordinatorId, now: input.now };
			if (binding.state === "bound")
				insertLink(db, { ...base, groupId: binding.group_id, source: "coordinator_binding" });
			else if (binding.state === "conflict")
				insertLink(db, { ...base, groupId: "", source: "coordinator_conflict" });
		}
	}).immediate();
}

/**
 * Teams whose binding to read from this coordinator: the Teams its accepted
 * invitations name, and every Team that a completed setup or a creation here
 * ties to this coordinator, so a disagreement with the binding is noticed.
 */
export function teamIdsForBindingRead(
	db: Database,
	input: { coordinatorId: string; invitedTeamIds: readonly string[] },
): string[] {
	const coordinator = teamMemberRemovalCoordinatorKey(input.coordinatorId);
	const local = db
		.prepare(
			`SELECT team_id, coordinator_id FROM policy_team_coordinator_links
			 UNION SELECT draft.completed_team_id, draft.coordinator_id
			 FROM legacy_team_setup_drafts AS draft
			 WHERE draft.state = 'completed' AND draft.completed_team_id IS NOT NULL`,
		)
		.all() as Array<{ team_id: string; coordinator_id: string }>;
	const tied = local
		.filter(
			(row) =>
				coordinator !== null && teamMemberRemovalCoordinatorKey(row.coordinator_id) === coordinator,
		)
		.map((row) => row.team_id);
	return [...new Set([...input.invitedTeamIds, ...tied])].sort();
}

/**
 * Teams whose coordinator group is a conflict: their groups disagree, or their
 * coordinator holds none and nothing here names one. No removal applies to
 * them, and the Viewer warns about them.
 */
export function teamCoordinatorLinkConflicts(db: Database): string[] {
	// Only a Team with two claims, or a coordinator report of a conflict, can be a conflict.
	const teamIds = db
		.prepare(
			`SELECT link.team_id FROM policy_team_coordinator_links AS link
			 GROUP BY link.team_id
			 HAVING COUNT(*) > 1 OR SUM(link.source = 'coordinator_conflict') > 0
			   OR EXISTS (SELECT 1 FROM legacy_team_setup_drafts AS draft
			     WHERE draft.state = 'completed' AND draft.completed_team_id = link.team_id)
			 ORDER BY link.team_id`,
		)
		.pluck()
		.all() as string[];
	return teamIds.filter((teamId) => teamCoordinatorLinkState(db, teamId).state === "conflict");
}

function completedSetupGroups(db: Database, teamId: string) {
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
	return rows.filter((row) => deterministicPolicyTeamId(row.candidate_id) === teamId);
}

/**
 * Identities removed from the Team: by its own coordinator group, or in a
 * removal this machine enforced earlier. A record from any other group is
 * kept but never applies, so a group cannot remove members of a Team it does
 * not hold. While the Team's group is a conflict, no new removal applies, and
 * every enforced one still does. `settingUpFrom` names the group of a setup
 * that is completing the Team now.
 */
export function removedTeamMemberIdentityIds(
	db: Database,
	teamId: string,
	options: { settingUpFrom?: { coordinatorId: string; groupId: string } } = {},
): Set<string> {
	// A setup in progress counts its own group, so a removal that arrived first
	// applies to it, and a setup from another group than the recorded one is a conflict.
	const setup = options.settingUpFrom;
	const { candidates, reportedConflict } = linkCandidates(db, teamId);
	const link = stateOf([...candidates, ...(setup ? [setup] : [])], reportedConflict);
	// A removal enforced here stays enforced, whatever later happens to the Team's group.
	const removed = enforcedRemovals(db, teamId);
	if (link.state !== "linked") return removed;
	const key = teamMemberRemovalLinkKey(link.coordinatorId, link.groupId);
	const rows = db
		.prepare(
			"SELECT identity_id, coordinator_id, group_id FROM policy_team_member_removals WHERE team_id = ?",
		)
		.all(teamId) as Array<{ identity_id: string; coordinator_id: string; group_id: string }>;
	for (const row of rows)
		if (key !== null && teamMemberRemovalLinkKey(row.coordinator_id, row.group_id) === key)
			removed.add(row.identity_id);
	return removed;
}

/** Identities whose removal from the Team this machine enforced. */
function enforcedRemovals(db: Database, teamId: string): Set<string> {
	return new Set(
		db
			.prepare("SELECT identity_id FROM policy_team_member_removal_enforcements WHERE team_id = ?")
			.pluck()
			.all(teamId) as string[],
	);
}

/** Whether the Team's own coordinator group removed the identity from it. */
export function isTeamMemberRemoved(db: Database, teamId: string, identityId: string): boolean {
	return removedTeamMemberIdentityIds(db, teamId).has(identityId);
}

/**
 * The Teams whose own coordinator group removed the person this device is
 * bound to. A device bound to another person now is not affected.
 */
export function teamMemberRemovalsForDevice(
	db: Database,
	deviceId: string,
): Array<{ teamId: string; identityId: string }> {
	const rows = db
		.prepare(
			`SELECT DISTINCT removal.team_id, removal.identity_id
			 FROM policy_team_member_removals AS removal
			 JOIN identity_devices AS binding ON binding.identity_id = removal.identity_id
			 WHERE binding.device_id = ?
			   AND NOT EXISTS (
			     SELECT 1 FROM identity_devices AS other
			     WHERE other.device_id = binding.device_id AND other.status = 'active'
			       AND other.identity_id <> removal.identity_id
			   )
			 ORDER BY removal.team_id, removal.identity_id`,
		)
		.all(deviceId) as Array<{ team_id: string; identity_id: string }>;
	return rows
		.filter((row) => isTeamMemberRemoved(db, row.team_id, row.identity_id))
		.map((row) => ({ teamId: row.team_id, identityId: row.identity_id }));
}
