import type { Database } from "./db.js";

/*
 * The Projects a Team's last recovery skipped: it did not share them with the
 * Team again, because someone changed their sharing or routing while the Team
 * was disabled. The scope the setup put them in can still hold their memories,
 * and a Team device can still hold proof of its membership there. So sync
 * admission asks, for every Project recorded here, whether current policy
 * gives the device that Project. The state of the Project's Team recipient does
 * not matter: one a person revoked is checked like one quarantine revoked.
 *
 * A Project shared with the Team again passes that check through the Team. Each
 * recovery replaces the Team's set with its own.
 */

export interface TeamRecoverySkippedProject {
	projectIdentity: string;
	reason: string;
}

/** Records the Projects this recovery skipped, in place of the set an earlier one left. */
export function recordTeamRecoverySkippedProjects(
	db: Database,
	input: {
		teamId: string;
		recoveryId: string;
		projects: readonly TeamRecoverySkippedProject[];
		now: string;
	},
): void {
	db.prepare("DELETE FROM policy_team_recovery_skipped_projects WHERE team_id = ?").run(
		input.teamId,
	);
	const insert = db.prepare(
		`INSERT INTO policy_team_recovery_skipped_projects(
		 team_id, project_identity, recovery_id, reason, skipped_at) VALUES (?, ?, ?, ?, ?)`,
	);
	for (const project of input.projects)
		insert.run(input.teamId, project.projectIdentity, input.recoveryId, project.reason, input.now);
}

/** The Projects the Team's last recovery skipped. A store from before the table has none. */
export function teamRecoverySkippedProjectIdentities(db: Database, teamId: string): string[] {
	try {
		return db
			.prepare(
				"SELECT project_identity FROM policy_team_recovery_skipped_projects WHERE team_id = ?",
			)
			.pluck()
			.all(teamId) as string[];
	} catch (error) {
		if (error instanceof Error && /no such table/u.test(error.message)) return [];
		throw error;
	}
}
