export const PROJECT_INVITE_PENDING_STATUS = "pending_setup" as const;

export const PROJECT_SYNC_ENABLEMENT_FAILED = "project_sync_enablement_failed" as const;

export const PROJECT_SYNC_ENABLEMENT_FAILURE_DETAIL =
	"Invitation was accepted, but sync could not be enabled. Make the codemem config writable, then retry.";

export class ProjectSyncEnablementError extends Error {
	readonly code = PROJECT_SYNC_ENABLEMENT_FAILED;
	readonly detail = PROJECT_SYNC_ENABLEMENT_FAILURE_DETAIL;

	constructor(options?: ErrorOptions) {
		super(PROJECT_SYNC_ENABLEMENT_FAILURE_DETAIL, options);
		this.name = "ProjectSyncEnablementError";
	}
}

export function isProjectSyncEnablementError(error: unknown): error is ProjectSyncEnablementError {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === PROJECT_SYNC_ENABLEMENT_FAILED &&
		"detail" in error &&
		error.detail === PROJECT_SYNC_ENABLEMENT_FAILURE_DETAIL
	);
}
