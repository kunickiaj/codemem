/**
 * Session context backfill — maintenance job that re-derives and persists
 * `session_context` on historical `sessions` rows whose raw events were
 * processed before the session-context extraction fixes landed.
 *
 * The write-side fix now normalizes raw events (Claude Code hook envelopes
 * and OpenCode `apply_patch` tool payloads) before running
 * `buildSessionContext`. This module applies the same rebuild retroactively:
 * it walks raw-event-backed sessions, reloads their raw events, runs them
 * through `normalizeEventsForSessionContext` + `buildSessionContext`, and
 * rewrites `sessions.metadata_json.session_context` when the rebuild produces
 * different content-derived fields (promptCount, toolCount, durationMs,
 * firstPrompt, filesRead, filesModified).
 *
 * The job is idempotent: a second pass after the rebuild lands is a no-op
 * because the rebuilt context will match the persisted one.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import { connect, resolveDbPath } from "./db.js";
import { normalizeEventsForSessionContext } from "./ingest-transcript.js";
import type { SessionContext } from "./ingest-types.js";
import {
	completeMaintenanceJob,
	failMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import { buildSessionContext } from "./raw-event-flush.js";

export const SESSION_CONTEXT_BACKFILL_JOB = "session_context_backfill";

type SessionContextBackfillMetadata = {
	last_cursor_id?: number;
	total_candidates?: number;
	processed_sessions?: number;
	rewritten_sessions?: number;
	skipped_no_events?: number;
	skipped_no_bridge?: number;
	unchanged_sessions?: number;
};

export interface SessionContextBackfillRunnerOptions {
	batchSize?: number;
	intervalMs?: number;
	dbPath?: string;
	signal?: AbortSignal;
}

interface CandidateSessionRow {
	id: number;
	metadata_json: string | null;
	source: string | null;
	stream_id: string | null;
}

interface RawEventRow {
	event_seq: number;
	event_type: string;
	ts_wall_ms: number | null;
	ts_mono_ms: number | null;
	payload_json: string;
	event_id: string | null;
}

/**
 * Fields that `buildSessionContext` derives from raw events. Only these are
 * compared and overwritten during backfill; identity/tracking fields on the
 * persisted context (source, streamId, opencodeSessionId, flusher, flushBatch)
 * are preserved as-is.
 */
const DERIVED_FIELDS = [
	"firstPrompt",
	"promptCount",
	"toolCount",
	"durationMs",
	"filesModified",
	"filesRead",
] as const;

function countCandidateSessions(db: SqliteDatabase): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS c FROM sessions
			 WHERE json_extract(metadata_json, '$.session_context.flusher') = 'raw_events'`,
		)
		.get() as { c?: number } | undefined;
	return Number(row?.c ?? 0);
}

function selectCandidateBatch(
	db: SqliteDatabase,
	afterId: number,
	batchSize: number,
): CandidateSessionRow[] {
	return db
		.prepare(
			`SELECT
				s.id AS id,
				s.metadata_json AS metadata_json,
				os.source AS source,
				os.stream_id AS stream_id
			 FROM sessions s
			 LEFT JOIN (
				SELECT session_id, source, stream_id
				FROM opencode_sessions
				GROUP BY session_id
			 ) os ON os.session_id = s.id
			 WHERE s.id > ?
			   AND json_extract(s.metadata_json, '$.session_context.flusher') = 'raw_events'
			 ORDER BY s.id ASC
			 LIMIT ?`,
		)
		.all(afterId, batchSize) as CandidateSessionRow[];
}

function loadRawEventsForStream(
	db: SqliteDatabase,
	source: string,
	streamId: string,
): Record<string, unknown>[] {
	const rows = db
		.prepare(
			`SELECT event_seq, event_type, ts_wall_ms, ts_mono_ms, payload_json, event_id
			 FROM raw_events
			 WHERE source = ? AND stream_id = ?
			 ORDER BY event_seq ASC`,
		)
		.all(source, streamId) as RawEventRow[];
	return rows.map<Record<string, unknown>>((row) => {
		const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
		payload.type = payload.type || row.event_type;
		payload.timestamp_wall_ms = row.ts_wall_ms;
		payload.timestamp_mono_ms = row.ts_mono_ms;
		payload.event_seq = row.event_seq;
		payload.event_id = row.event_id;
		return payload;
	});
}

function parseSessionMetadata(value: string | null): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Fall through — malformed metadata_json is treated as empty.
	}
	return {};
}

function normalizeDerived(value: unknown): unknown {
	if (Array.isArray(value)) {
		return [...value].sort();
	}
	return value ?? null;
}

function derivedFieldsDiffer(existing: Record<string, unknown>, rebuilt: SessionContext): boolean {
	for (const field of DERIVED_FIELDS) {
		const a = normalizeDerived(existing[field]);
		const b = normalizeDerived((rebuilt as Record<string, unknown>)[field]);
		if (JSON.stringify(a) !== JSON.stringify(b)) return true;
	}
	return false;
}

function mergeDerivedFields(
	existing: Record<string, unknown>,
	rebuilt: SessionContext,
): Record<string, unknown> {
	const next = { ...existing };
	for (const field of DERIVED_FIELDS) {
		const rebuiltValue = (rebuilt as Record<string, unknown>)[field];
		if (rebuiltValue === undefined) {
			delete next[field];
		} else {
			next[field] = rebuiltValue;
		}
	}
	return next;
}

interface BatchResult {
	processed: number;
	rewritten: number;
	skippedNoEvents: number;
	skippedNoBridge: number;
	unchanged: number;
	lastCursorId: number;
	exhausted: boolean;
}

function processCandidateBatch(
	db: SqliteDatabase,
	candidates: CandidateSessionRow[],
	batchSize: number,
): BatchResult {
	let rewritten = 0;
	let skippedNoEvents = 0;
	let skippedNoBridge = 0;
	let unchanged = 0;
	let lastCursorId = candidates.at(-1)?.id ?? 0;

	const updateStmt = db.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?");

	for (const row of candidates) {
		lastCursorId = row.id;
		if (!row.source || !row.stream_id) {
			skippedNoBridge += 1;
			continue;
		}
		const events = loadRawEventsForStream(db, row.source, row.stream_id);
		if (events.length === 0) {
			skippedNoEvents += 1;
			continue;
		}
		const normalized = normalizeEventsForSessionContext(events);
		const rebuilt = buildSessionContext(normalized);
		const metadata = parseSessionMetadata(row.metadata_json);
		const existingContextValue = metadata.session_context;
		const existingContext =
			existingContextValue && typeof existingContextValue === "object"
				? (existingContextValue as Record<string, unknown>)
				: {};
		if (!derivedFieldsDiffer(existingContext, rebuilt)) {
			unchanged += 1;
			continue;
		}
		const mergedContext = mergeDerivedFields(existingContext, rebuilt);
		const nextMetadata = { ...metadata, session_context: mergedContext };
		updateStmt.run(JSON.stringify(nextMetadata), row.id);
		rewritten += 1;
	}

	return {
		processed: candidates.length,
		rewritten,
		skippedNoEvents,
		skippedNoBridge,
		unchanged,
		lastCursorId,
		exhausted: candidates.length < batchSize,
	};
}

export function hasPendingSessionContextBackfill(db: SqliteDatabase): boolean {
	const job = getMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB);
	if (job?.status === "completed") return false;
	return countCandidateSessions(db) > 0;
}

export async function runSessionContextBackfillPass(
	db: SqliteDatabase,
	options: { batchSize?: number } = {},
): Promise<boolean> {
	const batchSize = Math.max(1, options.batchSize ?? 100);
	const existingJob = getMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB);
	const existingMetadata = (existingJob?.metadata ?? {}) as SessionContextBackfillMetadata;

	const isFreshRun =
		!existingJob || existingJob.status === "completed" || existingJob.status === "failed";

	const lastCursorId = isFreshRun ? 0 : Number(existingMetadata.last_cursor_id ?? 0);
	const totalCandidates = isFreshRun
		? countCandidateSessions(db)
		: Number(existingMetadata.total_candidates ?? countCandidateSessions(db));

	if (isFreshRun && totalCandidates <= 0) {
		return false;
	}

	if (isFreshRun) {
		startMaintenanceJob(db, {
			kind: SESSION_CONTEXT_BACKFILL_JOB,
			title: "Backfilling session context",
			message: `Rebuilding session_context for ${totalCandidates} raw-event sessions`,
			progressTotal: totalCandidates,
			metadata: {
				last_cursor_id: 0,
				total_candidates: totalCandidates,
				processed_sessions: 0,
				rewritten_sessions: 0,
				skipped_no_events: 0,
				skipped_no_bridge: 0,
				unchanged_sessions: 0,
			},
		});
	}

	const candidates = selectCandidateBatch(db, lastCursorId, batchSize);
	if (candidates.length === 0) {
		const metadata = (getMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB)?.metadata ??
			{}) as SessionContextBackfillMetadata;
		completeMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB, {
			message: summarizeCompletion(metadata),
			progressCurrent: Number(metadata.processed_sessions ?? 0),
			progressTotal: Number(metadata.total_candidates ?? metadata.processed_sessions ?? 0),
			metadata: {
				...metadata,
				last_cursor_id: lastCursorId,
			},
		});
		return false;
	}

	const batchResult = processCandidateBatch(db, candidates, batchSize);
	const metadataBefore = (getMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB)?.metadata ??
		{}) as SessionContextBackfillMetadata;
	const processedSessions = Number(metadataBefore.processed_sessions ?? 0) + batchResult.processed;
	const rewrittenSessions = Number(metadataBefore.rewritten_sessions ?? 0) + batchResult.rewritten;
	const skippedNoEvents =
		Number(metadataBefore.skipped_no_events ?? 0) + batchResult.skippedNoEvents;
	const skippedNoBridge =
		Number(metadataBefore.skipped_no_bridge ?? 0) + batchResult.skippedNoBridge;
	const unchangedSessions = Number(metadataBefore.unchanged_sessions ?? 0) + batchResult.unchanged;
	const nextMetadata: SessionContextBackfillMetadata = {
		last_cursor_id: batchResult.lastCursorId,
		total_candidates: Number(metadataBefore.total_candidates ?? totalCandidates),
		processed_sessions: processedSessions,
		rewritten_sessions: rewrittenSessions,
		skipped_no_events: skippedNoEvents,
		skipped_no_bridge: skippedNoBridge,
		unchanged_sessions: unchangedSessions,
	};

	if (batchResult.exhausted) {
		completeMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB, {
			message: summarizeCompletion(nextMetadata),
			progressCurrent: processedSessions,
			progressTotal: Number(nextMetadata.total_candidates ?? processedSessions),
			metadata: nextMetadata,
		});
		return false;
	}

	updateMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB, {
		status: "running",
		message: `Rebuilt session_context for ${rewrittenSessions} of ${processedSessions} scanned sessions`,
		progressCurrent: processedSessions,
		progressTotal: Number(nextMetadata.total_candidates ?? processedSessions),
		metadata: nextMetadata,
	});
	return true;
}

function summarizeCompletion(metadata: SessionContextBackfillMetadata): string {
	const rewritten = Number(metadata.rewritten_sessions ?? 0);
	const processed = Number(metadata.processed_sessions ?? 0);
	const skipped = Number(metadata.skipped_no_events ?? 0) + Number(metadata.skipped_no_bridge ?? 0);
	if (processed === 0) {
		return "No raw-event sessions required session_context backfill";
	}
	if (rewritten === 0) {
		return `Scanned ${processed} sessions, no session_context rewrite required`;
	}
	const skipSuffix = skipped > 0 ? ` (${skipped} skipped)` : "";
	return `Rebuilt session_context for ${rewritten} of ${processed} sessions${skipSuffix}`;
}

export class SessionContextBackfillRunner {
	private readonly dbPath: string;
	private readonly signal?: AbortSignal;
	private readonly batchSize: number;
	private readonly intervalMs: number;
	private active = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private currentRun: Promise<void> | null = null;

	constructor(options: SessionContextBackfillRunnerOptions = {}) {
		this.dbPath = resolveDbPath(options.dbPath);
		this.signal = options.signal;
		this.batchSize = Math.max(1, options.batchSize ?? 100);
		this.intervalMs = Math.max(1000, options.intervalMs ?? 5000);
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.schedule(100);
	}

	async stop(): Promise<void> {
		this.active = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.currentRun) await this.currentRun;
	}

	private schedule(delayMs: number): void {
		if (!this.active || this.signal?.aborted) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.currentRun = this.runOnce()
				.catch((err) => {
					console.error("Session-context backfill runner tick failed:", err);
				})
				.finally(() => {
					this.currentRun = null;
					this.schedule(this.intervalMs);
				});
		}, delayMs);
		if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
	}

	private async runOnce(): Promise<void> {
		if (!this.active || this.signal?.aborted) return;
		let db: SqliteDatabase | null = null;
		try {
			db = connect(this.dbPath) as SqliteDatabase;
			const hasMoreWork = await runSessionContextBackfillPass(db, { batchSize: this.batchSize });
			if (!hasMoreWork) {
				this.active = false;
			}
		} catch (error) {
			if (db) {
				failMaintenanceJob(
					db,
					SESSION_CONTEXT_BACKFILL_JOB,
					error instanceof Error ? error.message : String(error),
				);
			}
			console.warn("Session-context backfill runner failed", error);
		} finally {
			db?.close();
		}
	}
}
