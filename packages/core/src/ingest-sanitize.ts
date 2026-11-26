/**
 * Text sanitization for the ingest pipeline.
 *
 * Ports codemem/ingest_sanitize.py — strips <private> blocks and redacts
 * sensitive field names from payloads before they reach the observer LLM.
 */

// ---------------------------------------------------------------------------
// Private content stripping
// ---------------------------------------------------------------------------

/*
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

/** Remove private blocks from one text value, scanned on its own. */
export function stripPrivate(text: string): string {
	if (!text) return "";
	// Without the tag name there is no marker, and the text comes back unchanged.
	if (!text.toLowerCase().includes("private")) return text;
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

// ---------------------------------------------------------------------------
// Sensitive field detection
// ---------------------------------------------------------------------------

const REDACTED_VALUE = "[REDACTED]";

function fieldSegments(value: string): string[] {
	const segments: string[] = [];
	let current = "";
	for (const ch of value) {
		if (ch === "_" || ch === "-") {
			const trimmed = current.trim();
			if (trimmed) segments.push(trimmed);
			current = "";
		} else {
			current += ch;
		}
	}
	const trimmed = current.trim();
	if (trimmed) segments.push(trimmed);
	return segments;
}

export function isSensitiveFieldName(fieldName: string): boolean {
	const normalized = fieldName.trim().toLowerCase();
	if (!normalized) return false;
	if (normalized.includes("apikey") || normalized.includes("privatekey")) return true;
	const segments = fieldSegments(normalized);
	if (
		segments.some((part) =>
			["token", "secret", "password", "passwd", "authorization", "cookie"].includes(part),
		)
	) {
		return true;
	}
	return (
		segments.length >= 2 &&
		((segments.includes("api") && segments.includes("key")) ||
			(segments.includes("private") && segments.includes("key")))
	);
}

// ---------------------------------------------------------------------------
// Deep sanitization
// ---------------------------------------------------------------------------

/**
 * Remove private blocks from every string value, each scanned on its own. An entry
 * whose key carries a private marker is dropped with its value. Numbers, booleans
 * and null are not text, so a block in a neighbouring string does not hide them.
 */
export function stripPrivateObj(value: unknown): unknown {
	if (typeof value === "string") return stripPrivate(value);
	if (Array.isArray(value)) return value.map(stripPrivateObj);
	if (value != null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (hasPrivateMarker(key)) continue;
			result[key] = isSensitiveFieldName(key) ? REDACTED_VALUE : stripPrivateObj(item);
		}
		return result;
	}
	return value;
}

// ---------------------------------------------------------------------------
// Payload sanitization (truncation + private stripping)
// ---------------------------------------------------------------------------

function truncateText(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... (truncated)`;
}

export function sanitizePayload(value: unknown, maxChars: number): unknown {
	if (value == null) return null;
	if (typeof value === "string") {
		return truncateText(stripPrivate(value), maxChars);
	}
	const cleaned = stripPrivateObj(value);
	try {
		const serialized = JSON.stringify(cleaned);
		if (maxChars > 0 && serialized.length > maxChars) {
			return truncateText(serialized, maxChars);
		}
	} catch {
		const asStr = String(cleaned);
		if (maxChars > 0 && asStr.length > maxChars) {
			return truncateText(asStr, maxChars);
		}
	}
	return cleaned;
}

// ---------------------------------------------------------------------------
// Low-signal output detection
// ---------------------------------------------------------------------------

const LOW_SIGNAL_OUTPUTS = new Set([
	"wrote file successfully.",
	"wrote file successfully",
	"file written successfully.",
	"read file successfully.",
	"read file successfully",
	"<file>",
	"<image>",
]);

function isLowSignalOutput(output: string): boolean {
	if (!output) return true;
	const lines = output
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return true;
	return lines.every((line) => LOW_SIGNAL_OUTPUTS.has(line.toLowerCase()));
}

export function sanitizeToolOutput(_tool: string, output: unknown, maxChars: number): unknown {
	if (output == null) return null;
	const sanitized = sanitizePayload(output, maxChars);
	const text = String(sanitized ?? "");
	if (isLowSignalOutput(text)) return "";
	return sanitized;
}
