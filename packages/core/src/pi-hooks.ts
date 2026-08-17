/**
 * Pi extension event payload mapping.
 *
 * Normalizes pi coding-agent extension events into AdapterEvent v1 envelopes
 * for the shared raw-event sweeper pipeline. Mirrors claude-hooks.ts /
 * codex-hooks.ts structure with source hard-coded to "pi".
 *
 * Entry points:
 *   mapPiEventPayload(payload)              → adapter event or null
 *   buildRawEventEnvelopeFromPiEvent(...)   → raw event envelope or null
 *   buildIngestPayloadFromPiEvent(...)      → ingest payload or null
 *   buildPiFlushSignalFromEvent(...)        → flush signal (compaction only)
 *
 * session_before_compact is observe-only: it never becomes a transcript event
 * and never returns a compaction object for pi to apply.
 */

import { normalizeProjectLabel, resolveHookProject } from "./claude-hooks.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Pi extension events that map to AdapterEvent v1 transcript types. */
export const MAPPABLE_PI_EVENTS = new Set([
	"session_start",
	"session_shutdown",
	"message_end",
	"turn_end",
	"tool_call",
	"tool_result",
]);

/** Events that only signal a boundary flush (never stored as transcript). */
export const PI_FLUSH_ONLY_EVENTS = new Set(["session_before_compact"]);

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");
}

function normalizeIsoTs(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text) return null;
	const hasTimezone =
		/[Zz]$/.test(text) || /[+-]\d{2}:\d{2}$/.test(text) || /[+-]\d{4}$/.test(text);
	const parsed = new Date(hasTimezone ? text : `${text}Z`);
	if (Number.isNaN(parsed.getTime())) return null;
	const hasFractional = /\.\d+([Zz+-]|$)/.test(text);
	return hasFractional
		? parsed.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z")
		: parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isoToWallMs(value: string): number {
	return new Date(value).getTime();
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function coerceString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** Read the first defined field among camelCase / snake_case aliases. */
function field(payload: Record<string, unknown>, ...keys: string[]): unknown {
	for (const key of keys) {
		if (Object.hasOwn(payload, key) && payload[key] !== undefined) return payload[key];
	}
	return undefined;
}

function coerceSessionId(payload: Record<string, unknown>): string | null {
	const value = coerceString(field(payload, "sessionId", "session_id"));
	return value || null;
}

function coercePiEventName(payload: Record<string, unknown>): string {
	return coerceString(field(payload, "piEvent", "pi_event", "event", "type"));
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function coerceBool(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		const t = value.trim().toLowerCase();
		return t === "true" || t === "1" || t === "yes";
	}
	return false;
}

/**
 * Deterministic event id: `pi:<sessionId>:<entryId|toolCallId|stable-suffix>`.
 * Same logical event must yield the same id across HTTP/CLI retries.
 */
function buildPiEventId(sessionId: string, stablePart: string): string {
	const part = stablePart.trim();
	if (!part) throw new Error("pi event id stable part is required");
	return `pi:${sessionId}:${part}`;
}

// ---------------------------------------------------------------------------
// mapPiEventPayload
// ---------------------------------------------------------------------------

export interface PiHookAdapterEvent {
	schema_version: "1.0";
	source: "pi";
	session_id: string;
	event_id: string;
	event_type: string;
	ts: string;
	ordering_confidence: "low";
	cwd: string | null;
	payload: Record<string, unknown>;
	meta: Record<string, unknown>;
}

/**
 * Map a pi extension event payload to a normalized AdapterEvent v1.
 * Returns null if the event type is unsupported, flush-only, or required
 * fields are missing.
 */
export function mapPiEventPayload(payload: Record<string, unknown>): PiHookAdapterEvent | null {
	const piEvent = coercePiEventName(payload);
	if (!piEvent) return null;

	// Compaction is observe-only — never a transcript AdapterEvent.
	if (PI_FLUSH_ONLY_EVENTS.has(piEvent)) return null;
	if (!MAPPABLE_PI_EVENTS.has(piEvent)) return null;

	const sessionId = coerceSessionId(payload);
	if (!sessionId) return null;

	const normalizedRawTs = normalizeIsoTs(field(payload, "ts", "timestamp"));
	const ts = normalizedRawTs ?? nowIso();

	const entryId = coerceString(field(payload, "entryId", "entry_id"));
	const toolCallId = coerceString(field(payload, "toolCallId", "tool_call_id"));
	const cwdRaw = field(payload, "cwd");
	const cwd = typeof cwdRaw === "string" ? cwdRaw : null;

	const consumed = new Set([
		"piEvent",
		"pi_event",
		"event",
		"type",
		"sessionId",
		"session_id",
		"entryId",
		"entry_id",
		"toolCallId",
		"tool_call_id",
		"cwd",
		"ts",
		"timestamp",
		"project",
	]);

	let eventType: string;
	let eventPayload: Record<string, unknown>;
	let idPart: string | null = null;

	if (piEvent === "session_start") {
		eventType = "session_start";
		eventPayload = {};
		idPart = entryId || "session_start";
	} else if (piEvent === "session_shutdown") {
		const reason = field(payload, "reason");
		eventType = "session_end";
		eventPayload = { reason: reason ?? null };
		idPart = entryId || "session_end";
		consumed.add("reason");
	} else if (piEvent === "message_end") {
		const role = coerceString(field(payload, "role")).toLowerCase();
		const text = coerceString(field(payload, "text", "content", "prompt"));
		if (!text) return null;
		if (!entryId) return null;
		if (role === "user") {
			eventType = "prompt";
			eventPayload = { text };
		} else if (role === "assistant") {
			eventType = "assistant";
			eventPayload = { text };
		} else {
			return null;
		}
		idPart = entryId;
		consumed.add("role");
		consumed.add("text");
		consumed.add("content");
		consumed.add("prompt");
	} else if (piEvent === "turn_end") {
		// Design D2: turn_end → assistant. Extension emits message_end for completed
		// assistant turns; agent_end is intentionally not in the mappable set.
		const text = coerceString(field(payload, "text", "content"));
		if (!text) return null;
		if (!entryId && !toolCallId) return null;
		eventType = "assistant";
		eventPayload = { text };
		idPart = entryId || toolCallId;
		consumed.add("role");
		consumed.add("text");
		consumed.add("content");
	} else if (piEvent === "tool_call") {
		const toolName = coerceString(field(payload, "toolName", "tool_name", "name"));
		if (!toolName) return null;
		if (!toolCallId && !entryId) return null;
		const toolInput = objectOrEmpty(field(payload, "toolInput", "tool_input", "args", "input"));
		eventType = "tool_call";
		eventPayload = { tool_name: toolName, tool_input: toolInput };
		idPart = toolCallId || entryId;
		consumed.add("toolName");
		consumed.add("tool_name");
		consumed.add("name");
		consumed.add("toolInput");
		consumed.add("tool_input");
		consumed.add("args");
		consumed.add("input");
	} else if (piEvent === "tool_result") {
		const toolName = coerceString(field(payload, "toolName", "tool_name", "name"));
		if (!toolName) return null;
		if (!toolCallId && !entryId) return null;
		const toolInput = objectOrEmpty(field(payload, "toolInput", "tool_input", "args", "input"));
		const isError = coerceBool(field(payload, "isError", "is_error"));
		const toolOutput = field(payload, "toolOutput", "tool_output", "output", "result") ?? null;
		const error = field(payload, "error", "tool_error") ?? null;
		eventType = "tool_result";
		if (isError) {
			eventPayload = {
				tool_name: toolName,
				status: "error",
				tool_input: toolInput,
				tool_output: null,
				tool_error: error ?? true,
				error: error ?? true,
			};
		} else {
			eventPayload = {
				tool_name: toolName,
				status: "ok",
				tool_input: toolInput,
				tool_output: toolOutput,
				tool_error: null,
			};
		}
		// tool_result ids prefer toolCallId so call/result pair on the same id root.
		idPart = toolCallId ? `${toolCallId}:result` : `${entryId}:result`;
		consumed.add("toolName");
		consumed.add("tool_name");
		consumed.add("name");
		consumed.add("toolInput");
		consumed.add("tool_input");
		consumed.add("args");
		consumed.add("input");
		consumed.add("toolOutput");
		consumed.add("tool_output");
		consumed.add("output");
		consumed.add("result");
		consumed.add("isError");
		consumed.add("is_error");
		consumed.add("error");
		consumed.add("tool_error");
	} else {
		return null;
	}

	if (!idPart) return null;

	const meta: Record<string, unknown> = {
		pi_event: piEvent,
		ordering_confidence: "low",
	};
	if (entryId) meta.entry_id = entryId;
	if (toolCallId) meta.tool_call_id = toolCallId;
	if (normalizedRawTs === null) meta.ts_normalized = "generated";

	const unknown: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (!consumed.has(key)) unknown[key] = value;
	}
	if (Object.keys(unknown).length > 0) meta.pi_fields = unknown;

	return {
		schema_version: "1.0",
		source: "pi",
		session_id: sessionId,
		event_id: buildPiEventId(sessionId, idPart),
		event_type: eventType,
		ts,
		ordering_confidence: "low",
		cwd,
		payload: eventPayload,
		meta,
	};
}

// ---------------------------------------------------------------------------
// Flush signal (session_before_compact — observe only)
// ---------------------------------------------------------------------------

export interface PiFlushSignal {
	kind: "flush";
	reason: "session_before_compact";
	source: "pi";
	session_id: string;
	ts: string;
	cwd: string | null;
	project: string | null;
}

/**
 * Build a flush signal for pi compaction boundaries.
 * Returns null unless the payload is a session_before_compact event with a
 * session id. Never produces a compaction object for pi to apply.
 */
export function buildPiFlushSignalFromEvent(
	payload: Record<string, unknown>,
): PiFlushSignal | null {
	const piEvent = coercePiEventName(payload);
	if (!PI_FLUSH_ONLY_EVENTS.has(piEvent)) return null;

	const sessionId = coerceSessionId(payload);
	if (!sessionId) return null;

	const normalizedRawTs = normalizeIsoTs(field(payload, "ts", "timestamp"));
	const ts = normalizedRawTs ?? nowIso();
	const cwdRaw = field(payload, "cwd");
	const cwd = typeof cwdRaw === "string" ? cwdRaw : null;
	const project =
		resolveHookProject(cwd, field(payload, "project")) ??
		normalizeProjectLabel(field(payload, "project"));

	return {
		kind: "flush",
		reason: "session_before_compact",
		source: "pi",
		session_id: sessionId,
		ts,
		cwd,
		project,
	};
}

// ---------------------------------------------------------------------------
// buildRawEventEnvelopeFromPiEvent
// ---------------------------------------------------------------------------

export interface PiHookRawEventEnvelope {
	session_stream_id: string;
	session_id: string;
	opencode_session_id: string;
	source: "pi";
	event_id: string;
	event_type: "pi.hook";
	payload: Record<string, unknown>;
	ts_wall_ms: number;
	cwd: string | null;
	project: string | null;
	started_at: string | null;
}

/**
 * Build a raw event envelope from a pi extension event payload.
 * Returns null if the payload is unsupported, flush-only, or missing fields.
 * Source is always the literal "pi" — never falls through to a default.
 */
export function buildRawEventEnvelopeFromPiEvent(
	piPayload: Record<string, unknown>,
): PiHookRawEventEnvelope | null {
	const adapterEvent = mapPiEventPayload(piPayload);
	if (adapterEvent === null) return null;

	const sessionId = adapterEvent.session_id.trim();
	if (!sessionId) return null;
	const ts = adapterEvent.ts.trim();
	if (!ts) return null;

	const cwdRaw = field(piPayload, "cwd");
	const cwd = typeof cwdRaw === "string" ? cwdRaw : null;
	const project =
		resolveHookProject(cwd, field(piPayload, "project")) ??
		normalizeProjectLabel(field(piPayload, "project"));
	const piEvent = coercePiEventName(piPayload);

	return {
		session_stream_id: sessionId,
		session_id: sessionId,
		opencode_session_id: sessionId,
		source: "pi",
		event_id: adapterEvent.event_id,
		event_type: "pi.hook",
		payload: {
			type: "pi.hook",
			timestamp: ts,
			_adapter: adapterEvent,
		},
		ts_wall_ms: isoToWallMs(ts),
		cwd,
		project,
		started_at: piEvent === "session_start" ? ts : null,
	};
}

// ---------------------------------------------------------------------------
// buildIngestPayloadFromPiEvent
// ---------------------------------------------------------------------------

/**
 * Build an ingest pipeline payload from a pi extension event.
 * Used by the direct-ingest path. Source is always the literal "pi".
 * Returns null if the payload is unsupported or flush-only.
 */
export function buildIngestPayloadFromPiEvent(
	piPayload: Record<string, unknown>,
): Record<string, unknown> | null {
	const adapterEvent = mapPiEventPayload(piPayload);
	if (adapterEvent === null) return null;

	const sessionId = adapterEvent.session_id;
	return {
		cwd: field(piPayload, "cwd") ?? null,
		events: [
			{
				type: "pi.hook",
				timestamp: adapterEvent.ts,
				_adapter: adapterEvent,
			},
		],
		session_context: {
			source: "pi",
			stream_id: sessionId,
			session_stream_id: sessionId,
			session_id: sessionId,
			opencode_session_id: sessionId,
		},
	};
}
