export const RECIPIENT_POLICY_CONTRACT_VERSION = 1 as const;

export type RecipientPolicyContractVersion = typeof RECIPIENT_POLICY_CONTRACT_VERSION;

export const RECIPIENT_POLICY_TEAM_RENAME_ERROR_CODES = [
	"team_name_invalid",
	"team_not_found",
	"team_rename_stale",
	"team_link_stale",
	"team_link_ambiguous",
	"team_coordinator_rename_failed",
	"team_local_rename_pending",
	"team_rename_failed",
] as const;

export type RecipientPolicyTeamRenameErrorCode =
	(typeof RECIPIENT_POLICY_TEAM_RENAME_ERROR_CODES)[number];

export interface RecipientPolicyTeamRenameResultV1 {
	version: 1;
	teamId: string;
	displayName: string;
	revision: string;
	linkedCoordinatorGroupRenamed: boolean;
}

export type RecipientPolicyEdgeRecipientRefV1 =
	| { recipientKind: "identity"; identityId: string }
	| { recipientKind: "team"; teamId: string };

export interface RecipientPolicyEdgeChangeV1 {
	canonicalProjectIdentity: string;
	recipient: RecipientPolicyEdgeRecipientRefV1;
	action: "add" | "remove";
}

export interface RecipientPolicyEdgePreviewRequestV1 {
	version: 1;
	changes: RecipientPolicyEdgeChangeV1[];
}

export interface RecipientPolicyEdgeCommitRequestV1 extends RecipientPolicyEdgePreviewRequestV1 {
	reviewedPolicyDigest: string;
}

export interface RecipientPolicyEdgePreviewProjectV1 {
	canonicalProjectIdentity: string;
	displayName: string;
	existingMemoryCount: number;
	futureMemoriesShared: true;
}

export interface RecipientPolicyEdgeIdentitySummaryV1 {
	identityId: string;
	displayName: string;
	verification: "local";
}

export type RecipientPolicyEdgeSelectedRecipientV1 =
	| ({ recipientKind: "identity" } & RecipientPolicyEdgeIdentitySummaryV1)
	| {
			recipientKind: "team";
			teamId: string;
			displayName: string;
			currentMembers: RecipientPolicyEdgeIdentitySummaryV1[];
			futureMembersInherit: true;
	  };

export interface RecipientPolicyEdgeEffectiveDeviceV1 {
	canonicalProjectIdentity: string;
	identityId: string;
	deviceId: string;
	displayName: string;
}

export interface RecipientPolicyEdgePreviewResponseV1 {
	version: 1;
	normalizedChanges: RecipientPolicyEdgeChangeV1[];
	outcomes: RecipientPolicyEdgeCommitOutcomeV1[];
	projects: RecipientPolicyEdgePreviewProjectV1[];
	selectedRecipients: RecipientPolicyEdgeSelectedRecipientV1[];
	effectiveDevices: RecipientPolicyEdgeEffectiveDeviceV1[];
	unchangedProjects: RecipientPolicyEdgePreviewProjectV1[];
	reviewedPolicyDigest: string;
	addCount: number;
	removeCount: number;
	netWriteCount: number;
}

export type RecipientPolicyEdgeOutcomeV1 =
	| "added"
	| "removed"
	| "already_present"
	| "already_absent";

export interface RecipientPolicyEdgeCommitOutcomeV1 {
	change: RecipientPolicyEdgeChangeV1;
	outcome: RecipientPolicyEdgeOutcomeV1;
}

export interface RecipientPolicyEdgeCommitResultV1 {
	version: 1;
	status: "applied" | "stale" | "invalid" | "not_found" | "conflict";
	reviewedPolicyDigest: string;
	errorCode: string | null;
	outcomes: RecipientPolicyEdgeCommitOutcomeV1[];
	writeCount: number;
	idempotent: boolean;
}

export type RecipientPolicyIdentityKindV1 = "personal" | "work" | "other";
export type RecipientPolicyIdentityStatusV1 = "active" | "pending" | "merged";

export interface RecipientPolicyIdentityV1 {
	version: RecipientPolicyContractVersion;
	identityId: string;
	displayName: string;
	kind: RecipientPolicyIdentityKindV1;
	verification: "local";
	status: RecipientPolicyIdentityStatusV1;
	mergedIntoIdentityId: string | null;
}

export interface RecipientPolicyTeamV1 {
	version: RecipientPolicyContractVersion;
	teamId: string;
	displayName: string;
	status: "active" | "archived";
}

export interface RecipientPolicyTeamMembershipV1 {
	version: RecipientPolicyContractVersion;
	teamId: string;
	identityId: string;
	role: "member" | "admin";
	status: "active" | "pending" | "revoked";
}

export interface RecipientPolicyIdentityDeviceV1 {
	version: RecipientPolicyContractVersion;
	identityId: string;
	deviceId: string;
	displayName: string;
	status: "active" | "revoked";
}

export interface RecipientPolicyProjectV1 {
	version: RecipientPolicyContractVersion;
	canonicalIdentity: string;
	displayName: string;
}

export type RecipientPolicyIntentSourceV1 = "user" | "migration" | "legacy_project_invite";

interface RecipientPolicyProjectRecipientBaseV1 {
	version: RecipientPolicyContractVersion;
	canonicalProjectIdentity: string;
	intentSource: RecipientPolicyIntentSourceV1;
	policyRevision: string;
	status: "active" | "revoked";
}

export type RecipientPolicyProjectRecipientV1 =
	| (RecipientPolicyProjectRecipientBaseV1 & {
			recipientKind: "identity";
			identityId: string;
	  })
	| (RecipientPolicyProjectRecipientBaseV1 & {
			recipientKind: "team";
			teamId: string;
	  });

interface RecipientPolicyEffectiveDeviceBaseV1 {
	version: RecipientPolicyContractVersion;
	canonicalProjectIdentity: string;
	identityId: string;
	deviceId: string;
}

export type RecipientPolicyEffectiveDeviceV1 =
	| (RecipientPolicyEffectiveDeviceBaseV1 & {
			via: "direct_identity";
	  })
	| (RecipientPolicyEffectiveDeviceBaseV1 & {
			via: "team_membership";
			teamId: string;
	  });

export type RecipientPolicyAuthorityV1 = "legacy_scope" | "recipient_policy";
export type RecipientPolicyParityV1 = "unknown" | "matched" | "diverged";

export interface RecipientPolicyEnforcementV1 {
	version: RecipientPolicyContractVersion;
	canonicalProjectIdentity: string;
	authority: RecipientPolicyAuthorityV1;
	parity: RecipientPolicyParityV1;
	cutoverState: "legacy" | "eligible" | "active" | "rolled_back";
	managedScopeId: string | null;
	desiredDeviceIds: string[];
	currentDeviceIds: string[];
	safeErrorCode: string | null;
}

export type RecipientPolicyReviewDecisionV1 =
	| "apply_recommendation"
	| "choose_recipients"
	| "preserve_current_access"
	| "reject_suggestion"
	| "keep_current_setup"
	| "keep_project_local"
	| "keep_identities_separate"
	| "attach_device_to_identity"
	| "create_identity"
	| "remove_stale_device";

export const RECIPIENT_POLICY_NO_OP_DECISIONS = [
	"keep_current_setup",
	"reject_suggestion",
	"keep_project_local",
	"keep_identities_separate",
	"remove_stale_device",
] as const satisfies readonly RecipientPolicyReviewDecisionV1[];

const RECIPIENT_POLICY_NO_OP_DECISION_SET = new Set<RecipientPolicyReviewDecisionV1>(
	RECIPIENT_POLICY_NO_OP_DECISIONS,
);

export function isRecipientPolicyNoOpDecision(
	decision: RecipientPolicyReviewDecisionV1 | string,
): decision is (typeof RECIPIENT_POLICY_NO_OP_DECISIONS)[number] {
	return RECIPIENT_POLICY_NO_OP_DECISION_SET.has(decision as RecipientPolicyReviewDecisionV1);
}

export interface RecipientPolicyReviewOptionV1 {
	decision: RecipientPolicyReviewDecisionV1;
	label: string;
	effect: "none" | "grant_reviewed_access" | "revoke_reviewed_access" | "metadata_only";
	affectedProjectCount: number;
	affectedMemoryCount: number;
	affectedDeviceCount: number;
	/** Additive exact preview used by actionable review APIs. */
	preview?: RecipientPolicyReviewPreviewV1;
}

export interface RecipientPolicyReviewPreviewProjectV1 {
	canonicalIdentity: string;
	displayName: string;
}

export interface RecipientPolicyReviewPreviewDeviceV1 {
	deviceId: string;
	displayName: string;
	identityId: string | null;
	assignment: "assigned" | "unassigned";
}

export interface RecipientPolicyReviewPreviewV1 {
	projects: RecipientPolicyReviewPreviewProjectV1[];
	effectiveDevices: RecipientPolicyReviewPreviewDeviceV1[];
	affectedProjectCount: number;
	affectedMemoryCount: number;
	affectedDeviceCount: number;
	effect: RecipientPolicyReviewOptionV1["effect"];
	requiresDecisionInput: boolean;
}

export interface RecipientPolicyReviewResolutionV1 {
	decision: RecipientPolicyReviewDecisionV1;
	decidedByIdentityId: string;
	decidedByDeviceId: string;
	resolvedAt: string;
}

export type RecipientPolicyReviewConditionCodeV1 =
	| "suggest_local_identity"
	| "suggest_team_candidate"
	| "unassigned_effective_device";

export interface RecipientPolicyReviewProjectGroupV1 {
	identity: string;
	displayName: string;
}

export interface RecipientPolicyReviewItemV1 {
	version: RecipientPolicyContractVersion;
	reviewItemId: string;
	sourceFingerprint: string;
	conditionCode: RecipientPolicyReviewConditionCodeV1;
	projectGroup: RecipientPolicyReviewProjectGroupV1;
	finding: string;
	reason: string;
	recommendedDecision: RecipientPolicyReviewDecisionV1;
	options: RecipientPolicyReviewOptionV1[];
	state: "open" | "resolved";
	resolution: RecipientPolicyReviewResolutionV1 | null;
}

export interface RecipientPolicyBlockedItemV1 {
	version: RecipientPolicyContractVersion;
	blockedItemId: string;
	finding: string;
	reason: string;
	ownerLabel: string;
	repairAction: string;
	repair: {
		kind: "reassign_project" | "open_project_administration";
		projectIdentity: string;
		label: string;
	};
}

export interface RecipientPolicyProjectionV1 {
	version: RecipientPolicyContractVersion;
	project: RecipientPolicyProjectV1;
	intent: RecipientPolicyProjectRecipientV1[];
	effectiveDevices: RecipientPolicyEffectiveDeviceV1[];
	enforcement: RecipientPolicyEnforcementV1;
	reviewItems: RecipientPolicyReviewItemV1[];
	blockedItems: RecipientPolicyBlockedItemV1[];
}

export interface RecipientPolicyReconciliationStatusV1 {
	version: RecipientPolicyContractVersion;
	canonicalProjectIdentity: string;
	state: "projected" | "parity_verified" | "active" | "waiting" | "needs_attention" | "rolled_back";
	authority: RecipientPolicyAuthorityV1;
	parity: RecipientPolicyParityV1;
	lastCompletedAt: string | null;
	safeErrorCode: string | null;
}

export type LegacyTeamSetupActivationChangeV1 = "add" | "update" | "remove";

export interface LegacyTeamSetupTeamChangeV1 {
	teamId: string;
	change: LegacyTeamSetupActivationChangeV1;
	fromDeviceEligibilityMode: "person_all_devices" | "reviewed_allowlist" | null;
	toDeviceEligibilityMode: "reviewed_allowlist";
}

export interface LegacyTeamSetupMembershipChangeV1 {
	teamId: string;
	identityId: string;
	change: LegacyTeamSetupActivationChangeV1;
}

export interface LegacyTeamSetupProjectChangeV1 {
	projectRef: string;
	fromProjectIdentity: string | null;
	toProjectIdentity: string | null;
	change: LegacyTeamSetupActivationChangeV1;
}

export interface LegacyTeamSetupRecipientChangeV1 {
	canonicalProjectIdentity: string;
	recipientKind: "team";
	recipientId: string;
	change: LegacyTeamSetupActivationChangeV1;
}

export interface LegacyTeamSetupDeviceAccessChangeV1 {
	canonicalProjectIdentity: string;
	deviceId: string;
	change: "add" | "remove";
}

export interface LegacyTeamSetupAccessDeltaV1 {
	teamChanges: LegacyTeamSetupTeamChangeV1[];
	membershipChanges: LegacyTeamSetupMembershipChangeV1[];
	projectChanges: LegacyTeamSetupProjectChangeV1[];
	recipientChanges: LegacyTeamSetupRecipientChangeV1[];
	deviceAccessChanges: LegacyTeamSetupDeviceAccessChangeV1[];
}

export interface LegacyTeamSetupActivationPreviewV1 {
	candidateRef: string;
	attemptId: string;
	finishDigest: string;
	accessDeltaDigest: string;
	accessDelta: LegacyTeamSetupAccessDeltaV1;
}

export interface LegacyTeamSetupActivationResultV1 {
	status: "completed";
	teamId: string;
	attemptId: string;
	accessDeltaDigest: string;
	completedAt: string;
}
