/**
 * Text sanitization for the ingest pipeline.
 *
 * Ports codemem/ingest_sanitize.py — strips <private> blocks and redacts
 * sensitive field names from payloads before they reach the observer LLM.
 */

// ---------------------------------------------------------------------------
// Private content stripping
// ---------------------------------------------------------------------------

const PRIVATE_OPEN = "<private>";
const PRIVATE_CLOSE = "</private>";

/**
 * Remove `<private>…</private>` blocks from text.
 *
 * Handles matched pairs, orphaned opening tags (truncates at the tag),
 * and stray closing tags (removed).
 */
export function stripPrivate(text: string): string {
	if (!text) return "";
	let remaining = text;
	let lowered = remaining.toLowerCase();
	let output = "";
	while (remaining) {
		const openIndex = lowered.indexOf(PRIVATE_OPEN);
		const closeIndex = lowered.indexOf(PRIVATE_CLOSE);
		if (openIndex < 0) {
			if (closeIndex < 0) return output + remaining;
			output += remaining.slice(0, closeIndex);
			remaining = remaining.slice(closeIndex + PRIVATE_CLOSE.length);
			lowered = remaining.toLowerCase();
			continue;
		}
		if (closeIndex >= 0 && closeIndex < openIndex) {
			output += remaining.slice(0, closeIndex);
			remaining = remaining.slice(closeIndex + PRIVATE_CLOSE.length);
			lowered = remaining.toLowerCase();
			continue;
		}
		output += remaining.slice(0, openIndex);
		const blockCloseIndex = lowered.indexOf(PRIVATE_CLOSE, openIndex + PRIVATE_OPEN.length);
		if (blockCloseIndex < 0) return output;
		remaining = remaining.slice(blockCloseIndex + PRIVATE_CLOSE.length);
		lowered = remaining.toLowerCase();
	}
	return output;
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

export function stripPrivateObj(value: unknown): unknown {
	if (typeof value === "string") return stripPrivate(value);
	if (Array.isArray(value)) return value.map(stripPrivateObj);
	if (value != null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (isSensitiveFieldName(key)) {
				result[key] = REDACTED_VALUE;
			} else {
				result[key] = stripPrivateObj(item);
			}
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
