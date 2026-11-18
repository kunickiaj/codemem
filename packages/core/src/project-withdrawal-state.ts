/**
 * What the Viewer needs to let this device stop and resume a Project on its own
 * boundary (ADR 0007 Decision 4). The Viewer names Projects by their inventory
 * workspace identity:
 *
 * - A Project received from other devices on its own boundary is
 *   `peer-received:scope:<boundary scope ID>`.
 * - A Project of this device's own is its canonical identity, and its boundary
 *   scope ID is a hash of the coordinator group and that identity.
 */
import type { Database } from "./db.js";
import { managedProjectScopeId } from "./managed-project-scope.js";
import { resumeProjectScopeSync } from "./project-scope-resume.js";
import {
	listProjectScopeWithdrawals,
	type ProjectScopeWithdrawal,
	recordProjectScopeWithdrawal,
} from "./project-scope-withdrawal.js";

const RECEIVED_BOUNDARY_PREFIX = "peer-received:scope:";
const BOUNDARY_PREFIX = "managed-project:";

export interface ProjectWithdrawalState {
	scopeId: string;
	groupId: string;
	/** When this device stopped the Project, or null while it still syncs it. */
	withdrawnAt: string | null;
}

/** Active Project boundaries this device is an active member of, by scope ID, with their group. */
function ownProjectBoundaries(db: Database, deviceId: string): Map<string, string> {
	const rows = db
		.prepare(
			`SELECT s.scope_id, s.group_id
			   FROM replication_scopes s
			   JOIN scope_memberships m ON m.scope_id = s.scope_id
			  WHERE s.kind = 'managed_project' AND s.authority_type = 'coordinator'
			    AND s.status = 'active' AND s.group_id IS NOT NULL AND s.group_id != ''
			    AND m.device_id = ? AND m.status = 'active'`,
		)
		.all(deviceId) as Array<{ scope_id: string; group_id: string }>;
	return new Map(rows.map((row) => [row.scope_id, row.group_id]));
}

function boundaryScopeIdFor(workspaceIdentity: string, groups: string[]): string[] {
	if (workspaceIdentity.startsWith(RECEIVED_BOUNDARY_PREFIX)) {
		const scopeId = workspaceIdentity.slice(RECEIVED_BOUNDARY_PREFIX.length);
		return scopeId.startsWith(BOUNDARY_PREFIX) ? [scopeId] : [];
	}
	return groups.map((groupId) => managedProjectScopeId(groupId, workspaceIdentity));
}

function stateOf(withdrawal: ProjectScopeWithdrawal): ProjectWithdrawalState {
	return {
		scopeId: withdrawal.scopeId,
		groupId: withdrawal.groupId,
		withdrawnAt: withdrawal.withdrawnAt,
	};
}

/**
 * Where this device stands on each named Project that it syncs on the Project's
 * own boundary. A stopped Project stays listed after its boundary is gone, so the
 * device can still resume it.
 */
export function projectWithdrawalStates(
	db: Database,
	deviceId: string,
	workspaceIdentities: string[],
): Map<string, ProjectWithdrawalState> {
	const withdrawals = new Map(listProjectScopeWithdrawals(db).map((row) => [row.scopeId, row]));
	const boundaries = ownProjectBoundaries(db, deviceId);
	// A stopped Project's group counts even after this device's last boundary in it
	// ends, so the stop can still be found and resumed by the Project's identity.
	const groups = [
		...new Set([...boundaries.values(), ...[...withdrawals.values()].map((row) => row.groupId)]),
	];
	const states = new Map<string, ProjectWithdrawalState>();
	for (const identity of new Set(workspaceIdentities)) {
		for (const scopeId of boundaryScopeIdFor(identity, groups)) {
			const withdrawal = withdrawals.get(scopeId);
			const groupId = boundaries.get(scopeId);
			if (withdrawal) states.set(identity, stateOf(withdrawal));
			else if (groupId) states.set(identity, { scopeId, groupId, withdrawnAt: null });
			if (states.has(identity)) break;
		}
	}
	return states;
}

/**
 * The canonical identity a withdrawal records for the migration's benefit. A
 * receiving device may know a boundary only by scope ID, and the record is keyed
 * by that ID, so the scope ID stands in when no known identity hashes to it.
 */
function canonicalIdentityForBoundary(
	db: Database,
	state: ProjectWithdrawalState,
	workspaceIdentity: string,
): string {
	if (!workspaceIdentity.startsWith(RECEIVED_BOUNDARY_PREFIX)) return workspaceIdentity;
	const candidates = db
		.prepare(
			`SELECT canonical_project_identity FROM recipient_managed_project_projections WHERE managed_scope_id = ?
			 UNION SELECT canonical_project_identity FROM project_recipients
			 UNION SELECT canonical_project_identity FROM recipient_policy_authority_states`,
		)
		.pluck()
		.all(state.scopeId) as string[];
	return (
		candidates.find(
			(identity) => managedProjectScopeId(state.groupId, identity) === state.scopeId,
		) ?? state.scopeId
	);
}

/** Stops the Project on this device. Returns null when it isn't on its own boundary here. */
export function stopProjectOnThisDevice(
	db: Database,
	input: { deviceId: string; workspaceIdentity: string; now: string },
): ProjectWithdrawalState | null {
	const state = projectWithdrawalStates(db, input.deviceId, [input.workspaceIdentity]).get(
		input.workspaceIdentity,
	);
	if (!state) return null;
	if (state.withdrawnAt) return state;
	return stateOf(
		recordProjectScopeWithdrawal(db, {
			scopeId: state.scopeId,
			groupId: state.groupId,
			canonicalProjectIdentity: canonicalIdentityForBoundary(db, state, input.workspaceIdentity),
			now: input.now,
		}),
	);
}

/** Resumes a Project this device stopped. Returns false when it wasn't stopped. */
export function resumeProjectOnThisDevice(
	db: Database,
	input: { deviceId: string; workspaceIdentity: string; now: string },
): boolean {
	const state = projectWithdrawalStates(db, input.deviceId, [input.workspaceIdentity]).get(
		input.workspaceIdentity,
	);
	if (!state?.withdrawnAt) return false;
	return resumeProjectScopeSync(db, {
		scopeId: state.scopeId,
		deviceId: input.deviceId,
		now: input.now,
	}).resumed;
}
