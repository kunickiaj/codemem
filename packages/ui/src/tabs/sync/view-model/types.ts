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
	address?: string;
	opsIn: number;
	opsOut: number;
	addressErrors: Array<{ address: string; error: string }>;
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
	summary: {
		connectedDeviceCount: number;
		seenOnTeamCount: number;
		offlineTeamDeviceCount: number;
	};
	duplicatePeople: UiDuplicatePersonCandidate[];
	attentionItems: UiSyncAttentionItem[];
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
	| "scope_mismatch";

export interface PeerScopeRejectionsSummary {
	total?: number;
	by_reason?: Partial<Record<PeerScopeRejectionReason, number>>;
	last_at?: string | null;
}

export interface PeerLike {
	peer_device_id?: string;
	name?: string;
	has_error?: boolean;
	last_error?: string;
	fingerprint?: string;
	actor_id?: string;
	status?: SyncPeerStatusLike;
	recent_ops?: PeerRecentOps;
	scope_rejections?: PeerScopeRejectionsSummary;
}

export interface DiscoveredDeviceLike {
	device_id?: string;
	display_name?: string;
	stale?: boolean;
	fingerprint?: string;
	groups?: string[];
	needs_local_approval?: boolean;
	waiting_for_peer_approval?: boolean;
}

export interface UiCoordinatorApprovalSummary {
	state: UiCoordinatorApprovalState;
	badgeLabel: string | null;
	description: string | null;
	actionLabel: string | null;
}
