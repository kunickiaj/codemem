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

/** A store from before the table has no exclusions. */
function readExclusions<T>(read: () => T, none: T): T {
	try {
		return read();
	} catch (error) {
		if (error instanceof Error && /no such table/u.test(error.message)) return none;
		throw error;
	}
}

/** Every exclusion as a `team\0device` key. */
function exclusionKeys(db: Database): Set<string> {
	const sql = "SELECT team_id, device_id FROM policy_team_recovery_exclusions";
	const rows = readExclusions(
		() => db.prepare(sql).all() as Array<{ team_id: string; device_id: string }>,
		[],
	);
	return new Set(rows.map((row) => `${row.team_id}\u0000${row.device_id}`));
}

/** Returns whether a recovery left a device out of a Team, from one read of every exclusion. */
export function teamRecoveryExclusionCheck(
	db: Database,
): (teamId: string, deviceId: string) => boolean {
	const excluded = exclusionKeys(db);
	return (teamId, deviceId) => excluded.has(`${teamId}\u0000${deviceId}`);
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
	const sql = "SELECT device_id FROM policy_team_recovery_exclusions WHERE team_id = ?";
	return new Set(readExclusions(() => db.prepare(sql).pluck().all(teamId) as string[], []));
}

/**
 * The Team's exclusions as rows of device, key and reason, in device order,
 * for binding in a digest. A store from before the table has none.
 */
export function teamRecoveryExclusionRows(db: Database, teamId: string): unknown[][] {
	const sql = `SELECT device_id, key_fingerprint, reason FROM policy_team_recovery_exclusions
		WHERE team_id = ? ORDER BY device_id`;
	return readExclusions(() => db.prepare(sql).raw().all(teamId) as unknown[][], []);
}

/** Whether a recovery left the device out of the Team. */
export function isTeamRecoveryExcluded(db: Database, teamId: string, deviceId: string): boolean {
	const sql = "SELECT 1 FROM policy_team_recovery_exclusions WHERE team_id = ? AND device_id = ?";
	return readExclusions(() => db.prepare(sql).get(teamId, deviceId) !== undefined, false);
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
