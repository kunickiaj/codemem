import type { AccountView } from "../lib/api/account";
import type {
	RecoveryPreview,
	RecoveryPreviewRequest,
	RecoveryProfile,
} from "./account-owner-recovery-types";
import { status } from "./my-account-test-utils";

// Public synthetic DTOs only: the historical author is B, never the chosen owner A.
export const recoveryProfile: RecoveryProfile = {
	contextId: "semantic-profile-context",
	memoryActorId: "identity-b",
	deviceId: "device-one",
	fingerprint: "fingerprint",
	coordinatorOrigin: "https://coordinator.example",
	coordinatorId: "coordinator-one",
	configuredGroups: ["group-one", "group-two"],
};
export function recoveryEnvelope() {
	return {
		version: 1 as const,
		profile: structuredClone(recoveryProfile),
		candidates: [{ id: "identity-a", label: "Owner A" }],
		reviewAccess: "operator" as "operator" | "request",
	};
}
export function recoveryRequest(): RecoveryPreviewRequest {
	return {
		profile: structuredClone(recoveryProfile),
		existingOwnerId: "identity-a",
		groups: ["group-one", "group-two"],
		requestId: "review-request-one",
		purpose: "review",
	};
}
export function recoveryPreview(request = recoveryRequest()) {
	return {
		...structuredClone(request),
		scope: "historical_included_owner_labels_only",
		approvalDigest: "a".repeat(64),
		groupPreviews: request.groups.map((groupId) => ({
			groupId,
			action: "new" as const,
			reason: "Explicit existing-owner review required.",
		})),
		history: {
			complete: true,
			rows: [
				{
					id: "retained-row-b",
					groupId: "retained-history-group",
					deviceId: "device-one",
					fingerprint: "fingerprint",
					identityId: "identity-b",
					assignment: "included",
					relation: "exact_subject",
					reason: "Retained canonical Team decision; display metadata only.",
				},
			],
		},
		reviewedWeakLabels: [
			{
				kind: "consumed_project_actor_label" as const,
				label: "project-author-b",
				group_id: "group-one",
				device_id: "device-one",
				evidence_ref: "b".repeat(64),
				effect: "account_owner_display_only" as const,
			},
		],
	} satisfies RecoveryPreview & { reviewedWeakLabels: readonly object[] };
}
export function blockedAccount(): AccountView {
	return status({
		groups: ["group-one", "group-two"],
		canLink: false,
		blockedReason: "review_required",
		local: {
			deviceId: "device-one",
			fingerprint: "fingerprint",
			identityId: "identity-b",
			identityLabel: "Historical author B",
		},
		remote: {
			kind: "status",
			coordinatorId: "coordinator-one",
			authority: null,
			identityId: null,
			identityMatches: false,
			state: "review_required",
			account: null,
		},
	});
}
export function ownerAccount() {
	return {
		...blockedAccount(),
		contextId: "owner-display-context-a",
		operationContextId: "context-one",
		accountOwner: { identityId: "identity-a", memoryActorId: "identity-b" } as {
			identityId: string;
			memoryActorId: string;
			displayName?: string;
		},
		remote: { kind: "not_checked" as const },
		blockedReason: "already_linked" as const,
		ownerProjection: {
			kind: "resolved_account_owner" as const,
			status: {
				version: 1 as const,
				coordinatorId: "coordinator-one",
				groupId: "group-one",
				deviceId: "device-one",
				fingerprint: "fingerprint",
				state: "owner_confirmed" as const,
				ownerIdentity: "identity-a",
				profileState: "linked" as "linked" | "account_unlinked" | "unavailable",
				profile: {
					displayName: "Verified Owner A",
					email: "owner-a@example.test",
					pictureUrl: "https://lh3.googleusercontent.com/owner-a",
				} as { displayName: string; email: string; pictureUrl: string } | null,
			},
		},
	};
}
