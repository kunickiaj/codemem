import { type IngestOptions, ingest, rawEventObserverStatusFromError } from "./ingest-pipeline.js";
import { ObserverAuthError } from "./observer-client.js";
import { buildFlushSessionContext } from "./raw-event-flush.js";
import {
	planRawEventRecoveryWindows,
	type RawEventRecoveryRange,
} from "./raw-event-recovery-windows.js";
import { ScopeWriteAuthorityError } from "./scope-write-authority-error.js";
import type { MemoryStore } from "./store.js";

const RECOVERY_VERSION = "raw_events_auth_recovery_v1";
const MAX_EVENTS = 100;
const MAX_STREAMS = 1000;
const MAX_RANGES_PER_STREAM = 10_000;
const MAX_ATTEMPTS = 3;
const MAX_HOURLY_CALLS = 4;
const SCOPE_DENIAL_RETRY_MS = 15_000;

interface BatchRangeRow {
	id?: number;
	source: string;
	stream_id: string;
	start_event_seq: number;
	end_event_seq: number;
}

function acknowledgeCoveredRanges(
	store: MemoryStore,
	missing: BatchRangeRow[],
	completed: RawEventRecoveryRange[],
): BatchRangeRow[] {
	const uncovered: BatchRangeRow[] = [];
	for (const row of missing) {
		if (planRawEventRecoveryWindows([recoveryRange(row)], completed, MAX_EVENTS).length > 0) {
			uncovered.push(row);
			continue;
		}
		store.db
			.prepare(`
			UPDATE raw_event_flush_batches SET status = 'recovered', updated_at = ?
			WHERE id = ? AND status IN ('failed', 'gave_up') AND observer_error_code = 'auth_missing'
		`)
			.run(new Date().toISOString(), row.id);
	}
	return uncovered;
}

function recoveryRange(row: BatchRangeRow): RawEventRecoveryRange {
	return {
		source: row.source,
		streamId: row.stream_id,
		startEventSeq: row.start_event_seq,
		endEventSeq: row.end_event_seq,
	};
}

function recoveryWindowKey(window: RawEventRecoveryRange): string {
	return JSON.stringify([window.source, window.streamId, window.startEventSeq, window.endEventSeq]);
}

function eligibleRecoveryWindow(
	store: MemoryStore,
	windows: RawEventRecoveryRange[],
	observerBudgetAvailable: boolean,
	excludedWindows: ReadonlySet<string>,
): RawEventRecoveryRange | null {
	for (const window of windows) {
		if (excludedWindows.has(recoveryWindowKey(window))) continue;
		const batch = store.db
			.prepare(`
			SELECT status, attempt_count, error_type, updated_at FROM raw_event_flush_batches
			WHERE source = ? AND stream_id = ? AND start_event_seq = ?
				AND end_event_seq = ? AND extractor_version = ?
		`)
			.get(
				window.source,
				window.streamId,
				window.startEventSeq,
				window.endEventSeq,
				RECOVERY_VERSION,
			) as
			| { status: string; attempt_count: number; error_type: string | null; updated_at: string }
			| undefined;
		if (batch?.status === "completed") continue;
		// A scope-local admission denial must not monopolize sweeps of other historical windows.
		// Keep its attempt-neutral batch retryable once this short cooldown expires.
		if (
			batch?.status === "failed" &&
			batch.error_type === "ScopeWriteAuthorityError" &&
			Date.now() < Date.parse(batch.updated_at) + SCOPE_DENIAL_RETRY_MS
		)
			continue;
		if (observerBudgetAvailable && (!batch || batch.attempt_count < MAX_ATTEMPTS)) return window;
		if (isUsageOnlyRecoveryWindow(store, window)) return window;
	}
	return null;
}

function nextRecoveryWindow(
	store: MemoryStore,
	{
		observerBudgetAvailable,
		excludedWindows,
	}: {
		observerBudgetAvailable: boolean;
		excludedWindows: ReadonlySet<string>;
	},
): RawEventRecoveryRange | null {
	const streams = store.db
		.prepare(`
		SELECT b.source, b.stream_id
		FROM raw_event_flush_batches b
		JOIN raw_event_sessions s ON s.source = b.source AND s.stream_id = b.stream_id
		WHERE b.status IN ('failed', 'gave_up') AND b.observer_error_code = 'auth_missing'
			AND b.extractor_version != ? AND s.last_flushed_event_seq >= b.end_event_seq
		GROUP BY b.source, b.stream_id ORDER BY MIN(b.created_at) LIMIT ?
	`)
		.all(RECOVERY_VERSION, MAX_STREAMS + 1) as Array<{ source: string; stream_id: string }>;
	if (streams.length > MAX_STREAMS) throw new Error("observer recovery stream limit exceeded");
	for (const stream of streams) {
		const missingRows = store.db
			.prepare(`
			SELECT b.id, b.source, b.stream_id, b.start_event_seq, b.end_event_seq
			FROM raw_event_flush_batches b
			JOIN raw_event_sessions s ON s.source = b.source AND s.stream_id = b.stream_id
			WHERE b.source = ? AND b.stream_id = ? AND b.status IN ('failed', 'gave_up')
				AND b.observer_error_code = 'auth_missing' AND b.extractor_version != ?
				AND s.last_flushed_event_seq >= b.end_event_seq
			LIMIT ?
		`)
			.all(
				stream.source,
				stream.stream_id,
				RECOVERY_VERSION,
				MAX_RANGES_PER_STREAM + 1,
			) as BatchRangeRow[];
		if (missingRows.length > MAX_RANGES_PER_STREAM)
			throw new Error("observer recovery range limit exceeded");
		const completed = store.db
			.prepare(`
			SELECT source, stream_id, start_event_seq, end_event_seq
			FROM raw_event_flush_batches WHERE source = ? AND stream_id = ? AND status = 'completed'
			LIMIT ?
		`)
			.all(stream.source, stream.stream_id, MAX_RANGES_PER_STREAM + 1) as BatchRangeRow[];
		if (completed.length > MAX_RANGES_PER_STREAM)
			throw new Error("observer recovery completed-range limit exceeded");
		const covered = completed.map(recoveryRange);
		const uncovered = acknowledgeCoveredRanges(store, missingRows, covered);
		const windows = planRawEventRecoveryWindows(uncovered.map(recoveryRange), covered, MAX_EVENTS);
		const eligible = eligibleRecoveryWindow(
			store,
			windows,
			observerBudgetAvailable,
			excludedWindows,
		);
		if (eligible) return eligible;
	}
	return null;
}

function sourceEventTime(events: Record<string, unknown>[]): string {
	const times = events.map((event) => event.timestamp_wall_ms);
	if (
		times.some(
			(time) =>
				typeof time !== "number" ||
				!Number.isSafeInteger(time) ||
				time < 0 ||
				time > Date.now() + 60_000,
		)
	) {
		throw new Error("observer recovery event time is unavailable");
	}
	return new Date(Math.max(...(times as number[]))).toISOString();
}

function recoveryWindowEvents(
	store: MemoryStore,
	range: RawEventRecoveryRange,
): Record<string, unknown>[] {
	return store.rawEventsSinceBySeq(
		range.streamId,
		range.source,
		range.startEventSeq - 1,
		MAX_EVENTS,
		range.endEventSeq,
	);
}

function isUsageOnlyRecoveryWindow(store: MemoryStore, range: RawEventRecoveryRange): boolean {
	const events = recoveryWindowEvents(store, range);
	if (events.length !== range.endEventSeq - range.startEventSeq + 1 || events.length === 0)
		return false;
	if (!events.every((event) => event.type === "assistant_usage")) return false;
	try {
		sourceEventTime(events);
		return true;
	} catch {
		return false;
	}
}

function hasPersistedRecoveryOutcome(store: MemoryStore, batchId: number): boolean {
	const row = store.db
		.prepare(`
		SELECT COUNT(*) AS count FROM memory_items
		WHERE CAST(json_extract(metadata_json, '$.flush_batch.batch_id') AS INTEGER) = ?
	`)
		.get(batchId) as { count: number };
	if (row.count > 0) return true;
	const usage = store.db
		.prepare(`
		SELECT 1 FROM usage_events WHERE event = 'observer_call'
			AND CAST(json_extract(metadata_json, '$.historical_recovery_batch_id') AS INTEGER) = ?
		LIMIT 1
	`)
		.get(batchId);
	return usage != null;
}

function withinHourlyBudget(store: MemoryStore): boolean {
	const cutoff = new Date(Date.now() - 3_600_000).toISOString();
	const calls = store.db
		.prepare(`
		SELECT (
			SELECT COALESCE(SUM(attempt_count), 0) FROM raw_event_flush_batches
			WHERE extractor_version = ? AND attempt_count > 0 AND updated_at >= ?
		) + (
			SELECT COUNT(*) FROM usage_events
			WHERE event = 'observer_recovery_scope_denial' AND created_at > ?
		) AS count
	`)
		.get(RECOVERY_VERSION, cutoff, cutoff) as { count: number };
	return calls.count < MAX_HOURLY_CALLS;
}

function linkedRecoverySession(store: MemoryStore, range: RawEventRecoveryRange) {
	const linked = store.db
		.prepare(`
			SELECT os.session_id AS sessionId, s.cwd, s.project, s.started_at AS startedAt
			FROM opencode_sessions os JOIN sessions s ON s.id = os.session_id
			WHERE os.source = ? AND os.stream_id = ?
		`)
		.get(range.source, range.streamId) as
		| { sessionId: number; cwd: string | null; project: string | null; startedAt: string | null }
		| undefined;
	if (!linked?.sessionId) throw new Error("observer recovery session missing");
	return linked;
}

async function inferRecoveryWindow(
	store: MemoryStore,
	options: IngestOptions,
	range: RawEventRecoveryRange,
	batchId: number,
	onObserverInferenceStart: () => void,
	onObserverInferenceComplete: () => void,
): Promise<void> {
	const { source, streamId, startEventSeq, endEventSeq } = range;
	const events = recoveryWindowEvents(store, range);
	if (events.length !== endEventSeq - startEventSeq + 1)
		throw new Error("observer recovery events missing");
	const linked = linkedRecoverySession(store, range);
	const occurredAt = sourceEventTime(events);
	const context = buildFlushSessionContext(events, {
		opencodeSessionId: streamId,
		source,
		startEventSeq,
		lastEventSeq: endEventSeq,
		batchId,
	});
	if (context.flushBatch) context.flushBatch.extractor_version = RECOVERY_VERSION;
	await ingest(
		{
			cwd: linked.cwd ?? undefined,
			project: linked.project ?? undefined,
			startedAt: linked.startedAt ?? undefined,
			events,
			sessionContext: context,
		},
		store,
		{
			...options,
			storeSummary: false,
			historicalRecovery: {
				sessionId: linked.sessionId,
				occurredAt,
				onObserverInferenceStart,
				onObserverInferenceComplete,
			},
		},
	);
}

function releaseRecoveryAdmissionFailure(
	store: MemoryStore,
	batchId: number,
	error: unknown,
): ObserverAuthError | ScopeWriteAuthorityError | null {
	if (error instanceof ScopeWriteAuthorityError) {
		store.releaseRawEventFlushBatchAfterAuthError(batchId, {
			code: "scope_authority",
			provider: null,
			model: null,
			runtime: null,
			authSource: null,
			authType: null,
		});
		return error;
	}
	const status = rawEventObserverStatusFromError(error);
	if (!(error instanceof ObserverAuthError || status?.lastError?.code === "auth_missing"))
		return null;
	const authError =
		error instanceof ObserverAuthError
			? error
			: new ObserverAuthError("Observer authentication is unavailable", {
					code: "auth_missing",
					message: "Observer authentication is unavailable",
				});
	const released = store.releaseRawEventFlushBatchAfterAuthError(batchId, {
		code: authError.detail.code,
		provider: status?.provider ?? null,
		model: status?.model ?? null,
		runtime: status?.runtime ?? null,
		authSource: status?.auth?.source ?? null,
		authType: status?.auth?.type ?? null,
	});
	return released ? authError : null;
}

function releaseRecoveryFailure(
	store: MemoryStore,
	batchId: number,
	error: unknown,
	completedInferenceStartedAt: string | null,
): ObserverAuthError | ScopeWriteAuthorityError | null {
	// Content persistence has already rolled back. Release and debit together so an
	// attempt-neutral scope race cannot erase the returned invocation's hourly slot.
	return store.db.transaction(() => {
		const released = releaseRecoveryAdmissionFailure(store, batchId, error);
		if (released instanceof ScopeWriteAuthorityError && completedInferenceStartedAt) {
			store.db
				.prepare(`INSERT INTO usage_events(event, created_at)
					VALUES ('observer_recovery_scope_denial', ?)`)
				.run(completedInferenceStartedAt);
		}
		return released;
	})();
}

async function recoverMissingAuthWindow(
	store: MemoryStore,
	options: IngestOptions,
	window: RawEventRecoveryRange,
	{
		observerBudgetAvailable,
		onObserverInferenceStart,
	}: {
		observerBudgetAvailable: boolean;
		onObserverInferenceStart: () => void;
	},
): Promise<boolean> {
	const usageOnly = isUsageOnlyRecoveryWindow(store, window);
	if (!usageOnly && !observerBudgetAvailable) return false;
	const batch = store.getOrCreateRawEventFlushBatch(
		window.streamId,
		window.source,
		window.startEventSeq,
		window.endEventSeq,
		RECOVERY_VERSION,
	);
	if (batch.status === "completed" || (batch.attemptCount >= MAX_ATTEMPTS && !usageOnly))
		return false;
	if (!store.claimRawEventFlushBatch(batch.batchId, { countAttempt: !usageOnly })) return false;
	if (hasPersistedRecoveryOutcome(store, batch.batchId)) {
		store.updateRawEventFlushBatchStatus(batch.batchId, "completed");
		return true;
	}
	let inferenceStartedAt: string | null = null;
	let inferenceCompleted = false;
	try {
		if (usageOnly) {
			sourceEventTime(recoveryWindowEvents(store, window));
			store.updateRawEventFlushBatchStatus(batch.batchId, "completed", { resetAttempts: true });
			return true;
		}
		await inferRecoveryWindow(
			store,
			options,
			window,
			batch.batchId,
			() => {
				inferenceStartedAt = new Date().toISOString();
				onObserverInferenceStart();
			},
			() => {
				inferenceCompleted = true;
			},
		);
		store.updateRawEventFlushBatchStatus(batch.batchId, "completed");
		return true;
	} catch (error) {
		const admissionError = releaseRecoveryFailure(
			store,
			batch.batchId,
			error,
			inferenceCompleted ? inferenceStartedAt : null,
		);
		if (admissionError) throw admissionError;
		store.recordRawEventFlushBatchFailure(batch.batchId, {
			message: "Historical observer recovery could not process this range.",
			errorType: "RawEventRecoveryError",
			observerErrorCode: "recovery_failed",
		});
		throw error;
	}
}

/** At most one historical observer invocation per sweep. Never rewinds a stream cursor. */
export async function recoverOneMissingAuthWindow(
	store: MemoryStore,
	options: IngestOptions,
): Promise<boolean> {
	const observerBudgetAvailable = withinHourlyBudget(store);
	const excludedWindows = new Set<string>();
	let firstScopeError: ScopeWriteAuthorityError | null = null;
	let observerInferenceStarted = false;
	// Cap scope-local admissions per call as well as the existing stream/range scan limits.
	for (let admission = 0; admission < MAX_STREAMS; admission++) {
		const window = nextRecoveryWindow(store, { observerBudgetAvailable, excludedWindows });
		if (!window) break;
		excludedWindows.add(recoveryWindowKey(window));
		try {
			return await recoverMissingAuthWindow(store, options, window, {
				observerBudgetAvailable,
				onObserverInferenceStart: () => {
					observerInferenceStarted = true;
				},
			});
		} catch (error) {
			if (error instanceof ScopeWriteAuthorityError && !observerInferenceStarted) {
				firstScopeError ??= error;
				continue;
			}
			throw error;
		}
	}
	if (firstScopeError) throw firstScopeError;
	return false;
}
