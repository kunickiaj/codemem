/**
 * Local self-withdrawal from a Project (ADR 0007 Decision 4). This device stops
 * syncing one Project's boundary in both directions and records that it did. It
 * stays a member of the boundary at the coordinator until the signed withdrawal
 * route exists, and keeps every copy it already holds.
 *
 * A withdrawal is keyed by the Project's boundary scope ID, which stays the same
 * across a migration's commit, rollback, and a second commit, so it applies again
 * whenever the Project is on its boundary. It never touches migration records,
 * presence, or the local restamp of this device's own memories.
 */
import type { Database } from "./db.js";
import { tableExists } from "./db.js";
import { managedProjectScopeId } from "./managed-project-scope.js";

const TABLE = "project_scope_withdrawals";

export interface ProjectScopeWithdrawal {
	scopeId: string;
	canonicalProjectIdentity: string;
	groupId: string;
	withdrawnAt: string;
}

interface WithdrawalRow {
	scope_id: string;
	canonical_project_identity: string;
	group_id: string;
	withdrawn_at: string;
}

function fromRow(row: WithdrawalRow): ProjectScopeWithdrawal {
	return {
		scopeId: row.scope_id,
		canonicalProjectIdentity: row.canonical_project_identity,
		groupId: row.group_id,
		withdrawnAt: row.withdrawn_at,
	};
}

/** Records that this device stopped receiving the Project. Repeating it changes nothing. */
export function withdrawProjectScope(
	db: Database,
	input: { canonicalProjectIdentity: string; groupId: string; now: string },
): ProjectScopeWithdrawal {
	const scopeId = managedProjectScopeId(input.groupId, input.canonicalProjectIdentity);
	db.prepare(
		`INSERT INTO ${TABLE}(scope_id, canonical_project_identity, group_id, withdrawn_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(scope_id) DO NOTHING`,
	).run(scopeId, input.canonicalProjectIdentity, input.groupId, input.now);
	const row = db.prepare(`SELECT * FROM ${TABLE} WHERE scope_id = ?`).get(scopeId) as WithdrawalRow;
	return fromRow(row);
}

/**
 * Ends a withdrawal. Returns whether one existed. Callers then reset this device's
 * sync position for the boundary so it catches up through the normal membership
 * checks, which is what keeps an undo from delivering anything this device is no
 * longer entitled to.
 */
export function resumeProjectScope(db: Database, input: { scopeId: string; now: string }): boolean {
	if (!tableExists(db, TABLE)) return false;
	return db.prepare(`DELETE FROM ${TABLE} WHERE scope_id = ?`).run(input.scopeId).changes > 0;
}

/** A missing table means nothing is withdrawn, so older databases keep syncing as before. */
export function isProjectScopeWithdrawn(db: Database, scopeId: string): boolean {
	if (!scopeId || !tableExists(db, TABLE)) return false;
	return db.prepare(`SELECT 1 FROM ${TABLE} WHERE scope_id = ?`).get(scopeId) !== undefined;
}

export function listProjectScopeWithdrawals(db: Database): ProjectScopeWithdrawal[] {
	if (!tableExists(db, TABLE)) return [];
	return (db.prepare(`SELECT * FROM ${TABLE} ORDER BY scope_id`).all() as WithdrawalRow[]).map(
		fromRow,
	);
}
