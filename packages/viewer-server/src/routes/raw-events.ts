/**
 * Raw events routes — GET & POST /api/raw-events, GET /api/raw-events/status,
 * POST /api/claude-hooks, POST /api/codex-hooks, POST /api/pi-hooks.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { HookTranscriptOutcome, MemoryStore, RawEventSweeper } from "@codemem/core";
import {
	buildPiFlushSignalFromEvent,
	buildRawEventEnvelopeFromCodexHook,
	buildRawEventEnvelopeFromHook,
	buildRawEventEnvelopeFromPiEvent,
	ingestRawEvents,
	RawEventIngestValidationError,
	schema,
	validateRawEvents,
} from "@codemem/core";
import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { type Context, Hono } from "hono";
import { parseJsonObjectBody, queryInt } from "../helpers.js";
import {
	RAW_EVENT_INBOX_FULL_CODE,
	type RawEventInbox,
	type RawEventInboxBoundary,
} from "../raw-event-inbox.js";
import {
	flushRawEventBoundarySessions,
	isClaudeBoundaryEnvelope,
	nudgeRawEventSessions,
} from "../raw-event-processing.js";
import { type ViewerTargetStore, validateViewerTarget } from "./target-validation.js";

type StoreFactory = () => MemoryStore;
type JsonResponder = {
	json: (data: unknown, status?: number) => Response;
};

const DEFAULT_MAX_RAW_EVENTS_BODY_BYTES = 1_048_576;

function configuredMaxRawEventsBodyBytes(): number {
	const parsed = Number(process.env.CODEMEM_RAW_EVENTS_MAX_BODY_BYTES?.trim() ?? "");
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_RAW_EVENTS_BODY_BYTES;
}

const MAX_RAW_EVENTS_BODY_BYTES = configuredMaxRawEventsBodyBytes();
type LegacyTranscriptSource = "claude" | "codex";
type TranscriptOutcomeCounts = Record<HookTranscriptOutcome, number>;

function emptyTranscriptOutcomeCounts(): TranscriptOutcomeCounts {
	return {
		ok: 0,
		not_provided: 0,
		path_rejected: 0,
		unreadable: 0,
		no_complete_record: 0,
		no_assistant_record: 0,
	} satisfies TranscriptOutcomeCounts;
}

function createTranscriptDiagnostics() {
	const counts: Record<LegacyTranscriptSource, TranscriptOutcomeCounts> = {
		claude: emptyTranscriptOutcomeCounts(),
		codex: emptyTranscriptOutcomeCounts(),
	};
	return {
		record(source: LegacyTranscriptSource, outcome: HookTranscriptOutcome): void {
			counts[source][outcome] += 1;
		},
		snapshot() {
			return {
				scope: "legacy_compatibility_routes" as const,
				counts: {
					claude: { ...counts.claude },
					codex: { ...counts.codex },
				},
			};
		},
	};
}

function transcriptSkipResponse(outcome: HookTranscriptOutcome | null) {
	if (outcome !== null && outcome !== "ok") {
		return {
			inserted: 0,
			skipped: 1,
			skip_reason: "transcript_unavailable" as const,
			skip_detail: outcome,
		};
	}
	return { inserted: 0, skipped: 1, skip_reason: "unsupported_hook" as const };
}

function claudeTranscriptRoot(): string {
	return join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "projects");
}

function codexTranscriptRoot(): string {
	return join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions");
}

const SAFE_INGEST_VALIDATION_ERRORS = new Set([
	"source must be string",
	"source is required",
	"source must use 1-64 letters, digits, dots, underscores, or hyphens",
	"session_stream_id must be string",
	"session_id must be string",
	"stream_id must be string",
	"opencode_session_id must be string",
	"conflicting session id fields",
	"invalid session id",
	"event source conflicts with request source",
	"session id required",
	"event_type must be string",
	"event_type required",
	"event_type has invalid syntax",
	"event_id must be string",
	"event_id required",
	"event_id has invalid syntax",
	"event_seq must be int",
	"ts_wall_ms must be number",
	"ts_mono_ms must be number",
	"payload must be an object",
	"cwd must be string",
	"project must be string",
	"started_at must be string",
	"events must be a list",
	"event must be an object",
]);

function boundedIngestValidationMessage(error: RawEventIngestValidationError): string {
	return SAFE_INGEST_VALIDATION_ERRORS.has(error.message)
		? error.message
		: "invalid raw event request";
}

function boundedIngestErrorResponse(c: JsonResponder, error: unknown): Response {
	if (error instanceof RawEventIngestValidationError) {
		return c.json({ error: boundedIngestValidationMessage(error) }, 400);
	}
	const response: Record<string, unknown> = { error: "internal server error" };
	if (process.env.CODEMEM_VIEWER_DEBUG === "1") {
		response.detail = error instanceof Error ? error.message : String(error);
	}
	return c.json(response, 500);
}

function boundedInboxErrorResponse(c: JsonResponder, error: unknown): Response {
	const code = (error as NodeJS.ErrnoException)?.code;
	if (code === RAW_EVENT_INBOX_FULL_CODE) {
		return c.json(
			{ error: { code: "raw_event_queue_full", message: "raw-event queue is full" } },
			503,
		);
	}
	return c.json(
		{ error: { code: "raw_event_queue_write_failed", message: "raw-event queue write failed" } },
		503,
	);
}

function untargetedPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const { db_path: _dbPath, identity_target: _identityTarget, ...body } = payload;
	return body;
}

async function enqueueRawEventRequest(options: {
	c: JsonResponder;
	getStore: StoreFactory;
	inbox: RawEventInbox;
	inboxTarget?: ViewerTargetStore;
	payload: Record<string, unknown>;
	request: Record<string, unknown>;
	flushBoundary: boolean;
	boundary?: RawEventInboxBoundary;
	acceptedCount?: number;
}): Promise<Response> {
	const target = validateViewerTarget(options.inboxTarget ?? options.getStore(), options.payload, {
		requirePairedTargets: true,
	});
	if (!target.ok) return options.c.json(target.body, target.status);
	const validation = validateRawEvents(options.request);
	try {
		await options.inbox.enqueue(
			validation.request,
			options.boundary
				? { flushBoundary: options.flushBoundary, boundary: options.boundary }
				: { flushBoundary: options.flushBoundary },
		);
	} catch (error) {
		return boundedInboxErrorResponse(options.c, error);
	}
	const accepted = options.acceptedCount ?? validation.received;
	return options.c.json({ accepted, queued: accepted }, 202);
}

function piEventName(payload: Record<string, unknown>): string {
	for (const key of ["piEvent", "pi_event", "event", "type"] as const) {
		const value = payload[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function piInboxBoundary(
	payload: Record<string, unknown>,
	envelope: ReturnType<typeof buildRawEventEnvelopeFromPiEvent>,
	signal: ReturnType<typeof buildPiFlushSignalFromEvent>,
): RawEventInboxBoundary | undefined {
	if (!["session_before_compact", "session_shutdown"].includes(piEventName(payload))) return;
	const streamId = envelope?.session_stream_id ?? signal?.session_id;
	if (!streamId) return;
	const envelopeTimestamp = envelope?.payload.timestamp;
	const id = typeof envelopeTimestamp === "string" ? envelopeTimestamp : signal?.ts;
	return { source: "pi", streamId, ...(id ? { id } : {}) };
}

async function postPiHookRequest(
	c: Context,
	getStore: StoreFactory,
	sweeper: RawEventSweeper | null | undefined,
	inbox: RawEventInbox | null | undefined,
	inboxTarget: ViewerTargetStore | undefined,
): Promise<Response> {
	const result = await parseJsonObjectBody(c, MAX_RAW_EVENTS_BODY_BYTES);
	if (result instanceof Response) return result;
	const payload = result;
	try {
		const targetStore = inbox && inboxTarget ? inboxTarget : getStore();
		const target = validateViewerTarget(targetStore, payload, { requirePairedTargets: true });
		if (!target.ok) return c.json(target.body, target.status);
		const untargeted = untargetedPayload(payload);
		const envelope = buildRawEventEnvelopeFromPiEvent(untargeted);
		const signal = buildPiFlushSignalFromEvent(untargeted);
		const boundary = piInboxBoundary(untargeted, envelope, signal);
		if (envelope === null && signal === null) return c.json({ inserted: 0, skipped: 1 });
		if (inbox) {
			const request = envelope
				? { ...envelope, source: "pi" }
				: { source: "pi", session_stream_id: signal?.session_id, events: [] };
			return await enqueueRawEventRequest({
				c,
				getStore,
				inbox,
				inboxTarget,
				payload,
				request,
				flushBoundary: false,
				...(boundary ? { boundary, acceptedCount: 1 } : {}),
			});
		}
		if (envelope === null) return c.json({ inserted: 0, skipped: 1 });
		const ingestResult = await ingestNormalizedEnvelope(getStore(), sweeper, {
			...envelope,
			source: "pi",
		});
		return c.json({ inserted: ingestResult.inserted, skipped: ingestResult.skipped });
	} catch (error) {
		return boundedIngestErrorResponse(c, error);
	}
}

async function postRawEventRequest(
	c: Context,
	getStore: StoreFactory,
	sweeper?: RawEventSweeper | null,
	inbox?: RawEventInbox | null,
	inboxTarget?: ViewerTargetStore,
): Promise<Response> {
	const result = await parseJsonObjectBody(c, MAX_RAW_EVENTS_BODY_BYTES);
	if (result instanceof Response) return result;
	try {
		const request = untargetedPayload(result);
		if (inbox) {
			return await enqueueRawEventRequest({
				c,
				getStore,
				inbox,
				inboxTarget,
				payload: result,
				request,
				flushBoundary: c.req.header("x-codemem-boundary-flush") === "1",
			});
		}
		const store = getStore();
		const target = validateViewerTarget(store, result, { requirePairedTargets: true });
		if (!target.ok) return c.json(target.body, target.status);
		const ingestResult = await ingestNormalizedEnvelope(
			store,
			sweeper,
			request,
			c.req.header("x-codemem-boundary-flush") === "1",
		);
		return c.json({
			inserted: ingestResult.inserted,
			skipped: ingestResult.skipped,
			received: ingestResult.received,
		});
	} catch (error) {
		return boundedIngestErrorResponse(c, error);
	}
}

async function ingestNormalizedEnvelope(
	store: MemoryStore,
	sweeper: RawEventSweeper | null | undefined,
	envelope: object,
	flushBoundary = false,
) {
	const result = ingestRawEvents(store, envelope);
	nudgeRawEventSessions(sweeper, result.sessions);
	if (flushBoundary && isClaudeBoundaryEnvelope(envelope)) {
		await flushRawEventBoundarySessions(sweeper, result.sessions);
	}
	return result;
}

type TranscriptDiagnostics = ReturnType<typeof createTranscriptDiagnostics>;

async function postClaudeHookRequest(
	c: Context,
	getStore: StoreFactory,
	sweeper: RawEventSweeper | null | undefined,
	inbox: RawEventInbox | null | undefined,
	inboxTarget: ViewerTargetStore | undefined,
	transcriptDiagnostics: TranscriptDiagnostics,
): Promise<Response> {
	const result = await parseJsonObjectBody(c, MAX_RAW_EVENTS_BODY_BYTES);
	if (result instanceof Response) return result;
	const payload = result;
	try {
		const targetStore = inbox && inboxTarget ? inboxTarget : getStore();
		const target = validateViewerTarget(targetStore, payload, { requirePairedTargets: true });
		if (!target.ok) return c.json(target.body, target.status);
		let transcriptOutcome: HookTranscriptOutcome | null = null;
		const envelope = buildRawEventEnvelopeFromHook(untargetedPayload(payload), {
			transcriptPolicy: { trust: "restricted", approvedRoots: [claudeTranscriptRoot()] },
			onTranscriptOutcome: (outcome) => {
				transcriptOutcome = outcome;
				transcriptDiagnostics.record("claude", outcome);
			},
		});
		if (envelope === null) return c.json(transcriptSkipResponse(transcriptOutcome));
		const flushBoundary = c.req.header("x-codemem-boundary-flush") === "1";
		if (inbox) {
			return await enqueueRawEventRequest({
				c,
				getStore,
				inbox,
				inboxTarget,
				payload,
				request: { ...envelope },
				flushBoundary,
			});
		}
		const ingestResult = await ingestNormalizedEnvelope(
			getStore(),
			sweeper,
			envelope,
			flushBoundary,
		);
		return c.json({ inserted: ingestResult.inserted, skipped: ingestResult.skipped });
	} catch (error) {
		return boundedIngestErrorResponse(c, error);
	}
}

async function postCodexHookRequest(
	c: Context,
	getStore: StoreFactory,
	sweeper: RawEventSweeper | null | undefined,
	inbox: RawEventInbox | null | undefined,
	inboxTarget: ViewerTargetStore | undefined,
	transcriptDiagnostics: TranscriptDiagnostics,
): Promise<Response> {
	const result = await parseJsonObjectBody(c, MAX_RAW_EVENTS_BODY_BYTES);
	if (result instanceof Response) return result;
	const payload = result;
	try {
		const targetStore = inbox && inboxTarget ? inboxTarget : getStore();
		const target = validateViewerTarget(targetStore, payload, { requirePairedTargets: true });
		if (!target.ok) return c.json(target.body, target.status);
		let transcriptOutcome: HookTranscriptOutcome | null = null;
		const envelope = buildRawEventEnvelopeFromCodexHook(untargetedPayload(payload), {
			transcriptPolicy: { trust: "restricted", approvedRoots: [codexTranscriptRoot()] },
			onTranscriptOutcome: (outcome) => {
				transcriptOutcome = outcome;
				transcriptDiagnostics.record("codex", outcome);
			},
		});
		if (envelope === null) return c.json(transcriptSkipResponse(transcriptOutcome));
		if (inbox) {
			return await enqueueRawEventRequest({
				c,
				getStore,
				inbox,
				inboxTarget,
				payload,
				request: { ...envelope },
				flushBoundary: false,
			});
		}
		const ingestResult = await ingestNormalizedEnvelope(getStore(), sweeper, envelope);
		return c.json({ inserted: ingestResult.inserted, skipped: ingestResult.skipped });
	} catch (error) {
		return boundedIngestErrorResponse(c, error);
	}
}

export function rawEventsRoutes(
	getStore: StoreFactory,
	sweeper?: RawEventSweeper | null,
	inbox?: RawEventInbox | null,
	inboxTarget?: ViewerTargetStore,
) {
	const app = new Hono();
	const transcriptDiagnostics = createTranscriptDiagnostics();

	// GET /api/raw-events (compat endpoint for stats panel)
	app.get("/api/raw-events", (c) => {
		const store = getStore();
		const totals = store.rawEventBacklogTotals();
		return c.json(totals);
	});

	// GET /api/raw-events/status
	app.get("/api/raw-events/status", (c) => {
		const limit = queryInt(c.req.query("limit"), 25);
		if (inbox && limit === 0) {
			return c.json({
				items: [],
				ingest: {
					available: true,
					mode: "durable_queue",
					max_body_bytes: MAX_RAW_EVENTS_BODY_BYTES,
				},
				transcript_diagnostics: transcriptDiagnostics.snapshot(),
			});
		}
		const store = getStore();
		const d = drizzle(store.db, { schema });
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
			.orderBy(desc(schema.rawEventSessions.updated_at))
			.limit(limit)
			.all();
		const items = rows.map((row) => {
			const streamId = String(row.stream_id ?? row.opencode_session_id ?? "");
			return {
				...row,
				session_stream_id: streamId,
				session_id: streamId,
			};
		});
		const totals = store.rawEventBacklogTotals();
		return c.json({
			items,
			totals,
			ingest: {
				available: true,
				mode: inbox ? "durable_queue" : "stream_queue",
				max_body_bytes: MAX_RAW_EVENTS_BODY_BYTES,
			},
			transcript_diagnostics: transcriptDiagnostics.snapshot(),
		});
	});

	// POST /api/raw-events — ingest raw events from plugin
	app.post("/api/raw-events", (c) => postRawEventRequest(c, getStore, sweeper, inbox, inboxTarget));

	// POST /api/claude-hooks — ingest Claude Code hook events
	app.post("/api/claude-hooks", (c) =>
		postClaudeHookRequest(c, getStore, sweeper, inbox, inboxTarget, transcriptDiagnostics),
	);

	// POST /api/codex-hooks — ingest Codex hook events
	app.post("/api/codex-hooks", (c) =>
		postCodexHookRequest(c, getStore, sweeper, inbox, inboxTarget, transcriptDiagnostics),
	);

	// POST /api/pi-hooks — ingest pi extension events (compat alias)
	app.post("/api/pi-hooks", (c) => postPiHookRequest(c, getStore, sweeper, inbox, inboxTarget));

	return app;
}
