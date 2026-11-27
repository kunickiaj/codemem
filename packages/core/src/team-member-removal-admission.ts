import type { Database } from "./db.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import { projectsHeldInScope } from "./scope-project-mappings.js";
import { teamMemberRemovalsForDevice } from "./team-member-removal-lookup.js";

/*
 * Sync admission for a device whose person was removed from a Team. The
 * decision reads current state on every request, so it holds from the moment
 * the removal is recorded, before reconciliation runs, for mappings saved by
 * any path, and for scope memberships a later refresh installs.
 *
 * A scope holds a Project when a mapping of any provenance points the Project
 * to it, or when the scope already stores memories of the Project. The device
 * is refused a scope that holds one of the Team's Projects, unless the policy
 * still gives the device that Project another way, such as a direct share or
 * another Team. A scope is shared as a whole, so one such Project is enough.
 */

/** Active Projects shared with the Team. */
function teamProjects(db: Database, teamId: string): string[] {
	return db
		.prepare(
			`SELECT DISTINCT canonical_project_identity FROM project_recipients
			 WHERE recipient_kind = 'team' AND recipient_id = ? AND status = 'active'`,
		)
		.pluck()
		.all(teamId) as string[];
}

function policyAuthorizes(db: Database, projectId: string, deviceId: string): boolean {
	const derivation = deriveRecipientPolicyEffectiveDevicesFromDatabase(db, projectId);
	if (derivation.status === "blocked") return false;
	return derivation.devices.some((device) => device.deviceId === deviceId);
}

/**
 * Returns the Team's Projects that the scope holds, through a mapping of any
 * provenance or through memories it already stores. Built once per scope.
 */
export function teamProjectsHeldInScope(
	db: Database,
	scopeId: string,
): (teamId: string) => string[] {
	const held = projectsHeldInScope(db, scopeId);
	return (teamId) => teamProjects(db, teamId).filter(held);
}

/** Whether sync admission refuses the device the scope because of a Team member removal. */
export function teamMemberRemovalRefusesScope(
	db: Database,
	input: { scopeId: string; deviceId: string },
): boolean {
	const removals = teamMemberRemovalsForDevice(db, input.deviceId);
	if (removals.length === 0) return false;
	const heldProjects = teamProjectsHeldInScope(db, input.scopeId);
	return removals.some(({ teamId }) =>
		heldProjects(teamId).some((projectId) => !policyAuthorizes(db, projectId, input.deviceId)),
	);
}
