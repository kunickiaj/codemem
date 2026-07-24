/* Shared types and terminology for the sync view-model. Keeping
 * SYNC_TERMINOLOGY alongside the types keeps the user-facing strings
 * and the shapes that reference them colocated. */

export const SYNC_TERMINOLOGY = {
	actor: "person",
	actors: "people",
	actorAssignment: "person assignment",
	localActor: "you",
	peer: "device",
	peers: "devices",
	pairedLocally: "Connected on this device",
	discovered: "Seen on team",
	conflicts: "Needs review",
} as const;

export type UiSyncStatus = "connected" | "available" | "needs-repair" | "offline" | "waiting";
export type UiTrustState =
	| "available"
	| "trusted-by-you"
	| "mutual-trust"
	| "needs-repairing"
	| "needs-review"
	| "offline";
export type UiCoordinatorApprovalState =
	| "none"
	| "needs-your-approval"
	| "waiting-for-other-device";

export interface SyncPeerStatusLike {
	peer_state?: string;
	sync_status?: string;
	ping_status?: string;
	fresh?: boolean;
}

export interface UiSyncRunItem {
	peer_device_id: string;
	ok: boolean;
	error?: string;
	failureCategory?: UiSyncFailureCategory;
	address?: string;
	opsIn: number;
	opsOut: number;
	opsSkipped?: number;
	skipped_out?: UiSyncSkippedOutDetail | null;
	addressErrors: Array<{ address: string; error: string }>;
	perScopeResults?: UiSyncScopeResult[];
}

export type UiSyncFailureCategory = "trust" | "scope" | "connectivity" | "other";

export interface UiSyncScopeResult {
	scope_id?: string;
	ok?: boolean;
	error?: string;
	failureCategory?: UiSyncFailureCategory;
}

export type UiSyncSkippedOutReason = "scope_filter" | "visibility_filter" | "project_filter";

export interface UiSyncSkippedOutDetail {
	reason?: UiSyncSkippedOutReason | string;
	skipped_count?: number;
	project?: string | null;
	scope_id?: string | null;
	visibility?: string | null;
}

export interface UiSyncRunResponse {
	items: UiSyncRunItem[];
}

export interface UiSyncAttentionItem {
	id: string;
	kind: "possible-duplicate-person" | "device-needs-repair" | "review-team-device" | "name-device";
	priority: number;
	title: string;
	summary: string;
	actionLabel: string;
	deviceId?: string;
	actorIds?: string[];
}

export interface UiDuplicatePersonCandidate {
	displayName: string;
	actorIds: string[];
	includesLocal: boolean;
}

export interface UiSyncViewModel {
	/** Single Project/Team directive; attentionItems remain device-level follow-ups. */
	primaryStatus: UiTeamSyncPrimaryStatus;
	summary: {
		connectedDeviceCount: number;
		seenOnTeamCount: number;
		offlineTeamDeviceCount: number;
	};
	duplicatePeople: UiDuplicatePersonCandidate[];
	attentionItems: UiSyncAttentionItem[];
}

export type UiTeamSyncPrimaryState =
	| "disabled"
	| "needs-attention"
	| "pending-setup"
	| "trust-blocked"
	| "not-enrolled"
	| "reachable"
	| "unreachable"
	| "healthy";

export interface UiTeamSyncPrimaryStatus {
	state: UiTeamSyncPrimaryState;
	badgeLabel: string;
	meta: string;
	nextAction: string | null;
}

export interface ProjectShareOperationLike {
	person?: { display_name?: string };
	projects?: Array<{ display_name?: string }>;
	lifecycle?: {
		state?: TeamSyncProjectOperationState;
		primary_action?: { kind?: TeamSyncProjectOperationActionKind } | null;
	};
}

export interface RecipientPolicyReconciliationLike {
	items?: Array<{
		canonicalProjectIdentity?: string;
		state?: TeamSyncReconciliationState;
	}>;
}

export type TeamSyncProjectOperationState =
	| "pending_setup"
	| "waiting_for_acceptance"
	| "provisioning"
	| "initial_sync"
	| "waiting_for_device"
	| "active"
	| "needs_attention"
	| "revoking"
	| "revoked"
	| "cancelled";

export type TeamSyncProjectOperationActionKind =
	| "copy_invite"
	| "retry_setup"
	| "share_again"
	| "create_new_invite";

export type TeamSyncReconciliationState =
	| "active"
	| "needs_attention"
	| "pending"
	| "verifying"
	| "waiting";

export type TeamSyncDaemonState =
	| "ok"
	| "disabled"
	| "error"
	| "stopped"
	| "stopping"
	| "starting"
	| "needs_attention"
	| "rebootstrapping"
	| "degraded"
	| "offline-peers"
	| "stale";

export type TeamSyncPresenceState = "posted" | "not_enrolled" | "unknown" | "error";

export type CoordinatorSetupBlockerReason =
	| "coordinator_groups_empty"
	| "coordinator_url_missing"
	| "sync_disabled";

export interface CoordinatorSetupBlocker {
	reason: CoordinatorSetupBlockerReason;
	message: string;
}

export interface UiPeerTrustSummary {
	state: UiTrustState;
	badgeLabel: string;
	description: string;
	isWarning: boolean;
}

export interface VisiblePeopleResult {
	visibleActors: ActorLike[];
	hiddenLocalDuplicateCount: number;
}

export interface ActorLike {
	actor_id?: string;
	display_name?: string;
	is_local?: boolean;
}

export type PeerRecentOps = {
	in?: number;
	out?: number;
};

export type PeerDirection = "bidirectional" | "publishing" | "subscribed" | "none";

export type PeerScopeRejectionReason =
	| "missing_scope"
	| "sender_not_member"
	| "receiver_not_member"
	| "stale_epoch"
	| "scope_mismatch"
	| "visibility_filter"
	| "project_filter";

export interface PeerScopeRejectionsSummary {
	total?: number;
	by_reason?: Partial<Record<PeerScopeRejectionReason, number>>;
	last_at?: string | null;
}

export interface PeerProjectScopeLike {
	include?: string[];
	exclude?: string[];
	effective_include?: string[];
	effective_exclude?: string[];
	inherits_global?: boolean;
}

export interface PeerAuthorizedScopeLike {
	scope_id?: string | null;
	label?: string | null;
	kind?: string | null;
	authority_type?: string | null;
	coordinator_id?: string | null;
	group_id?: string | null;
	role?: string | null;
	membership_epoch?: number | null;
	updated_at?: string | null;
}

export interface PeerPerScopeSyncLike {
	scope_id?: string | null;
	label?: string | null;
	authority_type?: string | null;
	membership_epoch?: number | null;
	last_applied_cursor?: string | null;
	last_acked_cursor?: string | null;
	bootstrapped?: boolean | null;
}

export interface PeerClaimedLocalActorScopeLike {
	scope_id?: string | null;
	authorized?: boolean;
	state?: string | null;
	action_required?: boolean;
}

export interface PeerLike {
	peer_device_id?: string;
	name?: string;
	discovered_via_coordinator_id?: string | null;
	discovered_via_group_id?: string | null;
	has_error?: boolean;
	last_error?: string;
	fingerprint?: string;
	actor_id?: string;
	status?: SyncPeerStatusLike;
	recent_ops?: PeerRecentOps;
	scope_rejections?: PeerScopeRejectionsSummary;
	project_scope?: PeerProjectScopeLike;
	authorized_scopes?: PeerAuthorizedScopeLike[];
	per_scope_sync?: PeerPerScopeSyncLike[];
	claimed_local_actor?: boolean;
	claimed_local_actor_scope?: PeerClaimedLocalActorScopeLike | null;
}

export interface DiscoveredDeviceLike {
	device_id?: string;
	display_name?: string;
	stale?: boolean;
	fingerprint?: string;
	groups?: string[];
	address_count?: number;
	addresses?: unknown[];
	needs_local_approval?: boolean;
	waiting_for_peer_approval?: boolean;
}

export interface UiCoordinatorApprovalSummary {
	state: UiCoordinatorApprovalState;
	badgeLabel: string | null;
	description: string | null;
	actionLabel: string | null;
}
