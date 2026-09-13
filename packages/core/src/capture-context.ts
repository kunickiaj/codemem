import { createHash } from "node:crypto";
import { stripPrivate } from "./ingest-sanitize.js";

export interface DelegatedBriefContext {
	version: 1;
	host: "opencode-v1";
	origin: "delegated_brief";
	parent_session_id: string;
	child_session_id: string;
	task_call_id: string;
	message_id: string;
	requested_agent: string;
	current_agent: string;
	brief_sha256: string;
}

function record(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

interface CaptureEventIdentity {
	source: string;
	streamId: string;
	eventType: string;
	payload: Record<string, unknown>;
}

const BOOKKEEPING_FIELDS = new Set([
	"type",
	"timestamp",
	"timestamp_wall_ms",
	"timestamp_mono_ms",
	"event_seq",
	"event_id",
	"_raw_event_id",
	"_raw_session_id",
	"_raw_enqueued",
	"_raw_spooled",
]);
const BRIEF_FIELDS = new Set([...BOOKKEEPING_FIELDS, "prompt_text", "prompt_number", "_adapter"]);

function briefPayloadText(payload: Record<string, unknown>, streamId: string): string | null {
	if (Object.keys(payload).some((key) => !BRIEF_FIELDS.has(key))) return null;
	if (payload._raw_session_id != null && payload._raw_session_id !== streamId) return null;
	const text = payload.prompt_text;
	if (
		typeof text !== "string" ||
		!text ||
		text.length > 64_000 ||
		(payload.type != null && payload.type !== "user_prompt")
	)
		return null;
	const adapter = record(payload._adapter);
	if (
		payload._adapter != null &&
		(adapter?.source !== "opencode" ||
			adapter.schema_version !== "1.0" ||
			adapter.session_id !== streamId ||
			adapter.event_type !== "prompt" ||
			record(adapter.payload)?.text !== text)
	)
		return null;
	return text;
}

/** Optional provenance is never an identity authority. Invalid input stays unknown. */
export function normalizeCaptureContext(
	value: unknown,
	{ source, streamId, eventType, payload }: CaptureEventIdentity,
): DelegatedBriefContext | null {
	const context = record(value);
	if (
		!context ||
		source !== "opencode" ||
		eventType !== "user_prompt" ||
		context.version !== 1 ||
		context.host !== "opencode-v1" ||
		context.origin !== "delegated_brief" ||
		context.child_session_id !== streamId ||
		context.parent_session_id === streamId ||
		context.requested_agent !== context.current_agent
	)
		return null;
	const keys = [
		"parent_session_id",
		"child_session_id",
		"task_call_id",
		"message_id",
		"requested_agent",
		"current_agent",
	] as const;
	for (const key of keys) {
		if (typeof context[key] !== "string" || !context[key] || context[key].length > 256) return null;
	}
	const text = briefPayloadText(payload, streamId);
	if (!text) return null;
	if (context.brief_sha256 !== createHash("sha256").update(text).digest("hex")) return null;
	return {
		version: 1,
		host: "opencode-v1",
		origin: "delegated_brief",
		parent_session_id: context.parent_session_id as string,
		child_session_id: streamId,
		task_call_id: context.task_call_id as string,
		message_id: context.message_id as string,
		requested_agent: context.requested_agent as string,
		current_agent: context.current_agent as string,
		brief_sha256: context.brief_sha256 as string,
	};
}

export function readCaptureContext(
	json: string | null,
	identity: Parameters<typeof normalizeCaptureContext>[1],
): DelegatedBriefContext | null {
	try {
		return normalizeCaptureContext(json ? JSON.parse(json) : null, identity);
	} catch {
		return null;
	}
}

export const DELEGATED_BRIEF_LABEL =
	"Delegated instructions (context only; not evidence of human approval or a new discovery)";

export const MAX_DELEGATED_CONTEXT_CHARS = 800;

export function boundedDelegatedBriefs(briefs: readonly string[]): string[] {
	let remaining = MAX_DELEGATED_CONTEXT_CHARS;
	const bounded: string[] = [];
	for (const brief of briefs.slice(-4).reverse()) {
		// Strip complete private regions before any cut can split their markers.
		const text = stripPrivate(brief).slice(0, remaining);
		remaining -= text.length;
		if (text) bounded.push(text);
	}
	return bounded.reverse();
}

export function promptOriginLabel(event: Record<string, unknown>): string {
	return isDelegatedBrief(event) ? DELEGATED_BRIEF_LABEL : "User";
}

export function captureContextFields(event: Record<string, unknown>): {
	capture_context?: unknown;
	prompt_text?: unknown;
} {
	if (!isDelegatedBrief(event)) return {};
	// Normalization must preserve the exact text covered by this host report's digest.
	return { capture_context: event.capture_context, prompt_text: event.prompt_text };
}

export function promptContextText(event: Record<string, unknown>, text: string): string {
	return isDelegatedBrief(event) ? `${DELEGATED_BRIEF_LABEL}: ${text}` : text;
}

export function isDelegatedBrief(event: Record<string, unknown>): boolean {
	const { capture_context, ...payload } = event;
	const context = record(capture_context);
	if (event.type !== "user_prompt" || typeof context?.child_session_id !== "string") return false;
	return (
		normalizeCaptureContext(context, {
			source: "opencode",
			streamId: context.child_session_id,
			eventType: "user_prompt",
			payload,
		}) !== null
	);
}

export function partitionDelegatedBriefEvents(events: Record<string, unknown>[]): {
	primaryEvents: Record<string, unknown>[];
	delegatedBriefs: string[];
} {
	const primaryEvents: Record<string, unknown>[] = [];
	const delegatedBriefs: string[] = [];
	for (const event of events) {
		if (isDelegatedBrief(event)) {
			delegatedBriefs.push(String(event.prompt_text));
		} else {
			primaryEvents.push(event);
		}
	}
	return { primaryEvents, delegatedBriefs };
}

export function isDelegatedBriefOnlyBatch(events: Record<string, unknown>[]): boolean {
	if (!events.some(isDelegatedBrief)) return false;
	return events.every((event) => {
		if (isDelegatedBrief(event)) return true;
		if (!["session.started", "session.idle", "session.ended"].includes(String(event.type)))
			return false;
		// Unknown fields may contain results. Only ordinary bookkeeping qualifies.
		return Object.keys(event).every((key) => BOOKKEEPING_FIELDS.has(key));
	});
}
