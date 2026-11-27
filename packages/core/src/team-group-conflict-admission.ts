import type { Database } from "./db.js";
import { teamProjectsHeldInScope } from "./team-member-removal-admission.js";
import { teamCoordinatorLinkConflicts } from "./team-member-removal-lookup.js";

/*
 * Sync admission for a Team whose coordinator group is a conflict: its groups
 * disagree, or its coordinator holds no group for it and nothing here names
 * one. This machine cannot tell which group's removals apply to such a Team, so
 * it serves no one access through the Team: a device bound to a Team member is
 * refused every scope that holds one of the Team's Projects. This device, and
 * every device of this device's own person, keep their access.
 *
 * The decision reads current state on every request. It lifts once the Team's
 * group is resolved, for example when an admin binds the Team on the
 * coordinator and the next enrollment check records that binding.
 */

const LOCAL_DEVICE_SQL = "SELECT device_id FROM sync_device LIMIT 1";

// The device is bound to the same person as this device.
const SAME_PERSON_SQL = `SELECT 1 FROM identity_devices AS device
	JOIN identity_devices AS local ON local.identity_id = device.identity_id
	WHERE device.device_id = ? AND device.status = 'active'
	  AND local.device_id = ? AND local.status = 'active' LIMIT 1`;

// The device is bound to a current member of the Team.
const TEAM_MEMBER_DEVICE_SQL = `SELECT 1 FROM identity_devices AS device
	JOIN policy_team_memberships AS member ON member.identity_id = device.identity_id
	WHERE device.device_id = ? AND member.team_id = ?
	  AND member.status IN ('active', 'reviewed_active') LIMIT 1`;

function conflictedTeams(db: Database): string[] {
	try {
		return teamCoordinatorLinkConflicts(db);
	} catch (error) {
		// A store without recipient policy tables has no Teams to enforce.
		if (error instanceof Error && /no such table/u.test(error.message)) return [];
		throw error;
	}
}

/** Whether a Team with a conflicting coordinator group refuses this scope to this device now. */
export function teamGroupConflictRefusesScope(
	db: Database,
	input: { scopeId: string; deviceId: string },
): boolean {
	const teams = conflictedTeams(db);
	if (teams.length === 0) return false;
	const local = db.prepare(LOCAL_DEVICE_SQL).pluck().get();
	if (typeof local === "string") {
		if (input.deviceId === local) return false;
		if (db.prepare(SAME_PERSON_SQL).get(input.deviceId, local)) return false;
	}
	const members = teams.filter((teamId) =>
		Boolean(db.prepare(TEAM_MEMBER_DEVICE_SQL).get(input.deviceId, teamId)),
	);
	if (members.length === 0) return false;
	const heldProjects = teamProjectsHeldInScope(db, input.scopeId);
	return members.some((teamId) => heldProjects(teamId).length > 0);
}
