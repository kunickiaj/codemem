/**
 * Raw events routes — GET & POST /api/raw-events, GET /api/raw-events/status,
 * POST /api/claude-hooks, POST /api/codex-hooks.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryStore, RawEventSweeper } from "@codemem/core";
import {
	buildRawEventEnvelopeFromCodexHook,
	buildRawEventEnvelopeFromHook,
	ingestRawEvents,
	RawEventIngestValidationError,
	schema,
} from "@codemem/core";
import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { parseJsonObjectBody, queryInt } from "../helpers.js";

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

function claudeTranscriptRoot(): string {
	return join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "projects");
}

function codexTranscriptRoot(): string {
	return join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions");
}

/** Nudge the sweeper safely — never crashes the caller. */
function nudgeSweeper(
	sweeper: RawEventSweeper | null | undefined,
	sessions: Iterable<{ source: string; streamId: string }>,
): void {
	for (const session of sessions) {
		try {
			sweeper?.nudge(session.streamId, session.source);
		} catch {
			// A failed nudge must not block later validated sessions.
		}
	}
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

function ingestNormalizedEnvelope(
	store: MemoryStore,
	sweeper: RawEventSweeper | null | undefined,
	envelope: object,
) {
	const result = ingestRawEvents(store, envelope);
	nudgeSweeper(sweeper, result.sessions);
	return result;
}

export function rawEventsRoutes(getStore: StoreFactory, sweeper?: RawEventSweeper | null) {
	const app = new Hono();

	// GET /api/raw-events (compat endpoint for stats panel)
	app.get("/api/raw-events", (c) => {
		const store = getStore();
		const totals = store.rawEventBacklogTotals();
		return c.json(totals);
	});

	// GET /api/raw-events/status
	app.get("/api/raw-events/status", (c) => {
		const store = getStore();
		const limit = queryInt(c.req.query("limit"), 25);
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
				mode: "stream_queue",
				max_body_bytes: MAX_RAW_EVENTS_BODY_BYTES,
			},
		});
	});

	// POST /api/raw-events — ingest raw events from plugin
	app.post("/api/raw-events", async (c) => {
		const result = await parseJsonObjectBody(c, MAX_RAW_EVENTS_BODY_BYTES);
		if (result instanceof Response) return result;
		try {
			const ingestResult = ingestNormalizedEnvelope(getStore(), sweeper, result);
			return c.json({
				inserted: ingestResult.inserted,
				skipped: ingestResult.skipped,
				received: ingestResult.received,
			});
		} catch (err) {
			return boundedIngestErrorResponse(c, err);
		}
	});

	// POST /api/claude-hooks — ingest Claude Code hook events
	app.post("/api/claude-hooks", async (c) => {
		const result = await parseJsonObjectBody(c, MAX_RAW_EVENTS_BODY_BYTES);
		if (result instanceof Response) return result;
		const payload = result;

		try {
			const envelope = buildRawEventEnvelopeFromHook(payload, {
				transcriptPolicy: { trust: "restricted", approvedRoots: [claudeTranscriptRoot()] },
			});
			if (envelope === null) {
				const skipReason =
					payload.hook_event_name === "Stop" && typeof payload.transcript_path === "string"
						? "transcript_unavailable"
						: "unsupported_hook";
				return c.json({ inserted: 0, skipped: 1, skip_reason: skipReason });
			}
			const ingestResult = ingestNormalizedEnvelope(getStore(), sweeper, envelope);
			return c.json({ inserted: ingestResult.inserted, skipped: ingestResult.skipped });
		} catch (err) {
			return boundedIngestErrorResponse(c, err);
		}
	});

	// POST /api/codex-hooks — ingest Codex hook events
	app.post("/api/codex-hooks", async (c) => {
		const result = await parseJsonObjectBody(c, MAX_RAW_EVENTS_BODY_BYTES);
		if (result instanceof Response) return result;
		const payload = result;

		try {
			const envelope = buildRawEventEnvelopeFromCodexHook(payload, {
				transcriptPolicy: { trust: "restricted", approvedRoots: [codexTranscriptRoot()] },
			});
			if (envelope === null) {
				const skipReason =
					payload.hook_event_name === "Stop" && typeof payload.transcript_path === "string"
						? "transcript_unavailable"
						: "unsupported_hook";
				return c.json({ inserted: 0, skipped: 1, skip_reason: skipReason });
			}
			const ingestResult = ingestNormalizedEnvelope(getStore(), sweeper, envelope);
			return c.json({ inserted: ingestResult.inserted, skipped: ingestResult.skipped });
		} catch (err) {
			return boundedIngestErrorResponse(c, err);
		}
	});

	return app;
}
