import type { Database } from "./db.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import {
	canonicalRepositoryProjectIdentity,
	repositoryIdentitiesByWorkspace,
	repositoryIdentityForWorkspace,
} from "./repository-mapping-aliases.js";
import { mappingsHoldProject, readScopeMappings } from "./scope-project-mappings.js";
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

interface StoredProjectEvidence {
	project: string | null;
	cwd: string | null;
	session_project: string | null;
	git_remote: string | null;
	metadata_json: string | null;
}

/** The Projects, canonical, whose memories the scope already stores. */
function projectsStoredInScope(
	db: Database,
	scopeId: string,
	repositoryIdentities: ReadonlyMap<string, string>,
): Set<string> {
	const canonical = (value: string | null): string[] =>
		value ? [canonicalRepositoryProjectIdentity(repositoryIdentities, value)] : [];
	// Each session's own repository evidence counts, because the global alias map
	// leaves out a checkout path that held more than one repository.
	const stored = db
		.prepare(
			`SELECT DISTINCT memory.project, session.cwd, session.project AS session_project,
			        session.git_remote, session.metadata_json
			 FROM memory_items AS memory
			 LEFT JOIN sessions AS session ON session.id = memory.session_id
			 WHERE memory.scope_id = ?`,
		)
		.all(scopeId) as StoredProjectEvidence[];
	return new Set(
		stored.flatMap((row) => [
			...canonical(row.project),
			...canonical(row.cwd),
			...canonical(row.session_project),
			...canonical(
				repositoryIdentityForWorkspace(repositoryIdentities, {
					cwd: row.cwd,
					gitRemote: row.git_remote,
					metadataJson: row.metadata_json,
				}),
			),
		]),
	);
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
	const repositoryIdentities = repositoryIdentitiesByWorkspace(db);
	const canonical = (value: string) =>
		canonicalRepositoryProjectIdentity(repositoryIdentities, value);
	const mappings = readScopeMappings(db, scopeId);
	const stored = projectsStoredInScope(db, scopeId, repositoryIdentities);
	const held = (projectId: string) =>
		stored.has(canonical(projectId)) ||
		mappingsHoldProject(mappings, new Set([projectId, canonical(projectId)]), canonical);
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
