import { createParser } from "eventsource-parser";

const SSE_MAX_BUFFER_CHARS = 1024 * 1024;

export interface ParsedObserverSSE {
	raw: string | null;
	usageFields: Record<string, unknown>;
}

function collectUsage(event: Record<string, unknown>, usageFields: Record<string, unknown>): void {
	for (const candidate of [event, event.response, event.message]) {
		if (typeof candidate !== "object" || candidate == null || Array.isArray(candidate)) continue;
		const usage = (candidate as Record<string, unknown>).usage;
		if (typeof usage === "object" && usage != null && !Array.isArray(usage)) {
			Object.assign(usageFields, usage);
		}
	}
}

function collectPayload(
	payload: string,
	extractDelta: (event: Record<string, unknown>) => string | null,
	parts: string[],
	usageFields: Record<string, unknown>,
): void {
	if (!payload || payload === "[DONE]") return;
	try {
		const event = JSON.parse(payload) as Record<string, unknown>;
		const delta = extractDelta(event);
		if (delta) parts.push(delta);
		collectUsage(event, usageFields);
	} catch {
		// Skip malformed event payloads while continuing the stream.
	}
}

export async function parseObserverSSE(
	body: ReadableStream<Uint8Array> | null,
	extractDelta: (event: Record<string, unknown>) => string | null,
): Promise<ParsedObserverSSE> {
	const parts: string[] = [];
	const usageFields: Record<string, unknown> = {};
	const parser = createParser({
		maxBufferSize: SSE_MAX_BUFFER_CHARS,
		onError(error) {
			if (error.type === "max-buffer-size-exceeded") throw error;
		},
		onEvent({ data }) {
			collectPayload(data, extractDelta, parts, usageFields);
		},
	});
	if (body) {
		const decoder = new TextDecoder();
		for await (const chunk of body) parser.feed(decoder.decode(chunk, { stream: true }));
		const trailingText = decoder.decode();
		if (trailingText) parser.feed(trailingText);
	}
	// The SSE spec dispatches only events terminated by a blank line. Discard a
	// truncated final event rather than treating incomplete provider output as valid.
	parser.reset();
	return { raw: parts.length > 0 ? parts.join("").trim() : null, usageFields };
}
