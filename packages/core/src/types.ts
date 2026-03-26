/**
 * TypeScript type definitions for the codemem database schema.
 *
 * These match the Python schema defined in codemem/db.py and the
 * data structures in codemem/store/types.py.
 */

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export interface Session {
	id: number;
	started_at: string;
	ended_at: string | null;
	cwd: string | null;
	project: string | null;
	git_remote: string | null;
	git_branch: string | null;
	user: string | null;
	tool_version: string | null;
	metadata_json: string | null;
	import_key: string | null;
}

export interface MemoryItem {
	id: number;
	session_id: number;
	kind: string;
	title: string;
	subtitle: string | null;
	body_text: string;
	confidence: number;
	tags_text: string;
	active: number; // 0 or 1
	created_at: string;
	updated_at: string;
	metadata_json: string | null;
	// Identity / multi-actor fields
	actor_id: string | null;
	actor_display_name: string | null;
	visibility: string | null;
	workspace_id: string | null;
	workspace_kind: string | null;
	origin_device_id: string | null;
	origin_source: string | null;
	trust_state: string | null;
	// Structured content fields
	facts: string | null;
	narrative: string | null;
	concepts: string | null;
	files_read: string | null;
	files_modified: string | null;
	// Linkage
	user_prompt_id: number | null;
	prompt_number: number | null;
	import_key: string | null;
	// Soft delete + replication
	deleted_at: string | null;
	rev: number;
}

export interface Artifact {
	id: number;
	session_id: number;
	kind: string;
	path: string | null;
	content_text: string | null;
	content_hash: string | null;
	content_encoding: string | null;
	content_blob: Buffer | null;
	created_at: string;
	metadata_json: string | null;
}

// ---------------------------------------------------------------------------
// Usage tracking
// ---------------------------------------------------------------------------

export interface UsageEvent {
	id: number;
	session_id: number | null;
	event: string;
	tokens_read: number;
	tokens_written: number;
	tokens_saved: number;
	created_at: string;
	metadata_json: string | null;
}

// ---------------------------------------------------------------------------
// Raw event pipeline
// ---------------------------------------------------------------------------

export interface RawEvent {
	id: number;
	source: string;
	stream_id: string;
	opencode_session_id: string;
	event_id: string | null;
	event_seq: number;
	event_type: string;
	/** Wall-clock timestamp in ms. SQLite INTEGER. */
	ts_wall_ms: number | null;
	/** Monotonic timestamp in ms. SQLite REAL (may have fractional part). */
	ts_mono_ms: number | null;
	payload_json: string;
	created_at: string;
}

export interface RawEventSession {
	source: string;
	stream_id: string;
	opencode_session_id: string;
	cwd: string | null;
	project: string | null;
	started_at: string | null;
	last_seen_ts_wall_ms: number | null;
	last_received_event_seq: number;
	last_flushed_event_seq: number;
	updated_at: string;
}

export interface RawEventFlushBatch {
	id: number;
	source: string;
	stream_id: string;
	opencode_session_id: string;
	start_event_seq: number;
	end_event_seq: number;
	extractor_version: string;
	status: string;
	error_message: string | null;
	error_type: string | null;
	observer_provider: string | null;
	observer_model: string | null;
	observer_runtime: string | null;
	attempt_count: number;
	created_at: string;
	updated_at: string;
}

export interface UserPrompt {
	id: number;
	session_id: number | null;
	project: string | null;
	prompt_text: string;
	prompt_number: number | null;
	created_at: string;
	created_at_epoch: number;
	metadata_json: string | null;
	import_key: string | null;
}

export interface SessionSummary {
	id: number;
	session_id: number | null;
	project: string | null;
	request: string | null;
	investigated: string | null;
	learned: string | null;
	completed: string | null;
	next_steps: string | null;
	notes: string | null;
	files_read: string | null;
	files_edited: string | null;
	prompt_number: number | null;
	created_at: string;
	created_at_epoch: number;
	metadata_json: string | null;
	import_key: string | null;
}

export interface OpenCodeSession {
	source: string;
	stream_id: string;
	opencode_session_id: string;
	session_id: number | null;
	created_at: string;
}

export interface RawEventIngestStats {
	id: number; // always 1 (single-row table)
	inserted_events: number;
	skipped_events: number;
	skipped_invalid: number;
	skipped_duplicate: number;
	skipped_conflict: number;
	updated_at: string;
}

export interface RawEventIngestSample {
	id: number;
	created_at: string;
	inserted_events: number;
	skipped_invalid: number;
	skipped_duplicate: number;
	skipped_conflict: number;
}

// ---------------------------------------------------------------------------
// Sync / replication
// ---------------------------------------------------------------------------

export interface ReplicationOp {
	op_id: string;
	entity_type: string;
	entity_id: string;
	op_type: string;
	payload_json: string | null;
	clock_rev: number;
	clock_updated_at: string;
	clock_device_id: string;
	device_id: string;
	created_at: string;
}

export interface ReplicationClock {
	rev: number;
	updated_at: string;
	device_id: string;
}

export interface ReplicationCursor {
	peer_device_id: string;
	last_applied_cursor: string | null;
	last_acked_cursor: string | null;
	updated_at: string;
}

export interface SyncPeer {
	peer_device_id: string;
	name: string | null;
	pinned_fingerprint: string | null;
	public_key: string | null;
	addresses_json: string | null;
	claimed_local_actor: number;
	actor_id: string | null;
	projects_include_json: string | null;
	projects_exclude_json: string | null;
	created_at: string;
	last_seen_at: string | null;
	last_sync_at: string | null;
	last_error: string | null;
}

export interface SyncNonce {
	nonce: string;
	device_id: string;
	created_at: string;
}

export interface SyncDevice {
	device_id: string;
	public_key: string;
	fingerprint: string;
	created_at: string;
}

export interface SyncDaemonState {
	id: number; // always 1 (single-row table)
	last_error: string | null;
	last_traceback: string | null;
	last_error_at: string | null;
	last_ok_at: string | null;
}

export interface SyncResetState {
	id: number;
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
	retained_floor_cursor: string | null;
	updated_at: string;
}

export interface SyncResetBoundary {
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
	retained_floor_cursor: string | null;
}

export interface SyncResetRequired extends SyncResetBoundary {
	reset_required: true;
	reason: "stale_cursor" | "generation_mismatch" | "boundary_mismatch";
}

export interface SyncDirtyLocalState {
	dirty: boolean;
	count: number;
}

export interface SyncMemorySnapshotItem {
	entity_id: string;
	op_type: "upsert" | "delete";
	payload_json: string;
	clock_rev: number;
	clock_updated_at: string;
	clock_device_id: string;
}

export interface ReplicationOpsPruneResult {
	deleted: number;
	retained_floor_cursor: string | null;
	estimated_bytes_before?: number;
	estimated_bytes_after?: number;
}

export interface SyncAttempt {
	id: number;
	peer_device_id: string;
	started_at: string;
	finished_at: string | null;
	ok: number;
	ops_in: number;
	ops_out: number;
	error: string | null;
}

export interface Actor {
	actor_id: string;
	display_name: string;
	is_local: number;
	status: string;
	merged_into_actor_id: string | null;
	created_at: string;
	updated_at: string;
}

// ---------------------------------------------------------------------------
// Response types (parsed from DB rows)
// ---------------------------------------------------------------------------

/**
 * MemoryItem with metadata_json parsed to an object.
 * Returned by store.get(), store.recent(), updateMemoryVisibility(), etc.
 */
export interface MemoryItemResponse extends Omit<MemoryItem, "metadata_json"> {
	metadata_json: Record<string, unknown>;
}

/**
 * MemoryItemResponse with linked_prompt for timeline results.
 * linked_prompt will be populated once _attach_prompt_links is ported.
 */
export interface TimelineItemResponse extends MemoryItemResponse {
	linked_prompt: null;
}

/** Stats response from store.stats() */
export interface UsageEventRow {
	event: string;
	count: number;
	tokens_read: number;
	tokens_written: number;
	tokens_saved: number;
}

export interface StoreStats {
	identity: {
		device_id: string;
		actor_id: string;
		actor_display_name: string;
	};
	database: {
		path: string;
		size_bytes: number;
		sessions: number;
		memory_items: number;
		active_memory_items: number;
		artifacts: number;
		vector_rows: number;
		vector_coverage: number;
		tags_filled: number;
		tags_coverage: number;
		raw_events: number;
	};
	usage: {
		events: UsageEventRow[];
		totals: {
			events: number;
			tokens_read: number;
			tokens_written: number;
			tokens_saved: number;
		};
	};
}

/** Score breakdown in explain results */
export interface ExplainScoreComponents {
	base: number | null;
	recency: number;
	kind_bonus: number;
	personal_bias: number;
	semantic_boost: number | null;
}

/** Single item in explain results */
export interface ExplainItem {
	id: number;
	kind: string;
	title: string;
	created_at: string;
	project: string | null;
	retrieval: {
		source: string;
		rank: number | null;
	};
	score: {
		total: number | null;
		components: ExplainScoreComponents;
	};
	matches: {
		query_terms: string[];
		project_match: boolean | null;
	};
	pack_context: {
		included: boolean | null;
		section: string | null;
	} | null;
}

/** Explain response */
export interface ExplainResponse {
	items: ExplainItem[];
	missing_ids: number[];
	errors: ExplainError[];
	metadata: {
		query: string | null;
		project: string | null;
		requested_ids_count: number;
		returned_items_count: number;
		include_pack_context: boolean;
	};
}

export interface ExplainError {
	code: string;
	field: string;
	message: string;
	ids?: (string | number)[];
}

/** Single item in pack results */
export interface PackItem {
	id: number;
	kind: string;
	title: string;
	body: string;
	confidence: number;
	tags: string;
	metadata: Record<string, unknown>;
	/** Number of exact duplicates collapsed into this item. Only present when > 1. */
	support_count?: number;
	/** IDs of duplicates that were collapsed into this canonical item. Only present when non-empty. */
	duplicate_ids?: number[];
}

/** Pack response from buildMemoryPack() */
export interface PackResponse {
	context: string;
	items: PackItem[];
	item_ids: number[];
	pack_text: string;
	metrics: {
		total_items: number;
		pack_tokens: number;
		fallback_used: boolean;
		fallback: "recent" | null;
		limit: number;
		token_budget: number | null;
		project: string | null;
		pack_item_ids: number[];
		mode: "default" | "task" | "recall";
		added_ids: number[];
		removed_ids: number[];
		retained_ids: number[];
		pack_token_delta: number;
		pack_delta_available: boolean;
		work_tokens: number;
		work_tokens_unique: number;
		tokens_saved: number;
		compression_ratio: number | null;
		overhead_tokens: number | null;
		avoided_work_tokens: number;
		avoided_work_saved: number;
		avoided_work_ratio: number | null;
		avoided_work_known_items: number;
		avoided_work_unknown_items: number;
		avoided_work_sources: Record<string, number>;
		work_source: "estimate" | "usage" | "mixed";
		work_usage_items: number;
		work_estimate_items: number;
		savings_reliable: boolean;
		sources: { fts: number; semantic: number; fuzzy: number };
	};
}

// ---------------------------------------------------------------------------
// Search result (returned by store.search())
// ---------------------------------------------------------------------------

export interface MemoryResult {
	id: number;
	kind: string;
	title: string;
	body_text: string;
	confidence: number;
	created_at: string;
	updated_at: string;
	tags_text: string;
	score: number;
	session_id: number;
	metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Filter types (used by search, recent, etc.)
// ---------------------------------------------------------------------------

export interface MemoryFilters {
	kind?: string;
	session_id?: number;
	since?: string;
	working_set_paths?: string[];
	/** Project scope — matches sessions.project. Triggers session JOIN. */
	project?: string;
	visibility?: string | string[];
	include_visibility?: string[];
	exclude_visibility?: string[];
	include_workspace_ids?: string[];
	exclude_workspace_ids?: string[];
	include_workspace_kinds?: string[];
	exclude_workspace_kinds?: string[];
	include_actor_ids?: string[];
	exclude_actor_ids?: string[];
	include_trust_states?: string[];
	exclude_trust_states?: string[];
	ownership_scope?: "mine" | "theirs" | string;
	personal_first?: boolean | string;
	trust_bias?: "off" | "soft" | string;
	widen_shared_when_weak?: boolean | string;
	widen_shared_min_personal_results?: number;
	widen_shared_min_personal_score?: number;
}
