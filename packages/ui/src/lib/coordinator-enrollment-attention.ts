type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
	return value !== null && typeof value === "object" ? (value as UnknownRecord) : null;
}

export function coordinatorEnrollmentOpenIssueCount(payload: unknown): number {
	const root = record(payload);
	const status = record(root?.status);
	const block = record(
		root?.coordinator_enrollment_reconciliation_issues ??
			status?.coordinator_enrollment_reconciliation_issues,
	);
	const counts = record(block?.counts);
	const open = counts?.open;
	return typeof open === "number" && Number.isSafeInteger(open) && open > 0 ? open : 0;
}
