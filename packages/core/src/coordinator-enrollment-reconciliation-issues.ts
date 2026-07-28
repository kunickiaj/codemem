import type { Database } from "./db.js";

export type CoordinatorEnrollmentReconciliationIssueStatus = "open" | "resolved";

export interface CoordinatorEnrollmentReconciliationIssueInput {
	kind: "device" | "team_membership";
	referenceId: string;
	code: string;
}

export interface CoordinatorEnrollmentReconciliationIssueDiagnostic
	extends CoordinatorEnrollmentReconciliationIssueInput {
	coordinatorId: string;
	groupId: string;
	status: CoordinatorEnrollmentReconciliationIssueStatus;
	firstSeenAt: string;
	lastSeenAt: string;
	resolvedAt: string | null;
	occurrenceCount: number;
	updatedAt: string;
}

export interface CoordinatorEnrollmentReconciliationIssueSummary {
	counts: {
		open: number;
		resolved: number;
	};
	issues: CoordinatorEnrollmentReconciliationIssueDiagnostic[];
}

const MAX_DIAGNOSTIC_LIMIT = 100;

function validateDiagnosticLimit(limit: number): void {
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DIAGNOSTIC_LIMIT) {
		throw new Error("coordinator_enrollment_reconciliation_issue_limit_invalid");
	}
}

export function persistCoordinatorEnrollmentReconciliationIssues(
	db: Database,
	input: {
		coordinatorId: string;
		groupId: string;
		issues: CoordinatorEnrollmentReconciliationIssueInput[];
		now: string;
	},
): void {
	db.prepare(
		`UPDATE coordinator_enrollment_reconciliation_issues
		 SET status = 'resolved', resolved_at = ?, updated_at = ?
		 WHERE coordinator_id = ? AND group_id = ? AND status = 'open'`,
	).run(input.now, input.now, input.coordinatorId, input.groupId);

	const upsert = db.prepare(
		`INSERT INTO coordinator_enrollment_reconciliation_issues(
			coordinator_id, group_id, kind, reference_id, code, status,
			first_seen_at, last_seen_at, resolved_at, occurrence_count, updated_at
		 ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL, 1, ?)
		 ON CONFLICT(coordinator_id, group_id, kind, reference_id, code) DO UPDATE SET
			status = 'open',
			last_seen_at = excluded.last_seen_at,
			resolved_at = NULL,
			occurrence_count = occurrence_count + 1,
			updated_at = excluded.updated_at`,
	);
	for (const issue of input.issues) {
		upsert.run(
			input.coordinatorId,
			input.groupId,
			issue.kind,
			issue.referenceId,
			issue.code,
			input.now,
			input.now,
			input.now,
		);
	}
}

export function getCoordinatorEnrollmentReconciliationIssueSummary(
	db: Database,
	options: { limit?: number } = {},
): CoordinatorEnrollmentReconciliationIssueSummary {
	const limit = options.limit ?? 25;
	validateDiagnosticLimit(limit);
	const countRows = db
		.prepare(
			`SELECT status, COUNT(*) AS count
			 FROM coordinator_enrollment_reconciliation_issues
			 GROUP BY status`,
		)
		.all() as Array<{ status: string; count: number }>;
	const counts = { open: 0, resolved: 0 };
	for (const row of countRows) {
		if (row.status === "open" || row.status === "resolved") {
			counts[row.status] = row.count;
		}
	}
	const rows = db
		.prepare(
			`SELECT coordinator_id, group_id, kind, reference_id, code, status,
				first_seen_at, last_seen_at, resolved_at, occurrence_count, updated_at
			 FROM coordinator_enrollment_reconciliation_issues
			 WHERE status IN ('open', 'resolved')
			 ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
				CASE WHEN status = 'open' THEN last_seen_at END DESC,
				CASE WHEN status = 'resolved' THEN resolved_at END DESC,
				coordinator_id, group_id, kind, reference_id, code
			 LIMIT ?`,
		)
		.all(limit) as Array<{
		coordinator_id: string;
		group_id: string;
		kind: "device" | "team_membership";
		reference_id: string;
		code: string;
		status: CoordinatorEnrollmentReconciliationIssueStatus;
		first_seen_at: string;
		last_seen_at: string;
		resolved_at: string | null;
		occurrence_count: number;
		updated_at: string;
	}>;
	return {
		counts,
		issues: rows.map((row) => ({
			coordinatorId: row.coordinator_id,
			groupId: row.group_id,
			kind: row.kind,
			referenceId: row.reference_id,
			code: row.code,
			status: row.status,
			firstSeenAt: row.first_seen_at,
			lastSeenAt: row.last_seen_at,
			resolvedAt: row.resolved_at,
			occurrenceCount: row.occurrence_count,
			updatedAt: row.updated_at,
		})),
	};
}
