/* Shared types for the Feed tab. */

/**
 * A feed item — observations and session summaries are pulled from different
 * viewer endpoints but render through the same card component. This shape
 * covers every field we read; the server adds more fields that we ignore,
 * so shapes are open and all fields optional.
 */
export interface FeedItemMetadata {
	import_metadata?: FeedItemMetadata;
	subtitle?: string;
	narrative?: string;
	facts?: unknown;
	is_summary?: boolean;
	source?: string;
	request?: string;
	visibility?: string;
	workspace_kind?: string;
	origin_source?: string;
	origin_device_id?: string;
	trust_state?: string;
	summary?: unknown;
}

export interface FeedItem {
	id?: number;
	memory_id?: number | string;
	observation_id?: number | string;
	session_id?: number | string;
	created_at?: string;
	created_at_utc?: string;
	kind?: string;
	title?: string;
	subtitle?: string;
	body_text?: string;
	narrative?: string;
	facts?: unknown;
	tags?: unknown;
	files?: unknown;
	project?: string;
	actor_id?: string;
	actor_display_name?: string;
	owned_by_self?: boolean;
	visibility?: string;
	workspace_kind?: string;
	origin_source?: string;
	origin_device_id?: string;
	trust_state?: string;
	metadata_json?: FeedItemMetadata;
	summary?: unknown;
}

/** Which view mode a feed-item body is rendering in (toggled by FeedViewToggle). */
export type ItemViewMode = "summary" | "facts" | "narrative";

/** Summary payload attached to observations / session summaries. Open shape. */
export type FeedSummary = Record<string, unknown>;
