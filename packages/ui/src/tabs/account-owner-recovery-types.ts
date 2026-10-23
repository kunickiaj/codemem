/** Noncredential UI data. Device and group identifiers must not be published. */
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
	/** Server annotation, never inferred from fingerprint equality by the UI. */
	relation: "exact_subject" | "alias" | "other";
	reason: string;
}

export interface RecoveryGroupPreview {
	groupId: string;
	action: "new" | "reuse" | "blocked";
	reason: string;
	metadata?: {
		purpose: "account_owner_target";
		recoveryReceipt: "created" | "reused";
	};
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
	groupPreviews: readonly RecoveryGroupPreview[];
	/** Optional for inert fixtures; protected API responses must supply this field. */
	reviewedWeakLabels?: readonly ReviewedWeakLabel[];
	history:
		| { complete: true; rows: readonly RecoveryHistoryRow[] }
		| { complete: false; rows: readonly RecoveryHistoryRow[]; operatorHelp: string };
}

export interface RecoveryResult {
	preview: RecoveryPreview;
	groups: readonly {
		groupId: string;
		status: "confirmed" | "failed" | "unknown";
		message: string;
	}[];
}

export interface RecoverySupportRequest {
	version: 1;
	coordinatorOrigin: string;
	coordinatorId: string;
	deviceId: string;
	fingerprint: string;
	currentMemoryAuthor: string;
	configuredGroups: readonly string[];
	chosenExistingOwnerId?: string;
}

export function sameGroups(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		new Set(left).size === left.length &&
		new Set(right).size === right.length &&
		left.every((group) => right.includes(group))
	);
}

/** Explicit projection also prevents unknown/private fields from affecting the UI key. */
export function recoveryProfileKey(profile: RecoveryProfile): string {
	return JSON.stringify([
		profile.contextId,
		profile.memoryActorId,
		profile.deviceId,
		profile.fingerprint,
		profile.coordinatorOrigin,
		profile.coordinatorId,
		[...profile.configuredGroups].sort(),
	]);
}

export function matchesRecoveryPreview(
	preview: RecoveryPreview | null,
	selection: RecoverySelection,
	requestId: string | null,
): preview is RecoveryPreview {
	if (
		!preview ||
		!requestId ||
		preview.requestId !== requestId ||
		preview.scope !== "historical_included_owner_labels_only"
	)
		return false;
	return (
		recoveryProfileKey(preview.profile) === recoveryProfileKey(selection.profile) &&
		preview.existingOwnerId === selection.existingOwnerId &&
		selection.existingOwnerId.trim().length > 0 &&
		selection.groups.length > 0 &&
		selection.groups.every((group) => selection.profile.configuredGroups.includes(group)) &&
		sameGroups(preview.groups, selection.groups) &&
		sameGroups(
			preview.groupPreviews.map((group) => group.groupId),
			selection.groups,
		)
	);
}

export function buildRecoverySupportRequest(selection: RecoverySelection): RecoverySupportRequest {
	const profile = selection.profile;
	const request: RecoverySupportRequest = {
		version: 1,
		coordinatorOrigin: profile.coordinatorOrigin,
		coordinatorId: profile.coordinatorId,
		deviceId: profile.deviceId,
		fingerprint: profile.fingerprint,
		currentMemoryAuthor: profile.memoryActorId,
		configuredGroups: [...profile.configuredGroups],
	};
	if (selection.existingOwnerId) request.chosenExistingOwnerId = selection.existingOwnerId;
	return request;
}
