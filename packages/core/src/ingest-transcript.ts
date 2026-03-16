/**
 * Transcript building and request analysis for the ingest pipeline.
 *
 * Ports codemem/ingest/transcript.py + relevant extraction functions
 * from codemem/plugin_ingest.py.
 */

import { stripPrivate } from "./ingest-sanitize.js";
import type { ParsedSummary } from "./ingest-types.js";

// ---------------------------------------------------------------------------
// Trivial request detection
// ---------------------------------------------------------------------------

export const TRIVIAL_REQUESTS = new Set([
	"yes",
	"y",
	"ok",
	"okay",
	"approved",
	"approve",
	"looks good",
	"lgtm",
	"ship it",
	"sounds good",
	"sure",
	"go ahead",
	"proceed",
]);

/** Normalize request text for comparison: trim, strip quotes, collapse whitespace, lowercase. */
export function normalizeRequestText(text: string | null): string {
	if (!text) return "";
	let cleaned = text
		.trim()
		.replace(/^["']+|["']+$/g, "")
		.trim();
	cleaned = cleaned.replace(/\s+/g, " ");
	return cleaned.toLowerCase();
}

/** Check whether the text is a trivial approval/acknowledgement. */
export function isTrivialRequest(text: string | null): boolean {
	const normalized = normalizeRequestText(text);
	if (!normalized) return true;
	return TRIVIAL_REQUESTS.has(normalized);
}

// ---------------------------------------------------------------------------
// Sentence extraction
// ---------------------------------------------------------------------------

/** Extract the first sentence from text (strip markdown prefixes). */
export function firstSentence(text: string): string {
	let cleaned = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.join(" ");
	cleaned = cleaned.replace(/^[#*\-\d.\s]+/, "");
	const parts = cleaned.split(/(?<=[.!?])\s+/);
	return (parts[0] ?? cleaned).trim();
}

/** Derive a meaningful request from summary fields when the original is trivial. */
export function deriveRequest(summary: ParsedSummary): string {
	const candidates = [
		summary.completed,
		summary.learned,
		summary.investigated,
		summary.nextSteps,
		summary.notes,
	];
	for (const candidate of candidates) {
		if (candidate) return firstSentence(candidate);
	}
	return "";
}

// ---------------------------------------------------------------------------
// Transcript building
// ---------------------------------------------------------------------------

/**
 * Build a chronological transcript from user prompts and assistant messages.
 * Strips private content before including text.
 */
export function buildTranscript(events: Record<string, unknown>[]): string {
	const parts: string[] = [];
	for (const event of events) {
		const eventType = event.type;
		if (eventType === "user_prompt") {
			const promptText = stripPrivate(String(event.prompt_text ?? "")).trim();
			if (promptText) parts.push(`User: ${promptText}`);
		} else if (eventType === "assistant_message") {
			const assistantText = stripPrivate(String(event.assistant_text ?? "")).trim();
			if (assistantText) parts.push(`Assistant: ${assistantText}`);
		}
	}
	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/** Extract assistant text messages from raw events. */
export function extractAssistantMessages(events: Record<string, unknown>[]): string[] {
	const messages: string[] = [];
	for (const event of events) {
		if (event.type !== "assistant_message") continue;
		const text = String(event.assistant_text ?? "").trim();
		if (text) messages.push(text);
	}
	return messages;
}

/** Extract token usage events from assistant_usage events. */
export function extractAssistantUsage(events: Record<string, unknown>[]): Record<string, number>[] {
	const usageEvents: Record<string, number>[] = [];
	for (const event of events) {
		if (event.type !== "assistant_usage") continue;
		const usage = event.usage;
		if (usage == null || typeof usage !== "object") continue;
		const u = usage as Record<string, unknown>;
		const inputTokens = Number(u.input_tokens ?? 0) || 0;
		const outputTokens = Number(u.output_tokens ?? 0) || 0;
		const cacheCreation = Number(u.cache_creation_input_tokens ?? 0) || 0;
		const cacheRead = Number(u.cache_read_input_tokens ?? 0) || 0;
		const total = inputTokens + outputTokens + cacheCreation;
		if (total <= 0) continue;
		usageEvents.push({
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			cache_creation_input_tokens: cacheCreation,
			cache_read_input_tokens: cacheRead,
			total_tokens: total,
		});
	}
	return usageEvents;
}

/** Extract user prompts with prompt numbers from raw events. */
export function extractPrompts(
	events: Record<string, unknown>[],
): { promptText: string; promptNumber: number | null; timestamp: string | null }[] {
	const prompts: { promptText: string; promptNumber: number | null; timestamp: string | null }[] =
		[];
	for (const event of events) {
		if (event.type !== "user_prompt") continue;
		const promptText = String(event.prompt_text ?? "").trim();
		if (!promptText) continue;
		prompts.push({
			promptText,
			promptNumber: typeof event.prompt_number === "number" ? event.prompt_number : null,
			timestamp: typeof event.timestamp === "string" ? event.timestamp : null,
		});
	}
	return prompts;
}

/**
 * Project adapter events into the flat event format used by transcript building.
 *
 * Adapter events use the `_adapter` envelope (schema v1.0). This function
 * converts prompt and assistant adapter events into the standard
 * `user_prompt` / `assistant_message` shapes so buildTranscript can
 * process them uniformly.
 */
export function normalizeAdapterEvents(
	events: Record<string, unknown>[],
): Record<string, unknown>[] {
	return events.map((event) => {
		const adapter = event._adapter;
		if (adapter == null || typeof adapter !== "object" || Array.isArray(adapter)) return event;
		const a = adapter as Record<string, unknown>;
		if (a.schema_version !== "1.0") return event;

		const payload = a.payload;
		if (payload == null || typeof payload !== "object") return event;
		const p = payload as Record<string, unknown>;

		const eventType = String(a.event_type ?? "");
		if (eventType === "prompt") {
			const text = String(p.text ?? "").trim();
			if (!text) return event;
			return {
				type: "user_prompt",
				prompt_text: text,
				prompt_number: p.prompt_number ?? null,
				timestamp: a.ts ?? null,
			};
		}
		if (eventType === "assistant") {
			const text = String(p.text ?? "").trim();
			if (!text) return event;
			return {
				type: "assistant_message",
				assistant_text: text,
				timestamp: a.ts ?? null,
			};
		}
		return event;
	});
}
