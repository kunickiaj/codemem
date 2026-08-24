import type { Database } from "./db.js";

export interface LegacyTeamSetupAttemptSelection {
	attemptId: string;
	candidateId: string;
	isCurrent: boolean;
}

interface AttemptSelectionRow {
	attempt_id: string;
	candidate_id: string;
	is_current: number;
}

function selection(row: AttemptSelectionRow | undefined): LegacyTeamSetupAttemptSelection | null {
	return row
		? {
				attemptId: row.attempt_id,
				candidateId: row.candidate_id,
				isCurrent: row.is_current === 1,
			}
		: null;
}

/** Latest means greatest SQLite insertion rowid; caller-controlled timestamps are not authoritative. */
export function latestLegacyTeamSetupAttempt(
	db: Database,
	candidateId: string,
): LegacyTeamSetupAttemptSelection | null {
	return selection(
		db
			.prepare(
				`SELECT attempt_id, candidate_id, 1 AS is_current
				 FROM legacy_team_setup_drafts
				 WHERE candidate_id = ?
				 ORDER BY rowid DESC LIMIT 1`,
			)
			.get(candidateId) as AttemptSelectionRow | undefined,
	);
}

export function legacyTeamSetupAttemptCurrentness(
	db: Database,
	attemptId: string,
): LegacyTeamSetupAttemptSelection | null {
	return selection(
		db
			.prepare(
				`SELECT draft.attempt_id, draft.candidate_id,
				        NOT EXISTS (
				          SELECT 1 FROM legacy_team_setup_drafts AS newer
				          WHERE newer.candidate_id = draft.candidate_id AND newer.rowid > draft.rowid
				        ) AS is_current
				 FROM legacy_team_setup_drafts AS draft
				 WHERE draft.attempt_id = ?`,
			)
			.get(attemptId) as AttemptSelectionRow | undefined,
	);
}
