/* Global application state — shared across tabs. */

import type { UiSyncViewModel } from "../tabs/sync/view-model";

export type RefreshState = "idle" | "refreshing" | "paused" | "error";
export type TabId = "feed" | "health" | "sync" | "coordinator-admin";
export const ALL_TAB_IDS: TabId[] = ["feed", "health", "sync", "coordinator-admin"];

/* ── Cached server payload shapes ─────────────────────────── */

/**
 * Minimal interfaces covering the fields UI code actually reads from the
 * viewer API responses that get cached in `state`. All fields are optional
 * and shapes are open (additional fields from the server are just ignored).
 * When the UI starts reading a new field, add it here.
 */

export interface UsageTotals {
	tokens_read?: number;
	tokens_saved?: number;
	work_investment_tokens?: number;
}

export interface RecentPack {
	created_at?: string;
	tokens_read?: number;
	tokens_saved?: number;
	metadata_json?: {
		exact_duplicates_collapsed?: number;
		exact_dedupe_enabled?: boolean;
	};
}

export interface CachedStatsPayload {
	identity?: { actor_id?: string };
	database?: {
		path?: string;
		size_bytes?: number;
		active_memory_items?: number;
		vector_coverage?: number;
		tags_coverage?: number;
	};
	usage?: { totals?: UsageTotals };
	reliability?: {
		counts?: { errored_batches?: number };
		rates?: {
			flush_success_rate?: number;
			dropped_event_rate?: number;
		};
	};
	maintenance_jobs?: unknown[];
}

export interface CachedUsagePayload {
	totals_global?: UsageTotals;
	totals?: UsageTotals;
	totals_filtered?: UsageTotals | null;
	events?: unknown[];
	recent_packs?: RecentPack[];
}

export interface CachedRawEventsPayload {
	pending?: number;
	sessions?: number;
	events?: unknown;
}

export interface CachedSyncStatus {
	daemon_state?: string;
	enabled?: boolean;
	last_sync_at?: string;
	last_sync_at_utc?: string;
	presence_status?: string;
	attentionItems?: unknown[];
	summary?: unknown;
	discovered_devices?: unknown[];
	paired_peer_count?: number;
}

export interface SyncActor {
	actor_id?: string;
	display_name?: string;
	actor_display_name?: string;
	is_local?: boolean;
}

export interface SyncPeerStatus {
	peer_state?: string;
	sync_status?: string;
	ping_status?: string;
	fresh?: boolean;
}

export interface SyncPeer {
	peer_device_id?: string;
	peer_name?: string;
	name?: string;
	display_name?: string;
	actor_id?: string;
	fingerprint?: string;
	addresses?: unknown[];
	claimed_local_actor?: boolean;
	private_count?: number;
	shareable_count?: number;
	scope_label?: string;
	status?: SyncPeerStatus;
	last_error?: string;
}

export interface SyncSharingReviewRow {
	actor_display_name?: string;
	actor_id?: string;
	peer_name?: string;
	peer_device_id?: string;
	private_count?: number;
	scope_label?: string;
	shareable_count?: number;
}

export interface DiscoveredDevice {
	device_id?: string;
	display_name?: string;
	fingerprint?: string;
	groups?: string[];
	stale?: boolean;
	addresses?: string[];
	needs_local_approval?: boolean;
	waiting_for_peer_approval?: boolean;
}

export interface CachedSyncCoordinator {
	configured?: boolean;
	groups?: unknown[];
	coordinator_url?: string;
	discovered_devices?: DiscoveredDevice[];
	presence_status?: string;
	paired_peer_count?: number;
}

export interface CachedCoordinatorAdminStatus {
	readiness?: "not_configured" | "partial" | "ready";
	coordinator_url?: string | null;
	groups?: string[];
	active_group?: string | null;
	has_admin_secret?: boolean;
	has_groups?: boolean;
}

export interface CachedCoordinatorAdminDevice {
	device_id?: string;
	group_id?: string;
	display_name?: string | null;
	enabled?: number | boolean;
	fingerprint?: string;
}

export interface CachedCoordinatorAdminGroup {
	group_id?: string;
	display_name?: string | null;
	archived_at?: string | null;
	created_at?: string;
}

export interface CachedTeamInvite {
	encoded?: string;
	warnings?: string[];
}

export interface CachedTeamJoin {
	status?: string;
}

export interface CachedPairingPayload {
	name?: string;
}

export interface CachedSyncJoinRequest {
	display_name?: string;
	device_id?: string;
	request_id?: string;
}

const TAB_KEY = "codemem-tab";
const FEED_FILTER_KEY = "codemem-feed-filter";
const FEED_SCOPE_KEY = "codemem-feed-scope";
const DETAILS_OPEN_KEY = "codemem-details-open";
const SYNC_DIAGNOSTICS_KEY = "codemem-sync-diagnostics";
const SYNC_PAIRING_KEY = "codemem-sync-pairing";
const SYNC_REDACT_KEY = "codemem-sync-redact";

export const FEED_FILTERS = ["all", "observations", "summaries"] as const;
export type FeedFilter = (typeof FEED_FILTERS)[number];
export const FEED_SCOPES = ["all", "mine", "theirs"] as const;
export type FeedScope = (typeof FEED_SCOPES)[number];

/* ── Mutable application state ─────────────────────────────── */

export const state = {
	/* Tab */
	activeTab: "feed" as TabId,

	/* Project filter */
	currentProject: "",

	/* Refresh */
	refreshState: "idle" as RefreshState,
	refreshInFlight: false,
	refreshQueued: false,
	refreshTimer: null as ReturnType<typeof setInterval> | null,

	/* Feed */
	feedTypeFilter: "all" as FeedFilter,
	feedScopeFilter: "all" as FeedScope,
	feedQuery: "",
	lastFeedItems: [] as unknown[],
	lastFeedFilteredCount: 0,
	lastFeedSignature: "",
	pendingFeedItems: null as unknown[] | null,

	/* Feed item view state */
	itemViewState: new Map<string, string>(),
	itemExpandState: new Map<string, boolean>(),
	newItemKeys: new Set<string>(),

	/* Cached payloads */
	lastStatsPayload: null as CachedStatsPayload | null,
	lastUsagePayload: null as CachedUsagePayload | null,
	lastRawEventsPayload: null as CachedRawEventsPayload | null,
	lastSyncStatus: null as CachedSyncStatus | null,
	lastSyncActors: [] as SyncActor[],
	lastSyncPeers: [] as SyncPeer[],
	pendingAcceptedSyncPeers: [] as SyncPeer[],
	lastSyncSharingReview: [] as SyncSharingReviewRow[],
	lastSyncCoordinator: null as CachedSyncCoordinator | null,
	lastCoordinatorAdminStatus: null as CachedCoordinatorAdminStatus | null,
	coordinatorAdminTargetGroup: "",
	lastCoordinatorAdminGroups: [] as CachedCoordinatorAdminGroup[],
	lastCoordinatorAdminJoinRequests: [] as CachedSyncJoinRequest[],
	lastCoordinatorAdminDevices: [] as CachedCoordinatorAdminDevice[],
	lastSyncJoinRequests: [] as CachedSyncJoinRequest[],
	lastTeamInvite: null as CachedTeamInvite | null,
	lastTeamJoin: null as CachedTeamJoin | null,
	syncJoinFlowFeedback: null as { message: string; tone: "success" | "warning" } | null,
	syncPeerFeedbackById: new Map<string, { message: string; tone: "success" | "warning" }>(),
	syncPeersSectionFeedback: null as { message: string; tone: "success" | "warning" } | null,
	syncJoinRequestsFeedback: null as { message: string; tone: "success" | "warning" } | null,
	syncDiscoveredFeedback: null as { message: string; tone: "success" | "warning" } | null,
	lastSyncAttempts: [] as unknown[],
	lastSyncLegacyDevices: [] as unknown[],
	lastSyncViewModel: null as UiSyncViewModel | null,
	lastSyncDuplicatePersonDecisions: {} as Record<string, string>,
	pairingPayloadRaw: null as CachedPairingPayload | null,
	pairingCommandRaw: "",

	/* Config */
	configDefaults: {} as Record<string, unknown>,
	configPath: "",
	settingsDirty: false,
	noticeTimer: null as ReturnType<typeof setTimeout> | null,

	/* Sync UI toggles */
	syncDiagnosticsOpen: false,
	syncPairingOpen: false,
};

export function shouldShowCoordinatorAdminTab(
	status: CachedCoordinatorAdminStatus | null | undefined,
): boolean {
	if (!status) return true;
	return status.has_admin_secret === true;
}

export function getVisibleTabs(status: CachedCoordinatorAdminStatus | null | undefined): TabId[] {
	return shouldShowCoordinatorAdminTab(status)
		? [...ALL_TAB_IDS]
		: ALL_TAB_IDS.filter((tabId) => tabId !== "coordinator-admin");
}

export function resolveAccessibleTab(
	tab: TabId,
	status: CachedCoordinatorAdminStatus | null | undefined,
): TabId {
	return getVisibleTabs(status).includes(tab) ? tab : "sync";
}

/* ── Persistence helpers ───────────────────────────────────── */

export function getActiveTab(): TabId {
	const hash = window.location.hash.replace("#", "") as TabId;
	if (ALL_TAB_IDS.includes(hash))
		return resolveAccessibleTab(hash, state.lastCoordinatorAdminStatus);
	const saved = localStorage.getItem(TAB_KEY);
	if (saved && ALL_TAB_IDS.includes(saved as TabId)) {
		return resolveAccessibleTab(saved as TabId, state.lastCoordinatorAdminStatus);
	}
	return "feed";
}

export function setActiveTab(tab: TabId) {
	const nextTab = resolveAccessibleTab(tab, state.lastCoordinatorAdminStatus);
	state.activeTab = nextTab;
	window.location.hash = nextTab;
	localStorage.setItem(TAB_KEY, nextTab);
}

export function getFeedTypeFilter(): FeedFilter {
	const saved = localStorage.getItem(FEED_FILTER_KEY) || "all";
	return FEED_FILTERS.includes(saved as FeedFilter) ? (saved as FeedFilter) : "all";
}

export function getFeedScopeFilter(): FeedScope {
	const saved = localStorage.getItem(FEED_SCOPE_KEY) || "all";
	return FEED_SCOPES.includes(saved as FeedScope) ? (saved as FeedScope) : "all";
}

export function setFeedTypeFilter(value: string) {
	state.feedTypeFilter = FEED_FILTERS.includes(value as FeedFilter) ? (value as FeedFilter) : "all";
	localStorage.setItem(FEED_FILTER_KEY, state.feedTypeFilter);
}

export function setFeedScopeFilter(value: string) {
	state.feedScopeFilter = FEED_SCOPES.includes(value as FeedScope) ? (value as FeedScope) : "all";
	localStorage.setItem(FEED_SCOPE_KEY, state.feedScopeFilter);
}

export function isSyncDiagnosticsOpen(): boolean {
	return localStorage.getItem(SYNC_DIAGNOSTICS_KEY) === "1";
}

export function setSyncDiagnosticsOpen(open: boolean) {
	state.syncDiagnosticsOpen = open;
	localStorage.setItem(SYNC_DIAGNOSTICS_KEY, open ? "1" : "0");
}

export function isSyncPairingOpen(): boolean {
	return state.syncPairingOpen;
}

export function setSyncPairingOpen(open: boolean) {
	state.syncPairingOpen = open;
	try {
		localStorage.setItem(SYNC_PAIRING_KEY, open ? "1" : "0");
	} catch {}
}

export function isSyncRedactionEnabled(): boolean {
	return localStorage.getItem(SYNC_REDACT_KEY) !== "0";
}

export function setSyncRedactionEnabled(enabled: boolean) {
	localStorage.setItem(SYNC_REDACT_KEY, enabled ? "1" : "0");
}

export function isDetailsOpen(): boolean {
	return localStorage.getItem(DETAILS_OPEN_KEY) === "1";
}

export function setDetailsOpen(open: boolean) {
	localStorage.setItem(DETAILS_OPEN_KEY, open ? "1" : "0");
}

/* ── Init from storage ─────────────────────────────────────── */

export function initState() {
	state.activeTab = getActiveTab();
	state.feedTypeFilter = getFeedTypeFilter();
	state.feedScopeFilter = getFeedScopeFilter();
	state.syncDiagnosticsOpen = isSyncDiagnosticsOpen();
	try {
		state.syncPairingOpen = localStorage.getItem(SYNC_PAIRING_KEY) === "1";
	} catch {
		state.syncPairingOpen = false;
	}
}
