export type LegacyTeamSetupActivationErrorCode =
	| "team_setup_incomplete"
	| "team_setup_roster_changed"
	| "team_setup_projection_changed"
	| "team_setup_assignment_changed"
	| "team_setup_roster_unavailable"
	| "team_setup_conflict"
	| "team_setup_confirmation_stale"
	| "team_setup_failed";

export type LegacyTeamSetupDraftErrorCode =
	| "legacy_team_setup_time_invalid"
	| "legacy_team_setup_draft_not_found"
	| "legacy_team_setup_draft_stale"
	| "legacy_team_setup_device_not_found"
	| "legacy_team_setup_device_not_eligible"
	| "legacy_team_setup_assignment_changed"
	| "legacy_team_setup_identity_invalid"
	| "legacy_team_setup_decision_invalid"
	| "legacy_team_setup_identity_required"
	| "legacy_team_setup_device_not_removed"
	| "legacy_team_setup_project_mapping_invalid"
	| "legacy_team_setup_project_not_found"
	| "legacy_team_setup_project_not_ambiguous"
	| "legacy_team_setup_roster_too_large"
	| "legacy_team_setup_roster_conflict";

export type LegacyTeamSetupCoreErrorCode =
	| LegacyTeamSetupDraftErrorCode
	| LegacyTeamSetupActivationErrorCode;

/**
 * Stable API compatibility boundary. Core keeps throwing its released strings;
 * API callers translate them through this frozen, bounded vocabulary.
 */
export const LEGACY_TEAM_SETUP_API_ERROR_BY_CORE_ERROR = {
	legacy_team_setup_time_invalid: "team_setup_failed",
	legacy_team_setup_draft_not_found: "team_setup_confirmation_stale",
	legacy_team_setup_draft_stale: "team_setup_confirmation_stale",
	legacy_team_setup_device_not_found: "team_setup_confirmation_stale",
	legacy_team_setup_device_not_eligible: "team_setup_incomplete",
	legacy_team_setup_assignment_changed: "team_setup_assignment_changed",
	legacy_team_setup_identity_invalid: "team_setup_conflict",
	legacy_team_setup_decision_invalid: "team_setup_incomplete",
	legacy_team_setup_identity_required: "team_setup_incomplete",
	legacy_team_setup_device_not_removed: "team_setup_conflict",
	legacy_team_setup_project_mapping_invalid: "team_setup_incomplete",
	legacy_team_setup_project_not_found: "team_setup_confirmation_stale",
	legacy_team_setup_project_not_ambiguous: "team_setup_incomplete",
	legacy_team_setup_roster_too_large: "team_setup_incomplete",
	legacy_team_setup_roster_conflict: "team_setup_conflict",
	team_setup_incomplete: "team_setup_incomplete",
	team_setup_roster_changed: "team_setup_roster_changed",
	team_setup_projection_changed: "team_setup_projection_changed",
	team_setup_assignment_changed: "team_setup_assignment_changed",
	team_setup_roster_unavailable: "team_setup_roster_unavailable",
	team_setup_conflict: "team_setup_conflict",
	team_setup_confirmation_stale: "team_setup_confirmation_stale",
	team_setup_failed: "team_setup_failed",
} as const satisfies Record<LegacyTeamSetupCoreErrorCode, LegacyTeamSetupActivationErrorCode>;

export function legacyTeamSetupApiErrorCode(error: unknown): LegacyTeamSetupActivationErrorCode {
	const explicitCode =
		error && typeof error === "object" && "code" in error && typeof error.code === "string"
			? error.code
			: null;
	const code =
		explicitCode ??
		(error instanceof Error ? error.message : typeof error === "string" ? error : "");
	return Object.hasOwn(LEGACY_TEAM_SETUP_API_ERROR_BY_CORE_ERROR, code)
		? LEGACY_TEAM_SETUP_API_ERROR_BY_CORE_ERROR[
				code as keyof typeof LEGACY_TEAM_SETUP_API_ERROR_BY_CORE_ERROR
			]
		: "team_setup_failed";
}
