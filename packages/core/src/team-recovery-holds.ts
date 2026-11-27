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

/**
 * The oldest evidence a recovery may write on, and so the longest its hold can
 * wait for the second read: from the moment this machine sent the first of
 * the reads to the moment its transaction starts. The reads take a few seconds
 * at most, so this leaves room for one retry.
 */
export const TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS = 30_000;

// Recoveries this process placed a hold for and has not finished verifying.
const liveRecoveryIds = new Set<string>();

/** Marks the recovery as running in this process. Returns the function that ends it. */
export function trackLiveTeamRecovery(recoveryId: string): () => void {
	liveRecoveryIds.add(recoveryId);
	return () => {
		liveRecoveryIds.delete(recoveryId);
	};
}

/**
 * Whether the Team's hold was left behind: no recovery in this process is
 * verifying it, or it is older than a recovery is given. The process that
 * placed it stopped, or its second read never came back. Another recovery may
 * take such a hold over. Nothing lifts it meanwhile.
 */
export function isTeamRecoveryHoldAbandoned(db: Database, teamId: string, nowMs: number): boolean {
	let hold: { recovery_id: string; held_at: string } | undefined;
	try {
		hold = db
			.prepare("SELECT recovery_id, held_at FROM policy_team_recovery_holds WHERE team_id = ?")
			.get(teamId) as typeof hold;
	} catch (error) {
		if (error instanceof Error && /no such table/u.test(error.message)) return false;
		throw error;
	}
	if (!hold) return false;
	if (!liveRecoveryIds.has(hold.recovery_id)) return true;
	const age = nowMs - Date.parse(hold.held_at);
	return !Number.isFinite(age) || age < 0 || age > TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS;
}

export interface EffectivePolicyTeam {
	team_id: string;
	display_name: string;
	status: string;
	device_eligibility_mode: string;
}

/**
 * Every Team as recipient policy must read it. A held Team reads as inactive,
 * so nothing is derived for it and no grant is published for it until its
 * recovery is verified.
 */
export function readEffectivePolicyTeams(db: Database): EffectivePolicyTeam[] {
	const teams = db
		.prepare(
			`SELECT team_id, display_name, status, device_eligibility_mode
			 FROM policy_teams ORDER BY team_id`,
		)
		.all() as EffectivePolicyTeam[];
	const held = heldTeamIds(db);
	if (held.size === 0) return teams;
	return teams.map((team) => (held.has(team.team_id) ? { ...team, status: "inactive" } : team));
}

/** A store from before the table holds no Team. */
function heldTeamIds(db: Database): Set<string> {
	try {
		const ids = db.prepare("SELECT team_id FROM policy_team_recovery_holds").pluck().all();
		return new Set(ids as string[]);
	} catch (error) {
		if (error instanceof Error && /no such table/u.test(error.message)) return new Set();
		throw error;
	}
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
