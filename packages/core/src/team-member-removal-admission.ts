import type { Database } from "./db.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import {
	canonicalRepositoryProjectIdentity,
	repositoryIdentitiesByWorkspace,
} from "./repository-mapping-aliases.js";
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

/** Every Project the scope holds, canonical, from its mappings and its stored memories. */
function projectsHeldByScope(db: Database, scopeId: string): Set<string> {
	const repositoryIdentities = repositoryIdentitiesByWorkspace(db);
	const canonical = (value: string | null): string[] =>
		value ? [canonicalRepositoryProjectIdentity(repositoryIdentities, value)] : [];
	const mappings = db
		.prepare(
			"SELECT workspace_identity, project_pattern FROM project_scope_mappings WHERE scope_id = ?",
		)
		.all(scopeId) as Array<{ workspace_identity: string | null; project_pattern: string }>;
	const stored = db
		.prepare(
			`SELECT DISTINCT memory.project, session.cwd, session.project AS session_project
			 FROM memory_items AS memory
			 LEFT JOIN sessions AS session ON session.id = memory.session_id
			 WHERE memory.scope_id = ?`,
		)
		.all(scopeId) as Array<{
		project: string | null;
		cwd: string | null;
		session_project: string | null;
	}>;
	return new Set([
		...mappings.flatMap((row) => [
			...canonical(row.workspace_identity),
			...canonical(row.project_pattern),
		]),
		...stored.flatMap((row) => [
			...canonical(row.project),
			...canonical(row.cwd),
			...canonical(row.session_project),
		]),
	]);
}

function policyAuthorizes(db: Database, projectId: string, deviceId: string): boolean {
	const derivation = deriveRecipientPolicyEffectiveDevicesFromDatabase(db, projectId);
	if (derivation.status === "blocked") return false;
	return derivation.devices.some((device) => device.deviceId === deviceId);
}

/** Whether sync admission refuses the device the scope because of a Team member removal. */
export function teamMemberRemovalRefusesScope(
	db: Database,
	input: { scopeId: string; deviceId: string },
): boolean {
	const removals = teamMemberRemovalsForDevice(db, input.deviceId);
	if (removals.length === 0) return false;
	const repositoryIdentities = repositoryIdentitiesByWorkspace(db);
	const held = projectsHeldByScope(db, input.scopeId);
	return removals.some(({ teamId }) =>
		teamProjects(db, teamId).some((projectId) => {
			const canonical = canonicalRepositoryProjectIdentity(repositoryIdentities, projectId);
			return held.has(canonical) && !policyAuthorizes(db, projectId, input.deviceId);
		}),
	);
}
