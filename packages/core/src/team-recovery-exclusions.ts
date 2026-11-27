import type { Database } from "./db.js";

/*
 * Devices a Team recovery left out. The coordinator removed or blocked each
 * one, so the recovered Team must never serve it again, whatever happens to
 * its device decision afterwards: an invitation can reset a decision, a setup
 * activation can rewrite it, and deleting a binding deletes it. The exclusion
 * is its own row, only ever added, and every reader of device decisions applies
 * it on top: an excluded device reads as `excluded`.
 */

export type TeamRecoveryExclusionReason = "removed_from_group" | "blocked_by_coordinator";

export interface TeamRecoveryExclusion {
	deviceId: string;
	/** The key the coordinator removed or blocked the device under. */
	fingerprint: string;
	reason: TeamRecoveryExclusionReason;
}

/** Every exclusion as a `team\0device` key. A store from before the table has none. */
function exclusionKeys(db: Database): Set<string> {
	try {
		const rows = db
			.prepare("SELECT team_id, device_id FROM policy_team_recovery_exclusions")
			.all() as Array<{ team_id: string; device_id: string }>;
		return new Set(rows.map((row) => `${row.team_id}\u0000${row.device_id}`));
	} catch (error) {
		if (error instanceof Error && /no such table/u.test(error.message)) return new Set();
		throw error;
	}
}

/** Records the devices a recovery leaves out. An existing exclusion is kept as it is. */
export function recordTeamRecoveryExclusions(
	db: Database,
	input: { teamId: string; devices: readonly TeamRecoveryExclusion[]; now: string },
): void {
	const insert = db.prepare(
		`INSERT INTO policy_team_recovery_exclusions(team_id, device_id, key_fingerprint, reason, excluded_at)
		 VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_id, device_id) DO NOTHING`,
	);
	for (const device of input.devices)
		insert.run(input.teamId, device.deviceId, device.fingerprint, device.reason, input.now);
}

/** The devices a recovery left out of the Team. */
export function teamRecoveryExcludedDeviceIds(db: Database, teamId: string): Set<string> {
	const prefix = `${teamId}\u0000`;
	return new Set(
		[...exclusionKeys(db)]
			.filter((key) => key.startsWith(prefix))
			.map((key) => key.slice(prefix.length)),
	);
}

/**
 * Device decisions as policy must read them: a device a recovery left out of a
 * Team reads as `excluded` for that Team, whatever its stored decision says.
 */
export function withTeamRecoveryExclusions<
	Row extends { team_id: string; device_id: string; decision: string },
>(db: Database, rows: readonly Row[]): Row[] {
	const excluded = exclusionKeys(db);
	if (excluded.size === 0) return [...rows];
	return rows.map((row) =>
		excluded.has(`${row.team_id}\u0000${row.device_id}`) ? { ...row, decision: "excluded" } : row,
	);
}

/** The same, for the decisions of one Team. */
export function withTeamRecoveryExclusionsFor<Row extends { device_id: string; decision: string }>(
	db: Database,
	teamId: string,
	rows: readonly Row[],
): Row[] {
	const excluded = teamRecoveryExcludedDeviceIds(db, teamId);
	if (excluded.size === 0) return [...rows];
	return rows.map((row) => (excluded.has(row.device_id) ? { ...row, decision: "excluded" } : row));
}

export interface EffectiveTeamDeviceDecision {
	team_id: string;
	device_id: string;
	decision: string;
	assignment_version: number;
	provenance: string;
}

/** Every Team's device decisions as policy must read them, ordered by Team and device. */
export function readEffectiveTeamDeviceDecisions(db: Database): EffectiveTeamDeviceDecision[] {
	return withTeamRecoveryExclusions(
		db,
		db
			.prepare(
				`SELECT team_id, device_id, decision, assignment_version, provenance
				 FROM policy_team_device_decisions ORDER BY team_id, device_id`,
			)
			.all() as EffectiveTeamDeviceDecision[],
	);
}
