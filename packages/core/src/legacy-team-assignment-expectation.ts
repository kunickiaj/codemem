export interface StoredLegacyTeamAssignmentExpectation {
	kind: "absent" | "existing" | null;
	identityId: string | null;
	assignmentVersion: number | null;
}

export function isValidLegacyTeamAssignmentVersion(value: number | null): value is number {
	return value != null && Number.isSafeInteger(value) && value >= 0;
}

export function isStoredLegacyTeamAssignmentExpectationWellFormed(
	expectation: StoredLegacyTeamAssignmentExpectation,
): boolean {
	if (expectation.kind === "absent") {
		return expectation.identityId == null && expectation.assignmentVersion == null;
	}
	return (
		expectation.kind === "existing" &&
		expectation.identityId != null &&
		isValidLegacyTeamAssignmentVersion(expectation.assignmentVersion)
	);
}
