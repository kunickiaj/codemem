/**
 * Drizzle ORM schema for the codemem SQLite database.
 */

import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
	id: integer("id").primaryKey(),
	started_at: text("started_at").notNull(),
	ended_at: text("ended_at"),
	cwd: text("cwd"),
	project: text("project"),
	git_remote: text("git_remote"),
	git_branch: text("git_branch"),
	user: text("user"),
	tool_version: text("tool_version"),
	metadata_json: text("metadata_json"),
	import_key: text("import_key"),
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export const artifacts = sqliteTable(
	"artifacts",
	{
		id: integer("id").primaryKey(),
		session_id: integer("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(),
		path: text("path"),
		content_text: text("content_text"),
		content_hash: text("content_hash"),
		created_at: text("created_at").notNull(),
		metadata_json: text("metadata_json"),
	},
	(table) => [index("idx_artifacts_session_kind").on(table.session_id, table.kind)],
);

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;

export const memoryItems = sqliteTable(
	"memory_items",
	{
		id: integer("id").primaryKey(),
		session_id: integer("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(),
		title: text("title").notNull(),
		subtitle: text("subtitle"),
		body_text: text("body_text").notNull(),
		confidence: real("confidence").default(0.5),
		tags_text: text("tags_text").default(""),
		active: integer("active").default(1),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
		metadata_json: text("metadata_json"),
		actor_id: text("actor_id"),
		actor_display_name: text("actor_display_name"),
		visibility: text("visibility"),
		workspace_id: text("workspace_id"),
		workspace_kind: text("workspace_kind"),
		origin_device_id: text("origin_device_id"),
		origin_source: text("origin_source"),
		trust_state: text("trust_state"),
		facts: text("facts"),
		narrative: text("narrative"),
		concepts: text("concepts"),
		files_read: text("files_read"),
		files_modified: text("files_modified"),
		user_prompt_id: integer("user_prompt_id"),
		prompt_number: integer("prompt_number"),
		deleted_at: text("deleted_at"),
		rev: integer("rev").default(0),
		import_key: text("import_key"),
	},
	(table) => [
		index("idx_memory_items_active_created").on(table.active, table.created_at),
		index("idx_memory_items_session").on(table.session_id),
	],
);

export type MemoryItem = typeof memoryItems.$inferSelect;
export type NewMemoryItem = typeof memoryItems.$inferInsert;

export const usageEvents = sqliteTable(
	"usage_events",
	{
		id: integer("id").primaryKey(),
		session_id: integer("session_id").references(() => sessions.id, {
			onDelete: "set null",
		}),
		event: text("event").notNull(),
		tokens_read: integer("tokens_read").default(0),
		tokens_written: integer("tokens_written").default(0),
		tokens_saved: integer("tokens_saved").default(0),
		created_at: text("created_at").notNull(),
		metadata_json: text("metadata_json"),
	},
	(table) => [
		index("idx_usage_events_event_created").on(table.event, table.created_at),
		index("idx_usage_events_session").on(table.session_id),
	],
);

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;

export const maintenanceJobs = sqliteTable(
	"maintenance_jobs",
	{
		kind: text("kind").primaryKey(),
		title: text("title").notNull(),
		status: text("status").notNull(),
		message: text("message"),
		progress_current: integer("progress_current").notNull().default(0),
		progress_total: integer("progress_total"),
		progress_unit: text("progress_unit").notNull().default("items"),
		metadata_json: text("metadata_json"),
		started_at: text("started_at"),
		updated_at: text("updated_at").notNull(),
		finished_at: text("finished_at"),
		error: text("error"),
	},
	(table) => [index("idx_maintenance_jobs_status_updated").on(table.status, table.updated_at)],
);

export type MaintenanceJob = typeof maintenanceJobs.$inferSelect;
export type NewMaintenanceJob = typeof maintenanceJobs.$inferInsert;

export const rawEvents = sqliteTable(
	"raw_events",
	{
		id: integer("id").primaryKey(),
		source: text("source").notNull().default("opencode"),
		stream_id: text("stream_id").notNull().default(""),
		opencode_session_id: text("opencode_session_id").notNull(),
		event_id: text("event_id"),
		event_seq: integer("event_seq").notNull(),
		event_type: text("event_type").notNull(),
		ts_wall_ms: integer("ts_wall_ms"),
		ts_mono_ms: real("ts_mono_ms"),
		payload_json: text("payload_json").notNull(),
		created_at: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_raw_events_source_stream_seq").on(
			table.source,
			table.stream_id,
			table.event_seq,
		),
		uniqueIndex("idx_raw_events_source_stream_event_id").on(
			table.source,
			table.stream_id,
			table.event_id,
		),
		index("idx_raw_events_session_seq").on(table.opencode_session_id, table.event_seq),
		index("idx_raw_events_created").on(table.created_at),
	],
);

export type RawEvent = typeof rawEvents.$inferSelect;
export type NewRawEvent = typeof rawEvents.$inferInsert;

export const rawEventSessions = sqliteTable(
	"raw_event_sessions",
	{
		source: text("source").notNull().default("opencode"),
		stream_id: text("stream_id").notNull().default(""),
		opencode_session_id: text("opencode_session_id").notNull(),
		cwd: text("cwd"),
		project: text("project"),
		started_at: text("started_at"),
		last_seen_ts_wall_ms: integer("last_seen_ts_wall_ms"),
		last_received_event_seq: integer("last_received_event_seq").notNull().default(-1),
		last_flushed_event_seq: integer("last_flushed_event_seq").notNull().default(-1),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.source, table.stream_id] })],
);

export type RawEventSession = typeof rawEventSessions.$inferSelect;
export type NewRawEventSession = typeof rawEventSessions.$inferInsert;

export const opencodeSessions = sqliteTable(
	"opencode_sessions",
	{
		source: text("source").notNull().default("opencode"),
		stream_id: text("stream_id").notNull().default(""),
		opencode_session_id: text("opencode_session_id").notNull(),
		session_id: integer("session_id").references(() => sessions.id, {
			onDelete: "cascade",
		}),
		created_at: text("created_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.source, table.stream_id] }),
		index("idx_opencode_sessions_session").on(table.session_id),
	],
);

export type OpencodeSession = typeof opencodeSessions.$inferSelect;
export type NewOpencodeSession = typeof opencodeSessions.$inferInsert;

export const rawEventFlushBatches = sqliteTable(
	"raw_event_flush_batches",
	{
		id: integer("id").primaryKey(),
		source: text("source").notNull().default("opencode"),
		stream_id: text("stream_id").notNull().default(""),
		opencode_session_id: text("opencode_session_id").notNull(),
		start_event_seq: integer("start_event_seq").notNull(),
		end_event_seq: integer("end_event_seq").notNull(),
		extractor_version: text("extractor_version").notNull(),
		status: text("status").notNull(),
		error_message: text("error_message"),
		error_type: text("error_type"),
		observer_provider: text("observer_provider"),
		observer_model: text("observer_model"),
		observer_runtime: text("observer_runtime"),
		observer_auth_source: text("observer_auth_source"),
		observer_auth_type: text("observer_auth_type"),
		observer_error_code: text("observer_error_code"),
		observer_error_message: text("observer_error_message"),
		attempt_count: integer("attempt_count").notNull().default(0),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_flush_batches_source_stream_seq_ver").on(
			table.source,
			table.stream_id,
			table.start_event_seq,
			table.end_event_seq,
			table.extractor_version,
		),
		index("idx_flush_batches_session_created").on(table.opencode_session_id, table.created_at),
		index("idx_flush_batches_status_updated").on(table.status, table.updated_at),
	],
);

export type RawEventFlushBatch = typeof rawEventFlushBatches.$inferSelect;
export type NewRawEventFlushBatch = typeof rawEventFlushBatches.$inferInsert;

export const userPrompts = sqliteTable(
	"user_prompts",
	{
		id: integer("id").primaryKey(),
		session_id: integer("session_id").references(() => sessions.id, {
			onDelete: "cascade",
		}),
		project: text("project"),
		prompt_text: text("prompt_text").notNull(),
		prompt_number: integer("prompt_number"),
		created_at: text("created_at").notNull(),
		created_at_epoch: integer("created_at_epoch").notNull(),
		metadata_json: text("metadata_json"),
		import_key: text("import_key"),
	},
	(table) => [
		index("idx_user_prompts_session").on(table.session_id),
		index("idx_user_prompts_project").on(table.project),
		index("idx_user_prompts_epoch").on(table.created_at_epoch),
	],
);

export type UserPrompt = typeof userPrompts.$inferSelect;
export type NewUserPrompt = typeof userPrompts.$inferInsert;

export const sessionSummaries = sqliteTable(
	"session_summaries",
	{
		id: integer("id").primaryKey(),
		session_id: integer("session_id").references(() => sessions.id, {
			onDelete: "cascade",
		}),
		project: text("project"),
		request: text("request"),
		investigated: text("investigated"),
		learned: text("learned"),
		completed: text("completed"),
		next_steps: text("next_steps"),
		notes: text("notes"),
		files_read: text("files_read"),
		files_edited: text("files_edited"),
		prompt_number: integer("prompt_number"),
		created_at: text("created_at").notNull(),
		created_at_epoch: integer("created_at_epoch").notNull(),
		metadata_json: text("metadata_json"),
		import_key: text("import_key"),
	},
	(table) => [
		index("idx_session_summaries_session").on(table.session_id),
		index("idx_session_summaries_project").on(table.project),
		index("idx_session_summaries_epoch").on(table.created_at_epoch),
	],
);

export type SessionSummary = typeof sessionSummaries.$inferSelect;
export type NewSessionSummary = typeof sessionSummaries.$inferInsert;

export const replicationOps = sqliteTable(
	"replication_ops",
	{
		op_id: text("op_id").primaryKey(),
		entity_type: text("entity_type").notNull(),
		entity_id: text("entity_id").notNull(),
		op_type: text("op_type").notNull(),
		payload_json: text("payload_json"),
		clock_rev: integer("clock_rev").notNull(),
		clock_updated_at: text("clock_updated_at").notNull(),
		clock_device_id: text("clock_device_id").notNull(),
		device_id: text("device_id").notNull(),
		created_at: text("created_at").notNull(),
	},
	(table) => [
		index("idx_replication_ops_created").on(table.created_at, table.op_id),
		index("idx_replication_ops_entity").on(table.entity_type, table.entity_id),
	],
);

export type ReplicationOp = typeof replicationOps.$inferSelect;
export type NewReplicationOp = typeof replicationOps.$inferInsert;

export const replicationCursors = sqliteTable("replication_cursors", {
	peer_device_id: text("peer_device_id").primaryKey(),
	last_applied_cursor: text("last_applied_cursor"),
	last_acked_cursor: text("last_acked_cursor"),
	updated_at: text("updated_at").notNull(),
});

export type ReplicationCursor = typeof replicationCursors.$inferSelect;
export type NewReplicationCursor = typeof replicationCursors.$inferInsert;

export const syncPeers = sqliteTable("sync_peers", {
	peer_device_id: text("peer_device_id").primaryKey(),
	name: text("name"),
	pinned_fingerprint: text("pinned_fingerprint"),
	public_key: text("public_key"),
	addresses_json: text("addresses_json"),
	claimed_local_actor: integer("claimed_local_actor").notNull().default(0),
	actor_id: text("actor_id"),
	projects_include_json: text("projects_include_json"),
	projects_exclude_json: text("projects_exclude_json"),
	created_at: text("created_at").notNull(),
	last_seen_at: text("last_seen_at"),
	last_sync_at: text("last_sync_at"),
	last_error: text("last_error"),
});

export type SyncPeer = typeof syncPeers.$inferSelect;
export type NewSyncPeer = typeof syncPeers.$inferInsert;

export const syncNonces = sqliteTable("sync_nonces", {
	nonce: text("nonce").primaryKey(),
	device_id: text("device_id").notNull(),
	created_at: text("created_at").notNull(),
});

export type SyncNonce = typeof syncNonces.$inferSelect;
export type NewSyncNonce = typeof syncNonces.$inferInsert;

export const syncDevice = sqliteTable("sync_device", {
	device_id: text("device_id").primaryKey(),
	public_key: text("public_key").notNull(),
	fingerprint: text("fingerprint").notNull(),
	created_at: text("created_at").notNull(),
});

export type SyncDevice = typeof syncDevice.$inferSelect;
export type NewSyncDevice = typeof syncDevice.$inferInsert;

export const syncAttempts = sqliteTable(
	"sync_attempts",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		peer_device_id: text("peer_device_id").notNull(),
		started_at: text("started_at").notNull(),
		finished_at: text("finished_at"),
		ok: integer("ok").notNull(),
		ops_in: integer("ops_in").notNull(),
		ops_out: integer("ops_out").notNull(),
		error: text("error"),
	},
	(table) => [index("idx_sync_attempts_peer_started").on(table.peer_device_id, table.started_at)],
);

export type SyncAttempt = typeof syncAttempts.$inferSelect;
export type NewSyncAttempt = typeof syncAttempts.$inferInsert;

export const syncDaemonState = sqliteTable("sync_daemon_state", {
	id: integer("id").primaryKey(),
	last_error: text("last_error"),
	last_traceback: text("last_traceback"),
	last_error_at: text("last_error_at"),
	last_ok_at: text("last_ok_at"),
	phase: text("phase"),
});

export type SyncDaemonState = typeof syncDaemonState.$inferSelect;
export type NewSyncDaemonState = typeof syncDaemonState.$inferInsert;

export const syncResetState = sqliteTable("sync_reset_state", {
	id: integer("id").primaryKey(),
	generation: integer("generation").notNull(),
	snapshot_id: text("snapshot_id").notNull(),
	baseline_cursor: text("baseline_cursor"),
	retained_floor_cursor: text("retained_floor_cursor"),
	updated_at: text("updated_at").notNull(),
});

export type SyncResetState = typeof syncResetState.$inferSelect;
export type NewSyncResetState = typeof syncResetState.$inferInsert;

export const syncRetentionState = sqliteTable("sync_retention_state", {
	id: integer("id").primaryKey(),
	last_run_at: text("last_run_at"),
	last_duration_ms: integer("last_duration_ms"),
	last_deleted_ops: integer("last_deleted_ops").notNull().default(0),
	last_estimated_bytes_before: integer("last_estimated_bytes_before"),
	last_estimated_bytes_after: integer("last_estimated_bytes_after"),
	retained_floor_cursor: text("retained_floor_cursor"),
	last_error: text("last_error"),
	last_error_at: text("last_error_at"),
});

export type SyncRetentionState = typeof syncRetentionState.$inferSelect;
export type NewSyncRetentionState = typeof syncRetentionState.$inferInsert;

export const rawEventIngestSamples = sqliteTable("raw_event_ingest_samples", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	created_at: text("created_at").notNull(),
	inserted_events: integer("inserted_events").notNull().default(0),
	skipped_invalid: integer("skipped_invalid").notNull().default(0),
	skipped_duplicate: integer("skipped_duplicate").notNull().default(0),
	skipped_conflict: integer("skipped_conflict").notNull().default(0),
});

export type RawEventIngestSample = typeof rawEventIngestSamples.$inferSelect;
export type NewRawEventIngestSample = typeof rawEventIngestSamples.$inferInsert;

export const rawEventIngestStats = sqliteTable("raw_event_ingest_stats", {
	id: integer("id").primaryKey(),
	inserted_events: integer("inserted_events").notNull().default(0),
	skipped_events: integer("skipped_events").notNull().default(0),
	skipped_invalid: integer("skipped_invalid").notNull().default(0),
	skipped_duplicate: integer("skipped_duplicate").notNull().default(0),
	skipped_conflict: integer("skipped_conflict").notNull().default(0),
	updated_at: text("updated_at").notNull(),
});

export type RawEventIngestStat = typeof rawEventIngestStats.$inferSelect;
export type NewRawEventIngestStat = typeof rawEventIngestStats.$inferInsert;

export const actors = sqliteTable(
	"actors",
	{
		actor_id: text("actor_id").primaryKey(),
		display_name: text("display_name").notNull(),
		is_local: integer("is_local").notNull().default(0),
		status: text("status").notNull().default("active"),
		merged_into_actor_id: text("merged_into_actor_id"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(table) => ({
		isLocalIdx: index("idx_actors_is_local").on(table.is_local),
		statusIdx: index("idx_actors_status").on(table.status),
	}),
);

export type Actor = typeof actors.$inferSelect;
export type NewActor = typeof actors.$inferInsert;

export const schema = {
	sessions,
	artifacts,
	memoryItems,
	usageEvents,
	rawEvents,
	rawEventSessions,
	opencodeSessions,
	rawEventFlushBatches,
	userPrompts,
	sessionSummaries,
	replicationOps,
	replicationCursors,
	syncPeers,
	syncNonces,
	syncDevice,
	syncAttempts,
	syncDaemonState,
	syncResetState,
	rawEventIngestSamples,
	rawEventIngestStats,
	actors,
};
