/** Noncredential projections only; private paths and review evidence stay in the service. */
export interface RecoveryProfile {
	contextId: string;
	memoryActorId: string;
	deviceId: string;
	fingerprint: string;
	coordinatorOrigin: string;
	coordinatorId: string;
	configuredGroups: readonly string[];
}
export interface RecoverySelection {
	profile: RecoveryProfile;
	existingOwnerId: string;
	groups: readonly string[];
}
export interface RecoveryPreviewRequest extends RecoverySelection {
	requestId: string;
	purpose: "review" | "check_status";
}
export interface RecoveryHistoryRow {
	id: string;
	groupId: string;
	deviceId: string;
	fingerprint: string;
	identityId: string;
	assignment: "included" | "excluded";
	relation: "exact_subject" | "alias" | "other";
	reason: string;
}
export interface ReviewedWeakLabel {
	label: string;
	kind: "legacy_included_owner_label" | "consumed_project_actor_label";
	group_id: string;
	device_id: string;
	evidence_ref: string;
	effect: "account_owner_display_only";
}
export interface RecoveryPreview extends RecoverySelection {
	requestId: string;
	scope: "historical_included_owner_labels_only";
	approvalDigest: string;
	groupPreviews: readonly {
		groupId: string;
		action: "new" | "reuse" | "blocked";
		reason: string;
	}[];
	history:
		| { complete: true; rows: readonly RecoveryHistoryRow[] }
		| {
				complete: false;
				rows: readonly RecoveryHistoryRow[];
				operatorHelp: string;
		  };
	reviewedWeakLabels: readonly ReviewedWeakLabel[];
}
export interface RecoveryResult {
	preview: RecoveryPreview;
	groups: readonly {
		groupId: string;
		status: "confirmed" | "failed" | "unknown";
		message: string;
	}[];
}
