import type { Database } from "./db.js";
import {
	derivePolicyTeamDeviceEligibility,
	type PolicyTeamDeviceEligibilityResult,
} from "./policy-team-device-eligibility.js";
import { withTeamRecoveryExclusionsFor } from "./team-recovery-exclusions.js";

/**
 * One Team's device eligibility from this machine's policy rows, as recipient
 * policy derives it: active members with an active identity, their active
 * device bindings, and the Team's device decisions with recovery exclusions
 * applied. Undefined when the Team does not exist.
 */
export function readTeamDeviceEligibility(
	db: Database,
	teamId: string,
): PolicyTeamDeviceEligibilityResult | undefined {
	const mode = db
		.prepare("SELECT device_eligibility_mode FROM policy_teams WHERE team_id = ?")
		.pluck()
		.get(teamId) as string | undefined;
	if (mode === undefined) return undefined;
	const members = "SELECT identity_id FROM policy_team_memberships WHERE team_id = ?";
	const memberships = db
		.prepare(
			"SELECT identity_id AS identityId, status FROM policy_team_memberships WHERE team_id = ?",
		)
		.all(teamId) as Array<{ identityId: string; status: string }>;
	const identities = db
		.prepare(
			`SELECT actor_id AS identityId, status, merged_into_actor_id AS mergedIntoIdentityId
			 FROM actors WHERE actor_id IN (${members})`,
		)
		.all(teamId) as Array<{
		identityId: string;
		status: string;
		mergedIntoIdentityId: string | null;
	}>;
	const devices = db
		.prepare(
			`SELECT identity_id AS identityId, device_id AS deviceId, status,
			        assignment_version AS assignmentVersion
			 FROM identity_devices WHERE identity_id IN (${members})`,
		)
		.all(teamId) as Array<{
		identityId: string;
		deviceId: string;
		status: string;
		assignmentVersion: number;
	}>;
	const decisions = withTeamRecoveryExclusionsFor(
		db,
		teamId,
		db
			.prepare(
				`SELECT device_id, decision, assignment_version FROM policy_team_device_decisions
				 WHERE team_id = ?`,
			)
			.all(teamId) as Array<{ device_id: string; decision: string; assignment_version: number }>,
	);
	return derivePolicyTeamDeviceEligibility({
		teamId,
		mode,
		memberships,
		identities,
		devices,
		decisions: decisions.map((row) => ({
			deviceId: row.device_id,
			decision: row.decision,
			assignmentVersion: row.assignment_version,
		})),
	});
}
