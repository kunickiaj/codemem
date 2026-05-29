/**
 * Codex hook payload mapping.
 *
 * Normalizes Codex plugin hook payloads into AdapterEvent v1 envelopes for
 * the shared raw-event sweeper pipeline.
 */

import { createHash } from "node:crypto";
import {
	extractFromTranscript,
	normalizeProjectLabel,
	resolveHookProject,
} from "./claude-hooks.js";

export const MAPPABLE_CODEX_HOOK_EVENTS = new Set([
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"Stop",
]);

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

function stableEventId(...parts: string[]): string {
	const digest = createHash("sha256").update(parts.join("|"), "utf-8").digest("hex").slice(0, 24);
	return `cdx_evt_${digest}`;
}

function coerceString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function coerceSessionId(payload: Record<string, unknown>): string | null {
	const value = coerceString(payload.session_id);
	return value || null;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function sortKeys(value: unknown): unknown {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
	}
	return sorted;
}

export interface CodexHookAdapterEvent {
	schema_version: "1.0";
	source: "codex";
	session_id: string;
	event_id: string;
	event_type: string;
	ts: string;
	ordering_confidence: "low";
	cwd: string | null;
	payload: Record<string, unknown>;
	meta: Record<string, unknown>;
}

export function mapCodexHookPayload(
	payload: Record<string, unknown>,
): CodexHookAdapterEvent | null {
	const hookEvent = coerceString(payload.hook_event_name);
	if (!MAPPABLE_CODEX_HOOK_EVENTS.has(hookEvent)) return null;

	const sessionId = coerceSessionId(payload);
	if (!sessionId) return null;

	const normalizedRawTs = normalizeIsoTs(payload.ts ?? payload.timestamp);
	const ts = normalizedRawTs ?? nowIso();
	const generatedEventNonce = coerceString(payload.codemem_generated_event_nonce);
	const toolUseId = coerceString(payload.tool_use_id);
	const turnId = coerceString(payload.turn_id);

	const consumed = new Set([
		"hook_event_name",
		"session_id",
		"cwd",
		"ts",
		"timestamp",
		"transcript_path",
		"permission_mode",
		"codemem_generated_event_nonce",
		"tool_use_id",
		"turn_id",
		"model",
		"subagent",
	]);

	let eventType: string;
	let eventPayload: Record<string, unknown>;
	let eventIdPayload: Record<string, unknown>;
	let contentAnchoredEventId = false;

	if (hookEvent === "SessionStart") {
		const target = objectOrEmpty(payload.target);
		const source = payload.source ?? target.source ?? null;
		eventType = "session_start";
		eventPayload = { source, target: Object.keys(target).length ? target : null };
		eventIdPayload = { ...eventPayload };
		consumed.add("source");
		consumed.add("target");
	} else if (hookEvent === "UserPromptSubmit") {
		const text = coerceString(payload.prompt);
		if (!text) return null;
		eventType = "prompt";
		eventPayload = { text };
		eventIdPayload = { ...eventPayload };
		consumed.add("prompt");
	} else if (hookEvent === "PreToolUse") {
		const toolName = coerceString(payload.tool_name);
		if (!toolName) return null;
		const toolInput = objectOrEmpty(payload.tool_input);
		eventType = "tool_call";
		eventPayload = { tool_name: toolName, tool_input: toolInput };
		eventIdPayload = { ...eventPayload };
		consumed.add("tool_name");
		consumed.add("tool_input");
		consumed.add("matcher_aliases");
	} else if (hookEvent === "PostToolUse") {
		const toolName = coerceString(payload.tool_name);
		if (!toolName) return null;
		const toolInput = objectOrEmpty(payload.tool_input);
		const toolResponse = payload.tool_response ?? null;
		eventType = "tool_result";
		eventPayload = {
			tool_name: toolName,
			status: "ok",
			tool_input: toolInput,
			tool_output: toolResponse,
			tool_error: null,
		};
		eventIdPayload = { ...eventPayload };
		consumed.add("tool_name");
		consumed.add("tool_input");
		consumed.add("tool_response");
		consumed.add("matcher_aliases");
	} else {
		// Stop: prefer the inline assistant message, then fall back to the
		// transcript's last assistant text so Codex Stop payloads that only
		// carry `transcript_path` still reach the observer pipeline.
		//
		// Token usage is intentionally not captured for Codex Stop events:
		// the Codex MVP scope is context injection + ingestion only, so the
		// transcript usage tuple is discarded here. Mirror the Claude usage
		// handling if/when Codex usage capture becomes in scope.
		const rawAssistantText = coerceString(payload.last_assistant_message);
		let assistantText = rawAssistantText;
		if (!assistantText) {
			const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
			const [transcriptText] = extractFromTranscript(payload.transcript_path, cwd);
			if (transcriptText) assistantText = transcriptText.trim();
		}
		if (!assistantText) return null;
		eventType = "assistant";
		eventPayload = { text: assistantText };
		contentAnchoredEventId = true;

		// Keep the event id stable on the raw inline text when present;
		// otherwise anchor it to the transcript path so retries dedupe and a
		// later inline-text payload is still treated as a distinct event.
		if (rawAssistantText) {
			eventIdPayload = { text: rawAssistantText };
		} else {
			const transcriptPath = coerceString(payload.transcript_path);
			eventIdPayload = transcriptPath
				? { transcript_path: transcriptPath }
				: { text: assistantText };
		}
		consumed.add("stop_hook_active");
		consumed.add("last_assistant_message");
		consumed.add("target");
	}

	const meta: Record<string, unknown> = {
		hook_event_name: hookEvent,
		ordering_confidence: "low",
	};
	if (toolUseId) meta.tool_use_id = toolUseId;
	if (turnId) meta.turn_id = turnId;
	if (normalizedRawTs === null) meta.ts_normalized = "generated";

	const unknown: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (!consumed.has(key)) unknown[key] = value;
	}
	if (Object.keys(unknown).length > 0) meta.hook_fields = unknown;

	const payloadHash = createHash("sha256")
		.update(JSON.stringify(sortKeys(eventIdPayload)), "utf-8")
		.digest("hex");
	// Stop events are content-anchored: their identity is the assistant message
	// (inline text or transcript), so retries of the same completion must dedupe.
	// Excluding the generated wall-clock ts and per-call nonce keeps the id stable
	// when Codex omits a timestamp. Other event types keep the generated-time
	// fallbacks to avoid collisions for repeated timestamp-less payloads.
	const eventIdTs = normalizedRawTs ?? (contentAnchoredEventId ? "" : ts);
	const eventIdNonce = contentAnchoredEventId ? "" : generatedEventNonce;
	const eventId = stableEventId(
		sessionId,
		hookEvent,
		eventIdTs,
		turnId,
		toolUseId,
		eventIdNonce,
		payloadHash,
	);
	const cwd = typeof payload.cwd === "string" ? payload.cwd : null;

	return {
		schema_version: "1.0",
		source: "codex",
		session_id: sessionId,
		event_id: eventId,
		event_type: eventType,
		ts,
		ordering_confidence: "low",
		cwd,
		payload: eventPayload,
		meta,
	};
}

export interface CodexHookRawEventEnvelope {
	session_stream_id: string;
	session_id: string;
	opencode_session_id: string;
	source: string;
	event_id: string;
	event_type: "codex.hook";
	payload: Record<string, unknown>;
	ts_wall_ms: number;
	cwd: string | null;
	project: string | null;
	started_at: string | null;
}

export function buildRawEventEnvelopeFromCodexHook(
	hookPayload: Record<string, unknown>,
): CodexHookRawEventEnvelope | null {
	const adapterEvent = mapCodexHookPayload(hookPayload);
	if (adapterEvent === null) return null;

	const sessionId = adapterEvent.session_id.trim();
	if (!sessionId) return null;
	const ts = adapterEvent.ts.trim();
	if (!ts) return null;

	const cwd = typeof hookPayload.cwd === "string" ? hookPayload.cwd : null;
	const project =
		resolveHookProject(cwd, hookPayload.project) ?? normalizeProjectLabel(hookPayload.project);
	const hookEventName = coerceString(hookPayload.hook_event_name);

	return {
		session_stream_id: sessionId,
		session_id: sessionId,
		opencode_session_id: sessionId,
		source: "codex",
		event_id: adapterEvent.event_id,
		event_type: "codex.hook",
		payload: {
			type: "codex.hook",
			timestamp: ts,
			_adapter: adapterEvent,
		},
		ts_wall_ms: isoToWallMs(ts),
		cwd,
		project,
		started_at: hookEventName === "SessionStart" ? ts : null,
	};
}

export function buildIngestPayloadFromCodexHook(
	hookPayload: Record<string, unknown>,
): Record<string, unknown> | null {
	const adapterEvent = mapCodexHookPayload(hookPayload);
	if (adapterEvent === null) return null;
	const sessionId = adapterEvent.session_id;
	return {
		cwd: hookPayload.cwd ?? null,
		events: [
			{
				type: "codex.hook",
				timestamp: adapterEvent.ts,
				_adapter: adapterEvent,
			},
		],
		session_context: {
			source: "codex",
			stream_id: sessionId,
			session_stream_id: sessionId,
			session_id: sessionId,
			opencode_session_id: sessionId,
		},
	};
}
