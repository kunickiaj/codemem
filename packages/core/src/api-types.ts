/**
 * Shared HTTP API response types for the codemem viewer endpoints.
 *
 * These types define the JSON contract between the Python viewer backend
 * (codemem/viewer_routes/) and the frontend (viewer_ui/src/lib/api.ts).
 *
 * ⚠️ These types are manually transcribed from Python viewer route handlers.
 * There is no automated schema validation between Python and TypeScript.
 * When modifying Python routes, update these types and add integration tests.
 *
 * Import existing store/entity types where shapes match.
 */

import type {
	Actor,
	MemoryItemResponse,
	PackResponse,
	ReplicationOp,
	Session,
	StoreStats,
	SyncMemorySnapshotItem,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Standard pagination envelope returned by list endpoints. */
export interface ApiPagination {
	limit: number;
	offset: number;
	next_offset: number | null;
	has_more: boolean;
}

/** Common error shape returned by all endpoints on failure. */
export interface ApiErrorResponse {
	error: string;
	detail?: string;
}

// ---------------------------------------------------------------------------
// Core viewer API responses — stats.py
// ---------------------------------------------------------------------------

/**
 * GET /api/stats
 *
 * Delegates directly to store.stats(); shape matches StoreStats.
 */
export type ApiStatsResponse = StoreStats;

/** Single usage event summary row. */
export interface ApiUsageEventSummary {
	event: string;
	total_tokens_read: number;
	total_tokens_written: number;
	total_tokens_saved: number;
	count: number;
}

/** Usage totals row. */
export interface ApiUsageTotals {
	tokens_read: number;
	tokens_written: number;
	tokens_saved: number;
	count: number;
}

/** Recent pack event row. */
export interface ApiRecentPackEvent {
	id: number;
	session_id: number | null;
	event: string;
	tokens_read: number;
	tokens_written: number;
	tokens_saved: number;
	created_at: string;
	metadata_json: Record<string, unknown> | null;
}

/**
 * GET /api/usage
 *
 * Returns usage breakdown, optionally filtered by project.
 */
export interface ApiUsageResponse {
	project: string | null;
	events: ApiUsageEventSummary[];
	totals: ApiUsageTotals;
	events_global: ApiUsageEventSummary[];
	totals_global: ApiUsageTotals;
	events_filtered: ApiUsageEventSummary[] | null;
	totals_filtered: ApiUsageTotals | null;
	recent_packs: ApiRecentPackEvent[];
}

// ---------------------------------------------------------------------------
// Core viewer API responses — memory.py
// ---------------------------------------------------------------------------

/** Extended memory item with session + ownership fields attached by the viewer. */
export interface ApiMemoryItem extends MemoryItemResponse {
	project?: string;
	cwd?: string;
	owned_by_self?: boolean;
}

/**
 * GET /api/sessions
 *
 * Returns recent sessions with parsed metadata.
 */
export interface ApiSessionsResponse {
	items: (Session & { metadata_json: Record<string, unknown> | null })[];
}

/**
 * GET /api/projects
 *
 * Returns deduplicated, sorted project names.
 */
export interface ApiProjectsResponse {
	projects: string[];
}

/**
 * GET /api/observations  (also GET /api/memories — aliased)
 * GET /api/summaries
 *
 * Paginated memory items with session/ownership fields attached.
 */
export interface ApiMemoryListResponse {
	items: ApiMemoryItem[];
	pagination: ApiPagination;
}

/**
 * GET /api/session
 *
 * Aggregate counts for a project (or global).
 */
export interface ApiSessionCountsResponse {
	total: number;
	memories: number;
	artifacts: number;
	prompts: number;
	observations: number;
}

/**
 * GET /api/pack
 *
 * Delegates directly to store.build_memory_pack(); shape matches PackResponse.
 */
export type ApiPackResponse = PackResponse;

/**
 * GET /api/memory
 *
 * Returns a list of recent memories, optionally filtered by kind/project/scope.
 */
export interface ApiMemoryResponse {
	items: ApiMemoryItem[];
}

/**
 * GET /api/artifacts
 *
 * Returns artifacts for a given session.
 */
export interface ApiArtifactsResponse {
	items: Record<string, unknown>[];
}

/**
 * POST /api/memories/visibility — request body.
 */
export interface ApiUpdateVisibilityRequest {
	memory_id: number;
	visibility: "private" | "shared";
}

/**
 * POST /api/memories/visibility — response.
 */
export interface ApiUpdateVisibilityResponse {
	item: ApiMemoryItem;
}

// ---------------------------------------------------------------------------
// Observer status — observer_status.py
// ---------------------------------------------------------------------------

/** Active observer runtime status (from observer.get_status()). */
export interface ApiObserverActiveStatus {
	provider: string | null;
	model: string | null;
	runtime: string | null;
	auth: string | null;
	last_error?: string | null;
}

/** Per-provider credential probe result. */
export interface ApiProviderCredential {
	oauth: boolean;
	api_key: boolean;
	source: string | null;
}

/** Credential availability — provider-keyed map (from probe_available_credentials()). */
export type ApiAvailableCredentials = Record<string, ApiProviderCredential>;

/** Latest flush failure with impact annotation. */
export interface ApiFlushFailure {
	id: number;
	source: string;
	stream_id: string;
	opencode_session_id: string;
	status: string;
	error_message: string | null;
	error_type: string | null;
	impact: string | null;
}

/** Queue status within observer-status. */
export interface ApiObserverQueue {
	pending: number;
	sessions: number;
	auth_backoff_active: boolean;
	auth_backoff_remaining_s: number;
}

/**
 * GET /api/observer-status
 */
export interface ApiObserverStatusResponse {
	active: ApiObserverActiveStatus | null;
	available_credentials: ApiAvailableCredentials;
	latest_failure: ApiFlushFailure | null;
	queue: ApiObserverQueue;
}

// ---------------------------------------------------------------------------
// Config — config.py
// ---------------------------------------------------------------------------

/**
 * GET /api/config
 */
export interface ApiConfigGetResponse {
	path: string;
	config: Record<string, unknown>;
	defaults: Record<string, unknown>;
	effective: Record<string, unknown>;
	env_overrides: Record<string, string>;
	providers: string[];
}

/** Manual action suggestion in config save effects. */
export interface ApiConfigManualAction {
	kind: string;
	command: string;
	label: string;
	reason: string;
}

/** Sync effect detail in config save response. */
export interface ApiConfigSyncEffect {
	affected_keys: string[];
	action: string | null;
	reason: string | null;
	attempted: boolean;
	ok: boolean | null;
	message: string | null;
	manual_action: ApiConfigManualAction | null;
}

/** Effects block in config save response. */
export interface ApiConfigEffects {
	saved_keys: string[];
	effective_keys: string[];
	hot_reloaded_keys: string[];
	live_applied_keys: string[];
	restart_required_keys: string[];
	ignored_by_env_keys: string[];
	warnings: string[];
	sync: ApiConfigSyncEffect;
	manual_actions: ApiConfigManualAction[];
}

/**
 * POST /api/config — request body.
 * Accepts a direct updates object, or wrapped as { config: {...} }.
 * Python unwraps: `updates = payload.get("config") if "config" in payload else payload`
 */
export type ApiConfigSaveRequest = Record<string, unknown>;

/**
 * POST /api/config — response.
 */
export interface ApiConfigSaveResponse {
	path: string;
	config: Record<string, unknown>;
	effective: Record<string, unknown>;
	effects: ApiConfigEffects;
}

// ---------------------------------------------------------------------------
// Raw events — raw_events.py
// ---------------------------------------------------------------------------

/**
 * Raw event session backlog item (from store.raw_event_backlog() + _with_session_aliases).
 * Fields vary by query — max_seq/pending come from the backlog query,
 * last_received_event_seq/updated_at may be absent.
 */
export interface ApiRawEventBacklogItem {
	stream_id: string;
	opencode_session_id: string;
	session_stream_id?: string;
	session_id?: string;
	cwd?: string | null;
	project?: string | null;
	started_at?: string | null;
	max_seq?: number;
	pending?: number;
	last_seen_ts_wall_ms?: number | null;
	last_received_event_seq?: number;
	last_flushed_event_seq?: number;
	updated_at?: string;
}

/** Raw event backlog totals. */
export interface ApiRawEventBacklogTotals {
	pending: number;
	sessions: number;
}

/** Ingest capability metadata. */
export interface ApiRawEventIngestInfo {
	available: boolean;
	mode: string;
	max_body_bytes: number;
}

/**
 * GET /api/raw-events
 *
 * Returns backlog totals directly (compat endpoint for stats panel).
 */
export type ApiRawEventsResponse = ApiRawEventBacklogTotals;

/**
 * GET /api/raw-events/status
 */
export interface ApiRawEventsStatusResponse {
	items: ApiRawEventBacklogItem[];
	totals: ApiRawEventBacklogTotals;
	ingest: ApiRawEventIngestInfo;
}

/**
 * POST /api/raw-events — response.
 */
export interface ApiRawEventsPostResponse {
	inserted: number;
	received: number;
}

/**
 * POST /api/claude-hooks — response.
 */
export interface ApiClaudeHooksPostResponse {
	inserted: number;
	skipped: number;
}

// ---------------------------------------------------------------------------
// Sync — sync.py
// ---------------------------------------------------------------------------

/** Project scope filter for a peer. */
export interface ApiProjectScope {
	include: string[];
	exclude: string[];
	effective_include: string[];
	effective_exclude: string[];
	inherits_global: boolean;
}

/** Peer status breakdown. */
export interface ApiPeerStatus {
	sync_status: "ok" | "error" | "stale" | "unknown";
	ping_status: "ok" | "stale" | "unknown";
	peer_state: "online" | "offline" | "degraded" | "stale" | "unknown";
	fresh: boolean;
	last_sync_at: string | null;
	last_ping_at: string | null;
}

/** Peer item in sync status/peers responses. */
export interface ApiSyncPeerItem {
	peer_device_id: string;
	name: string | null;
	fingerprint: string | null;
	pinned: boolean;
	addresses: string[];
	last_seen_at: string | null;
	last_sync_at: string | null;
	last_error: string | null;
	has_error: boolean;
	claimed_local_actor: boolean;
	actor_id: string | null;
	actor_display_name: string | null;
	project_scope: ApiProjectScope;
	status?: ApiPeerStatus;
}

/** Sync attempt item. */
/** Raw sync attempt row — returned by /api/sync/attempts. */
export interface ApiSyncAttemptItem {
	peer_device_id: string;
	ok: number;
	error: string | null;
	started_at: string;
	finished_at: string | null;
	ops_in: number;
	ops_out: number;
}

/** Enriched sync attempt — embedded in /api/sync/status with extra fields. */
export interface ApiSyncAttemptItemEnriched extends ApiSyncAttemptItem {
	status: string;
	address: string | null;
}

export interface ApiSharingReviewItem {
	peer_device_id: string;
	peer_name: string;
	actor_id: string;
	actor_display_name: string;
	project: string | null;
	scope_label: string;
	shareable_count: number;
	private_count: number;
	total_count: number;
}

export interface ApiLegacyDeviceItem {
	origin_device_id: string;
	memory_count: number;
	last_seen_at: string | null;
}

/**
 * Coordinator status snapshot (from coordinator.status_snapshot()).
 * Shape varies by state — fields are optional to cover enabled/disabled modes.
 */
export interface ApiCoordinatorStatus {
	enabled: boolean;
	configured: boolean;
	coordinator_url?: string | null;
	groups?: string[];
	group_id?: string | null;
	last_sync_at?: string | null;
	last_error?: string | null;
}

/** Join request item. */
export interface ApiJoinRequest {
	request_id: string;
	device_id: string;
	fingerprint: string;
	status: string;
}

/** Public sync daemon state enum returned by /api/sync/status. */
export type ApiSyncDaemonState =
	| "ok"
	| "disabled"
	| "error"
	| "stopped"
	| "degraded"
	| "offline-peers"
	| "stale"
	| "starting"
	| "stopping"
	| "rebootstrapping"
	| "needs_attention";

export interface ApiSyncRetentionStatus {
	enabled: boolean;
	max_age_days: number;
	max_size_mb: number;
	retained_floor_cursor: string | null;
	last_run_at?: string | null;
	last_duration_ms?: number | null;
	last_deleted_ops?: number | null;
	last_estimated_bytes_before?: number | null;
	last_estimated_bytes_after?: number | null;
	last_error?: string | null;
	last_error_at?: string | null;
}

/** Status block nested in sync status response. */
export interface ApiSyncStatusBlock {
	enabled: boolean;
	interval_s: number;
	retention: ApiSyncRetentionStatus;
	peer_count: number;
	last_sync_at: string | null;
	daemon_state: ApiSyncDaemonState;
	daemon_running: boolean;
	daemon_detail: string | null;
	project_filter_active: boolean;
	project_filter: { include: string[]; exclude: string[] };
	redacted: boolean;
	peers: Record<string, ApiPeerStatus>;
	pending: number;
	sync: Record<string, unknown>;
	ping: Record<string, unknown>;
}

/**
 * GET /api/sync/status
 */
export interface ApiSyncStatusResponse {
	/* Top-level status fields */
	enabled: boolean;
	interval_s: number;
	retention: ApiSyncRetentionStatus;
	peer_count: number;
	last_sync_at: string | null;
	daemon_state: ApiSyncDaemonState;
	daemon_running: boolean;
	daemon_detail: string | null;
	project_filter_active: boolean;
	project_filter: { include: string[]; exclude: string[] };
	redacted: boolean;
	/* Diagnostics (present when includeDiagnostics=1) */
	device_id?: string | null;
	fingerprint?: string | null;
	bind?: string;
	daemon_last_error?: string | null;
	daemon_last_error_at?: string | null;
	daemon_last_ok_at?: string | null;
	/* Nested collections */
	status: ApiSyncStatusBlock;
	peers: ApiSyncPeerItem[];
	attempts: ApiSyncAttemptItemEnriched[];
	legacy_devices: ApiLegacyDeviceItem[];
	sharing_review: ApiSharingReviewItem[];
	coordinator: ApiCoordinatorStatus;
	join_requests: ApiJoinRequest[];
}

/**
 * GET /api/sync/peers
 */
export interface ApiSyncPeersResponse {
	items: ApiSyncPeerItem[];
	redacted: boolean;
}

/**
 * GET /api/sync/actors
 */
export interface ApiSyncActorsResponse {
	items: Actor[];
}

/**
 * GET /api/sync/attempts
 */
export interface ApiSyncAttemptsResponse {
	items: ApiSyncAttemptItem[];
}

/**
 * GET /api/sync/pairing
 */
export interface ApiSyncPairingResponse {
	device_id?: string;
	fingerprint?: string;
	public_key?: string;
	pairing_filter_hint: string;
	addresses?: string[];
	redacted?: boolean;
}

// ---------------------------------------------------------------------------
// Sync mutations — request/response types
// ---------------------------------------------------------------------------

/** POST /api/sync/actors — request. */
export interface ApiCreateActorRequest {
	display_name: string;
	actor_id?: string | null;
}

/**
 * POST /api/sync/actors — response.
 *
 * Returns the full Actor row from store.create_actor().
 */
export type ApiCreateActorResponse = Actor;

/** POST /api/sync/actors/rename — request. */
export interface ApiRenameActorRequest {
	actor_id: string;
	display_name: string;
}

/**
 * POST /api/sync/actors/rename — response.
 *
 * Returns the full Actor row from store.rename_actor().
 */
export type ApiRenameActorResponse = Actor;

/** POST /api/sync/actors/merge — request. */
export interface ApiMergeActorRequest {
	primary_actor_id: string;
	secondary_actor_id: string;
}

/** POST /api/sync/actors/merge — response. */
export interface ApiMergeActorResponse {
	merged_count: number;
}

/** POST /api/sync/peers/rename — request. */
export interface ApiRenamePeerRequest {
	peer_device_id: string;
	name: string;
}

/** POST /api/sync/peers/rename — response. */
export interface ApiOkResponse {
	ok: true;
}

/** POST /api/sync/peers/scope — request. */
export interface ApiPeerScopeRequest {
	peer_device_id: string;
	include?: string[] | null;
	exclude?: string[] | null;
	inherit_global?: boolean;
}

/** POST /api/sync/peers/scope — response. */
export interface ApiPeerScopeResponse {
	ok: true;
	project_scope: ApiProjectScope;
}

/** POST /api/sync/peers/identity — request. */
export interface ApiPeerIdentityRequest {
	peer_device_id: string;
	actor_id?: string | null;
	claimed_local_actor?: boolean;
}

/** POST /api/sync/peers/identity — response. */
export interface ApiPeerIdentityResponse {
	ok: true;
	actor_id: string | null;
	claimed_local_actor: boolean;
}

/** POST /api/sync/legacy-devices/claim — request. */
export interface ApiClaimLegacyDeviceRequest {
	origin_device_id: string;
}

/** POST /api/sync/legacy-devices/claim — response. */
export interface ApiClaimLegacyDeviceResponse {
	ok: true;
	origin_device_id: string;
	updated: number;
}

/** POST /api/sync/invites/create — request. */
export interface ApiCreateInviteRequest {
	group_id: string;
	coordinator_url?: string | null;
	policy?: "auto_admit" | "approval_required";
	ttl_hours?: number;
}

/** POST /api/sync/invites/create — response. */
export interface ApiCreateInviteResponse extends ApiOkResponse {
	invite: string;
}

/** POST /api/sync/invites/import — request. */
export interface ApiImportInviteRequest {
	invite: string;
}

/** POST /api/sync/invites/import — response. */
export interface ApiImportInviteResponse extends ApiOkResponse {
	group_id: string;
}

/** POST /api/sync/join-requests/review — request. */
export interface ApiReviewJoinRequestRequest {
	request_id: string;
	action: "approve" | "deny";
}

/** POST /api/sync/join-requests/review — response. */
export interface ApiReviewJoinRequestResponse {
	ok: true;
	request: ApiJoinRequest;
}

/** DELETE /api/sync/peers/:peer_device_id — response. */
export type ApiDeletePeerResponse = ApiOkResponse;

/** POST /api/sync/actions/sync-now — request. */
export interface ApiSyncNowRequest {
	peer_device_id?: string;
	address?: string;
}

/** POST /api/sync/actions/sync-now — response. */
export interface ApiSyncNowResponse {
	items: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Peer sync protocol (/v1/*)
// ---------------------------------------------------------------------------

export interface ApiSyncOpsRequestQuery {
	since: string | null;
	limit: number;
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
}

export interface ApiSyncResetBoundary {
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
	retained_floor_cursor: string | null;
}

export interface ApiSyncOpsIncrementalResponse extends ApiSyncResetBoundary {
	reset_required: false;
	ops: ReplicationOp[];
	next_cursor: string | null;
	skipped: number;
}

export interface ApiSyncOpsResetRequiredResponse extends ApiSyncResetBoundary {
	error: "reset_required";
	reset_required: true;
	reason: "stale_cursor" | "generation_mismatch" | "boundary_mismatch";
}

export type ApiSyncOpsResponse = ApiSyncOpsIncrementalResponse | ApiSyncOpsResetRequiredResponse;

export interface ApiSyncMemorySnapshotPageRequestQuery {
	limit: number;
	page_token: string | null;
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
}

export interface ApiSyncMemorySnapshotPageResponse extends ApiSyncResetBoundary {
	items: SyncMemorySnapshotItem[];
	next_page_token: string | null;
	has_more: boolean;
}
