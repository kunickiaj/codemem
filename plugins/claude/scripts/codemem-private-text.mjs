//#region packages/core/src/private-text.ts
var TAG_NAME_CHAR = /[A-Za-z0-9_.:-]/;
var WHITESPACE = /\s/;
var CUT = (text) => ({
	kind: "cut",
	end: text.length
});
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
* reaches the end of the text, ends inside an unclosed quote, or meets an unquoted
* `<` before its `>` is malformed and cut off, so it can never hide another tag.
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
		else if (char === "<") break;
		else if (!WHITESPACE.test(char)) lastSignificant = char;
	}
	return CUT(text);
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
/** Block content running to `terminator`, or a cut when the terminator never comes. */
function readUntil(text, start, terminator) {
	const at = text.indexOf(terminator, start);
	return at === -1 ? CUT(text) : {
		kind: "other",
		end: at + terminator.length
	};
}
/**
* The tag at a `<` inside a block. Every `<` there starts a tag, including one
* followed by a space or digit, because reading it as a tag removes more. A private
* tag changes depth; any other tag, comment or CDATA section is skipped whole as
* block content, so a closer in its quoted attributes or body cannot end the block.
*/
function readBlockTag(text, start) {
	const privateTag = readPrivateTag(text, start);
	if (privateTag) return privateTag;
	if (text.startsWith("<!--", start)) return readUntil(text, start + 4, "-->");
	if (text.startsWith("<![CDATA[", start)) return readUntil(text, start + 9, "]]>");
	const tag = readTagEnd(text, start + 1, false);
	return tag.kind === "cut" ? tag : {
		kind: "other",
		end: tag.end
	};
}
/** Remove private blocks from one text value, scanned on its own. Non-strings become "". */
function stripPrivate(text) {
	if (typeof text !== "string" || !text) return "";
	if (!text.toLowerCase().includes("private")) return text;
	return removePrivateBlocks(text);
}
/** The output once scanning stops at `end`; text after an open block is removed. */
function finish(state, text, end) {
	return state.depth === 0 ? state.output + text.slice(state.kept, end) : state.output;
}
/** A private opener or closer: keep the text before it when outside a block, then move depth. */
function applyMarker(state, text, start, tag) {
	if (state.depth === 0) state.output += text.slice(state.kept, start);
	if (tag.kind === "open") state.depth += 1;
	else if (state.depth > 0) state.depth -= 1;
	state.kept = tag.end;
}
function removePrivateBlocks(text) {
	const state = {
		output: "",
		depth: 0,
		kept: 0
	};
	let index = text.indexOf("<");
	while (index !== -1) {
		const tag = state.depth > 0 ? readBlockTag(text, index) : readPrivateTag(text, index);
		if (!tag) {
			index = text.indexOf("<", index + 1);
			continue;
		}
		if (tag.kind === "cut") return finish(state, text, index);
		if (tag.kind === "open" || tag.kind === "close") applyMarker(state, text, index, tag);
		index = text.indexOf("<", tag.end);
	}
	return finish(state, text, text.length);
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
/** True when any string or key inside the value carries a private marker. */
function containsPrivateMarker(value) {
	if (typeof value === "string") return hasPrivateMarker(value);
	if (Array.isArray(value)) return value.some(containsPrivateMarker);
	if (value != null && typeof value === "object") return Object.entries(value).some(([key, item]) => hasPrivateMarker(key) || containsPrivateMarker(item));
	return false;
}
/** Fields that route or identify a raw event. They are kept exactly as sent. */
var RAW_EVENT_ROUTING_KEYS = /* @__PURE__ */ new Set([
	"source",
	"session_stream_id",
	"session_id",
	"stream_id",
	"opencode_session_id",
	"event_id",
	"event_type",
	"event_seq",
	"ts_wall_ms",
	"ts_mono_ms",
	"host_generation"
]);
/** Captured content of a raw event. Each is cleaned before it is kept. */
var RAW_EVENT_CONTENT_KEYS = /* @__PURE__ */ new Set([
	"payload",
	"cwd",
	"project",
	"started_at"
]);
var isRecord = (value) => value != null && typeof value === "object" && !Array.isArray(value);
/** The kept form of one field of a raw event, or undefined when the field is dropped. */
function cleanRawEventField(key, value, clean) {
	if (RAW_EVENT_ROUTING_KEYS.has(key)) return value;
	if (RAW_EVENT_CONTENT_KEYS.has(key)) return clean(value);
	if (key === "capture_context" && value != null && !containsPrivateMarker(value)) return clean(value);
}
/**
* One raw event reduced to the fields ingestion reads, in their original order.
* Routing fields are kept as sent, content is cleaned, and every other field is
* dropped. A request's `events` list is reduced the same way, event by event.
*/
function cleanRawEvent(item, clean, { withEvents }) {
	const cleaned = {};
	for (const [key, value] of Object.entries(item)) {
		if (withEvents && key === "events") {
			cleaned.events = Array.isArray(value) ? value.map((event) => isRecord(event) ? cleanRawEvent(event, clean, { withEvents: false }) : clean(event)) : clean(value);
			continue;
		}
		const kept = cleanRawEventField(key, value, clean);
		if (kept !== void 0) cleaned[key] = kept;
	}
	return cleaned;
}
/**
* The form of a raw-event envelope, or of a request carrying `events`, that may be
* stored: each event reduced to the fields ingestion reads and cleaned on its own.
* `clean` cleans content values; core also redacts secret-named fields with it.
*/
function sanitizeRawEventEnvelope(envelope, clean = stripPrivateValues) {
	if (!isRecord(envelope)) return envelope;
	return cleanRawEvent(envelope, clean, { withEvents: true });
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
export { containsPrivateMarker, hasPrivateMarker, sanitizeHookPayload, sanitizeRawEventEnvelope, stripPrivate, stripPrivateValues };
