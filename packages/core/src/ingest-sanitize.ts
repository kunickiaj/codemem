/**
 * Text sanitization for the ingest pipeline.
 *
 * Ports codemem/ingest_sanitize.py — strips <private> blocks and redacts
 * sensitive field names from payloads before they reach the observer LLM.
 */

// ---------------------------------------------------------------------------
// Private content stripping
// ---------------------------------------------------------------------------

/**
 * A `<private>` opener or closer, case-insensitive, with optional whitespace and
 * attributes. A tag without its `>` runs to the end of the text, so it still counts.
 */
const PRIVATE_TAG = /<\s*(\/)?\s*private\b([^>]*)(>|$)/gi;

/** Scan state carried across consecutive pieces of one message or stream. */
export interface PrivateScan {
	/** How many private blocks are open. */
	depth: number;
}

export function newPrivateScan(): PrivateScan {
	return { depth: 0 };
}

/**
 * Remove private regions from one piece of text, continuing `scan` from the
 * previous piece. Blocks nest by depth. An opener left open removes the rest of the
 * piece and stays open for the next piece. A closer with no open block removes it and
 * everything before it in this piece, since that text may continue a block opened
 * in an earlier piece. `<private/>` and escaped forms such as `&lt;private&gt;` are
 * text, not markers.
 */
export function scanPrivate(text: string, scan: PrivateScan): string {
	if (!text) return "";
	let output = "";
	let last = 0;
	for (const match of text.matchAll(PRIVATE_TAG)) {
		const closer = match[1] === "/";
		const selfClosing = !closer && match[3] === ">" && (match[2] ?? "").trimEnd().endsWith("/");
		if (selfClosing) continue;
		const index = match.index ?? 0;
		if (scan.depth === 0) output += text.slice(last, index);
		if (!closer) scan.depth += 1;
		else if (scan.depth > 0) scan.depth -= 1;
		else output = "";
		last = index + match[0].length;
	}
	if (scan.depth === 0) output += text.slice(last);
	return output;
}

/** Remove private regions from text scanned on its own; an open block runs to its end. */
export function stripPrivate(text: string): string {
	return scanPrivate(text, newPrivateScan());
}

/** Remove private regions from consecutive pieces, carrying an open block from one to the next. */
export function stripPrivateSequence(pieces: readonly string[]): string[] {
	const scan = newPrivateScan();
	return pieces.map((piece) => scanPrivate(piece, scan));
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
 * Remove private regions from every key and string value, in traversal order, with
 * one scan carried across them. An entry whose key carried a private marker is
 * dropped with its value.
 */
export function stripPrivateObj(value: unknown, scan: PrivateScan = newPrivateScan()): unknown {
	if (typeof value === "string") return scanPrivate(value, scan);
	if (Array.isArray(value)) return value.map((item) => stripPrivateObj(item, scan));
	if (value != null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			const visibleKey = scanPrivate(key, scan);
			const cleaned = stripPrivateObj(item, scan);
			if (visibleKey !== key) continue;
			result[key] = isSensitiveFieldName(key) ? REDACTED_VALUE : cleaned;
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

/** `scan` carries an open private block across the values of one event. */
export function sanitizePayload(
	value: unknown,
	maxChars: number,
	scan: PrivateScan = newPrivateScan(),
): unknown {
	if (value == null) return null;
	if (typeof value === "string") {
		return truncateText(scanPrivate(value, scan), maxChars);
	}
	const cleaned = stripPrivateObj(value, scan);
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

export function sanitizeToolOutput(
	_tool: string,
	output: unknown,
	maxChars: number,
	scan: PrivateScan = newPrivateScan(),
): unknown {
	if (output == null) return null;
	const sanitized = sanitizePayload(output, maxChars, scan);
	const text = String(sanitized ?? "");
	if (isLowSignalOutput(text)) return "";
	return sanitized;
}
