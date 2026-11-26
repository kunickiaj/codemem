/**
 * The `<private>` lexer, the one source for core and for every plugin copy.
 *
 * Plugins that cannot import core ship a generated copy of this module, built by
 * `pnpm run build:adapter-normalizers`, so it must stay free of imports.
 *
 * Contract: a private block protects text inside the single text value where it is
 * written, one message or one string field of a tool event. It never spans values,
 * messages or events. Markers are literal `<private ...>` and `</private>` tags in
 * any case, with optional whitespace and attributes, and nest by depth. An opener
 * with no closer in the same value removes the rest of that value; a tag cut off
 * before its `>` at the end of a value counts as an unterminated opener. A closer
 * with no opener is removed and nothing else is. `<private/>`, escaped forms such
 * as `&lt;private&gt;`, and other tag names such as `<private-notes>` are text.
 * Text without markers is returned unchanged.
 */

type PrivateTag = { kind: "open" | "close" | "self" | "cut"; end: number };

const TAG_NAME_CHAR = /[A-Za-z0-9_.:-]/;
const WHITESPACE = /\s/;

function skipWhitespace(text: string, index: number): number {
	let next = index;
	while (next < text.length && WHITESPACE.test(text.charAt(next))) next += 1;
	return next;
}

/** The private tag starting at `text[start]` (a `<`), or null when it is not one. */
function readPrivateTag(text: string, start: number): PrivateTag | null {
	let index = skipWhitespace(text, start + 1);
	const closer = text.charAt(index) === "/";
	index = skipWhitespace(text, closer ? index + 1 : index);
	const nameStart = index;
	while (index < text.length && TAG_NAME_CHAR.test(text.charAt(index))) index += 1;
	// The name must be exactly `private`; `<private-notes>` is another tag.
	if (text.slice(nameStart, index).toLowerCase() !== "private") return null;
	return readTagEnd(text, index, closer);
}

/**
 * Where a tag ends: the first `>` outside a quoted attribute value. A tag that
 * reaches the end of the text, or ends inside an unclosed quote, is cut off.
 */
function readTagEnd(text: string, start: number, closer: boolean): PrivateTag {
	let lastSignificant = "";
	for (let index = start; index < text.length; index += 1) {
		const char = text.charAt(index);
		if (char === '"' || char === "'") {
			const closingQuote = text.indexOf(char, index + 1);
			if (closingQuote === -1) break;
			index = closingQuote;
			lastSignificant = char;
		} else if (char === ">") {
			return tagEnding(index + 1, closer, lastSignificant);
		} else if (!WHITESPACE.test(char)) {
			lastSignificant = char;
		}
	}
	return { kind: "cut", end: text.length };
}

/** A tag ending at `end`; an opener whose last character before `>` is `/` is self-closing. */
function tagEnding(end: number, closer: boolean, lastSignificant: string): PrivateTag {
	if (closer) return { kind: "close", end };
	return { kind: lastSignificant === "/" ? "self" : "open", end };
}

/** Remove private blocks from one text value, scanned on its own. Non-strings become "". */
export function stripPrivate(text: string): string {
	if (typeof text !== "string" || !text) return "";
	// Without the tag name there is no marker, and the text comes back unchanged.
	if (!text.toLowerCase().includes("private")) return text;
	return removePrivateBlocks(text);
}

function removePrivateBlocks(text: string): string {
	let output = "";
	let depth = 0;
	let kept = 0;
	let index = text.indexOf("<");
	while (index !== -1) {
		const tag = readPrivateTag(text, index);
		if (!tag || tag.kind === "self") {
			index = text.indexOf("<", index + 1);
			continue;
		}
		if (depth === 0) output += text.slice(kept, index);
		if (tag.kind === "cut") return output;
		if (tag.kind === "open") depth += 1;
		else if (depth > 0) depth -= 1;
		kept = tag.end;
		index = text.indexOf("<", tag.end);
	}
	return depth === 0 ? output + text.slice(kept) : output;
}

/** True when the text contains a private marker that stripping would remove. */
export function hasPrivateMarker(text: string): boolean {
	return stripPrivate(text) !== text;
}

/**
 * Remove private blocks from every string value, each scanned on its own. An entry
 * whose key carries a private marker is dropped with its value. Numbers, booleans
 * and null are not text and are kept.
 */
export function stripPrivateValues(value: unknown): unknown {
	if (typeof value === "string") return stripPrivate(value);
	if (Array.isArray(value)) return value.map(stripPrivateValues);
	if (value != null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (!hasPrivateMarker(key)) result[key] = stripPrivateValues(item);
		}
		return result;
	}
	return value;
}

const EVENT_METADATA_KEYS = ["cwd", "project", "started_at"] as const;

function sanitizeEventItem(
	item: Record<string, unknown>,
	cleanPayload: (value: unknown) => unknown,
): Record<string, unknown> {
	const sanitized = { ...item };
	if (item.payload != null && typeof item.payload === "object") {
		sanitized.payload = cleanPayload(item.payload);
	}
	for (const key of EVENT_METADATA_KEYS) {
		const value = item[key];
		if (typeof value === "string") sanitized[key] = stripPrivate(value);
	}
	return sanitized;
}

/**
 * A raw-event envelope, or a request carrying `events`, with private blocks removed
 * from each event's payload values and session metadata, every event on its own.
 * Routing fields such as source, session, stream and event IDs are left as sent.
 */
export function sanitizeRawEventEnvelope<T>(
	envelope: T,
	cleanPayload: (value: unknown) => unknown = stripPrivateValues,
): T {
	if (envelope == null || typeof envelope !== "object" || Array.isArray(envelope)) return envelope;
	const request = envelope as Record<string, unknown>;
	const sanitized = sanitizeEventItem(request, cleanPayload);
	if (Array.isArray(request.events)) {
		sanitized.events = request.events.map((event) =>
			event != null && typeof event === "object" && !Array.isArray(event)
				? sanitizeEventItem(event as Record<string, unknown>, cleanPayload)
				: event,
		);
	}
	return sanitized as T;
}

/**
 * Top-level fields of a native hook payload that route or identify the event, such
 * as the session, event name, turn, tool call and transcript location. They are
 * kept as sent; every other field is captured content.
 */
const HOOK_ROUTING_KEYS = new Set([
	"session_id",
	"sessionId",
	"hook_event_name",
	"turn_id",
	"tool_use_id",
	"transcript_path",
	"codemem_generated_event_nonce",
	"piEvent",
	"pi_event",
	"event",
	"type",
	"entryId",
	"entry_id",
	"toolCallId",
	"tool_call_id",
]);

/**
 * A native hook payload (Claude, Codex or Pi) with private blocks removed from its
 * content, each string value on its own, before it is spooled or saved.
 */
export function sanitizeHookPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (HOOK_ROUTING_KEYS.has(key)) sanitized[key] = value;
		else if (!hasPrivateMarker(key)) sanitized[key] = stripPrivateValues(value);
	}
	return sanitized;
}
