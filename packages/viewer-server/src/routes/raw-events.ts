/**
 * Raw events routes — GET & POST /api/raw-events, GET /api/raw-events/status,
 * POST /api/claude-hooks.
 */

import { createHash } from "node:crypto";
import type { MemoryStore, RawEventSweeper } from "@codemem/core";
import { buildRawEventEnvelopeFromHook, schema, stripPrivateObj } from "@codemem/core";
import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { queryInt } from "../helpers.js";

type StoreFactory = () => MemoryStore;

const MAX_RAW_EVENTS_BODY_BYTES =
	Number.parseInt(process.env.CODEMEM_RAW_EVENTS_MAX_BODY_BYTES ?? "", 10) || 1048576;

/** Keys to check (in priority order) when resolving a session stream id. */
const SESSION_ID_KEYS = [
	"session_stream_id",
	"session_id",
	"stream_id",
	"opencode_session_id",
] as const;

/**
 * Resolve a session stream id from a payload object.
 * Checks multiple field aliases. Throws on conflicting values.
 */
function resolveSessionStreamId(payload: Record<string, unknown>): string | null {
	const values = new Map<string, string>();
	for (const key of SESSION_ID_KEYS) {
		const value = payload[key];
		if (value == null) continue;
		if (typeof value !== "string") throw new Error(`${key} must be string`);
		const text = value.trim();
		if (text) values.set(key, text);
	}
	if (values.size === 0) return null;
	const unique = new Set(values.values());
	if (unique.size > 1) throw new Error("conflicting session id fields");
	// Return the first matching key's value (preserves priority order)
	for (const key of SESSION_ID_KEYS) {
		const v = values.get(key);
		if (v) return v;
	}
	return null;
}

/**
 * Parse and validate a JSON object body, enforcing size limits.
 * Returns the parsed payload or a Hono Response on error.
 */
async function parseJsonObjectBody(
	c: {
		req: { header: (name: string) => string | undefined; text: () => Promise<string> };
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
	let raw: string;
	try {
		raw = await c.req.text();
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}
	if (Buffer.byteLength(raw, "utf-8") > maxBytes) {
		return c.json({ error: "payload too large", max_bytes: maxBytes }, 413);
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
	sessionIds: Iterable<string>,
	source = "opencode",
): void {
	try {
		for (const sessionId of sessionIds) {
			sweeper?.nudge(sessionId, source);
		}
	} catch {
		// never crash the request if sweeper nudge fails
	}
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
		const payload = result;

		const store = getStore();
		try {
			// Validate top-level string fields
			const cwd = payload.cwd;
			if (cwd != null && typeof cwd !== "string") {
				return c.json({ error: "cwd must be string" }, 400);
			}
			const project = payload.project;
			if (project != null && typeof project !== "string") {
				return c.json({ error: "project must be string" }, 400);
			}
			const startedAt = payload.started_at;
			if (startedAt != null && typeof startedAt !== "string") {
				return c.json({ error: "started_at must be string" }, 400);
			}

			// Determine event list: batch (events array) or single-event payload
			let items = payload.events;
			if (items == null) {
				items = [payload];
			}
			if (!Array.isArray(items)) {
				return c.json({ error: "events must be a list" }, 400);
			}

			// Resolve default session id from top-level payload
			let defaultSessionId: string;
			try {
				defaultSessionId = resolveSessionStreamId(payload) ?? "";
			} catch (err) {
				return c.json({ error: (err as Error).message }, 400);
			}
			if (defaultSessionId.startsWith("msg_")) {
				return c.json({ error: "invalid session id" }, 400);
			}

			let inserted = 0;
			const lastSeenBySession = new Map<string, number>();
			const metaBySession = new Map<string, Record<string, string>>();
			const sessionIds = new Set<string>();
			const batchBySession = new Map<string, Record<string, unknown>[]>();

			for (const item of items) {
				if (item == null || typeof item !== "object" || Array.isArray(item)) {
					return c.json({ error: "event must be an object" }, 400);
				}
				const itemObj = item as Record<string, unknown>;

				let itemSessionId: string | null;
				try {
					itemSessionId = resolveSessionStreamId(itemObj);
				} catch (err) {
					return c.json({ error: (err as Error).message }, 400);
				}
				const opencodeSessionId = String(itemSessionId ?? defaultSessionId ?? "");
				if (!opencodeSessionId) {
					return c.json({ error: "session id required" }, 400);
				}
				if (opencodeSessionId.startsWith("msg_")) {
					return c.json({ error: "invalid session id" }, 400);
				}

				let eventId = String(itemObj.event_id ?? "");
				const eventType = String(itemObj.event_type ?? "");
				if (!eventType) {
					return c.json({ error: "event_type required" }, 400);
				}

				const eventSeqValue = itemObj.event_seq;
				if (eventSeqValue != null) {
					const parsed = Number(eventSeqValue);
					if (!Number.isFinite(parsed) || parsed !== Math.floor(parsed)) {
						return c.json({ error: "event_seq must be int" }, 400);
					}
				}

				let tsWallMs = itemObj.ts_wall_ms;
				if (tsWallMs != null) {
					const parsed = Number(tsWallMs);
					if (!Number.isFinite(parsed)) {
						return c.json({ error: "ts_wall_ms must be int" }, 400);
					}
					tsWallMs = Math.floor(parsed);
					const prev = lastSeenBySession.get(opencodeSessionId) ?? (tsWallMs as number);
					lastSeenBySession.set(opencodeSessionId, Math.max(prev, tsWallMs as number));
				}

				let tsMonoMs = itemObj.ts_mono_ms;
				if (tsMonoMs != null) {
					const parsed = Number(tsMonoMs);
					if (!Number.isFinite(parsed)) {
						return c.json({ error: "ts_mono_ms must be number" }, 400);
					}
					tsMonoMs = parsed;
				}

				let eventPayload = itemObj.payload;
				if (eventPayload == null) eventPayload = {};
				if (typeof eventPayload !== "object" || Array.isArray(eventPayload)) {
					return c.json({ error: "payload must be an object" }, 400);
				}

				// Per-item meta fields
				const itemCwd = itemObj.cwd;
				if (itemCwd != null && typeof itemCwd !== "string") {
					return c.json({ error: "cwd must be string" }, 400);
				}
				const itemProject = itemObj.project;
				if (itemProject != null && typeof itemProject !== "string") {
					return c.json({ error: "project must be string" }, 400);
				}
				const itemStartedAt = itemObj.started_at;
				if (itemStartedAt != null && typeof itemStartedAt !== "string") {
					return c.json({ error: "started_at must be string" }, 400);
				}

				// Sanitize payload
				eventPayload = stripPrivateObj(eventPayload) as Record<string, unknown>;

				// Generate stable event_id for legacy senders.
				// Python uses json.dumps(sort_keys=True) which recursively sorts all keys.
				// We replicate with a recursive key-sorting replacer.
				if (!eventId) {
					const sortedStringify = (obj: unknown): string =>
						JSON.stringify(obj, (_key, value) => {
							if (value != null && typeof value === "object" && !Array.isArray(value)) {
								const sorted: Record<string, unknown> = {};
								for (const k of Object.keys(value as Record<string, unknown>).sort()) {
									sorted[k] = (value as Record<string, unknown>)[k];
								}
								return sorted;
							}
							return value;
						});
					if (eventSeqValue != null) {
						const rawId = sortedStringify({
							s: eventSeqValue,
							t: eventType,
							p: eventPayload,
						});
						const hash = createHash("sha256").update(rawId, "utf-8").digest("hex").slice(0, 16);
						eventId = `legacy-seq-${eventSeqValue}-${hash}`;
					} else {
						const rawId = sortedStringify({
							m: tsMonoMs ?? null,
							p: eventPayload,
							t: eventType,
							w: tsWallMs ?? null,
						});
						eventId = `legacy-${createHash("sha256").update(rawId, "utf-8").digest("hex").slice(0, 16)}`;
					}
				}

				const eventEntry: Record<string, unknown> = {
					event_id: eventId,
					event_type: eventType,
					payload: eventPayload,
					ts_wall_ms: tsWallMs ?? null,
					ts_mono_ms: tsMonoMs ?? null,
				};

				sessionIds.add(opencodeSessionId);
				const list = batchBySession.get(opencodeSessionId) ?? [];
				list.push({ ...eventEntry });
				batchBySession.set(opencodeSessionId, list);

				if (itemCwd || itemProject || itemStartedAt) {
					const perSession = metaBySession.get(opencodeSessionId) ?? {};
					if (itemCwd) perSession.cwd = itemCwd as string;
					if (itemProject) perSession.project = itemProject as string;
					if (itemStartedAt) perSession.started_at = itemStartedAt as string;
					metaBySession.set(opencodeSessionId, perSession);
				}
			}

			// Insert events
			if (sessionIds.size === 1) {
				const singleSessionId = sessionIds.values().next().value as string;
				const batch = batchBySession.get(singleSessionId) ?? [];
				const result = store.recordRawEventsBatch(singleSessionId, batch);
				inserted = result.inserted;
			} else {
				for (const [sid, sidEvents] of batchBySession) {
					const result = store.recordRawEventsBatch(sid, sidEvents);
					inserted += result.inserted;
				}
			}

			// Update session metadata
			for (const metaSessionId of sessionIds) {
				const sessionMeta = metaBySession.get(metaSessionId) ?? {};
				const applyRequestMeta = sessionIds.size === 1 || metaSessionId === defaultSessionId;
				store.updateRawEventSessionMeta({
					opencodeSessionId: metaSessionId,
					cwd:
						sessionMeta.cwd ?? (applyRequestMeta ? (cwd as string | undefined) : undefined) ?? null,
					project:
						sessionMeta.project ??
						(applyRequestMeta ? (project as string | undefined) : undefined) ??
						null,
					startedAt:
						sessionMeta.started_at ??
						(applyRequestMeta ? (startedAt as string | undefined) : undefined) ??
						null,
					lastSeenTsWallMs: lastSeenBySession.get(metaSessionId) ?? null,
				});
			}

			// Note per-session activity for optional debounced auto-flush.
			nudgeSweeper(sweeper, sessionIds);

			return c.json({ inserted, received: (items as unknown[]).length });
		} catch (err) {
			const response: Record<string, unknown> = { error: "internal server error" };
			if (process.env.CODEMEM_VIEWER_DEBUG === "1") {
				response.detail = (err as Error).message;
			}
			return c.json(response, 500);
		}
	});

	// POST /api/claude-hooks — ingest Claude Code hook events
	app.post("/api/claude-hooks", async (c) => {
		const result = await parseJsonObjectBody(c, MAX_RAW_EVENTS_BODY_BYTES);
		if (result instanceof Response) return result;
		const payload = result;

		// Map hook payload → raw event envelope
		const envelope = buildRawEventEnvelopeFromHook(payload);
		if (envelope === null) {
			// Unsupported event type or missing required fields — skip gracefully
			return c.json({ inserted: 0, skipped: 1 });
		}

		const store = getStore();
		try {
			const opencodeSessionId = envelope.opencode_session_id;
			const source = envelope.source;
			const strippedPayload = stripPrivateObj(envelope.payload) as Record<string, unknown>;

			const inserted = store.recordRawEvent({
				opencodeSessionId,
				source,
				eventId: envelope.event_id,
				eventType: "claude.hook",
				payload: strippedPayload,
				tsWallMs: envelope.ts_wall_ms,
			});

			store.updateRawEventSessionMeta({
				opencodeSessionId,
				source,
				cwd: envelope.cwd,
				project: envelope.project,
				startedAt: envelope.started_at,
				lastSeenTsWallMs: envelope.ts_wall_ms,
			});

			// Note activity for optional debounced auto-flush.
			nudgeSweeper(sweeper, [opencodeSessionId], source);

			return c.json({ inserted: inserted ? 1 : 0, skipped: 0 });
		} catch (err) {
			const response: Record<string, unknown> = { error: "internal server error" };
			if (process.env.CODEMEM_VIEWER_DEBUG === "1") {
				response.detail = (err as Error).message;
			}
			return c.json(response, 500);
		}
	});

	return app;
}
