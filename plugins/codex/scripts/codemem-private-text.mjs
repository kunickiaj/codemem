//#region packages/core/src/private-text.ts
var TAG_NAME_CHAR = /[A-Za-z0-9_.:-]/;
var WHITESPACE = /\s/;
function skipWhitespace(text, index) {
	let next = index;
	while (next < text.length && WHITESPACE.test(text.charAt(next))) next += 1;
	return next;
}
/** The private tag starting at `text[start]` (a `<`), or null when it is not one. */
function readPrivateTag(text, start) {
	let index = skipWhitespace(text, start + 1);
	const closer = text.charAt(index) === "/";
	index = skipWhitespace(text, closer ? index + 1 : index);
	const nameStart = index;
	while (index < text.length && TAG_NAME_CHAR.test(text.charAt(index))) index += 1;
	if (text.slice(nameStart, index).toLowerCase() !== "private") return null;
	return readTagEnd(text, index, closer);
}
/**
* Where a tag ends: the first `>` outside a quoted attribute value. A tag that
* reaches the end of the text, or ends inside an unclosed quote, is cut off.
*/
function readTagEnd(text, start, closer) {
	let lastSignificant = "";
	for (let index = start; index < text.length; index += 1) {
		const char = text.charAt(index);
		if (char === "\"" || char === "'") {
			const closingQuote = text.indexOf(char, index + 1);
			if (closingQuote === -1) break;
			index = closingQuote;
			lastSignificant = char;
		} else if (char === ">") return tagEnding(index + 1, closer, lastSignificant);
		else if (!WHITESPACE.test(char)) lastSignificant = char;
	}
	return {
		kind: "cut",
		end: text.length
	};
}
/** A tag ending at `end`; an opener whose last character before `>` is `/` is self-closing. */
function tagEnding(end, closer, lastSignificant) {
	if (closer) return {
		kind: "close",
		end
	};
	return {
		kind: lastSignificant === "/" ? "self" : "open",
		end
	};
}
/** Remove private blocks from one text value, scanned on its own. Non-strings become "". */
function stripPrivate(text) {
	if (typeof text !== "string" || !text) return "";
	if (!text.toLowerCase().includes("private")) return text;
	return removePrivateBlocks(text);
}
function removePrivateBlocks(text) {
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
function hasPrivateMarker(text) {
	return stripPrivate(text) !== text;
}
/**
* Remove private blocks from every string value, each scanned on its own. An entry
* whose key carries a private marker is dropped with its value. Numbers, booleans
* and null are not text and are kept.
*/
function stripPrivateValues(value) {
	if (typeof value === "string") return stripPrivate(value);
	if (Array.isArray(value)) return value.map(stripPrivateValues);
	if (value != null && typeof value === "object") {
		const result = {};
		for (const [key, item] of Object.entries(value)) if (!hasPrivateMarker(key)) result[key] = stripPrivateValues(item);
		return result;
	}
	return value;
}
var EVENT_METADATA_KEYS = [
	"cwd",
	"project",
	"started_at"
];
function sanitizeEventItem(item, cleanPayload) {
	const sanitized = { ...item };
	if (item.payload != null && typeof item.payload === "object") sanitized.payload = cleanPayload(item.payload);
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
function sanitizeRawEventEnvelope(envelope, cleanPayload = stripPrivateValues) {
	if (envelope == null || typeof envelope !== "object" || Array.isArray(envelope)) return envelope;
	const request = envelope;
	const sanitized = sanitizeEventItem(request, cleanPayload);
	if (Array.isArray(request.events)) sanitized.events = request.events.map((event) => event != null && typeof event === "object" && !Array.isArray(event) ? sanitizeEventItem(event, cleanPayload) : event);
	return sanitized;
}
/**
* Top-level fields of a native hook payload that route or identify the event, such
* as the session, event name, turn, tool call and transcript location. They are
* kept as sent; every other field is captured content.
*/
var HOOK_ROUTING_KEYS = /* @__PURE__ */ new Set([
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
	"tool_call_id"
]);
/**
* A native hook payload (Claude, Codex or Pi) with private blocks removed from its
* content, each string value on its own, before it is spooled or saved.
*/
function sanitizeHookPayload(payload) {
	const sanitized = {};
	for (const [key, value] of Object.entries(payload)) if (HOOK_ROUTING_KEYS.has(key)) sanitized[key] = value;
	else if (!hasPrivateMarker(key)) sanitized[key] = stripPrivateValues(value);
	return sanitized;
}
//#endregion
export { hasPrivateMarker, sanitizeHookPayload, sanitizeRawEventEnvelope, stripPrivate, stripPrivateValues };
