import { INVITE_DECISION_PROVENANCES } from "./recipient-policy-identifiers.js";

export type TeamPolicyOwnership = "setup" | "invite" | "other";

export interface ExistingTeamMembership {
	provenance: string;
	status: string;
}

export interface ExistingTeamDeviceDecision {
	provenance: string;
	decision: string;
}

export type SetupMembershipTransition =
	| "upsert_setup"
	| "revoke_setup"
	| "normalize_invite"
	| "preserve";

export type InviteMembershipTransition =
	| "insert_invite"
	| "adopt_setup"
	| "reauthorize_setup"
	| "normalize_invite"
	| "preserve"
	| "reject";

export type SetupDeviceDecisionTransition =
	| "upsert_setup"
	| "upsert_preserving_invite"
	| "delete_setup"
	| "settle_invite_excluded"
	| "preserve";

export type InviteDeviceDecisionTransition =
	| "insert_unresolved"
	| "adopt_setup"
	| "replace_unresolved"
	| "preserve";

const SETUP_PROVENANCES = new Set([
	"reviewed_active",
	"reviewed_team_candidate",
	"reviewed_team_setup",
]);
const INVITE_PROVENANCES: ReadonlySet<string> = new Set(INVITE_DECISION_PROVENANCES);

export function classifyTeamPolicyOwnership(provenance: string): TeamPolicyOwnership {
	if (SETUP_PROVENANCES.has(provenance)) return "setup";
	if (INVITE_PROVENANCES.has(provenance)) return "invite";
	return "other";
}

export function planSetupMembershipTransition(
	existing: ExistingTeamMembership | undefined,
	desired: boolean,
): SetupMembershipTransition {
	if (!existing) return desired ? "upsert_setup" : "preserve";

	const ownership = classifyTeamPolicyOwnership(existing.provenance);
	if (desired) {
		if (ownership === "setup") return "upsert_setup";
		if (ownership === "invite" && existing.status === "active") return "normalize_invite";
		return "preserve";
	}

	if (ownership === "setup") {
		return ["active", "reviewed_active"].includes(existing.status) ? "revoke_setup" : "preserve";
	}
	if (ownership === "invite" && existing.status === "active") return "normalize_invite";
	return "preserve";
}

export function planInviteMembershipTransition(
	existing: ExistingTeamMembership | undefined,
	targetStatus: "active" | "reviewed_active",
): InviteMembershipTransition {
	if (!existing) return "insert_invite";

	const ownership = classifyTeamPolicyOwnership(existing.provenance);
	if (ownership === "setup") {
		if (existing.status === "revoked") return "reauthorize_setup";
		if (["active", "reviewed_active"].includes(existing.status)) return "adopt_setup";
		return "reject";
	}
	if (ownership !== "invite") return "reject";
	if (existing.status === targetStatus) return "preserve";
	if (existing.status === "active" && targetStatus === "reviewed_active") {
		return "normalize_invite";
	}
	return "reject";
}

export function planSetupDeviceDecisionTransition(
	existing: ExistingTeamDeviceDecision | undefined,
	options: { desiredDecision?: "included" | "excluded"; belongsToRoster: boolean },
): SetupDeviceDecisionTransition {
	if (options.desiredDecision) {
		if (!existing) return "upsert_setup";
		const ownership = classifyTeamPolicyOwnership(existing.provenance);
		if (ownership === "setup") return "upsert_setup";
		if (ownership === "invite") return "upsert_preserving_invite";
		return "preserve";
	}
	if (!existing) return "preserve";

	const ownership = classifyTeamPolicyOwnership(existing.provenance);
	if (ownership === "setup") return "delete_setup";
	if (ownership !== "invite") return "preserve";
	if (options.belongsToRoster || existing.decision === "unresolved") {
		return "settle_invite_excluded";
	}
	return "preserve";
}

export function planInviteDeviceDecisionTransition(
	existing: ExistingTeamDeviceDecision | undefined,
	newlyAuthorizedMembership: boolean,
): InviteDeviceDecisionTransition {
	if (!existing) return "insert_unresolved";
	if (classifyTeamPolicyOwnership(existing.provenance) === "setup") return "adopt_setup";
	// A newly authorized membership resets invite-owned and unknown decisions
	// to non-granting unresolved state so stale grants cannot survive reauthorization.
	return newlyAuthorizedMembership ? "replace_unresolved" : "preserve";
}
