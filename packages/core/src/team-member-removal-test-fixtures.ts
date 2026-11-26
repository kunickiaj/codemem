import type { Database } from "./db.js";
import { deterministicPolicyTeamId } from "./recipient-policy-identifiers.js";

/**
 * Records a completed Team setup from the coordinator group, which is what
 * makes that group's removals apply to the Team. Returns the Team ID.
 */
export function linkTeamToCoordinatorGroup(
	db: Database,
	input: { candidateId: string; coordinatorId: string; groupId: string; now?: string },
): string {
	const teamId = deterministicPolicyTeamId(input.candidateId);
	const now = input.now ?? "2026-07-26T00:00:00.000Z";
	const attemptId = `attempt-${input.candidateId}-${input.groupId}`;
	db.prepare(
		`INSERT INTO legacy_team_setup_drafts(
		 attempt_id, candidate_id, coordinator_id, group_id, state, display_name,
		 roster_fingerprint, projection_fingerprint, finish_digest, completed_team_id,
		 created_at, updated_at, completed_at
		 ) VALUES (?, ?, ?, ?, 'completed', 'Team', 'roster', 'projection', 'finish', ?, ?, ?, ?)`,
	).run(attemptId, input.candidateId, input.coordinatorId, input.groupId, teamId, now, now, now);
	db.prepare(
		`INSERT INTO legacy_team_setup_completions(
		 attempt_id, finish_digest, candidate_ref, confirmed_access_delta_digest,
		 completed_team_id, response_json, completed_at, created_at
		 ) VALUES (?, 'finish', ?, 'delta', ?, '{}', ?, ?)`,
	).run(attemptId, input.candidateId, teamId, now, now);
	return teamId;
}
