import { statSync } from "node:fs";
import { and, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
	assertSchemaReady,
	connect,
	type Database,
	getSchemaVersion,
	resolveDbPath,
} from "./db.js";
import { isLowSignalObservation } from "./ingest-filters.js";
import { projectClause } from "./project.js";
import * as schema from "./schema.js";
import { bootstrapSchema } from "./schema-bootstrap.js";

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
	const resolvedPath = resolveDbPath(dbPath);
	const db = connect(resolvedPath);
	try {
		if (getSchemaVersion(db) === 0) {
			bootstrapSchema(db);
		}
		assertSchemaReady(db);
		const stats = statSync(resolvedPath);
		return { path: resolvedPath, sizeBytes: stats.size };
	} finally {
		db.close();
	}
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
		const d = drizzle(db, { schema });
		const maxEvents = d
			.select({
				source: schema.rawEvents.source,
				stream_id: schema.rawEvents.stream_id,
				max_seq: sql<number>`MAX(${schema.rawEvents.event_seq})`.as("max_seq"),
			})
			.from(schema.rawEvents)
			.groupBy(schema.rawEvents.source, schema.rawEvents.stream_id)
			.as("max_events");

		const rows = d
			.select({
				source: schema.rawEventSessions.source,
				stream_id: schema.rawEventSessions.stream_id,
				opencode_session_id: schema.rawEventSessions.opencode_session_id,
				cwd: schema.rawEventSessions.cwd,
				project: schema.rawEventSessions.project,
				started_at: schema.rawEventSessions.started_at,
				last_seen_ts_wall_ms: schema.rawEventSessions.last_seen_ts_wall_ms,
				last_received_event_seq: schema.rawEventSessions.last_received_event_seq,
				last_flushed_event_seq: schema.rawEventSessions.last_flushed_event_seq,
				updated_at: schema.rawEventSessions.updated_at,
			})
			.from(schema.rawEventSessions)
			.innerJoin(
				maxEvents,
				and(
					eq(maxEvents.source, schema.rawEventSessions.source),
					eq(maxEvents.stream_id, schema.rawEventSessions.stream_id),
				),
			)
			.where(gt(maxEvents.max_seq, schema.rawEventSessions.last_flushed_event_seq))
			.orderBy(sql`${schema.rawEventSessions.updated_at} DESC`)
			.limit(limit)
			.all();

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

		const totalsRow = d
			.select({
				sessions: sql<number>`COUNT(1)`,
				pending: sql<
					number | null
				>`SUM(${maxEvents.max_seq} - ${schema.rawEventSessions.last_flushed_event_seq})`,
			})
			.from(schema.rawEventSessions)
			.innerJoin(
				maxEvents,
				and(
					eq(maxEvents.source, schema.rawEventSessions.source),
					eq(maxEvents.stream_id, schema.rawEventSessions.stream_id),
				),
			)
			.where(gt(maxEvents.max_seq, schema.rawEventSessions.last_flushed_event_seq))
			.get();

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
		const d = drizzle(db, { schema });
		const cutoffIso =
			windowHours != null ? new Date(Date.now() - windowHours * 3600 * 1000).toISOString() : null;

		// Batch counts
		const batchRow = (
			cutoffIso
				? d
						.select({
							started: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('started', 'pending') THEN 1 ELSE 0 END), 0)`,
							running: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('running', 'claimed') THEN 1 ELSE 0 END), 0)`,
							completed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} = 'completed' THEN 1 ELSE 0 END), 0)`,
							errored: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('error', 'failed') THEN 1 ELSE 0 END), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.where(gte(schema.rawEventFlushBatches.updated_at, cutoffIso))
						.get()
				: d
						.select({
							started: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('started', 'pending') THEN 1 ELSE 0 END), 0)`,
							running: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('running', 'claimed') THEN 1 ELSE 0 END), 0)`,
							completed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} = 'completed' THEN 1 ELSE 0 END), 0)`,
							errored: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('error', 'failed') THEN 1 ELSE 0 END), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.get()
		) as Record<string, number> | undefined;

		const startedBatches = Number(batchRow?.started ?? 0);
		const runningBatches = Number(batchRow?.running ?? 0);
		const completedBatches = Number(batchRow?.completed ?? 0);
		const erroredBatches = Number(batchRow?.errored ?? 0);
		const terminalBatches = completedBatches + erroredBatches;
		const flushSuccessRate = terminalBatches > 0 ? completedBatches / terminalBatches : 1.0;

		// Event counts from raw_event_sessions
		// Sequences are 0-based indexes, so +1 converts to counts.
		const eventRow = (
			cutoffIso
				? d
						.select({
							total_received: sql<number>`COALESCE(SUM(${schema.rawEventSessions.last_received_event_seq} + 1), 0)`,
							total_flushed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventSessions.last_flushed_event_seq} >= 0 THEN ${schema.rawEventSessions.last_flushed_event_seq} + 1 ELSE 0 END), 0)`,
						})
						.from(schema.rawEventSessions)
						.where(gte(schema.rawEventSessions.updated_at, cutoffIso))
						.get()
				: d
						.select({
							total_received: sql<number>`COALESCE(SUM(${schema.rawEventSessions.last_received_event_seq} + 1), 0)`,
							total_flushed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventSessions.last_flushed_event_seq} >= 0 THEN ${schema.rawEventSessions.last_flushed_event_seq} + 1 ELSE 0 END), 0)`,
						})
						.from(schema.rawEventSessions)
						.get()
		) as Record<string, number> | undefined;

		// In-flight events: sum of (end_event_seq - start_event_seq + 1) for active batches
		const inFlightRow = (
			cutoffIso
				? d
						.select({
							in_flight: sql<number>`COALESCE(SUM(${schema.rawEventFlushBatches.end_event_seq} - ${schema.rawEventFlushBatches.start_event_seq} + 1), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.where(
							and(
								inArray(schema.rawEventFlushBatches.status, [
									"started",
									"pending",
									"running",
									"claimed",
								]),
								gte(schema.rawEventFlushBatches.updated_at, cutoffIso),
							),
						)
						.get()
				: d
						.select({
							in_flight: sql<number>`COALESCE(SUM(${schema.rawEventFlushBatches.end_event_seq} - ${schema.rawEventFlushBatches.start_event_seq} + 1), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.where(
							inArray(schema.rawEventFlushBatches.status, [
								"started",
								"pending",
								"running",
								"claimed",
							]),
						)
						.get()
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
		const hasEvents = (
			cutoffIso
				? d
						.selectDistinct({
							source: schema.rawEvents.source,
							stream_id: schema.rawEvents.stream_id,
						})
						.from(schema.rawEvents)
						.where(gte(schema.rawEvents.created_at, cutoffIso))
				: d
						.selectDistinct({
							source: schema.rawEvents.source,
							stream_id: schema.rawEvents.stream_id,
						})
						.from(schema.rawEvents)
		).as("has_events");

		const boundaryRow = d
			.select({
				sessions_with_events: sql<number>`COUNT(1)`,
				sessions_with_started_at: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.rawEventSessions.started_at}, '') != '' THEN 1 ELSE 0 END), 0)`,
			})
			.from(hasEvents)
			.leftJoin(
				schema.rawEventSessions,
				and(
					eq(schema.rawEventSessions.source, hasEvents.source),
					eq(schema.rawEventSessions.stream_id, hasEvents.stream_id),
				),
			)
			.get() as Record<string, number> | undefined;

		const sessionsWithEvents = Number(boundaryRow?.sessions_with_events ?? 0);
		const sessionsWithStartedAt = Number(boundaryRow?.sessions_with_started_at ?? 0);
		const sessionBoundaryAccuracy =
			sessionsWithEvents > 0 ? sessionsWithStartedAt / sessionsWithEvents : 1.0;

		const retryDepthRow = (
			cutoffIso
				? d
						.select({
							retry_depth_max: sql<number>`COALESCE(MAX(${schema.rawEventFlushBatches.attempt_count}), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.where(gte(schema.rawEventFlushBatches.updated_at, cutoffIso))
						.get()
				: d
						.select({
							retry_depth_max: sql<number>`COALESCE(MAX(${schema.rawEventFlushBatches.attempt_count}), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.get()
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
		const d = drizzle(db, { schema });
		const now = new Date().toISOString();
		return db.transaction(() => {
			const candidateIds = d
				.select({ id: schema.rawEventFlushBatches.id })
				.from(schema.rawEventFlushBatches)
				.where(inArray(schema.rawEventFlushBatches.status, ["failed", "error"]))
				.orderBy(schema.rawEventFlushBatches.updated_at)
				.limit(limit)
				.all()
				.map((row) => Number(row.id));

			if (candidateIds.length === 0) return { retried: 0 };

			const result = d
				.update(schema.rawEventFlushBatches)
				.set({
					status: "pending",
					updated_at: now,
					error_message: null,
					error_type: null,
					observer_provider: null,
					observer_model: null,
					observer_runtime: null,
					observer_auth_source: null,
					observer_auth_type: null,
					observer_error_code: null,
					observer_error_message: null,
				})
				.where(
					and(
						inArray(schema.rawEventFlushBatches.id, candidateIds),
						inArray(schema.rawEventFlushBatches.status, ["failed", "error"]),
					),
				)
				.run();

			return { retried: Number(result.changes ?? 0) };
		})();
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

export interface DeactivateLowSignalResult {
	checked: number;
	deactivated: number;
}

export interface DeactivateLowSignalMemoriesOptions {
	kinds?: string[] | null;
	limit?: number | null;
	dryRun?: boolean;
}

const DEFAULT_LOW_SIGNAL_KINDS = [
	"observation",
	"discovery",
	"change",
	"feature",
	"bugfix",
	"refactor",
	"decision",
	"note",
	"entities",
	"session_summary",
];

const OBSERVATION_EQUIVALENT_KINDS = [
	"observation",
	"bugfix",
	"feature",
	"refactor",
	"change",
	"discovery",
	"decision",
	"exploration",
];

/**
 * Deactivate low-signal observations only.
 */
export function deactivateLowSignalObservations(
	db: Database,
	limit?: number | null,
	dryRun = false,
): DeactivateLowSignalResult {
	return deactivateLowSignalMemories(db, {
		kinds: OBSERVATION_EQUIVALENT_KINDS,
		limit,
		dryRun,
	});
}

/**
 * Deactivate low-signal memories across selected kinds (does not delete rows).
 */
export function deactivateLowSignalMemories(
	db: Database,
	opts: DeactivateLowSignalMemoriesOptions = {},
): DeactivateLowSignalResult {
	const selectedKinds =
		opts.kinds?.map((kind) => kind.trim()).filter((kind) => kind.length > 0) ?? [];
	const kinds = selectedKinds.length > 0 ? selectedKinds : DEFAULT_LOW_SIGNAL_KINDS;
	const placeholders = kinds.map(() => "?").join(",");
	const params: unknown[] = [...kinds];
	let limitClause = "";
	if (opts.limit != null && opts.limit > 0) {
		limitClause = "LIMIT ?";
		params.push(opts.limit);
	}

	const rows = db
		.prepare(
			`SELECT id, title, body_text
			 FROM memory_items
			 WHERE kind IN (${placeholders}) AND active = 1
			 ORDER BY id DESC
			 ${limitClause}`,
		)
		.all(...params) as Array<{ id: number; title: string | null; body_text: string | null }>;

	const checked = rows.length;
	const ids = rows
		.filter((row) => isLowSignalObservation(row.body_text || row.title || ""))
		.map((row) => Number(row.id));

	if (ids.length === 0 || opts.dryRun === true) {
		return { checked, deactivated: ids.length };
	}

	const now = new Date().toISOString();
	const chunkSize = 200;
	for (let start = 0; start < ids.length; start += chunkSize) {
		const chunk = ids.slice(start, start + chunkSize);
		const chunkPlaceholders = chunk.map(() => "?").join(",");
		db.prepare(
			`UPDATE memory_items SET active = 0, updated_at = ? WHERE id IN (${chunkPlaceholders})`,
		).run(now, ...chunk);
	}

	return { checked, deactivated: ids.length };
}
