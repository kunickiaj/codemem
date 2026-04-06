/**
 * Low-signal observation filtering for the ingest pipeline.
 *
 * Ports the relevant parts of codemem/summarizer.py — detects observations
 * that are too generic or noisy to store as memories.
 */

// ---------------------------------------------------------------------------
// Patterns that indicate low-signal content
// ---------------------------------------------------------------------------

/**
 * Observation-level patterns that indicate content too generic to store.
 * Empty by default — trust the observer LLM. Only patterns that consistently
 * get through observer guidance are added here.
 */
const LOW_SIGNAL_OBSERVATION_PATTERNS: RegExp[] = [
	/\bno\s+code\s+changes?\s+(?:were|was)\s+(?:recorded|made)\b/i,
	/\bno\s+code\s+was\s+modified\b/i,
	/\bno\s+new\s+(?:code|configuration|config|documentation)(?:\s+or\s+(?:code|configuration|config|documentation))?\s+(?:was|were)\s+(?:shipped|delivered)\b/i,
	/\bno\s+new\s+deliverables?\b/i,
	/\bno\s+definitive\s+(?:code\s+rewrite|feature\s+delivery)(?:\s+or\s+(?:code\s+rewrite|feature\s+delivery))?\s+(?:occurred|happened)\b/i,
	/\bonly\s+file\s+inspection\s+occurred\b/i,
	/\bonly\s+produced\s+(?:an?\s+)?understanding\b/i,
	/\bconsisted\s+entirely\s+of\s+capturing\b/i,
	/\bno\s+fully\s+resolved\s+deliverable\b/i,
	/\beffort\s+focused\s+on\s+clarifying\b/i,
	/\bno\s+code\s*,?\s+configuration\s*,?\s+or\s+documentation\s+changes?\s+(?:were|was)\s+made\b/i,
	/\bwork\s+consisted\s+entirely\s+of\s+capturing\s+the\s+current\s+state\b/i,
	/\bprimary\s+user\s+request\s+details\s+were\s+absent\b/i,
];

const LOW_SIGNAL_SUMMARY_PATTERNS: RegExp[] = [
	/\bcheck\s+logs?\b/i,
	/\binspect(?:ed|ion)?\s+(?:the\s+)?current\s+state\b/i,
	/\breview(?:ed|ing)?\s+(?:the\s+)?current\s+state\b/i,
	/\bverify\s+the\s+current\s+state\b/i,
	/\bno\s+(?:meaningful|substantive)\s+(?:changes|updates|deliverables?)\b/i,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Normalize observation text: strip leading bullets/markers, collapse whitespace. */
export function normalizeObservation(text: string): string {
	let cleaned = text.trim().replace(/^[\s\-\u2022\u2514\u203a>$]+/, "");
	cleaned = cleaned.replace(/\s+/g, " ").trim();
	return cleaned;
}

/**
 * Return true if the observation text is too generic / low-signal to store.
 *
 * Checks against known patterns of empty or self-referential content that
 * the observer LLM sometimes generates.
 */
export function isLowSignalObservation(text: string): boolean {
	const normalized = normalizeObservation(text);
	if (!normalized) return true;
	return LOW_SIGNAL_OBSERVATION_PATTERNS.some((p) => p.test(normalized));
}

export function isLowSignalSummary(text: string): boolean {
	const normalized = normalizeObservation(text);
	if (!normalized) return true;
	if (normalized.length < 40) return true;
	return LOW_SIGNAL_SUMMARY_PATTERNS.some((p) => p.test(normalized));
}
