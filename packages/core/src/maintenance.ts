import { statSync } from "node:fs";
import { assertSchemaReady, connect, type Database, resolveDbPath } from "./db.js";
import { projectClause } from "./project.js";

export interface RawEventStatusItem {
	source: string;
	stream_id: string;
	opencode_session_id: string | null;
	cwd: string | null;
	project: string | null;
	started_at: string | null;
	last_seen_ts_wall_ms: number | null;
	last_received_event_seq: number;
	last_flushed_event_seq: number;
	updated_at: string;
	session_stream_id: string;
	session_id: string;
}

export interface RawEventStatusResult {
	items: RawEventStatusItem[];
	totals: { pending: number; sessions: number };
	ingest: { available: true; mode: "stream_queue"; max_body_bytes: number };
}

function withDb<T>(dbPath: string | undefined, fn: (db: Database, resolvedPath: string) => T): T {
	const resolvedPath = resolveDbPath(dbPath);
	const db = connect(resolvedPath);
	try {
		assertSchemaReady(db);
		return fn(db, resolvedPath);
	} finally {
		db.close();
	}
}

export function initDatabase(dbPath?: string): { path: string; sizeBytes: number } {
	return withDb(dbPath, (_db, resolvedPath) => {
		const stats = statSync(resolvedPath);
		return { path: resolvedPath, sizeBytes: stats.size };
	});
}

export function vacuumDatabase(dbPath?: string): { path: string; sizeBytes: number } {
	return withDb(dbPath, (db, resolvedPath) => {
		db.exec("VACUUM");
		const stats = statSync(resolvedPath);
		return { path: resolvedPath, sizeBytes: stats.size };
	});
}

export function getRawEventStatus(dbPath?: string, limit = 25): RawEventStatusResult {
	return withDb(dbPath, (db) => {
		const rows = db
			.prepare(
				`WITH max_events AS (
					SELECT source, stream_id, MAX(event_seq) AS max_seq
					FROM raw_events
					GROUP BY source, stream_id
				)
				SELECT s.source, s.stream_id, s.opencode_session_id, s.cwd, s.project,
					s.started_at, s.last_seen_ts_wall_ms,
					s.last_received_event_seq, s.last_flushed_event_seq, s.updated_at
				FROM raw_event_sessions s
				JOIN max_events e ON e.source = s.source AND e.stream_id = s.stream_id
				WHERE e.max_seq > s.last_flushed_event_seq
				ORDER BY s.updated_at DESC
				 LIMIT ?`,
			)
			.all(limit) as Array<Record<string, unknown>>;

		const items = rows.map((row) => {
			const streamId = String(row.stream_id ?? row.opencode_session_id ?? "");
			return {
				source: String(row.source ?? "opencode"),
				stream_id: streamId,
				opencode_session_id:
					row.opencode_session_id == null ? null : String(row.opencode_session_id),
				cwd: row.cwd == null ? null : String(row.cwd),
				project: row.project == null ? null : String(row.project),
				started_at: row.started_at == null ? null : String(row.started_at),
				last_seen_ts_wall_ms:
					row.last_seen_ts_wall_ms == null ? null : Number(row.last_seen_ts_wall_ms),
				last_received_event_seq: Number(row.last_received_event_seq ?? -1),
				last_flushed_event_seq: Number(row.last_flushed_event_seq ?? -1),
				updated_at: String(row.updated_at ?? ""),
				session_stream_id: streamId,
				session_id: streamId,
			};
		});

		const totalsRow = db
			.prepare(
				`WITH max_events AS (
					SELECT source, stream_id, MAX(event_seq) AS max_seq
					FROM raw_events
					GROUP BY source, stream_id
				)
				SELECT
					COUNT(1) AS sessions,
					SUM(e.max_seq - s.last_flushed_event_seq) AS pending
				FROM raw_event_sessions s
				JOIN max_events e ON e.source = s.source AND e.stream_id = s.stream_id
				WHERE e.max_seq > s.last_flushed_event_seq`,
			)
			.get() as { sessions: number | null; pending: number | null } | undefined;

		return {
			items,
			totals: {
				pending: Number(totalsRow?.pending ?? 0),
				sessions: Number(totalsRow?.sessions ?? 0),
			},
			ingest: {
				available: true,
				mode: "stream_queue",
				max_body_bytes: 2_000_000,
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Reliability metrics
// ---------------------------------------------------------------------------

export interface ReliabilityMetrics {
	counts: {
		inserted_events: number;
		dropped_events: number;
		started_batches: number;
		running_batches: number;
		completed_batches: number;
		errored_batches: number;
		terminal_batches: number;
		sessions_with_events: number;
		sessions_with_started_at: number;
		retry_depth_max: number;
	};
	rates: {
		flush_success_rate: number;
		dropped_event_rate: number;
		session_boundary_accuracy: number;
	};
	window_hours: number | null;
}

export function getReliabilityMetrics(
	dbPath?: string,
	windowHours?: number | null,
): ReliabilityMetrics {
	return withDb(dbPath, (db) => {
		const cutoffIso =
			windowHours != null ? new Date(Date.now() - windowHours * 3600 * 1000).toISOString() : null;

		// Batch counts
		const batchSql = `
			SELECT
				COALESCE(SUM(CASE WHEN status IN ('started', 'pending') THEN 1 ELSE 0 END), 0) AS started,
				COALESCE(SUM(CASE WHEN status IN ('running', 'claimed') THEN 1 ELSE 0 END), 0) AS running,
				COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
				COALESCE(SUM(CASE WHEN status IN ('error', 'failed') THEN 1 ELSE 0 END), 0) AS errored
			FROM raw_event_flush_batches
			${cutoffIso ? "WHERE updated_at >= ?" : ""}
		`;
		const batchRow = (
			cutoffIso ? db.prepare(batchSql).get(cutoffIso) : db.prepare(batchSql).get()
		) as Record<string, number> | undefined;

		const startedBatches = Number(batchRow?.started ?? 0);
		const runningBatches = Number(batchRow?.running ?? 0);
		const completedBatches = Number(batchRow?.completed ?? 0);
		const erroredBatches = Number(batchRow?.errored ?? 0);
		const terminalBatches = completedBatches + erroredBatches;
		const flushSuccessRate = terminalBatches > 0 ? completedBatches / terminalBatches : 1.0;

		// Event counts from raw_event_sessions
		// Sequences are 0-based indexes, so +1 converts to counts.
		const eventSql = `
			SELECT
				COALESCE(SUM(last_received_event_seq + 1), 0) AS total_received,
				COALESCE(SUM(CASE WHEN last_flushed_event_seq >= 0 THEN last_flushed_event_seq + 1 ELSE 0 END), 0) AS total_flushed
			FROM raw_event_sessions
			${cutoffIso ? "WHERE updated_at >= ?" : ""}
		`;
		const eventRow = (
			cutoffIso ? db.prepare(eventSql).get(cutoffIso) : db.prepare(eventSql).get()
		) as Record<string, number> | undefined;

		// In-flight events: sum of (end_event_seq - start_event_seq + 1) for active batches
		const inFlightSql = `
			SELECT COALESCE(SUM(end_event_seq - start_event_seq + 1), 0) AS in_flight
			FROM raw_event_flush_batches
			WHERE status IN ('started', 'pending', 'running', 'claimed')
			${cutoffIso ? "AND updated_at >= ?" : ""}
		`;
		const inFlightRow = (
			cutoffIso ? db.prepare(inFlightSql).get(cutoffIso) : db.prepare(inFlightSql).get()
		) as Record<string, number> | undefined;
		const inFlightEvents = Number(inFlightRow?.in_flight ?? 0);

		const insertedEvents = Number(eventRow?.total_flushed ?? 0);
		const droppedEvents = Math.max(
			0,
			Number(eventRow?.total_received ?? 0) - Number(eventRow?.total_flushed ?? 0) - inFlightEvents,
		);
		const droppedDenom = insertedEvents + droppedEvents;
		const droppedEventRate = droppedDenom > 0 ? droppedEvents / droppedDenom : 0.0;

		// Session boundary accuracy
		const boundarySql = `
			WITH has_events AS (
				SELECT DISTINCT source, stream_id FROM raw_events
				${cutoffIso ? "WHERE created_at >= ?" : ""}
			)
			SELECT
				COUNT(1) AS sessions_with_events,
				COALESCE(SUM(CASE WHEN COALESCE(s.started_at, '') != '' THEN 1 ELSE 0 END), 0) AS sessions_with_started_at
			FROM has_events e
			LEFT JOIN raw_event_sessions s ON s.source = e.source AND s.stream_id = e.stream_id
		`;
		const boundaryRow = (
			cutoffIso ? db.prepare(boundarySql).get(cutoffIso) : db.prepare(boundarySql).get()
		) as Record<string, number> | undefined;

		const sessionsWithEvents = Number(boundaryRow?.sessions_with_events ?? 0);
		const sessionsWithStartedAt = Number(boundaryRow?.sessions_with_started_at ?? 0);
		const sessionBoundaryAccuracy =
			sessionsWithEvents > 0 ? sessionsWithStartedAt / sessionsWithEvents : 1.0;

		const retryDepthSql = `
			SELECT COALESCE(MAX(attempt_count), 0) AS retry_depth_max
			FROM raw_event_flush_batches
			${cutoffIso ? "WHERE updated_at >= ?" : ""}
		`;
		const retryDepthRow = (
			cutoffIso ? db.prepare(retryDepthSql).get(cutoffIso) : db.prepare(retryDepthSql).get()
		) as Record<string, number> | undefined;
		const retryDepthMax = Math.max(0, Number(retryDepthRow?.retry_depth_max ?? 0) - 1);

		return {
			counts: {
				inserted_events: insertedEvents,
				dropped_events: droppedEvents,
				started_batches: startedBatches,
				running_batches: runningBatches,
				completed_batches: completedBatches,
				errored_batches: erroredBatches,
				terminal_batches: terminalBatches,
				sessions_with_events: sessionsWithEvents,
				sessions_with_started_at: sessionsWithStartedAt,
				retry_depth_max: retryDepthMax,
			},
			rates: {
				flush_success_rate: flushSuccessRate,
				dropped_event_rate: droppedEventRate,
				session_boundary_accuracy: sessionBoundaryAccuracy,
			},
			window_hours: windowHours ?? null,
		};
	});
}

export interface GateResult {
	passed: boolean;
	failures: string[];
	metrics: ReliabilityMetrics;
}

export function rawEventsGate(
	dbPath?: string,
	opts?: {
		minFlushSuccessRate?: number;
		maxDroppedEventRate?: number;
		minSessionBoundaryAccuracy?: number;
		windowHours?: number;
	},
): GateResult {
	const minFlushSuccessRate = opts?.minFlushSuccessRate ?? 0.95;
	const maxDroppedEventRate = opts?.maxDroppedEventRate ?? 0.05;
	const minSessionBoundaryAccuracy = opts?.minSessionBoundaryAccuracy ?? 0.9;
	const windowHours = opts?.windowHours ?? 24;

	const metrics = getReliabilityMetrics(dbPath, windowHours);
	const failures: string[] = [];

	if (metrics.rates.flush_success_rate < minFlushSuccessRate) {
		failures.push(
			`flush_success_rate=${metrics.rates.flush_success_rate.toFixed(4)} < min ${minFlushSuccessRate.toFixed(4)}`,
		);
	}
	if (metrics.rates.dropped_event_rate > maxDroppedEventRate) {
		failures.push(
			`dropped_event_rate=${metrics.rates.dropped_event_rate.toFixed(4)} > max ${maxDroppedEventRate.toFixed(4)}`,
		);
	}
	if (metrics.rates.session_boundary_accuracy < minSessionBoundaryAccuracy) {
		failures.push(
			`session_boundary_accuracy=${metrics.rates.session_boundary_accuracy.toFixed(4)} < min ${minSessionBoundaryAccuracy.toFixed(4)}`,
		);
	}

	return { passed: failures.length === 0, failures, metrics };
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export function retryRawEventFailures(dbPath?: string, limit = 25): { retried: number } {
	return withDb(dbPath, (db) => {
		const now = new Date().toISOString();
		// Single atomic UPDATE with subquery to avoid TOCTOU race with concurrent
		// workers that may claim or complete batches between SELECT and UPDATE.
		const result = db
			.prepare(
				`UPDATE raw_event_flush_batches
				 SET status = 'pending',
				     updated_at = ?,
				     error_message = NULL,
				     error_type = NULL,
				     observer_provider = NULL,
				     observer_model = NULL,
				     observer_runtime = NULL
				 WHERE id IN (
				     SELECT id FROM raw_event_flush_batches
				     WHERE status IN ('failed', 'error')
				     ORDER BY updated_at ASC
				     LIMIT ?
				 )`,
			)
			.run(now, limit);

		return { retried: result.changes };
	});
}

export interface BackfillTagsTextOptions {
	limit?: number | null;
	since?: string | null;
	project?: string | null;
	activeOnly?: boolean;
	dryRun?: boolean;
	memoryIds?: number[] | null;
}

export interface BackfillTagsTextResult {
	checked: number;
	updated: number;
	skipped: number;
}

function normalizeTag(value: string): string {
	let normalized = value.trim().toLowerCase();
	if (!normalized) return "";
	normalized = normalized.replace(/[^a-z0-9_]+/g, "-");
	normalized = normalized.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	if (!normalized) return "";
	if (normalized.length > 40) normalized = normalized.slice(0, 40).replace(/-+$/g, "");
	return normalized;
}

function fileTags(pathValue: string): string[] {
	const raw = pathValue.trim();
	if (!raw) return [];
	const parts = raw.split(/[\\/]+/).filter((part) => part && part !== "." && part !== "..");
	if (parts.length === 0) return [];
	const tags: string[] = [];
	const basename = normalizeTag(parts[parts.length - 1] ?? "");
	if (basename) tags.push(basename);
	if (parts.length >= 2) {
		const parent = normalizeTag(parts[parts.length - 2] ?? "");
		if (parent) tags.push(parent);
	}
	if (parts.length >= 3) {
		const top = normalizeTag(parts[0] ?? "");
		if (top) tags.push(top);
	}
	return tags;
}

function parseJsonStringList(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((item) => (typeof item === "string" ? item.trim() : ""))
			.filter((item) => item.length > 0);
	} catch {
		return [];
	}
}

function deriveTags(input: {
	kind: string;
	title: string;
	concepts: string[];
	filesRead: string[];
	filesModified: string[];
}): string[] {
	const tags: string[] = [];
	const kindTag = normalizeTag(input.kind);
	if (kindTag) tags.push(kindTag);

	for (const concept of input.concepts) {
		const tag = normalizeTag(concept);
		if (tag) tags.push(tag);
	}

	for (const filePath of [...input.filesRead, ...input.filesModified]) {
		tags.push(...fileTags(filePath));
	}

	if (tags.length === 0 && input.title.trim()) {
		const tokens = input.title.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
		for (const token of tokens) {
			const tag = normalizeTag(token);
			if (tag) tags.push(tag);
		}
	}

	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const tag of tags) {
		if (seen.has(tag)) continue;
		seen.add(tag);
		deduped.push(tag);
		if (deduped.length >= 20) break;
	}
	return deduped;
}

/**
 * Populate memory_items.tags_text for rows where it is empty.
 * Port of Python's backfill_tags_text() maintenance helper.
 */
export function backfillTagsText(
	db: Database,
	opts: BackfillTagsTextOptions = {},
): BackfillTagsTextResult {
	const { limit, since, project, activeOnly = true, dryRun = false, memoryIds } = opts;

	const params: unknown[] = [];
	const whereClauses = ["(memory_items.tags_text IS NULL OR TRIM(memory_items.tags_text) = '')"];

	if (activeOnly) whereClauses.push("memory_items.active = 1");
	if (since) {
		whereClauses.push("memory_items.created_at >= ?");
		params.push(since);
	}

	let joinSessions = false;
	if (project) {
		const pc = projectClause(project);
		if (pc.clause) {
			whereClauses.push(pc.clause);
			params.push(...pc.params);
			joinSessions = true;
		}
	}

	if (memoryIds && memoryIds.length > 0) {
		const placeholders = memoryIds.map(() => "?").join(",");
		whereClauses.push(`memory_items.id IN (${placeholders})`);
		params.push(...memoryIds.map((id) => Number(id)));
	}

	const where = whereClauses.join(" AND ");
	const joinClause = joinSessions ? "JOIN sessions ON sessions.id = memory_items.session_id" : "";
	const limitClause = limit != null && limit > 0 ? "LIMIT ?" : "";
	if (limit != null && limit > 0) params.push(limit);

	const rows = db
		.prepare(
			`SELECT memory_items.id, memory_items.kind, memory_items.title,
			        memory_items.concepts, memory_items.files_read, memory_items.files_modified
			 FROM memory_items
			 ${joinClause}
			 WHERE ${where}
			 ORDER BY memory_items.created_at ASC
			 ${limitClause}`,
		)
		.all(...params) as Array<{
		id: number;
		kind: string | null;
		title: string | null;
		concepts: string | null;
		files_read: string | null;
		files_modified: string | null;
	}>;

	let checked = 0;
	let updated = 0;
	let skipped = 0;
	const now = new Date().toISOString();
	const updateStmt = db.prepare(
		"UPDATE memory_items SET tags_text = ?, updated_at = ? WHERE id = ?",
	);
	const updates: Array<{ id: number; tagsText: string }> = [];

	for (const row of rows) {
		checked += 1;
		const tags = deriveTags({
			kind: String(row.kind ?? ""),
			title: String(row.title ?? ""),
			concepts: parseJsonStringList(row.concepts),
			filesRead: parseJsonStringList(row.files_read),
			filesModified: parseJsonStringList(row.files_modified),
		});
		const tagsText = tags.join(" ");
		if (!tagsText) {
			skipped += 1;
			continue;
		}
		updates.push({ id: row.id, tagsText });
		updated += 1;
	}

	if (!dryRun && updates.length > 0) {
		db.transaction(() => {
			for (const update of updates) {
				updateStmt.run(update.tagsText, now, update.id);
			}
		})();
	}

	return { checked, updated, skipped };
}
