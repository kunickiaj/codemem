import type { Database } from "./db.js";

/*
 * A Team recovery that has not been verified yet. The commit places the hold
 * in the transaction that makes the Team active, then reads the coordinator
 * evidence again. Only that second read lifts the hold: every part has to
 * read, and nothing the recovery decided on may have changed. Until then the
 * Team serves no device. A hold that is not lifted stays, and nothing else
 * makes a held Team active. Applying the coordinator's copy of the setup, the
 * one other way a disabled Team becomes active, refuses a held Team and
 * disables it. Only another recovery reopens it, which takes the hold over and
 * lifts it with its own second read.
 *
 * Each hold names the recovery that placed it, so a second read that comes
 * back late acts only on the recovery it verified.
 */

export type TeamRecoveryHoldReason =
	| "awaiting_verification"
	| "evidence_changed"
	| "evidence_unavailable";

interface HoldKey {
	teamId: string;
	recoveryId: string;
}

/** Holds the Team for this recovery. It takes over a hold an earlier recovery left. */
export function placeTeamRecoveryHold(db: Database, input: HoldKey & { now: string }): void {
	db.prepare(
		`INSERT INTO policy_team_recovery_holds(team_id, recovery_id, reason, held_at)
		 VALUES (?, ?, 'awaiting_verification', ?)
		 ON CONFLICT(team_id) DO UPDATE SET recovery_id = excluded.recovery_id,
		   reason = excluded.reason, held_at = excluded.held_at`,
	).run(input.teamId, input.recoveryId, input.now);
}

/** Whether the Team's hold is the one this recovery placed. */
export function isTeamRecoveryHeldBy(db: Database, input: HoldKey): boolean {
	const held = db.prepare(
		"SELECT 1 FROM policy_team_recovery_holds WHERE team_id = ? AND recovery_id = ?",
	);
	return held.get(input.teamId, input.recoveryId) !== undefined;
}

/** Lifts the hold this recovery placed. Another recovery's hold is left alone. */
export function liftTeamRecoveryHold(db: Database, input: HoldKey): void {
	db.prepare("DELETE FROM policy_team_recovery_holds WHERE team_id = ? AND recovery_id = ?").run(
		input.teamId,
		input.recoveryId,
	);
}

/** Records why this recovery's hold stays. Another recovery's hold is left alone. */
export function recordTeamRecoveryHoldReason(
	db: Database,
	input: HoldKey & { reason: Exclude<TeamRecoveryHoldReason, "awaiting_verification"> },
): void {
	db.prepare(
		"UPDATE policy_team_recovery_holds SET reason = ? WHERE team_id = ? AND recovery_id = ?",
	).run(input.reason, input.teamId, input.recoveryId);
}

/** Whether a recovery of the Team is unverified. A store from before the table holds none. */
export function isTeamRecoveryHeld(db: Database, teamId: string): boolean {
	try {
		const held = db.prepare("SELECT 1 FROM policy_team_recovery_holds WHERE team_id = ?");
		return held.get(teamId) !== undefined;
	} catch (error) {
		if (error instanceof Error && /no such table/u.test(error.message)) return false;
		throw error;
	}
}
