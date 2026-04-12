/**
 * Raw event flush orchestration — bridge between the sweeper and the ingest pipeline.
 *
 * Ports the core flush logic from codemem/raw_event_flush.py.
 *
 * Reads unflushed raw events for a session, creates a batch record,
 * builds an IngestPayload, runs it through the ingest pipeline,
 * and updates flush state on success (or records failure details).
 */

import { extractAdapterEvent, projectAdapterToolEvent } from "./ingest-events.js";
import { type IngestOptions, ingest } from "./ingest-pipeline.js";
import { normalizeAdapterEvents, normalizeEventsForSessionContext } from "./ingest-transcript.js";
import type { IngestPayload, SessionContext } from "./ingest-types.js";
import { ObserverAuthError } from "./observer-client.js";
import type { MemoryStore } from "./store.js";

const EXTRACTOR_VERSION = "raw_events_v1";

/** Max flush attempts before a batch is permanently abandoned.
 *  Override via CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS. */
const DEFAULT_MAX_FLUSH_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateErrorMessage(message: string, limit = 280): string {
	const text = message.replace(/\s+/g, " ").trim();
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 3).trimEnd()}...`;
}

function providerDisplayName(provider: string | null | undefined): string {
	const normalized = (provider ?? "").trim().toLowerCase();
	if (normalized === "openai") return "OpenAI";
	if (normalized === "anthropic") return "Anthropic";
	if (normalized) return normalized.charAt(0).toUpperCase() + normalized.slice(1);
	return "Observer";
}

function summarizeFlushFailure(exc: Error, provider: string | null | undefined): string {
	const providerTitle = providerDisplayName(provider);
	const rawMessage = String(exc.message ?? "")
		.trim()
		.toLowerCase();

	if (exc instanceof ObserverAuthError) {
		return `${providerTitle} authentication failed. Refresh credentials and retry.`;
	}
	if (exc.name === "TimeoutError" || rawMessage.includes("timeout")) {
		return `${providerTitle} request timed out during raw-event processing.`;
	}
	if (
		rawMessage === "observer failed during raw-event flush" ||
		rawMessage === "observer produced no storable output for raw-event flush"
	) {
		return `${providerTitle} returned no usable output for raw-event processing.`;
	}
	if (/parse|xml|json/i.test(rawMessage)) {
		return `${providerTitle} response could not be processed.`;
	}
	return `${providerTitle} processing failed during raw-event ingestion.`;
}

// ---------------------------------------------------------------------------
// Session context builder
// ---------------------------------------------------------------------------

/**
 * Build session context from raw events — extracts prompt count, tool count,
 * duration, files modified/read, and first user prompt.
 *
 * Port of build_session_context() from raw_event_flush.py.
 */
export function buildSessionContext(events: Record<string, unknown>[]): SessionContext {
	let promptCount = 0;
	let toolCount = 0;

	for (const e of events) {
		if (e.type === "user_prompt") promptCount++;
		if (e.type === "tool.execute.after") toolCount++;
	}

	const tsValues: number[] = [];
	for (const e of events) {
		const ts = e.timestamp_wall_ms;
		if (ts == null) continue;
		const num = Number(ts);
		if (!Number.isFinite(num)) continue;
		tsValues.push(num);
	}
	let durationMs = 0;
	if (tsValues.length > 0) {
		const firstTs = tsValues[0];
		if (firstTs == null) {
			throw new Error("Expected timestamp when tsValues is non-empty");
		}
		const restTs = tsValues.slice(1);
		let minTs = firstTs;
		let maxTs = firstTs;
		for (const v of restTs) {
			if (v < minTs) minTs = v;
			if (v > maxTs) maxTs = v;
		}
		durationMs = Math.max(0, maxTs - minTs);
	}

	const filesModified = new Set<string>();
	const filesRead = new Set<string>();
	for (const e of events) {
		if (e.type !== "tool.execute.after") continue;
		const tool = String(e.tool ?? "").toLowerCase();
		const args = e.args;
		if (args == null || typeof args !== "object") continue;
		const argsObj = args as Record<string, unknown>;
		// Support both OpenCode-style camelCase (`filePath`) and Claude Code-style
		// snake_case (`file_path`) tool input keys. Claude Code hook payloads use
		// `file_path` verbatim from the Claude Code schema.
		const filePath = argsObj.filePath ?? argsObj.file_path ?? argsObj.path;
		if (typeof filePath !== "string" || !filePath) continue;
		if (tool === "write" || tool === "edit") filesModified.add(filePath);
		if (tool === "read") filesRead.add(filePath);
	}

	let firstPrompt: string | undefined;
	for (const e of events) {
		if (e.type !== "user_prompt") continue;
		const text = e.prompt_text;
		if (typeof text === "string" && text.trim()) {
			firstPrompt = text.trim();
			break;
		}
	}

	return {
		firstPrompt,
		promptCount,
		toolCount,
		durationMs,
		filesModified: [...filesModified].sort(),
		filesRead: [...filesRead].sort(),
	};
}

function isTerminalLowSignalSession(
	events: Record<string, unknown>[],
	sessionContext: SessionContext,
): boolean {
	const promptCount = sessionContext.promptCount ?? 0;
	const toolCount = sessionContext.toolCount ?? 0;
	if (promptCount > 0 || toolCount > 0 || sessionContext.firstPrompt) {
		return false;
	}
	if (events.length > 4) return false;

	const normalizedEvents = normalizeAdapterEvents(events);
	const hasPromptOrAssistant = normalizedEvents.some((event) => {
		const type = String(event.type ?? "");
		return type === "user_prompt" || type === "assistant_message";
	});
	if (hasPromptOrAssistant) return false;

	const hasToolSignal = events.some((event) => {
		const adapter = extractAdapterEvent(event);
		if (adapter) return projectAdapterToolEvent(adapter, event) != null;
		return String(event.type ?? "") === "tool.execute.after";
	});
	if (hasToolSignal) return false;

	const allowedTopLevelTypes = new Set(["session.started", "session.idle", "session.ended"]);
	const allowedAdapterTypes = new Set(["session_start", "session_end", "error"]);
	return events.every((event) => {
		const adapter = extractAdapterEvent(event);
		if (adapter) {
			return allowedAdapterTypes.has(String(adapter.event_type ?? ""));
		}
		return allowedTopLevelTypes.has(String(event.type ?? ""));
	});
}

// ---------------------------------------------------------------------------
// Main flush function
// ---------------------------------------------------------------------------

export interface FlushRawEventsOptions {
	opencodeSessionId: string;
	source?: string;
	cwd?: string | null;
	project?: string | null;
	startedAt?: string | null;
	maxEvents?: number | null;
}

/**
 * Flush raw events for a single session through the ingest pipeline.
 *
 * 1. Reads unflushed raw events from the store
 * 2. Creates/claims a flush batch for idempotency
 * 3. Builds session context and IngestPayload
 * 4. Calls ingest()
 * 5. Updates flush state on success; records failure details on error
 *
 * Port of flush_raw_events() from raw_event_flush.py.
 */
export async function flushRawEvents(
	store: MemoryStore,
	ingestOpts: IngestOptions,
	opts: FlushRawEventsOptions,
): Promise<{ flushed: number; updatedState: number }> {
	let { source = "opencode", cwd, project, startedAt } = opts;
	const { opencodeSessionId, maxEvents } = opts;

	source = (source ?? "").trim().toLowerCase() || "opencode";

	// Resolve session metadata for missing fields
	const meta = store.rawEventSessionMeta(opencodeSessionId, source);
	if (cwd == null) cwd = (meta.cwd as string) ?? process.cwd();
	if (project == null) project = (meta.project as string) ?? null;
	if (startedAt == null) startedAt = (meta.started_at as string) ?? null;

	// Read unflushed events
	const lastFlushed = store.rawEventFlushState(opencodeSessionId, source);
	const events = store.rawEventsSinceBySeq(opencodeSessionId, source, lastFlushed, maxEvents);
	if (events.length === 0) {
		return { flushed: 0, updatedState: 0 };
	}

	// Extract event sequence range
	const eventSeqs: number[] = [];
	for (const e of events) {
		const seq = e.event_seq;
		if (seq == null) continue;
		const num = Number(seq);
		if (Number.isFinite(num)) eventSeqs.push(num);
	}
	if (eventSeqs.length === 0) {
		return { flushed: 0, updatedState: 0 };
	}

	const firstEventSeq = eventSeqs[0];
	if (firstEventSeq == null) {
		return { flushed: 0, updatedState: 0 };
	}
	const restEventSeqs = eventSeqs.slice(1);
	let startEventSeq = firstEventSeq;
	let lastEventSeq = firstEventSeq;
	for (const v of restEventSeqs) {
		if (v < startEventSeq) startEventSeq = v;
		if (v > lastEventSeq) lastEventSeq = v;
	}
	if (lastEventSeq < startEventSeq) {
		return { flushed: 0, updatedState: 0 };
	}

	// Get or create flush batch (idempotency guard)
	const { batchId, status, attemptCount } = store.getOrCreateRawEventFlushBatch(
		opencodeSessionId,
		source,
		startEventSeq,
		lastEventSeq,
		EXTRACTOR_VERSION,
	);

	// If already completed, just advance flush state
	if (status === "completed") {
		store.updateRawEventFlushState(opencodeSessionId, lastEventSeq, source);
		return { flushed: 0, updatedState: 1 };
	}

	// Give up after too many failed attempts — mark batch as permanently failed
	// and advance the cursor so the pipeline isn't blocked forever.
	// Only trigger from terminal failure states; if another worker has the batch
	// claimed/running, fall through to the claim step which will correctly bail.
	const maxAttempts = Number.parseInt(process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS ?? "", 10);
	const effectiveMax =
		Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : DEFAULT_MAX_FLUSH_ATTEMPTS;
	if (attemptCount >= effectiveMax && (status === "failed" || status === "error")) {
		store.updateRawEventFlushBatchStatus(batchId, "gave_up");
		store.updateRawEventFlushState(opencodeSessionId, lastEventSeq, source);
		return { flushed: 0, updatedState: 1 };
	}

	// Claim the batch (atomic lock)
	if (!store.claimRawEventFlushBatch(batchId)) {
		return { flushed: 0, updatedState: 0 };
	}

	// Build session context. Claude Code raw events arrive as `claude.hook`
	// with an adapter envelope; normalize them to the flat user_prompt /
	// tool.execute.after shapes before scanning so promptCount, toolCount,
	// firstPrompt, filesRead, and filesModified are populated correctly.
	const normalizedForContext = normalizeEventsForSessionContext(events);
	const sessionContext: SessionContext = buildSessionContext(normalizedForContext);
	sessionContext.opencodeSessionId = opencodeSessionId;
	sessionContext.source = source;
	sessionContext.streamId = opencodeSessionId;
	sessionContext.flusher = "raw_events";
	sessionContext.flushBatch = {
		batch_id: batchId,
		start_event_seq: startEventSeq,
		end_event_seq: lastEventSeq,
	};

	if (isTerminalLowSignalSession(events, sessionContext)) {
		store.updateRawEventFlushBatchStatus(batchId, "completed");
		store.updateRawEventFlushState(opencodeSessionId, lastEventSeq, source);
		return { flushed: events.length, updatedState: 1 };
	}

	// Build ingest payload
	const payload: IngestPayload = {
		cwd: cwd ?? undefined,
		project: project ?? undefined,
		startedAt: startedAt ?? new Date().toISOString(),
		events,
		sessionContext,
	};

	// Run ingest pipeline
	try {
		await ingest(payload, store, ingestOpts);
	} catch (exc) {
		// Record failure details on the batch
		const err = exc instanceof Error ? exc : new Error(String(exc));
		const status = ingestOpts.observer?.getStatus?.();
		const provider = status?.provider as string | undefined;
		const message = truncateErrorMessage(summarizeFlushFailure(err, provider));
		store.recordRawEventFlushBatchFailure(batchId, {
			message,
			errorType: err instanceof ObserverAuthError ? "ObserverAuthError" : err.name,
			observerProvider: provider ?? null,
			observerModel: status?.model ?? null,
			observerRuntime: status?.runtime ?? null,
			observerAuthSource: status?.auth?.source ?? null,
			observerAuthType: status?.auth?.type ?? null,
			observerErrorCode: status?.lastError?.code ?? null,
			observerErrorMessage: truncateErrorMessage(status?.lastError?.message ?? "", 400) || null,
		});
		throw exc;
	}

	// Success — mark batch completed and advance flush state
	store.updateRawEventFlushBatchStatus(batchId, "completed");
	store.updateRawEventFlushState(opencodeSessionId, lastEventSeq, source);
	return { flushed: events.length, updatedState: 1 };
}
