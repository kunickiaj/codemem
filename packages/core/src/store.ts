/**
 * MemoryStore — TypeScript port of codemem/store/_store.py (Phase 1 CRUD).
 *
 * During Phase 1, Python owns DDL/schema. This TS runtime reads and writes data
 * but does NOT create or migrate tables. The assertSchemaReady() call verifies
 * the schema was initialized by Python before any operations.
 *
 * Methods ported: get, remember, forget, recent, recentByKinds, stats,
 * updateMemoryVisibility, close.
 *
 * NOT ported yet: pack, usage tracking, vectors, provenance resolution,
 * memory_owned_by_self check.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { Database } from "./db.js";
import {
	assertSchemaReady,
	connect,
	DEFAULT_DB_PATH,
	fromJson,
	loadSqliteVec,
	tableExists,
	toJson,
} from "./db.js";
import { buildFilterClauses } from "./filters.js";
import { buildMemoryPack } from "./pack.js";
import { explain as explainFn, search as searchFn, timeline as timelineFn } from "./search.js";
import type {
	ExplainResponse,
	MemoryFilters,
	MemoryItem,
	MemoryItemResponse,
	MemoryResult,
	PackResponse,
	StoreStats,
	TimelineItemResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Memory kind validation (mirrors codemem/memory_kinds.py)
// ---------------------------------------------------------------------------

const ALLOWED_MEMORY_KINDS = new Set([
	"discovery",
	"change",
	"feature",
	"bugfix",
	"refactor",
	"decision",
	"exploration",
]);

/** Normalize and validate a memory kind. Throws on invalid kinds. */
function validateMemoryKind(kind: string): string {
	const normalized = kind.trim().toLowerCase();
	if (!ALLOWED_MEMORY_KINDS.has(normalized)) {
		throw new Error(
			`Invalid memory kind "${kind}". Allowed: ${[...ALLOWED_MEMORY_KINDS].join(", ")}`,
		);
	}
	return normalized;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ISO 8601 timestamp in UTC. */
function nowIso(): string {
	return new Date().toISOString();
}

/** Trim a string value, returning null for empty/non-string. Matches Python's _clean_optional_str. */
function cleanStr(value: unknown): string | null {
	if (value == null || typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse a row's metadata_json string into a plain object.
 * Returns a new MemoryItemResponse with metadata_json as a parsed object.
 */
function parseMetadata(row: MemoryItem): MemoryItemResponse {
	const { metadata_json, ...rest } = row;
	return { ...rest, metadata_json: fromJson(metadata_json) };
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
	readonly db: Database;
	readonly dbPath: string;
	readonly deviceId: string;
	readonly actorId: string;
	readonly actorDisplayName: string;

	constructor(dbPath: string = DEFAULT_DB_PATH) {
		this.dbPath = dbPath;
		this.db = connect(dbPath);
		try {
			loadSqliteVec(this.db);
			assertSchemaReady(this.db);
		} catch (err) {
			this.db.close();
			throw err;
		}

		// Resolve device ID: env var → sync_device table → random UUID fallback.
		// Python reads from sync_device; randomUUID would break ownership checks
		// (every request gets a different ID, so nothing is "owned by self").
		const envDeviceId = process.env.CODEMEM_DEVICE_ID?.trim();
		if (envDeviceId) {
			this.deviceId = envDeviceId;
		} else {
			// Guard: sync_device may not exist in older/minimal schemas
			let dbDeviceId: string | undefined;
			try {
				const row = this.db.prepare("SELECT device_id FROM sync_device LIMIT 1").get() as
					| { device_id: string }
					| undefined;
				dbDeviceId = row?.device_id;
			} catch {
				// Table doesn't exist — fall through to UUID
			}
			this.deviceId = dbDeviceId ?? randomUUID();
		}

		// Resolve actor identity — matches Python's _resolve_actor_id / _resolve_actor_display_name.
		// Python: actor_id = config.actor_id OR f"local:{device_id}"
		// Python: actor_display_name = config.actor_display_name OR $USER OR actor_id
		const configActorId = process.env.CODEMEM_ACTOR_ID?.trim();
		this.actorId = configActorId || `local:${this.deviceId}`;

		const configDisplayName = process.env.CODEMEM_ACTOR_DISPLAY_NAME?.trim();
		this.actorDisplayName =
			configDisplayName || process.env.USER?.trim() || process.env.USERNAME?.trim() || this.actorId;
	}

	// -----------------------------------------------------------------------
	// get
	// -----------------------------------------------------------------------

	/**
	 * Fetch a single memory item by ID.
	 * Returns null if not found (does not filter by active status).
	 */
	get(memoryId: number): MemoryItemResponse | null {
		const row = this.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(memoryId) as
			| MemoryItem
			| undefined;
		if (!row) return null;
		return parseMetadata(row);
	}

	// -----------------------------------------------------------------------
	// remember
	// -----------------------------------------------------------------------

	/**
	 * Create a new memory item. Returns the new memory ID.
	 *
	 * Validates and normalizes the kind. Resolves provenance fields (actor_id,
	 * visibility, workspace_id, trust_state) matching Python's
	 * _resolve_memory_provenance logic.
	 */
	remember(
		sessionId: number,
		kind: string,
		title: string,
		bodyText: string,
		confidence = 0.5,
		tags?: string[],
		metadata?: Record<string, unknown>,
	): number {
		const validKind = validateMemoryKind(kind);
		const now = nowIso();
		const tagsText = tags ? [...new Set(tags)].sort().join(" ") : "";
		const metaPayload = { ...(metadata ?? {}) };

		metaPayload.clock_device_id ??= this.deviceId;
		const importKey = (metaPayload.import_key as string) || randomUUID();
		metaPayload.import_key = importKey;

		// Resolve provenance fields — mirrors Python's _resolve_memory_provenance
		const provenance = this.resolveProvenance(metaPayload);

		const info = this.db
			.prepare(
				`INSERT INTO memory_items(
					session_id, kind, title, body_text, confidence, tags_text,
					active, created_at, updated_at, metadata_json,
					actor_id, actor_display_name, visibility, workspace_id,
					workspace_kind, origin_device_id, origin_source, trust_state,
					deleted_at, rev, import_key
				) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
			)
			.run(
				sessionId,
				validKind,
				title,
				bodyText,
				confidence,
				tagsText,
				now,
				now,
				toJson(metaPayload),
				provenance.actor_id,
				provenance.actor_display_name,
				provenance.visibility,
				provenance.workspace_id,
				provenance.workspace_kind,
				provenance.origin_device_id,
				provenance.origin_source,
				provenance.trust_state,
				importKey,
			);

		return Number(info.lastInsertRowid);
	}

	// -----------------------------------------------------------------------
	// provenance resolution
	// -----------------------------------------------------------------------

	/**
	 * Resolve provenance fields for a new memory, matching Python's
	 * _resolve_memory_provenance. Uses metadata overrides when present,
	 * falls back to store-level defaults.
	 */
	private resolveProvenance(metadata: Record<string, unknown>): {
		actor_id: string | null;
		actor_display_name: string | null;
		visibility: string;
		workspace_id: string;
		workspace_kind: string;
		origin_device_id: string;
		origin_source: string | null;
		trust_state: string;
	} {
		const clean = (v: unknown): string | null => {
			if (v == null) return null;
			const s = String(v).trim();
			return s.length > 0 ? s : null;
		};

		const actorId = clean(metadata.actor_id) ?? this.actorId;
		const actorDisplayName = clean(metadata.actor_display_name) ?? this.actorDisplayName;

		const explicitWorkspaceKind = clean(metadata.workspace_kind);
		const explicitWorkspaceId = clean(metadata.workspace_id);

		// Visibility defaults to "shared" (matches Python behavior)
		let visibility = clean(metadata.visibility);
		if (!visibility || (visibility !== "private" && visibility !== "shared")) {
			if (explicitWorkspaceKind === "shared" || explicitWorkspaceId?.startsWith("shared:")) {
				visibility = "shared";
			} else {
				visibility = "shared";
			}
		}

		// Workspace kind derives from visibility
		let workspaceKind = explicitWorkspaceKind ?? "shared";
		if (workspaceKind !== "personal" && workspaceKind !== "shared") {
			workspaceKind = visibility === "shared" ? "shared" : "personal";
		} else if (visibility === "shared") {
			workspaceKind = "shared";
		} else if (visibility === "private") {
			workspaceKind = "personal";
		}

		// Workspace ID with fallback — matches Python's _default_workspace_id
		const workspaceId =
			explicitWorkspaceId ??
			(workspaceKind === "personal" ? `personal:${actorId}` : "shared:default");

		const originDeviceId = clean(metadata.origin_device_id) ?? this.deviceId;
		const originSource = clean(metadata.origin_source) ?? clean(metadata.source) ?? null;
		const trustState = clean(metadata.trust_state) ?? "trusted";

		return {
			actor_id: actorId,
			actor_display_name: actorDisplayName,
			visibility,
			workspace_id: workspaceId,
			workspace_kind: workspaceKind,
			origin_device_id: originDeviceId,
			origin_source: originSource,
			trust_state: trustState,
		};
	}

	// -----------------------------------------------------------------------
	// ownership check
	// -----------------------------------------------------------------------

	/**
	 * Check if a memory item is owned by this actor/device.
	 * Port of Python's memory_owned_by_self().
	 *
	 * Python checks:
	 * 1. actor_id == self.actor_id → owned
	 * 2. origin_device_id in claimed_same_actor_peers → owned
	 * 3. actor_id in legacy sync actor ids → owned
	 *
	 * Simplified: check actor_id first, then origin_device_id.
	 * Peer claim/legacy checks deferred until sync parity is needed.
	 */
	memoryOwnedBySelf(item: MemoryItem | Record<string, unknown>): boolean {
		const itemActorId = cleanStr(
			(item as Record<string, unknown>).actor_id ?? (item as MemoryItem).actor_id,
		);
		if (itemActorId === this.actorId) return true;

		const itemOriginDeviceId = cleanStr(
			(item as Record<string, unknown>).origin_device_id ?? (item as MemoryItem).origin_device_id,
		);
		if (itemOriginDeviceId === this.deviceId) return true;

		return false;
	}

	// -----------------------------------------------------------------------
	// forget
	// -----------------------------------------------------------------------

	/**
	 * Soft-delete a memory item (set active = 0, record deleted_at).
	 * Updates metadata_json with clock_device_id for replication tracing.
	 * No-op if the memory doesn't exist.
	 */
	forget(memoryId: number): void {
		const row = this.db
			.prepare("SELECT rev, metadata_json FROM memory_items WHERE id = ?")
			.get(memoryId) as { rev: number; metadata_json: string | null } | undefined;
		if (!row) return;

		const meta = fromJson(row.metadata_json);
		meta.clock_device_id = this.deviceId;

		const now = nowIso();
		const rev = (row.rev ?? 0) + 1;

		this.db
			.prepare(
				`UPDATE memory_items
				 SET active = 0, deleted_at = ?, updated_at = ?, metadata_json = ?, rev = ?
				 WHERE id = ?`,
			)
			.run(now, now, toJson(meta), rev, memoryId);
	}

	// -----------------------------------------------------------------------
	// recent
	// -----------------------------------------------------------------------

	/**
	 * Return recent active memories, newest first.
	 * Supports optional filters via buildFilterClauses.
	 */
	recent(limit = 10, filters?: MemoryFilters | null, offset = 0): MemoryItemResponse[] {
		const baseClauses = ["memory_items.active = 1"];
		const filterResult = buildFilterClauses(filters);
		const allClauses = [...baseClauses, ...filterResult.clauses];
		const where = allClauses.join(" AND ");

		// Note: joinSessions is set by the project filter (not yet ported).
		// Once project filtering lands, it will trigger the sessions JOIN.
		const from = filterResult.joinSessions
			? "memory_items JOIN sessions ON sessions.id = memory_items.session_id"
			: "memory_items";

		const rows = this.db
			.prepare(
				`SELECT memory_items.* FROM ${from}
				 WHERE ${where}
				 ORDER BY created_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...filterResult.params, limit, Math.max(offset, 0)) as MemoryItem[];

		return rows.map((row) => parseMetadata(row));
	}

	// -----------------------------------------------------------------------
	// recentByKinds
	// -----------------------------------------------------------------------

	/**
	 * Return recent active memories filtered to specific kinds, newest first.
	 */
	recentByKinds(
		kinds: string[],
		limit = 10,
		filters?: MemoryFilters | null,
		offset = 0,
	): MemoryItemResponse[] {
		const kindsList = kinds.filter((k) => k.length > 0);
		if (kindsList.length === 0) return [];

		const kindPlaceholders = kindsList.map(() => "?").join(", ");
		const baseClauses = ["memory_items.active = 1", `memory_items.kind IN (${kindPlaceholders})`];
		const filterResult = buildFilterClauses(filters);
		const allClauses = [...baseClauses, ...filterResult.clauses];
		const where = allClauses.join(" AND ");

		const from = filterResult.joinSessions
			? "memory_items JOIN sessions ON sessions.id = memory_items.session_id"
			: "memory_items";

		const params = [...kindsList, ...filterResult.params, limit, Math.max(offset, 0)];

		const rows = this.db
			.prepare(
				`SELECT memory_items.* FROM ${from}
				 WHERE ${where}
				 ORDER BY created_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...params) as MemoryItem[];

		return rows.map((row) => parseMetadata(row));
	}

	// -----------------------------------------------------------------------
	// stats
	// -----------------------------------------------------------------------

	/**
	 * Return database statistics matching the Python stats() output shape.
	 */
	stats(): StoreStats {
		const count = (sql: string): number => {
			const row = this.db.prepare(sql).get() as { c: number } | undefined;
			return row?.c ?? 0;
		};

		const totalMemories = count("SELECT COUNT(*) AS c FROM memory_items");
		const activeMemories = count("SELECT COUNT(*) AS c FROM memory_items WHERE active = 1");
		const sessions = count("SELECT COUNT(*) AS c FROM sessions");
		const artifacts = count("SELECT COUNT(*) AS c FROM artifacts");
		const rawEvents = count("SELECT COUNT(*) AS c FROM raw_events");

		let vectorCount = 0;
		if (tableExists(this.db, "memory_vectors")) {
			vectorCount = count("SELECT COUNT(*) AS c FROM memory_vectors");
		}
		const vectorCoverage = activeMemories > 0 ? Math.min(1, vectorCount / activeMemories) : 0;

		const tagsFilled = count(
			"SELECT COUNT(*) AS c FROM memory_items WHERE active = 1 AND TRIM(tags_text) != ''",
		);
		const tagsCoverage = activeMemories > 0 ? Math.min(1, tagsFilled / activeMemories) : 0;

		let sizeBytes = 0;
		try {
			sizeBytes = statSync(this.dbPath).size;
		} catch {
			// File may not exist yet or be inaccessible
		}

		// Usage stats
		const usageRows = this.db
			.prepare(
				`SELECT event, COUNT(*) AS count,
				        SUM(tokens_read) AS tokens_read,
				        SUM(tokens_written) AS tokens_written,
				        SUM(COALESCE(tokens_saved, 0)) AS tokens_saved
				 FROM usage_events
				 GROUP BY event
				 ORDER BY count DESC`,
			)
			.all() as {
			event: string;
			count: number;
			tokens_read: number | null;
			tokens_written: number | null;
			tokens_saved: number | null;
		}[];

		const usageEvents = usageRows.map((r) => ({
			event: r.event,
			count: r.count,
			tokens_read: r.tokens_read ?? 0,
			tokens_written: r.tokens_written ?? 0,
			tokens_saved: r.tokens_saved ?? 0,
		}));

		const totalEvents = usageEvents.reduce((s, e) => s + e.count, 0);
		const totalTokensRead = usageEvents.reduce((s, e) => s + e.tokens_read, 0);
		const totalTokensWritten = usageEvents.reduce((s, e) => s + e.tokens_written, 0);
		const totalTokensSaved = usageEvents.reduce((s, e) => s + e.tokens_saved, 0);

		return {
			identity: {
				device_id: this.deviceId,
				actor_id: this.actorId,
				actor_display_name: this.actorDisplayName,
			},
			database: {
				path: this.dbPath,
				size_bytes: sizeBytes,
				sessions,
				memory_items: totalMemories,
				active_memory_items: activeMemories,
				artifacts,
				vector_rows: vectorCount,
				vector_coverage: vectorCoverage,
				tags_filled: tagsFilled,
				tags_coverage: tagsCoverage,
				raw_events: rawEvents,
			},
			usage: {
				events: usageEvents,
				totals: {
					events: totalEvents,
					tokens_read: totalTokensRead,
					tokens_written: totalTokensWritten,
					tokens_saved: totalTokensSaved,
				},
			},
		};
	}

	// -----------------------------------------------------------------------
	// updateMemoryVisibility
	// -----------------------------------------------------------------------

	/**
	 * Update the visibility of an active memory item.
	 * Throws if visibility is invalid, memory not found, memory is inactive,
	 * or memory is not owned by this device/actor.
	 */
	updateMemoryVisibility(memoryId: number, visibility: string): MemoryItemResponse {
		const cleaned = visibility.trim();
		if (cleaned !== "private" && cleaned !== "shared") {
			throw new Error("visibility must be private or shared");
		}

		const row = this.db
			.prepare("SELECT * FROM memory_items WHERE id = ? AND active = 1")
			.get(memoryId) as MemoryItem | undefined;
		if (!row) {
			throw new Error("memory not found");
		}

		// Ownership check — matches Python's memory_owned_by_self().
		// Python checks: actor_id == self.actor_id, then origin_device_id in claimed peers.
		// Simplified: check actor_id first, then fall back to origin_device_id.
		if (!this.memoryOwnedBySelf(row)) {
			throw new Error("memory not owned by this device");
		}

		const rowActorId = cleanStr(row.actor_id) ?? this.actorId;
		const workspaceKind = cleaned === "shared" ? "shared" : "personal";
		const workspaceId =
			cleaned === "shared" && row.workspace_id?.startsWith("shared:")
				? row.workspace_id
				: workspaceKind === "personal"
					? `personal:${rowActorId}`
					: "shared:default";

		// Update metadata with visibility change + clock stamp
		const meta = fromJson(row.metadata_json);
		meta.visibility = cleaned;
		meta.workspace_kind = workspaceKind;
		meta.workspace_id = workspaceId;
		meta.clock_device_id = this.deviceId;

		const now = nowIso();
		const rev = (row.rev ?? 0) + 1;

		this.db
			.prepare(
				`UPDATE memory_items
				 SET visibility = ?, workspace_kind = ?, workspace_id = ?,
				     updated_at = ?, metadata_json = ?, rev = ?
				 WHERE id = ?`,
			)
			.run(cleaned, workspaceKind, workspaceId, now, toJson(meta), rev, memoryId);

		const updated = this.get(memoryId);
		if (!updated) {
			throw new Error("memory not found after update");
		}
		return updated;
	}

	// -----------------------------------------------------------------------
	// search
	// -----------------------------------------------------------------------

	/**
	 * Full-text search for memories using FTS5.
	 *
	 * Delegates to search.ts to keep the search logic decoupled.
	 * Results are ranked by BM25 score, recency, and kind bonus.
	 */
	search(query: string, limit = 10, filters?: MemoryFilters): MemoryResult[] {
		return searchFn(this, query, limit, filters);
	}

	// -----------------------------------------------------------------------
	// timeline
	// -----------------------------------------------------------------------

	/**
	 * Return a chronological window of memories around an anchor.
	 *
	 * Finds an anchor by memoryId or query, then fetches neighbors
	 * in the same session. Delegates to search.ts.
	 */
	timeline(
		query?: string | null,
		memoryId?: number | null,
		depthBefore = 3,
		depthAfter = 3,
		filters?: MemoryFilters | null,
	): TimelineItemResponse[] {
		return timelineFn(this, query, memoryId, depthBefore, depthAfter, filters);
	}

	// -----------------------------------------------------------------------
	// explain
	// -----------------------------------------------------------------------

	/**
	 * Explain search results with scoring breakdown.
	 *
	 * Returns detailed scoring components for each result, merging
	 * query-based and ID-based lookups. Delegates to search.ts.
	 */
	explain(
		query?: string | null,
		ids?: unknown[] | null,
		limit = 10,
		filters?: MemoryFilters | null,
	): ExplainResponse {
		return explainFn(this, query, ids, limit, filters);
	}

	// -----------------------------------------------------------------------
	// buildMemoryPack
	// -----------------------------------------------------------------------

	/**
	 * Build a formatted memory pack from search results.
	 *
	 * Categorizes memories into summary/timeline/observations sections,
	 * with optional token budgeting. Delegates to pack.ts.
	 */
	buildMemoryPack(
		context: string,
		limit?: number,
		tokenBudget?: number | null,
		filters?: MemoryFilters,
	): PackResponse {
		return buildMemoryPack(this, context, limit, tokenBudget ?? null, filters);
	}

	// -----------------------------------------------------------------------
	// Raw event helpers
	// -----------------------------------------------------------------------

	/**
	 * Normalize source/streamId to match Python's _normalize_stream_identity().
	 * Trims whitespace, lowercases source, defaults to "opencode".
	 */
	private normalizeStreamIdentity(source: string, streamId: string): [string, string] {
		const s = source.trim().toLowerCase() || "opencode";
		const sid = streamId.trim();
		if (!sid) throw new Error("stream_id is required");
		return [s, sid];
	}

	// -----------------------------------------------------------------------
	// Raw event query methods (ports from codemem/store/raw_events.py)
	// -----------------------------------------------------------------------

	/**
	 * Find sessions that have unflushed events and have been idle long enough.
	 * Port of raw_event_sessions_pending_idle_flush().
	 */
	rawEventSessionsPendingIdleFlush(
		idleBeforeTsWallMs: number,
		limit = 25,
	): { source: string; streamId: string }[] {
		const rows = this.db
			.prepare(
				`WITH max_events AS (
            SELECT source, stream_id, MAX(event_seq) AS max_seq
            FROM raw_events
            GROUP BY source, stream_id
        )
        SELECT s.source, s.stream_id
        FROM raw_event_sessions s
        JOIN max_events e ON e.source = s.source AND e.stream_id = s.stream_id
        WHERE s.last_seen_ts_wall_ms IS NOT NULL
          AND s.last_seen_ts_wall_ms <= ?
          AND e.max_seq > s.last_flushed_event_seq
        ORDER BY s.last_seen_ts_wall_ms ASC
        LIMIT ?`,
			)
			.all(idleBeforeTsWallMs, limit) as { source: string | null; stream_id: string | null }[];

		return rows
			.filter((row) => row.stream_id)
			.map((row) => ({
				source: String(row.source ?? "opencode"),
				streamId: String(row.stream_id ?? ""),
			}));
	}

	/**
	 * Find sessions that have pending/failed flush batches with unflushed events.
	 * Port of raw_event_sessions_with_pending_queue().
	 */
	rawEventSessionsWithPendingQueue(limit = 25): { source: string; streamId: string }[] {
		const rows = this.db
			.prepare(
				`WITH pending_batches AS (
            SELECT b.source, b.stream_id, MIN(b.updated_at) AS oldest_pending_update
            FROM raw_event_flush_batches b
            WHERE b.status IN ('pending', 'failed', 'started', 'error')
            GROUP BY b.source, b.stream_id
        ),
        max_events AS (
            SELECT source, stream_id, MAX(event_seq) AS max_seq
            FROM raw_events
            GROUP BY source, stream_id
        )
        SELECT b.source, b.stream_id
        FROM pending_batches b
        JOIN max_events e ON e.source = b.source AND e.stream_id = b.stream_id
        LEFT JOIN raw_event_sessions s ON s.source = b.source AND s.stream_id = b.stream_id
        WHERE e.max_seq > COALESCE(s.last_flushed_event_seq, -1)
        ORDER BY b.oldest_pending_update ASC
        LIMIT ?`,
			)
			.all(limit) as { source: string | null; stream_id: string | null }[];

		return rows
			.filter((row) => row.stream_id)
			.map((row) => ({
				source: String(row.source ?? "opencode"),
				streamId: String(row.stream_id ?? ""),
			}));
	}

	/**
	 * Delete raw events older than max_age_ms. Returns count of deleted raw_events rows.
	 * Port of purge_raw_events() + purge_raw_events_before().
	 */
	purgeRawEvents(maxAgeMs: number): number {
		if (maxAgeMs <= 0) return 0;
		const nowMs = Date.now();
		const cutoffTsWallMs = nowMs - maxAgeMs;
		const cutoffIso = new Date(cutoffTsWallMs).toISOString();

		return this.db.transaction(() => {
			this.db.prepare("DELETE FROM raw_event_ingest_samples WHERE created_at < ?").run(cutoffIso);
			const result = this.db
				.prepare("DELETE FROM raw_events WHERE ts_wall_ms IS NOT NULL AND ts_wall_ms < ?")
				.run(cutoffTsWallMs);
			return result.changes;
		})();
	}

	/**
	 * Mark stuck flush batches (started/running/pending/claimed) as failed.
	 * Port of mark_stuck_raw_event_batches_as_error().
	 */
	markStuckRawEventBatchesAsError(olderThanIso: string, limit = 100): number {
		const now = new Date().toISOString();
		const result = this.db
			.prepare(
				`WITH candidates AS (
            SELECT id
            FROM raw_event_flush_batches
            WHERE status IN ('started', 'running', ?, ?) AND updated_at < ?
            ORDER BY updated_at
            LIMIT ?
        )
        UPDATE raw_event_flush_batches
        SET status = ?,
            updated_at = ?,
            error_message = 'Flush retry timed out.',
            error_type = 'RawEventBatchStuck',
            observer_provider = NULL,
            observer_model = NULL,
            observer_runtime = NULL
        WHERE id IN (SELECT id FROM candidates)`,
			)
			.run(
				"pending", // RAW_EVENT_QUEUE_PENDING
				"claimed", // RAW_EVENT_QUEUE_CLAIMED
				olderThanIso,
				limit,
				"failed", // RAW_EVENT_QUEUE_FAILED
				now,
			);

		return result.changes;
	}

	// -----------------------------------------------------------------------
	// Raw event per-session methods (ports for flush pipeline)
	// -----------------------------------------------------------------------

	/**
	 * Get session metadata (cwd, project, started_at, etc.) for a raw event stream.
	 * Port of raw_event_session_meta().
	 */
	rawEventSessionMeta(opencodeSessionId: string, source = "opencode"): Record<string, unknown> {
		const [s, sid] = this.normalizeStreamIdentity(source, opencodeSessionId);
		const row = this.db
			.prepare(
				`SELECT cwd, project, started_at, last_seen_ts_wall_ms, last_flushed_event_seq
				 FROM raw_event_sessions
				 WHERE source = ? AND stream_id = ?`,
			)
			.get(s, sid) as Record<string, unknown> | undefined;
		if (!row) return {};
		return {
			cwd: row.cwd,
			project: row.project,
			started_at: row.started_at,
			last_seen_ts_wall_ms: row.last_seen_ts_wall_ms,
			last_flushed_event_seq: row.last_flushed_event_seq,
		};
	}

	/**
	 * Get the last flushed event_seq for a session. Returns -1 if no state.
	 * Port of raw_event_flush_state().
	 */
	rawEventFlushState(opencodeSessionId: string, source = "opencode"): number {
		const [s, sid] = this.normalizeStreamIdentity(source, opencodeSessionId);
		const row = this.db
			.prepare(
				"SELECT last_flushed_event_seq FROM raw_event_sessions WHERE source = ? AND stream_id = ?",
			)
			.get(s, sid) as { last_flushed_event_seq: number } | undefined;
		if (!row) return -1;
		return Number(row.last_flushed_event_seq);
	}

	/**
	 * Get raw events after a given event_seq, ordered by event_seq ASC.
	 * Returns enriched event objects with type, timestamps, event_seq, event_id.
	 * Port of raw_events_since_by_seq().
	 */
	rawEventsSinceBySeq(
		opencodeSessionId: string,
		source = "opencode",
		afterEventSeq = -1,
		limit?: number | null,
	): Record<string, unknown>[] {
		const [s, sid] = this.normalizeStreamIdentity(source, opencodeSessionId);
		const limitClause = limit != null && limit > 0 ? "LIMIT ?" : "";
		const params: unknown[] = [s, sid, afterEventSeq];
		if (limit != null && limit > 0) params.push(limit);

		const rows = this.db
			.prepare(
				`SELECT event_seq, event_type, ts_wall_ms, ts_mono_ms, payload_json, event_id
				 FROM raw_events
				 WHERE source = ? AND stream_id = ? AND event_seq > ?
				 ORDER BY event_seq ASC
				 ${limitClause}`,
			)
			.all(...params) as {
			event_seq: number;
			event_type: string;
			ts_wall_ms: number | null;
			ts_mono_ms: number | null;
			payload_json: string | null;
			event_id: string | null;
		}[];

		return rows.map((row) => {
			const payload = fromJson(row.payload_json) as Record<string, unknown>;
			// Use || (not ??) to match Python's `or` semantics — empty string falls through
			payload.type = payload.type || row.event_type;
			payload.timestamp_wall_ms = row.ts_wall_ms;
			payload.timestamp_mono_ms = row.ts_mono_ms;
			payload.event_seq = row.event_seq;
			payload.event_id = row.event_id;
			return payload;
		});
	}

	/**
	 * Get or create a flush batch record. Returns [batchId, status].
	 * Port of get_or_create_raw_event_flush_batch().
	 */
	getOrCreateRawEventFlushBatch(
		opencodeSessionId: string,
		source: string,
		startEventSeq: number,
		endEventSeq: number,
		extractorVersion: string,
	): { batchId: number; status: string } {
		const [s, sid] = this.normalizeStreamIdentity(source, opencodeSessionId);
		const now = new Date().toISOString();

		// Atomic UPSERT to avoid SELECT+INSERT races. We intentionally do NOT
		// heartbeat claimed/running batches: their updated_at stays unchanged so
		// stuck-batch recovery can still age them out.
		const row = this.db
			.prepare(
				`INSERT INTO raw_event_flush_batches(
					source, stream_id, opencode_session_id,
					start_event_seq, end_event_seq, extractor_version,
					status, created_at, updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
				ON CONFLICT(source, stream_id, start_event_seq, end_event_seq, extractor_version)
				DO UPDATE SET
					updated_at = CASE
						WHEN raw_event_flush_batches.status IN ('claimed', 'running')
						THEN raw_event_flush_batches.updated_at
						ELSE excluded.updated_at
					END
				RETURNING id, status`,
			)
			.get(s, sid, sid, startEventSeq, endEventSeq, extractorVersion, now, now) as
			| { id: number; status: string }
			| undefined;

		if (!row) throw new Error("Failed to create flush batch");
		// Canonicalize legacy DB statuses to match Python's _RAW_EVENT_QUEUE_DB_TO_CANONICAL
		const rawStatus = String(row.status);
		const canonicalStatus =
			rawStatus === "started"
				? "pending"
				: rawStatus === "running"
					? "claimed"
					: rawStatus === "error"
						? "failed"
						: rawStatus;
		return { batchId: Number(row.id), status: canonicalStatus };
	}

	/**
	 * Attempt to claim a flush batch for processing.
	 * Returns true if successfully claimed, false if already claimed/completed.
	 * Port of claim_raw_event_flush_batch().
	 */
	claimRawEventFlushBatch(batchId: number): boolean {
		const now = new Date().toISOString();
		const row = this.db
			.prepare(
				`UPDATE raw_event_flush_batches
				 SET status = 'claimed', updated_at = ?, attempt_count = attempt_count + 1
				 WHERE id = ? AND status IN ('pending', 'failed', 'started', 'error')
				 RETURNING id`,
			)
			.get(now, batchId) as { id: number } | undefined;
		return row != null;
	}

	/**
	 * Update the status of a flush batch.
	 * Port of update_raw_event_flush_batch_status().
	 */
	updateRawEventFlushBatchStatus(batchId: number, status: string): void {
		const now = new Date().toISOString();
		this.db
			.prepare(
				`UPDATE raw_event_flush_batches
				 SET status = ?,
				     updated_at = ?,
				     error_message = CASE WHEN ? = 'failed' THEN error_message ELSE NULL END,
				     error_type = CASE WHEN ? = 'failed' THEN error_type ELSE NULL END,
				     observer_provider = CASE WHEN ? = 'failed' THEN observer_provider ELSE NULL END,
				     observer_model = CASE WHEN ? = 'failed' THEN observer_model ELSE NULL END,
				     observer_runtime = CASE WHEN ? = 'failed' THEN observer_runtime ELSE NULL END
				 WHERE id = ?`,
			)
			.run(status, now, status, status, status, status, status, batchId);
	}

	/**
	 * Record a flush batch failure with error details.
	 * Port of record_raw_event_flush_batch_failure().
	 */
	recordRawEventFlushBatchFailure(
		batchId: number,
		opts: {
			message: string;
			errorType: string;
			observerProvider?: string | null;
			observerModel?: string | null;
			observerRuntime?: string | null;
		},
	): void {
		const now = new Date().toISOString();
		this.db
			.prepare(
				`UPDATE raw_event_flush_batches
				 SET status = 'failed',
				     updated_at = ?,
				     error_message = ?,
				     error_type = ?,
				     observer_provider = ?,
				     observer_model = ?,
				     observer_runtime = ?
				 WHERE id = ?`,
			)
			.run(
				now,
				opts.message,
				opts.errorType,
				opts.observerProvider ?? null,
				opts.observerModel ?? null,
				opts.observerRuntime ?? null,
				batchId,
			);
	}

	/**
	 * Update the last flushed event_seq for a session.
	 * Port of update_raw_event_flush_state().
	 */
	updateRawEventFlushState(
		opencodeSessionId: string,
		lastFlushed: number,
		source = "opencode",
	): void {
		const [s, sid] = this.normalizeStreamIdentity(source, opencodeSessionId);
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO raw_event_sessions(opencode_session_id, source, stream_id, last_flushed_event_seq, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(source, stream_id) DO UPDATE SET
				     opencode_session_id = excluded.opencode_session_id,
				     last_flushed_event_seq = excluded.last_flushed_event_seq,
				     updated_at = excluded.updated_at`,
			)
			.run(sid, s, sid, lastFlushed, now);
	}

	// -----------------------------------------------------------------------
	// close
	// -----------------------------------------------------------------------

	/** Close the database connection. */
	close(): void {
		this.db.close();
	}
}
