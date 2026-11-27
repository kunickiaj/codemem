import type { LegacyTeamSetupPendingCandidateSummaryV1 } from "../lib/api/sync";

/** Shared by Projects and Sharing so both name a blocked Team setup the same way. */
export function teamSetupRecoveryReason(
	candidate: Pick<LegacyTeamSetupPendingCandidateSummaryV1, "blockingError" | "blockingReason">,
): string {
	const error = candidate.blockingError;
	if (
		error === "team_setup_completion_unavailable" &&
		candidate.blockingReason === "device_removals_unavailable"
	)
		return "Device removal records could not be read from the coordinator. Nothing changed. View recovery details and try again.";
	if (
		error === "team_setup_completion_unavailable" &&
		candidate.blockingReason === "team_member_removals_unavailable"
	)
		return "Team member removals could not be read from the coordinator. Nothing changed here. View recovery details and try again.";
	if (
		error === "team_setup_completion_unavailable" &&
		candidate.blockingReason === "team_recovery_unconfirmed"
	)
		return "A recovery of this Team was saved but not confirmed, so the Team shares nothing yet. On a device that holds the coordinator admin secret, view recovery details and review the recovery again.";
	switch (error) {
		case "team_setup_completion_conflict":
		case "team_setup_conflict":
			return "Saved Team setup conflicts with the current sharing policy. View recovery details before trying again.";
		case "team_setup_completion_invalid":
			return "Saved Team setup could not be verified. View recovery details before trying again.";
		case "team_setup_roster_unavailable":
			return "Current device or Project information is unavailable. View recovery details and try again.";
		case "team_setup_completion_unavailable":
			return "Saved Team setup cannot be recovered on this device right now. View recovery details and try again.";
		case "team_setup_assignment_changed":
		case "team_setup_roster_changed":
		case "team_setup_confirmation_stale":
			return "Team setup information has changed. View recovery details before trying again.";
		case "team_setup_incomplete":
			return "Team setup is incomplete. View recovery details to check what is missing.";
		default:
			return "Team setup could not be recovered. View recovery details and try again.";
	}
}
