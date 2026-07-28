import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCoordinatorEnrollmentReconciliationIssueSummary } from "./coordinator-enrollment-reconciliation-issues.js";
import { initTestSchema } from "./test-utils.js";

describe("getCoordinatorEnrollmentReconciliationIssueSummary", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => db.close());

	function insertIssue(input: {
		referenceId: string;
		status: "open" | "resolved";
		lastSeenAt: string;
		resolvedAt?: string;
	}): void {
		db.prepare(`INSERT INTO coordinator_enrollment_reconciliation_issues(
			coordinator_id, group_id, kind, reference_id, code, status, first_seen_at,
			last_seen_at, resolved_at, occurrence_count, updated_at
		) VALUES ('https://coord.example.test', 'group-a', 'device', ?, 'safe_code', ?,
			'2026-07-29T00:00:00.000Z', ?, ?, 2, ?)`).run(
			input.referenceId,
			input.status,
			input.lastSeenAt,
			input.resolvedAt ?? null,
			input.resolvedAt ?? input.lastSeenAt,
		);
	}

	it("returns an empty bounded summary", () => {
		expect(getCoordinatorEnrollmentReconciliationIssueSummary(db)).toEqual({
			counts: { open: 0, resolved: 0 },
			issues: [],
		});
	});

	it("returns safe columns in open-first recency order and honors the bound", () => {
		insertIssue({
			referenceId: "resolved-new",
			status: "resolved",
			lastSeenAt: "2026-07-29T00:01:00.000Z",
			resolvedAt: "2026-07-29T00:05:00.000Z",
		});
		insertIssue({
			referenceId: "open-old",
			status: "open",
			lastSeenAt: "2026-07-29T00:02:00.000Z",
		});
		insertIssue({
			referenceId: "open-new",
			status: "open",
			lastSeenAt: "2026-07-29T00:04:00.000Z",
		});

		const summary = getCoordinatorEnrollmentReconciliationIssueSummary(db, { limit: 2 });

		expect(summary.counts).toEqual({ open: 2, resolved: 1 });
		expect(summary.issues.map((issue) => issue.referenceId)).toEqual(["open-new", "open-old"]);
		expect(Object.keys(summary.issues[0] ?? {}).toSorted()).toEqual(
			[
				"code",
				"coordinatorId",
				"firstSeenAt",
				"groupId",
				"kind",
				"lastSeenAt",
				"occurrenceCount",
				"referenceId",
				"resolvedAt",
				"status",
				"updatedAt",
			].toSorted(),
		);
	});

	it.each([0, -1, 1.5, 101])("rejects invalid diagnostic limit %s", (limit) => {
		expect(() => getCoordinatorEnrollmentReconciliationIssueSummary(db, { limit })).toThrow(
			"coordinator_enrollment_reconciliation_issue_limit_invalid",
		);
	});
});
