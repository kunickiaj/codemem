/**
 * Text sanitization for the ingest pipeline.
 *
 * Ports codemem/ingest_sanitize.py — strips <private> blocks and redacts
 * sensitive field names from payloads before they reach the observer LLM.
 */

// ---------------------------------------------------------------------------
// Private content stripping
// ---------------------------------------------------------------------------

const PRIVATE_BLOCK_RE = /<private>.*?<\/private>/gis;
const PRIVATE_OPEN_RE = /<private>/gi;
const PRIVATE_CLOSE_RE = /<\/private>/gi;

/**
 * Remove `<private>…</private>` blocks from text.
 *
 * Handles matched pairs, orphaned opening tags (truncates at the tag),
 * and stray closing tags (removed).
 */
export function stripPrivate(text: string): string {
	if (!text) return "";
	// Remove matched pairs
	let redacted = text.replace(PRIVATE_BLOCK_RE, "");
	// Orphaned opening tag — truncate everything after it
	const openMatch = PRIVATE_OPEN_RE.exec(redacted);
	if (openMatch) {
		redacted = redacted.slice(0, openMatch.index);
	}
	// Stray closing tags
	redacted = redacted.replace(PRIVATE_CLOSE_RE, "");
	return redacted;
}

// ---------------------------------------------------------------------------
// Sensitive field detection
// ---------------------------------------------------------------------------

const SENSITIVE_FIELD_RE =
	/(?:^|_|-)(?:token|secret|password|passwd|api[_-]?key|authorization|private[_-]?key|cookie)(?:$|_|-)/i;

const REDACTED_VALUE = "[REDACTED]";

export function isSensitiveFieldName(fieldName: string): boolean {
	const normalized = fieldName.trim().toLowerCase();
	if (!normalized) return false;
	return SENSITIVE_FIELD_RE.test(normalized);
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
