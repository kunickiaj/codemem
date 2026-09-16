/**
 * Main ingest pipeline — processes raw coding session events, calls the
 * observer LLM, and stores extracted memories.
 *
 * Ports the `ingest()` function from codemem/plugin_ingest.py.
 *
 * Pipeline stages:
 * 1. Create or reuse the session.
 * 2. Prepare normalized events and observer context.
 * 3. Select and invoke the observer.
 * 4. Build and atomically persist a memory/usage plan.
 * 5. Write vectors after commit and end the session.
 */

import { and, eq, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { boundedDelegatedBriefs, partitionDelegatedBriefEvents } from "./capture-context.js";
import { fromJson, toJson } from "./db.js";
import {
	buildTieredObserverSelection,
	decideExtractionReplayTier,
} from "./extraction-tier-routing.js";
import {
	budgetToolEvents,
	eventToToolEvent,
	extractAdapterEvent,
	extractToolEvents,
	projectAdapterToolEvent,
} from "./ingest-events.js";
import { isLowSignalObservation } from "./ingest-filters.js";
import { buildObserverPrompt, truncateObserverTranscript } from "./ingest-prompts.js";
import { type CaptureRoutedObservation, routeObservationsForCapture } from "./ingest-routing.js";
import {
	buildTranscript,
	deriveRequest,
	extractAssistantMessages,
	extractAssistantUsage,
	extractPrompts,
	firstSentence,
	isTrivialRequest,
	normalizeAdapterEvents,
} from "./ingest-transcript.js";
import type {
	IngestPayload,
	ObserverContext,
	ParsedSummary,
	SessionContext,
	ToolEvent,
} from "./ingest-types.js";
import { hasMeaningfulObservation } from "./ingest-xml-parser.js";
import { REMEMBER_MEMORY_KINDS } from "./memory-kinds.js";
import {
	ObserverAuthError,
	type ObserverClient,
	ObserverClient as ObserverClientImpl,
	type ObserverTokenUsage,
} from "./observer-client.js";
import {
	type NormalizedObserverOutput,
	ObserverOutputError,
	ObserverOutputTransportError,
	observeAndNormalizeObserverOutput,
	observerOutputAttemptCount,
	observerOutputFailureStatus,
	observerOutputMetadata,
	observerOutputTotalUsage,
	resolveObserverOutputCapability,
} from "./observer-output.js";
import { resolveProject } from "./project.js";
import { normalizeProjectLabel } from "./project-label.js";
import { resolveAdjacentDelegatedContext } from "./raw-event-context.js";
import * as schema from "./schema.js";
import { classifySessionForInjection, shouldSuppressSummaryOnlyOutput } from "./session-policy.js";
import type { MemoryStore } from "./store.js";
import { recordReplicationOp } from "./sync-replication.js";
import { deriveTags } from "./tags.js";
import { storeVectors } from "./vectors.js";

// ---------------------------------------------------------------------------
// Allowed memory kinds (matches Python)
// ---------------------------------------------------------------------------

const ALLOWED_KINDS = new Set<string>(REMEMBER_MEMORY_KINDS);

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

function normalizePath(path: string, repoRoot: string | null): string {
	if (!path) return "";
	const cleaned = path.trim();
	if (!repoRoot) return cleaned;
	const root = repoRoot.replace(/\/+$/, "");
	if (cleaned === root) return ".";
	if (cleaned.startsWith(`${root}/`)) return cleaned.slice(root.length + 1);
	return cleaned;
}

function normalizePaths(paths: string[], repoRoot: string | null): string[] {
	return paths.map((p) => normalizePath(p, repoRoot)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Session-summary emission guard
// ---------------------------------------------------------------------------

/**
 * Soft-delete prior active `session_summary` memories written by the observer
 * for a session so each session holds at most one live observer summary.
 *
 * The observer pipeline writes a summary per flush batch. Long-running
 * "durable" sessions therefore accumulate hundreds of per-flush summaries that
 * crowd out typed observations and poison retrieval. This helper enforces the
 * "one active observer summary per session" invariant by superseding earlier
 * active rows whose `metadata.source === "observer_summary"`, leaving them
 * soft-deleted for audit (with `superseded_at` metadata) and recording
 * replication ops so peers drop the stale rows.
 *
 * Must be called *before* the new summary is persisted. If it ran afterward,
 * `store.remember`'s title dedupe could return an existing stale summary's id
 * rather than inserting a new row, and this helper would then treat that
 * stale id as the replacement and wipe out newer summaries in the session.
 * Running first ensures the dedupe query sees no prior active matches.
 *
 * Only `observer_summary` rows are touched; manually-created or
 * legacy-imported session summaries are left alone.
 *
 * Returns the ids of the superseded rows so callers can backfill
 * `superseded_by` once the new replacement id is known.
 */
export function supersedePriorObserverSummaries(
	store: MemoryStore,
	d: ReturnType<typeof drizzle>,
	sessionId: number,
): number[] {
	const rows = d
		.select({
			id: schema.memoryItems.id,
			rev: schema.memoryItems.rev,
			metadata_json: schema.memoryItems.metadata_json,
		})
		.from(schema.memoryItems)
		.where(
			and(
				eq(schema.memoryItems.session_id, sessionId),
				eq(schema.memoryItems.kind, "session_summary"),
				eq(schema.memoryItems.active, 1),
			),
		)
		.all();

	if (rows.length === 0) return [];

	const now = new Date().toISOString();
	const superseded: number[] = [];
	for (const row of rows) {
		const meta = fromJson(row.metadata_json);
		if (meta.source !== "observer_summary") continue;
		meta.superseded_at = now;
		meta.clock_device_id = store.deviceId;
		d.update(schema.memoryItems)
			.set({
				active: 0,
				deleted_at: now,
				updated_at: now,
				metadata_json: toJson(meta),
				rev: (row.rev ?? 0) + 1,
			})
			.where(eq(schema.memoryItems.id, row.id))
			.run();
		try {
			recordReplicationOp(store.db, {
				memoryId: row.id,
				opType: "delete",
				deviceId: store.deviceId,
			});
		} catch {
			// Replication-op recording is best-effort; continue with supersede.
		}
		superseded.push(row.id);
	}
	return superseded;
}

/**
 * Annotate rows superseded by `supersedePriorObserverSummaries` with the id of
 * the replacement summary. Local audit only — no rev bump or replication op,
 * since peers already learned of the soft-delete from the primary supersede.
 */
function markSupersededBy(
	d: ReturnType<typeof drizzle>,
	supersededIds: number[],
	replacementId: number,
): void {
	if (supersededIds.length === 0) return;
	for (const id of supersededIds) {
		const row = d
			.select({ metadata_json: schema.memoryItems.metadata_json })
			.from(schema.memoryItems)
			.where(eq(schema.memoryItems.id, id))
			.get();
		if (!row) continue;
		const meta = fromJson(row.metadata_json);
		meta.superseded_by = replacementId;
		d.update(schema.memoryItems)
			.set({ metadata_json: toJson(meta) })
			.where(eq(schema.memoryItems.id, id))
			.run();
	}
}

// ---------------------------------------------------------------------------
// Summary body formatting
// ---------------------------------------------------------------------------

function summaryBody(summary: ParsedSummary): string {
	const sections: [string, string][] = [
		["Request", summary.request],
		["Completed", summary.completed],
		["Learned", summary.learned],
		["Investigated", summary.investigated],
		["Next steps", summary.nextSteps],
		["Notes", summary.notes],
	];
	return sections
		.filter(([, value]) => value)
		.map(([label, value]) => `## ${label}\n${value}`)
		.join("\n\n");
}

// ---------------------------------------------------------------------------
// Event normalization (adapter projection)
// ---------------------------------------------------------------------------

/**
 * Convert raw events with adapter envelopes into normalized flat events.
 * Handles both tool events (via adapter projection) and transcript events
 * (via normalizeAdapterEvents).
 */
function normalizeEventsForToolExtraction(
	events: Record<string, unknown>[],
	maxChars: number,
): ToolEvent[] {
	const toolEvents: ToolEvent[] = [];
	for (const event of events) {
		const adapter = extractAdapterEvent(event);
		if (adapter) {
			// Skip tool_call events (only tool_result matters)
			if (adapter.event_type === "tool_call") continue;
			const projected = projectAdapterToolEvent(adapter, event);
			if (projected) {
				const te = eventToToolEvent(projected, maxChars);
				if (te) {
					toolEvents.push(te);
					continue;
				}
			}
		}
		// Direct (non-adapter) events
		const directEvents = extractToolEvents([event], maxChars);
		toolEvents.push(...directEvents);
	}
	return toolEvents;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export interface IngestOptions {
	/** Observer LLM client. */
	observer: ObserverClient;
	/** Optional hook to create a routed observer during tests or controlled integrations. */
	createTierObserver?: (config: ReturnType<ObserverClient["toConfig"]>) => ObserverClient;
	/** Maximum chars per tool event payload (from config). Default 12000. */
	maxChars?: number;
	/** Maximum chars for observer total budget. Default 12000. */
	observerMaxChars?: number;
	/** Whether to store summaries. Default true. */
	storeSummary?: boolean;
	/** Whether to store typed observations. Default true. */
	storeTyped?: boolean;
}

export type RawEventObserverOutputFailureReason =
	| "no_processable_input"
	| "empty_observer_output"
	| "lossy_repair"
	| "unstorable_observer_output";

const observerFailureStatuses = new WeakMap<object, ReturnType<ObserverClient["getStatus"]>>();

export class RawEventObserverOutputError extends Error {
	readonly observerStatus: ReturnType<ObserverClient["getStatus"]>;
	readonly reason: RawEventObserverOutputFailureReason;

	constructor(
		message: string,
		reason: RawEventObserverOutputFailureReason,
		observer: ObserverClient,
		options: {
			includeObserverError?: boolean;
			observerStatus?: ReturnType<ObserverClient["getStatus"]>;
		} = {},
	) {
		super(message);
		this.name = "RawEventObserverOutputError";
		this.reason = reason;
		const observerStatus = options.observerStatus ?? observer.getStatus();
		if (options.includeObserverError === false) {
			const { lastError: _lastError, ...statusWithoutError } = observerStatus;
			this.observerStatus = statusWithoutError;
			return;
		}
		this.observerStatus = observerStatus;
	}
}

export function rawEventObserverStatusFromError(
	error: unknown,
): ReturnType<ObserverClient["getStatus"]> | null {
	if (error instanceof RawEventObserverOutputError) return error.observerStatus;
	if ((typeof error !== "object" && typeof error !== "function") || error === null) return null;
	return observerFailureStatuses.get(error) ?? null;
}

function observerStatusForFailure(observer: ObserverClient, error: unknown) {
	const status = observer.getStatus();
	if (error instanceof ObserverAuthError) status.lastError = { ...error.detail };
	if (!(error instanceof ObserverOutputError || error instanceof ObserverOutputTransportError)) {
		return status;
	}
	const callError = error.outcome?.error;
	if (error.outcome) delete status.lastError;
	if (callError) status.lastError = { ...callError };
	return status;
}

function recordObserverFailureUsage(
	error: ObserverOutputError | ObserverOutputTransportError,
	status: ReturnType<ObserverClient["getStatus"]>,
	usageContext: { store: MemoryStore; sessionId: number; project: string | null },
): void {
	const usage = error.telemetry.totalUsage;
	try {
		recordObserverUsage(
			usageContext.store,
			usageContext.sessionId,
			normalizedObserverTokenCounts(usage, status.provider),
			{
				project: usageContext.project,
				token_usage: observerTokenUsageMetadata(
					usage,
					observerDiagnosticsAttemptCount(error.diagnostics),
				),
				provider: status.provider,
				model: status.model,
				runtime: status.runtime,
				observer_output_failure_reason: error.diagnostics.failureReason,
				observer_output_retry_attempted: error.diagnostics.retryAttempted,
				observer_output_repair_attempted: error.diagnostics.repairAttempted,
				observer_output_total_elapsed_ms: error.telemetry.totalElapsedMs,
				observer_output_total_usage: usage,
			},
		);
	} catch {
		// Failure telemetry is best-effort and must not replace the observer cause.
	}
}

async function observeRawEventOutput(
	observer: ObserverClient,
	system: string,
	user: string,
	capability: ReturnType<typeof resolveObserverOutputCapability>,
	usageContext: { store: MemoryStore; sessionId: number; project: string | null },
): Promise<Awaited<ReturnType<typeof observeAndNormalizeObserverOutput>>> {
	try {
		return await observeAndNormalizeObserverOutput(observer, system, user, capability);
	} catch (error) {
		const status = observerStatusForFailure(observer, error);
		if ((typeof error === "object" || typeof error === "function") && error !== null) {
			observerFailureStatuses.set(error, status);
		}
		if (error instanceof ObserverOutputError || error instanceof ObserverOutputTransportError) {
			recordObserverFailureUsage(error, status, usageContext);
		}
		throw error;
	}
}

function delegatedBriefsForObserver(
	context: SessionContext,
	priorBriefs: string[],
	currentBriefs: string[],
): string[] | undefined {
	if (!isTrustedOpenCodeRawEventContext(context)) return undefined;
	const briefs = boundedDelegatedBriefs([...priorBriefs, ...currentBriefs]);
	return briefs.length ? briefs : undefined;
}

function isTrustedOpenCodeRawEventContext(
	context: SessionContext,
): context is SessionContext & { source: "opencode"; flusher: "raw_events" } {
	return context.source === "opencode" && context.flusher === "raw_events";
}

function resolvePriorDelegatedContext(
	store: MemoryStore,
	context: SessionContext,
): { briefs: string[]; hasDelegatedTask: boolean } {
	if (!isTrustedOpenCodeRawEventContext(context)) {
		return { briefs: [], hasDelegatedTask: false };
	}
	const opencodeSessionId = context.opencodeSessionId;
	if (!context.streamId || !opencodeSessionId || context.streamId !== opencodeSessionId) {
		return { briefs: [], hasDelegatedTask: false };
	}
	const startEventSeq = context.flushBatch?.start_event_seq;
	const extractorVersion = context.flushBatch?.extractor_version;
	if (typeof startEventSeq !== "number" || typeof extractorVersion !== "string") {
		return { briefs: [], hasDelegatedTask: false };
	}
	return resolveAdjacentDelegatedContext(store.db, {
		source: context.source,
		streamId: context.streamId,
		opencodeSessionId,
		startEventSeq,
		extractorVersion,
	});
}

function sessionContextForStorage(
	context: SessionContext,
): Omit<SessionContext, "delegatedBriefs"> {
	const { delegatedBriefs: _delegatedBriefs, ...persistent } = context;
	if (!persistent.flushBatch) return persistent;
	const { batch_id, start_event_seq, end_event_seq, extractor_version } = persistent.flushBatch;
	const flushBatch = { batch_id, start_event_seq, end_event_seq, extractor_version };
	return { ...persistent, flushBatch };
}

interface IngestSessionStage {
	captureRoutingEnabled: boolean;
	cwd: string;
	d: ReturnType<typeof drizzle>;
	events: Record<string, unknown>[];
	maxChars: number;
	observerMaxChars: number;
	priorDelegatedContext: ReturnType<typeof resolvePriorDelegatedContext>;
	project: string | null;
	sessionContext: SessionContext;
	sessionId: number;
	storeSummary: boolean;
	storeTyped: boolean;
}

interface PreparedIngestStage {
	assistantUsageEvents: ReturnType<typeof extractAssistantUsage>;
	hasDelegatedTask: boolean;
	lastAssistantMessage: string | null;
	latestPrompt: string | null;
	observerContext: ObserverContext;
	promptNumber: number | null;
	shouldProcess: boolean;
	toolEvents: ToolEvent[];
	transcript: string;
}

interface ObserverSelectionStage {
	fallbackApplied: boolean;
	fallbackReason: string | null;
	observer: ObserverClient;
	requestedModel: string | null;
	requestedOpenAIResponses: boolean | null;
	requestedProvider: string | null;
	requestedRuntime: string | null;
	tier: "simple" | "rich" | null;
	tierReasons: string[];
}

interface ObserverInferenceStage {
	observerStatus: ReturnType<ObserverClient["getStatus"]>;
	output: NormalizedObserverOutput;
	outputMetadata: Record<string, unknown>;
	response: NormalizedObserverOutput["final"];
	selection: ObserverSelectionStage;
	usage: ObserverTokenUsage | null;
}

interface PlannedMemory {
	bodyText: string;
	confidence: number;
	kind: string;
	metadata: Record<string, unknown>;
	tags: ReturnType<typeof deriveTags>;
	title: string;
}

interface PersistIngestPlan {
	memories: PlannedMemory[];
	observerCallMetadata: Record<string, unknown>;
	observerTokenCounts: ReturnType<typeof normalizedObserverTokenCounts>;
	sessionMetadata: Record<string, unknown>;
	summaryIndex: number | null;
}

interface SkipIngestPlan {
	observerCallMetadata: Record<string, unknown>;
	sessionMetadata: Record<string, unknown>;
}

type IngestPersistencePlan =
	| { action: "persist"; plan: PersistIngestPlan }
	| { action: "skip"; plan: SkipIngestPlan };

function insertPluginSession(
	stage: Pick<IngestSessionStage, "cwd" | "d" | "project" | "sessionContext">,
	metadata: Record<string, unknown>,
	now: string,
): number {
	const rows = stage.d
		.insert(schema.sessions)
		.values({
			started_at: now,
			cwd: stage.cwd,
			project: stage.project,
			user: process.env.USER ?? "unknown",
			tool_version: "plugin-ts",
			metadata_json: toJson(metadata),
		})
		.returning({ id: schema.sessions.id })
		.all();
	const id = rows[0]?.id;
	if (id == null) throw new Error("session insert returned no id");
	return id;
}

function resolveIngestSessionId(
	stage: Pick<IngestSessionStage, "cwd" | "d" | "project" | "sessionContext">,
	store: MemoryStore,
	payload: IngestPayload,
	metadata: Record<string, unknown>,
	now: string,
): number {
	const { sessionContext } = stage;
	if (sessionContext.flusher !== "raw_events" || !sessionContext.opencodeSessionId) {
		return insertPluginSession(stage, metadata, now);
	}
	return store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: sessionContext.opencodeSessionId,
		source: sessionContext.source,
		cwd: stage.cwd,
		project: stage.project,
		metadata,
		startedAt: payload.startedAt ?? now,
		toolVersion: "raw_events",
	});
}

function createIngestSession(
	payload: IngestPayload,
	store: MemoryStore,
	options: IngestOptions,
): IngestSessionStage | null {
	const cwd = payload.cwd ?? process.cwd();
	const events = payload.events ?? [];
	if (!Array.isArray(events) || events.length === 0) return null;

	const sessionContext = payload.sessionContext ?? {};
	const priorDelegatedContext = resolvePriorDelegatedContext(store, sessionContext);
	const storeSummary = options.storeSummary ?? true;
	const storeTyped = options.storeTyped ?? true;
	const maxChars = options.maxChars ?? 12_000;
	const observerMaxChars = options.observerMaxChars ?? 12_000;
	const captureRoutingEnabled = process.env.CODEMEM_CAPTURE_ROUTING === "1";
	const d = drizzle(store.db, { schema });
	const now = new Date().toISOString();
	const project = normalizeProjectLabel(payload.project) ?? resolveProject(cwd) ?? null;
	const sessionMetadata = {
		source: "plugin",
		event_count: events.length,
		started_at: payload.startedAt,
		session_context: sessionContextForStorage(sessionContext),
	};

	const sessionId = resolveIngestSessionId(
		{ cwd, d, project, sessionContext },
		store,
		payload,
		sessionMetadata,
		now,
	);

	return {
		captureRoutingEnabled,
		cwd,
		d,
		events,
		maxChars,
		observerMaxChars,
		priorDelegatedContext,
		project,
		sessionContext,
		sessionId,
		storeSummary,
		storeTyped,
	};
}

function buildSessionInfoText(context: SessionContext): string {
	const parts: string[] = [];
	if ((context.promptCount ?? 0) > 1) parts.push(`Session had ${context.promptCount} prompts`);
	if ((context.toolCount ?? 0) > 0) parts.push(`${context.toolCount} tool executions`);
	if ((context.durationMs ?? 0) > 0) {
		parts.push(`~${((context.durationMs ?? 0) / 60000).toFixed(1)} minutes of work`);
	}
	if (context.filesModified?.length) {
		parts.push(`Modified: ${context.filesModified.slice(0, 5).join(", ")}`);
	}
	if (context.filesRead?.length) parts.push(`Read: ${context.filesRead.slice(0, 5).join(", ")}`);
	return parts.join("; ");
}

function buildObserverPromptText(latestPrompt: string | null, context: SessionContext): string {
	const info = buildSessionInfoText(context);
	if (!info) return latestPrompt ?? "";
	if (!latestPrompt) return `[Session context: ${info}]`;
	return `${latestPrompt}\n\n[Session context: ${info}]`;
}

function buildPreparedObserverContext(
	stage: IngestSessionStage,
	input: {
		currentDelegatedBriefs: string[];
		lastAssistantMessage: string | null;
		latestPrompt: string | null;
		promptNumber: number | null;
		toolEvents: ToolEvent[];
		transcript: string;
	},
): ObserverContext {
	const transcriptBudget = Math.max(1500, Math.min(5000, Math.floor(stage.observerMaxChars * 0.4)));
	return {
		delegatedBriefs: delegatedBriefsForObserver(
			stage.sessionContext,
			stage.priorDelegatedContext.briefs.length
				? stage.priorDelegatedContext.briefs
				: (stage.sessionContext.delegatedBriefs ?? []),
			input.currentDelegatedBriefs,
		),
		project: stage.project,
		userPrompt: buildObserverPromptText(input.latestPrompt, stage.sessionContext),
		promptNumber: input.promptNumber,
		transcript: truncateObserverTranscript(input.transcript, transcriptBudget),
		toolEvents: input.toolEvents,
		lastAssistantMessage: stage.storeSummary ? input.lastAssistantMessage : null,
		includeSummary: stage.storeSummary,
		diffSummary: "",
		recentFiles: "",
	};
}

function hasProcessableInput(
	stage: IngestSessionStage,
	latestPrompt: string | null,
	toolEvents: ToolEvent[],
	lastAssistantMessage: string | null,
): boolean {
	if (
		latestPrompt &&
		isTrivialRequest(latestPrompt) &&
		toolEvents.length === 0 &&
		!lastAssistantMessage
	) {
		return false;
	}
	return (
		toolEvents.length > 0 ||
		Boolean(latestPrompt) ||
		(stage.storeSummary && Boolean(lastAssistantMessage))
	);
}

function prepareIngestInput(stage: IngestSessionStage): PreparedIngestStage {
	const normalizedEvents = normalizeAdapterEvents(stage.events);
	const partitioned = isTrustedOpenCodeRawEventContext(stage.sessionContext)
		? partitionDelegatedBriefEvents(normalizedEvents)
		: { primaryEvents: normalizedEvents, delegatedBriefs: [] };
	const hasDelegatedTask =
		partitioned.delegatedBriefs.length > 0 || stage.priorDelegatedContext.hasDelegatedTask;
	const prompts = extractPrompts(partitioned.primaryEvents);
	const promptNumber =
		prompts.length > 0 ? (prompts[prompts.length - 1]?.promptNumber ?? prompts.length) : null;
	const toolBudget = Math.max(2000, Math.min(8000, stage.observerMaxChars - 5000));
	const toolEvents = budgetToolEvents(
		normalizeEventsForToolExtraction(stage.events, stage.maxChars),
		toolBudget,
		30,
	);
	const assistantMessages = extractAssistantMessages(partitioned.primaryEvents);
	const assistantUsageEvents = extractAssistantUsage(partitioned.primaryEvents);
	const lastAssistantMessage = assistantMessages.at(-1) ?? null;
	const latestPrompt =
		stage.sessionContext.firstPrompt ??
		(prompts.length > 0 ? prompts[prompts.length - 1]?.promptText : null) ??
		null;
	const shouldProcess = hasProcessableInput(stage, latestPrompt, toolEvents, lastAssistantMessage);
	const transcript = buildTranscript(partitioned.primaryEvents);
	const observerContext = buildPreparedObserverContext(stage, {
		currentDelegatedBriefs: partitioned.delegatedBriefs,
		lastAssistantMessage,
		latestPrompt,
		promptNumber,
		toolEvents,
		transcript,
	});
	return {
		assistantUsageEvents,
		hasDelegatedTask,
		lastAssistantMessage,
		latestPrompt,
		observerContext,
		promptNumber,
		shouldProcess,
		toolEvents,
		transcript,
	};
}

function selectObserverForIngest(
	stage: IngestSessionStage,
	prepared: PreparedIngestStage,
	options: IngestOptions,
): ObserverSelectionStage {
	const selection: ObserverSelectionStage = {
		fallbackApplied: false,
		fallbackReason: null,
		observer: options.observer,
		requestedModel: null,
		requestedOpenAIResponses: null,
		requestedProvider: null,
		requestedRuntime: null,
		tier: null,
		tierReasons: [],
	};
	if (!options.observer.tierRoutingEnabled) return selection;

	const flushBatchId =
		stage.sessionContext.flushBatch &&
		typeof stage.sessionContext.flushBatch === "object" &&
		"batch_id" in stage.sessionContext.flushBatch
			? Number((stage.sessionContext.flushBatch as Record<string, unknown>).batch_id ?? 0)
			: 0;
	const decision = decideExtractionReplayTier({
		batchId: Number.isFinite(flushBatchId) ? flushBatchId : 0,
		sessionId: stage.sessionId,
		eventSpan: stage.events.length,
		promptCount: stage.sessionContext.promptCount ?? 0,
		toolCount: stage.sessionContext.toolCount ?? 0,
		transcriptLength: prepared.transcript.length,
	});
	const tierSelection = buildTieredObserverSelection(options.observer.toConfig(), decision);
	return {
		fallbackApplied: tierSelection.metadata.fallbackApplied,
		fallbackReason: tierSelection.metadata.fallbackReason,
		observer: options.createTierObserver
			? options.createTierObserver(tierSelection.observer)
			: new ObserverClientImpl(tierSelection.observer),
		requestedModel: tierSelection.metadata.requestedModel,
		requestedOpenAIResponses: tierSelection.metadata.requestedOpenAIResponses,
		requestedProvider: tierSelection.metadata.requestedProvider,
		requestedRuntime: tierSelection.metadata.requestedRuntime,
		tier: decision.tier,
		tierReasons: decision.reasons,
	};
}

async function runObserverInference(
	store: MemoryStore,
	stage: IngestSessionStage,
	prepared: PreparedIngestStage,
	options: IngestOptions,
): Promise<ObserverInferenceStage> {
	const selection = selectObserverForIngest(stage, prepared, options);
	const outputCapability = resolveObserverOutputCapability(selection.observer);
	const { system, user } = buildObserverPrompt(prepared.observerContext, {
		outputMode: outputCapability.actualMode,
	});
	const output = await observeRawEventOutput(selection.observer, system, user, outputCapability, {
		store,
		sessionId: stage.sessionId,
		project: stage.project,
	});
	return {
		observerStatus: selection.observer.getStatus(),
		output,
		outputMetadata: observerOutputMetadata(output),
		response: output.final,
		selection,
		usage: observerOutputTotalUsage(output),
	};
}

function observerMemoryMetadata(inference: ObserverInferenceStage): Record<string, unknown> {
	const { response, selection } = inference;
	return {
		observer_tier: selection.tier,
		observer_tier_reasons: selection.tierReasons,
		observer_requested_provider: selection.requestedProvider,
		observer_requested_model: selection.requestedModel,
		observer_requested_runtime: selection.requestedRuntime,
		observer_requested_openai_responses: selection.requestedOpenAIResponses,
		observer_provider: response.provider,
		observer_model: response.model,
		observer_runtime: inference.observerStatus.runtime,
		observer_openai_responses: selection.observer.openaiUseResponses,
		observer_fallback_applied: selection.fallbackApplied,
		observer_fallback_reason: selection.fallbackReason,
		...inference.outputMetadata,
	};
}

type SummaryCandidate = { summary: ParsedSummary; request: string; body: string };

interface CaptureRoutingStage {
	candidateCount: number;
	observations: CaptureRoutedObservation[];
	suppressedCount: number;
}

interface OutputDispositionStage {
	sessionClass: ReturnType<typeof classifySessionForInjection>;
	sessionMetadata: Record<string, unknown>;
	softSkip: boolean;
	summary: SummaryCandidate | null;
}

function filterObservationsForPersistence(
	stage: IngestSessionStage,
	parsed: ObserverInferenceStage["response"]["parsed"],
): CaptureRoutedObservation[] {
	if (!stage.storeTyped || !hasMeaningfulObservation(parsed.observations)) return [];
	const observations: CaptureRoutedObservation[] = [];
	for (const observation of parsed.observations) {
		const kind = observation.kind.trim().toLowerCase();
		if (!ALLOWED_KINDS.has(kind)) continue;
		if (!observation.title && !observation.narrative) continue;
		if (
			isLowSignalObservation(observation.title) ||
			isLowSignalObservation(observation.narrative)
		) {
			continue;
		}
		observation.filesRead = normalizePaths(observation.filesRead, stage.cwd);
		observation.filesModified = normalizePaths(observation.filesModified, stage.cwd);
		observations.push(observation);
	}
	return observations;
}

function prepareSummaryForPersistence(
	stage: IngestSessionStage,
	parsed: ObserverInferenceStage["response"]["parsed"],
): SummaryCandidate | null {
	if (!stage.storeSummary || !parsed.summary || parsed.skipSummaryReason) return null;
	const summary = parsed.summary;
	const hasContent =
		summary.request ||
		summary.investigated ||
		summary.learned ||
		summary.completed ||
		summary.nextSteps ||
		summary.notes;
	if (!hasContent) return null;
	summary.filesRead = normalizePaths(summary.filesRead, stage.cwd);
	summary.filesModified = normalizePaths(summary.filesModified, stage.cwd);
	let request = summary.request;
	if (isTrivialRequest(request)) request = deriveRequest(summary) || request;
	const body = summaryBody(summary);
	if (!body || isLowSignalObservation(firstSentence(body))) return null;
	return { summary, request, body };
}

function logCaptureSuppressions(count: number, reasons: string[]): void {
	if (count === 0 || process.env.CODEMEM_DEBUG !== "1") return;
	const reasonText = [...new Set(reasons)].join(", ") || "unknown";
	for (let i = 0; i < count; i += 1) {
		console.error(
			`[codemem] capture routing suppressed telemetry observation (reasons=${reasonText})`,
		);
	}
}

function applyCaptureRouting(
	stage: IngestSessionStage,
	observations: CaptureRoutedObservation[],
): CaptureRoutingStage {
	if (!stage.captureRoutingEnabled) {
		return { candidateCount: 0, observations, suppressedCount: 0 };
	}
	const routed = routeObservationsForCapture(observations, {
		project: stage.project,
		sessionMinutes:
			typeof stage.sessionContext.durationMs === "number"
				? stage.sessionContext.durationMs / 60000
				: null,
	});
	const candidateCount = routed.kept.filter(
		(observation) => observation.derivation?.candidate === true,
	).length;
	logCaptureSuppressions(routed.suppressedTelemetry.count, routed.suppressedTelemetry.reasons);
	return {
		candidateCount,
		observations: routed.kept,
		suppressedCount: routed.suppressedTelemetry.count,
	};
}

function shouldSoftSkipRawOutput(
	stage: IngestSessionStage,
	prepared: PreparedIngestStage,
	inference: ObserverInferenceStage,
	capture: CaptureRoutingStage,
	summary: SummaryCandidate | null,
): boolean {
	const parsed = inference.response.parsed;
	const pureLowSignalSkip =
		parsed.skipSummaryReason?.trim().toLowerCase() === "low-signal" &&
		parsed.observations.length === 0 &&
		parsed.summary === null;
	const locallySuppressedSummaryOnlyMicro =
		parsed.observations.length === 0 &&
		parsed.summary !== null &&
		shouldSuppressSummaryOnlyOutput({
			sessionContext: stage.sessionContext,
			observationsCount: 0,
			hasSummaryCandidate: true,
			latestPrompt: prepared.latestPrompt,
			toolEventCount: prepared.toolEvents.length,
			hasAssistantMessage: Boolean(prepared.lastAssistantMessage),
			hasDelegatedTask: prepared.hasDelegatedTask,
			skipSummaryReason: parsed.skipSummaryReason,
		});
	const captureSuppressedTelemetryOnly =
		stage.captureRoutingEnabled &&
		capture.suppressedCount > 0 &&
		parsed.observations.length > 0 &&
		capture.suppressedCount === parsed.observations.length &&
		summary == null;
	return pureLowSignalSkip || locallySuppressedSummaryOnlyMicro || captureSuppressedTelemetryOnly;
}

function resolveOutputDisposition(
	stage: IngestSessionStage,
	prepared: PreparedIngestStage,
	inference: ObserverInferenceStage,
	capture: CaptureRoutingStage,
	summaryCandidate: SummaryCandidate | null,
): OutputDispositionStage {
	const parsed = inference.response.parsed;
	const sessionClass = classifySessionForInjection({
		sessionContext: stage.sessionContext,
		latestPrompt: prepared.latestPrompt,
		toolEventCount: prepared.toolEvents.length,
		hasAssistantMessage: Boolean(prepared.lastAssistantMessage),
		observationsCount: capture.observations.length,
		hasSummaryCandidate: summaryCandidate != null,
		hasDelegatedTask: prepared.hasDelegatedTask,
	});
	let summary = summaryCandidate;
	let summaryDisposition: "stored" | "suppressed" | "none" = summary ? "stored" : "none";
	const suppressSummary = shouldSuppressSummaryOnlyOutput({
		sessionContext: stage.sessionContext,
		observationsCount: capture.observations.length,
		hasSummaryCandidate: summary != null,
		latestPrompt: prepared.latestPrompt,
		toolEventCount: prepared.toolEvents.length,
		hasAssistantMessage: Boolean(prepared.lastAssistantMessage),
		hasDelegatedTask: prepared.hasDelegatedTask,
		skipSummaryReason: parsed.skipSummaryReason,
	});
	if (suppressSummary) {
		summary = null;
		summaryDisposition = "suppressed";
	}
	if (
		stage.sessionContext.flusher === "raw_events" &&
		capture.observations.length === 0 &&
		summary &&
		prepared.toolEvents.length === 0 &&
		!prepared.lastAssistantMessage
	) {
		summary = null;
	}
	const sessionMetadata = {
		session_class: sessionClass,
		summary_disposition: summaryDisposition,
		...(stage.captureRoutingEnabled ? { capture_suppressed_count: capture.suppressedCount } : {}),
	};
	if (
		stage.sessionContext.flusher !== "raw_events" ||
		capture.observations.length + (summary ? 1 : 0) > 0
	) {
		return { sessionClass, sessionMetadata, softSkip: false, summary };
	}
	if (shouldSoftSkipRawOutput(stage, prepared, inference, capture, summary)) {
		return { sessionClass, sessionMetadata, softSkip: true, summary };
	}
	throw new RawEventObserverOutputError(
		"observer produced no storable output for raw-event flush",
		"unstorable_observer_output",
		inference.selection.observer,
		{ observerStatus: inference.response.status },
	);
}

function flushBatchMetadata(stage: IngestSessionStage): SessionContext["flushBatch"] | null {
	if (!stage.sessionContext.flushBatch || typeof stage.sessionContext.flushBatch !== "object") {
		return null;
	}
	return stage.sessionContext.flushBatch;
}

function planObservationMemory(
	observation: CaptureRoutedObservation,
	prepared: PreparedIngestStage,
	sessionClass: ReturnType<typeof classifySessionForInjection>,
	sharedMetadata: Record<string, unknown>,
	flushBatch: SessionContext["flushBatch"] | null,
): PlannedMemory {
	const kind = observation.kind.trim().toLowerCase();
	const bodyParts: string[] = [];
	if (observation.narrative) bodyParts.push(observation.narrative);
	if (observation.facts.length > 0) {
		bodyParts.push(observation.facts.map((fact) => `- ${fact}`).join("\n"));
	}
	const title = observation.title || observation.narrative;
	return {
		bodyText: bodyParts.join("\n\n"),
		confidence: 0.5,
		kind,
		metadata: {
			...(observation.derivation ? { derivation: observation.derivation } : {}),
			subtitle: observation.subtitle,
			narrative: observation.narrative,
			facts: observation.facts,
			concepts: observation.concepts,
			files_read: observation.filesRead,
			files_modified: observation.filesModified,
			prompt_number: prepared.promptNumber,
			session_class: sessionClass,
			source: "observer",
			...sharedMetadata,
			flush_batch: flushBatch,
		},
		tags: deriveTags({
			kind,
			title,
			concepts: observation.concepts,
			filesRead: observation.filesRead,
			filesModified: observation.filesModified,
		}),
		title,
	};
}

function planSummaryMemory(
	candidate: SummaryCandidate,
	prepared: PreparedIngestStage,
	sessionClass: ReturnType<typeof classifySessionForInjection>,
	sharedMetadata: Record<string, unknown>,
	flushBatch: SessionContext["flushBatch"] | null,
): PlannedMemory {
	const { summary, request, body } = candidate;
	const title = request || "Session summary";
	return {
		bodyText: body,
		confidence: 0.3,
		kind: "session_summary",
		metadata: {
			is_summary: true,
			request,
			investigated: summary.investigated,
			learned: summary.learned,
			completed: summary.completed,
			next_steps: summary.nextSteps,
			notes: summary.notes,
			prompt_number: prepared.promptNumber,
			session_class: sessionClass,
			...sharedMetadata,
			files_read: summary.filesRead,
			files_modified: summary.filesModified,
			source: "observer_summary",
			flush_batch: flushBatch,
		},
		tags: deriveTags({
			kind: "session_summary",
			title,
			filesRead: summary.filesRead,
			filesModified: summary.filesModified,
		}),
		title,
	};
}

function buildObserverCallMetadata(
	stage: IngestSessionStage,
	prepared: PreparedIngestStage,
	inference: ObserverInferenceStage,
	capture: CaptureRoutingStage,
	disposition: OutputDispositionStage,
): Record<string, unknown> {
	const { response, selection } = inference;
	const sessionUsageTokens = prepared.assistantUsageEvents.reduce(
		(sum, event) => sum + (event.total_tokens ?? 0),
		0,
	);
	return {
		project: stage.project,
		token_usage: observerTokenUsageMetadata(
			inference.usage,
			observerOutputAttemptCount(inference.output),
		),
		observation_count: capture.observations.length,
		has_summary: disposition.summary != null,
		...captureMetadata(
			stage.captureRoutingEnabled,
			capture.suppressedCount,
			capture.candidateCount,
		),
		...disposition.sessionMetadata,
		observer_tier: selection.tier,
		observer_tier_reasons: selection.tierReasons,
		requested_provider: selection.requestedProvider,
		requested_model: selection.requestedModel,
		requested_runtime: selection.requestedRuntime,
		requested_openai_responses: selection.requestedOpenAIResponses,
		provider: response.provider,
		model: response.model,
		runtime: inference.observerStatus.runtime,
		openai_responses: selection.observer.openaiUseResponses,
		fallback_applied: selection.fallbackApplied,
		fallback_reason: selection.fallbackReason,
		...inference.outputMetadata,
		session_usage_tokens: sessionUsageTokens,
	};
}

function completedObserverUsageRecord(
	stage: IngestSessionStage,
	prepared: PreparedIngestStage,
	inference: ObserverInferenceStage,
): ObserverUsageRecord {
	const { response, selection } = inference;
	const sessionUsageTokens = prepared.assistantUsageEvents.reduce(
		(sum, event) => sum + (event.total_tokens ?? 0),
		0,
	);
	return {
		recorded: false,
		tokens: normalizedObserverTokenCounts(inference.usage, response.provider),
		metadata: {
			project: stage.project,
			token_usage: observerTokenUsageMetadata(
				inference.usage,
				observerOutputAttemptCount(inference.output),
			),
			observation_count: 0,
			has_summary: false,
			...captureMetadata(stage.captureRoutingEnabled, 0, 0),
			observer_tier: selection.tier,
			observer_tier_reasons: selection.tierReasons,
			requested_provider: selection.requestedProvider,
			requested_model: selection.requestedModel,
			requested_runtime: selection.requestedRuntime,
			requested_openai_responses: selection.requestedOpenAIResponses,
			provider: response.provider,
			model: response.model,
			runtime: inference.observerStatus.runtime,
			openai_responses: selection.observer.openaiUseResponses,
			fallback_applied: selection.fallbackApplied,
			fallback_reason: selection.fallbackReason,
			...inference.outputMetadata,
			session_usage_tokens: sessionUsageTokens,
		},
	};
}

function completedSessionMetadata(
	disposition: OutputDispositionStage,
	inference: ObserverInferenceStage,
): Record<string, unknown> {
	const { response, selection } = inference;
	return {
		...disposition.sessionMetadata,
		observer_tier: selection.tier,
		observer_tier_reasons: selection.tierReasons,
		observer_requested_provider: selection.requestedProvider,
		observer_requested_model: selection.requestedModel,
		observer_requested_runtime: selection.requestedRuntime,
		observer_requested_openai_responses: selection.requestedOpenAIResponses,
		observer_provider: response.provider,
		observer_model: response.model,
		observer_runtime: inference.observerStatus.runtime,
		observer_openai_responses: selection.observer.openaiUseResponses,
		observer_fallback_applied: selection.fallbackApplied,
		observer_fallback_reason: selection.fallbackReason,
		...inference.outputMetadata,
	};
}

function buildPlannedMemories(
	prepared: PreparedIngestStage,
	inference: ObserverInferenceStage,
	capture: CaptureRoutingStage,
	disposition: OutputDispositionStage,
	flushBatch: SessionContext["flushBatch"] | null,
): { memories: PlannedMemory[]; summaryIndex: number | null } {
	const sharedMetadata = observerMemoryMetadata(inference);
	const memories = capture.observations.map((observation) =>
		planObservationMemory(
			observation,
			prepared,
			disposition.sessionClass,
			sharedMetadata,
			flushBatch,
		),
	);
	const summaryIndex = disposition.summary ? memories.length : null;
	if (disposition.summary) {
		memories.push(
			planSummaryMemory(
				disposition.summary,
				prepared,
				disposition.sessionClass,
				sharedMetadata,
				flushBatch,
			),
		);
	}
	return { memories, summaryIndex };
}

function buildIngestPersistencePlan(
	stage: IngestSessionStage,
	prepared: PreparedIngestStage,
	inference: ObserverInferenceStage,
): IngestPersistencePlan {
	const parsed = inference.response.parsed;
	const filtered = filterObservationsForPersistence(stage, parsed);
	const capture = applyCaptureRouting(stage, filtered);
	const summaryCandidate = prepareSummaryForPersistence(stage, parsed);
	const disposition = resolveOutputDisposition(
		stage,
		prepared,
		inference,
		capture,
		summaryCandidate,
	);
	const observerCallMetadata = buildObserverCallMetadata(
		stage,
		prepared,
		inference,
		capture,
		disposition,
	);
	if (disposition.softSkip) {
		return {
			action: "skip",
			plan: { observerCallMetadata, sessionMetadata: disposition.sessionMetadata },
		};
	}
	const flushBatch = flushBatchMetadata(stage);
	const { memories, summaryIndex } = buildPlannedMemories(
		prepared,
		inference,
		capture,
		disposition,
		flushBatch,
	);
	return {
		action: "persist",
		plan: {
			memories,
			observerCallMetadata,
			observerTokenCounts: normalizedObserverTokenCounts(
				inference.usage,
				inference.response.provider,
			),
			sessionMetadata: completedSessionMetadata(disposition, inference),
			summaryIndex,
		},
	};
}

function persistIngestPlan(
	store: MemoryStore,
	stage: IngestSessionStage,
	plan: PersistIngestPlan,
	usageRecord: ObserverUsageRecord,
): Array<{ memoryId: number; title: string; bodyText: string }> {
	const vectorWriteInputs: Array<{ memoryId: number; title: string; bodyText: string }> = [];
	store.db.transaction(() => {
		for (const [index, memory] of plan.memories.entries()) {
			let supersededIds: number[] = [];
			if (index === plan.summaryIndex) {
				supersededIds = supersedePriorObserverSummaries(store, stage.d, stage.sessionId);
			}
			const memoryId = store.remember(
				stage.sessionId,
				memory.kind,
				memory.title,
				memory.bodyText,
				memory.confidence,
				memory.tags,
				memory.metadata,
			);
			if (supersededIds.length > 0) markSupersededBy(stage.d, supersededIds, memoryId);
			vectorWriteInputs.push({
				memoryId,
				title: memory.title,
				bodyText: memory.bodyText,
			});
		}
		recordObserverUsage(
			store,
			stage.sessionId,
			plan.observerTokenCounts,
			plan.observerCallMetadata,
		);
	})();
	usageRecord.recorded = true;
	return vectorWriteInputs;
}

async function storeVectorInputs(
	store: MemoryStore,
	inputs: Array<{ memoryId: number; title: string; bodyText: string }>,
): Promise<void> {
	for (const input of inputs) {
		try {
			await storeVectors(store.db, input.memoryId, input.title, input.bodyText);
		} catch {
			// Non-fatal — ingestion should not fail when embeddings are unavailable
		}
	}
}

function endIngestSession(
	store: MemoryStore,
	stage: IngestSessionStage,
	metadata: Record<string, unknown> = {},
): void {
	endSession(store, stage.sessionId, stage.events.length, stage.sessionContext, metadata);
}

function handleUnprocessableInput(
	store: MemoryStore,
	stage: IngestSessionStage,
	prepared: PreparedIngestStage,
	observer: ObserverClient,
): boolean {
	if (prepared.shouldProcess) return false;
	if (stage.sessionContext.flusher === "raw_events") {
		throw new RawEventObserverOutputError(
			"observer produced no storable output for raw-event flush",
			"no_processable_input",
			observer,
			{ includeObserverError: false },
		);
	}
	endIngestSession(store, stage);
	return true;
}

function handleObserverOutput(
	store: MemoryStore,
	stage: IngestSessionStage,
	inference: ObserverInferenceStage,
): boolean {
	if (!inference.response.raw) {
		if (stage.sessionContext.flusher === "raw_events") {
			throw new RawEventObserverOutputError(
				"observer failed during raw-event flush",
				"empty_observer_output",
				inference.selection.observer,
				{ observerStatus: inference.response.status },
			);
		}
		const status = inference.selection.observer.getStatus();
		console.warn(
			`[codemem] Observer returned no output (provider=${inference.response.provider}, model=${inference.response.model}` +
				`${status.lastError ? `, error=${status.lastError}` : ""}). No memories will be created for this session.`,
		);
		endIngestSession(store, stage);
		return false;
	}
	const parsed = inference.response.parsed;
	const lossyRawOutput =
		stage.sessionContext.flusher === "raw_events" &&
		inference.output.diagnostics.failureReason === "legacy_xml_lossy" &&
		(parsed.observations.length > 0 ||
			parsed.summary !== null ||
			parsed.skipSummaryReason !== null);
	if (!lossyRawOutput) return true;
	throw new RawEventObserverOutputError(
		"observer repair remained lossy during raw-event flush",
		"lossy_repair",
		inference.selection.observer,
		{ observerStatus: observerOutputFailureStatus(inference.output) },
	);
}

async function processIngestSession(
	store: MemoryStore,
	stage: IngestSessionStage,
	options: IngestOptions,
): Promise<void> {
	const prepared = prepareIngestInput(stage);
	if (handleUnprocessableInput(store, stage, prepared, options.observer)) return;
	const inference = await runObserverInference(store, stage, prepared, options);
	const usageRecord = completedObserverUsageRecord(stage, prepared, inference);
	try {
		if (!handleObserverOutput(store, stage, inference)) {
			recordCompletedObserverUsage(store, stage.sessionId, usageRecord);
			return;
		}
		const persistence = buildIngestPersistencePlan(stage, prepared, inference);
		usageRecord.metadata = persistence.plan.observerCallMetadata;
		if (persistence.action === "skip") {
			recordCompletedObserverUsage(store, stage.sessionId, usageRecord);
			endIngestSession(store, stage, persistence.plan.sessionMetadata);
			return;
		}
		const vectorWriteInputs = persistIngestPlan(store, stage, persistence.plan, usageRecord);
		await storeVectorInputs(store, vectorWriteInputs);
		endIngestSession(store, stage, persistence.plan.sessionMetadata);
	} catch (error) {
		try {
			recordCompletedObserverUsage(store, stage.sessionId, usageRecord);
		} catch {
			// Failure telemetry is best-effort and must not replace the ingest cause.
		}
		throw error;
	}
}

/**
 * Process a batch of raw coding session events through the full ingest pipeline.
 *
 * Extracts prompts, tool events, and assistant messages from the payload,
 * builds a transcript, calls the observer LLM, parses the response,
 * filters low-signal content, and persists observations + summary.
 */
export async function ingest(
	payload: IngestPayload,
	store: MemoryStore,
	options: IngestOptions,
): Promise<void> {
	const stage = createIngestSession(payload, store, options);
	if (!stage) return;
	try {
		await processIngestSession(store, stage, options);
	} catch (err) {
		try {
			endIngestSession(store, stage);
		} catch {
			// ignore cleanup errors
		}
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Session lifecycle helpers
// ---------------------------------------------------------------------------

function endSession(
	store: MemoryStore,
	sessionId: number,
	eventCount: number,
	sessionContext: SessionContext,
	extraPost: Record<string, unknown> = {},
): void {
	// Use store.endSession() which merges metadata instead of replacing it,
	// preserving fields set during session creation (startedAt, session_context, etc.)
	store.endSession(sessionId, {
		post: extraPost,
		source: "plugin",
		event_count: eventCount,
		session_context: sessionContextForStorage(sessionContext),
	});
}

// ---------------------------------------------------------------------------
// Orphan session cleanup
// ---------------------------------------------------------------------------

/**
 * Close orphan sessions (started but never ended) older than maxAgeHours.
 * Returns the number of sessions closed.
 */
export function cleanOrphanSessions(store: MemoryStore, maxAgeHours = 24): number {
	const d = drizzle(store.db, { schema });
	const cutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString();
	const result = d
		.update(schema.sessions)
		.set({ ended_at: cutoff })
		.where(and(isNull(schema.sessions.ended_at), lt(schema.sessions.started_at, cutoff)))
		.run();
	return result.changes;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Read a JSON payload from stdin and run the ingest pipeline.
 *
 * This is the TypeScript equivalent of `codemem ingest` — receives events
 * from the plugin and processes them through the observer LLM.
 */
export async function main(store: MemoryStore, observer: ObserverClient): Promise<void> {
	const chunks: string[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(String(chunk));
	}
	const raw = chunks.join("");
	if (!raw.trim()) return;

	let payload: IngestPayload;
	try {
		payload = JSON.parse(raw) as IngestPayload;
	} catch (err) {
		throw new Error(`codemem: invalid payload: ${err}`);
	}

	await ingest(payload, store, { observer });
}
function observerTokenUsageMetadata(
	usage: ObserverTokenUsage | null,
	attemptCount: number,
): Record<string, unknown> {
	return {
		unit: "tokens",
		source: usage ? "provider" : "unavailable",
		input_direction: "observer_input",
		output_direction: "observer_output",
		attempt_count: attemptCount,
	};
}

function observerDiagnosticsAttemptCount(diagnostics: {
	repairAttempted: boolean;
	retryAttempted: boolean;
}): number {
	return diagnostics.repairAttempted || diagnostics.retryAttempted ? 2 : 1;
}

function normalizedObserverTokenCounts(
	usage: ObserverTokenUsage | null,
	provider: string,
): {
	inputTokens: number | null;
	outputTokens: number | null;
} {
	if (!usage) return { inputTokens: null, outputTokens: null };
	if (provider !== "anthropic") return usage;
	return {
		inputTokens:
			usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
		outputTokens: usage.outputTokens,
	};
}

interface ObserverUsageRecord {
	recorded: boolean;
	tokens: { inputTokens: number | null; outputTokens: number | null };
	metadata: Record<string, unknown>;
}

function recordCompletedObserverUsage(
	store: MemoryStore,
	sessionId: number,
	record: ObserverUsageRecord | null,
): void {
	if (!record || record.recorded) return;
	recordObserverUsage(store, sessionId, record.tokens, record.metadata);
	record.recorded = true;
}

function recordObserverUsage(
	store: MemoryStore,
	sessionId: number,
	tokens: { inputTokens: number | null; outputTokens: number | null },
	metadata: Record<string, unknown>,
): void {
	store.db
		.prepare(
			`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, created_at, metadata_json)
			 VALUES (?, 'observer_call', ?, ?, ?, ?)`,
		)
		.run(
			sessionId,
			tokens.inputTokens,
			tokens.outputTokens,
			new Date().toISOString(),
			toJson(metadata),
		);
}

function captureMetadata(
	enabled: boolean,
	suppressedCount: number,
	candidateCount: number,
): Record<string, unknown> {
	if (!enabled) return {};
	return {
		capture_suppressed_count: suppressedCount,
		capture_candidate_count: candidateCount,
		capture_routing_enabled: true,
	};
}
