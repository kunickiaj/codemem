export const RECIPIENT_POLICY_CONTRACT_VERSION = 1 as const;

export type RecipientPolicyContractVersion = typeof RECIPIENT_POLICY_CONTRACT_VERSION;

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

export interface RecipientPolicyReviewItemV1 {
	version: RecipientPolicyContractVersion;
	reviewItemId: string;
	sourceFingerprint: string;
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
