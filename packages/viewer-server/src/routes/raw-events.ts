/**
 * Raw events routes — GET & POST /api/raw-events, GET /api/raw-events/status,
 * POST /api/claude-hooks, POST /api/codex-hooks.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { HookTranscriptOutcome, MemoryStore, RawEventSweeper } from "@codemem/core";
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
import { queryInt } from "../helpers.js";
import { validateViewerTarget } from "./target-validation.js";

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

/**
 * Parse and validate a JSON object body, enforcing size limits.
 * Returns the parsed payload or a Hono Response on error.
 */
async function parseJsonObjectBody(
	c: {
		req: { header: (name: string) => string | undefined; raw: Request };
		json: (data: unknown, status?: number) => Response;
	},
	maxBytes: number,
): Promise<Record<string, unknown> | Response> {
	const contentLength = Number.parseInt(c.req.header("content-length") ?? "0", 10);
	if (Number.isNaN(contentLength) || contentLength < 0) {
		return c.json({ error: "invalid content-length" }, 400);
	}
	if (contentLength > maxBytes) {
		return c.json({ error: "payload too large", max_bytes: maxBytes }, 413);
	}
	let raw = "";
	try {
		const body = c.req.raw.body;
		if (body !== null) {
			const reader = body.getReader();
			const chunks: Uint8Array[] = [];
			let totalBytes = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					totalBytes += value.byteLength;
					if (totalBytes > maxBytes) {
						try {
							await reader.cancel();
						} catch {
							// The size rejection is authoritative even if cancellation fails.
						}
						return c.json({ error: "payload too large", max_bytes: maxBytes }, 413);
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}

			const bytes = new Uint8Array(totalBytes);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		}
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}
	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : {};
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return c.json({ error: "payload must be an object" }, 400);
	}
	return parsed as Record<string, unknown>;
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

async function flushBoundarySessions(
	sweeper: RawEventSweeper | null | undefined,
	sessions: Iterable<{ source: string; streamId: string }>,
): Promise<void> {
	for (const session of sessions) {
		try {
			await sweeper?.flushBoundary(session.streamId, session.source);
		} catch {
			// Boundary extraction remains best-effort, matching the legacy CLI path.
		}
	}
}

function isClaudeBoundaryEnvelope(envelope: object): boolean {
	const record = envelope as Record<string, unknown>;
	if (
		String(record.source ?? "")
			.trim()
			.toLowerCase() !== "claude"
	)
		return false;
	const payload = record.payload;
	if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return false;
	const adapter = (payload as Record<string, unknown>)._adapter;
	if (adapter == null || typeof adapter !== "object" || Array.isArray(adapter)) return false;
	const meta = (adapter as Record<string, unknown>).meta;
	if (meta == null || typeof meta !== "object" || Array.isArray(meta)) return false;
	const hookEventName = (meta as Record<string, unknown>).hook_event_name;
	return hookEventName === "SessionEnd" || hookEventName === "Stop";
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

function untargetedPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const { db_path: _dbPath, identity_target: _identityTarget, ...body } = payload;
	return body;
}

async function ingestNormalizedEnvelope(
	store: MemoryStore,
	sweeper: RawEventSweeper | null | undefined,
	envelope: object,
	flushBoundary = false,
) {
	const result = ingestRawEvents(store, envelope);
	nudgeSweeper(sweeper, result.sessions);
	if (flushBoundary && isClaudeBoundaryEnvelope(envelope)) {
		await flushBoundarySessions(sweeper, result.sessions);
	}
	return result;
}

export function rawEventsRoutes(getStore: StoreFactory, sweeper?: RawEventSweeper | null) {
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
			transcript_diagnostics: transcriptDiagnostics.snapshot(),
		});
	});

	// POST /api/raw-events — ingest raw events from plugin
	app.post("/api/raw-events", async (c) => {
		const result = await parseJsonObjectBody(c, MAX_RAW_EVENTS_BODY_BYTES);
		if (result instanceof Response) return result;
		try {
			const store = getStore();
			const target = validateViewerTarget(store, result, { requirePairedTargets: true });
			if (!target.ok) return c.json(target.body, target.status);
			const ingestResult = await ingestNormalizedEnvelope(
				store,
				sweeper,
				untargetedPayload(result),
				c.req.header("x-codemem-boundary-flush") === "1",
			);
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
			const store = getStore();
			const target = validateViewerTarget(store, payload, { requirePairedTargets: true });
			if (!target.ok) return c.json(target.body, target.status);
			let transcriptOutcome: HookTranscriptOutcome | null = null;
			const envelope = buildRawEventEnvelopeFromHook(untargetedPayload(payload), {
				transcriptPolicy: { trust: "restricted", approvedRoots: [claudeTranscriptRoot()] },
				onTranscriptOutcome: (outcome) => {
					transcriptOutcome = outcome;
					transcriptDiagnostics.record("claude", outcome);
				},
			});
			if (envelope === null) {
				return c.json(transcriptSkipResponse(transcriptOutcome));
			}
			const ingestResult = await ingestNormalizedEnvelope(
				store,
				sweeper,
				envelope,
				c.req.header("x-codemem-boundary-flush") === "1",
			);
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
			const store = getStore();
			const target = validateViewerTarget(store, payload, { requirePairedTargets: true });
			if (!target.ok) return c.json(target.body, target.status);
			let transcriptOutcome: HookTranscriptOutcome | null = null;
			const envelope = buildRawEventEnvelopeFromCodexHook(untargetedPayload(payload), {
				transcriptPolicy: { trust: "restricted", approvedRoots: [codexTranscriptRoot()] },
				onTranscriptOutcome: (outcome) => {
					transcriptOutcome = outcome;
					transcriptDiagnostics.record("codex", outcome);
				},
			});
			if (envelope === null) {
				return c.json(transcriptSkipResponse(transcriptOutcome));
			}
			const ingestResult = await ingestNormalizedEnvelope(store, sweeper, envelope);
			return c.json({ inserted: ingestResult.inserted, skipped: ingestResult.skipped });
		} catch (err) {
			return boundedIngestErrorResponse(c, err);
		}
	});

	return app;
}
