import type { LegacyTeamSetupErrorCode } from "../lib/api/sync";

/** Shared by Projects and Sharing so both name a blocked Team setup the same way. */
export function teamSetupRecoveryReason(error: LegacyTeamSetupErrorCode): string {
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
