import type {
	RecoveryPreview,
	RecoveryPreviewRequest,
	RecoveryProfile,
} from "./account-owner-recovery-types";

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
