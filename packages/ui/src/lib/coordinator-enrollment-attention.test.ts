import { describe, expect, it } from "vitest";
import { coordinatorEnrollmentOpenIssueCount } from "./coordinator-enrollment-attention";

describe("coordinatorEnrollmentOpenIssueCount", () => {
	it("reads only the bounded open issue count", () => {
		expect(
			coordinatorEnrollmentOpenIssueCount({
				coordinator_enrollment_reconciliation_issues: {
					counts: { open: 2, resolved: 4 },
					issues: [{ coordinator_id: "not-for-normal-ui" }],
				},
			}),
		).toBe(2);
		expect(
			coordinatorEnrollmentOpenIssueCount({
				status: {
					coordinator_enrollment_reconciliation_issues: { counts: { open: 3 } },
				},
			}),
		).toBe(3);
	});

	it.each([
		null,
		{},
		{ coordinator_enrollment_reconciliation_issues: {} },
		{ coordinator_enrollment_reconciliation_issues: { counts: { open: -1 } } },
	])("fails closed to no normal attention for malformed payload %j", (payload) => {
		expect(coordinatorEnrollmentOpenIssueCount(payload)).toBe(0);
	});
});
