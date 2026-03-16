/**
 * XML response parser for the observer LLM output.
 *
 * Ports codemem/xml_parser.py — uses regex-based parsing to extract
 * observations and session summaries from the observer's XML response.
 *
 * The observer output is structured XML, not arbitrary HTML, so regex
 * is sufficient (no DOM parser needed).
 */

import type { ParsedObservation, ParsedOutput, ParsedSummary } from "./ingest-types.js";

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// Match <observation> with optional attributes (LLMs sometimes add kind="...")
const OBSERVATION_BLOCK_RE = /<observation[^>]*>.*?<\/observation>/gs;
const SUMMARY_BLOCK_RE = /<summary[^>]*>.*?<\/summary>/gs;
const SKIP_SUMMARY_RE = /<skip_summary(?:\s+reason="(?<reason>[^"]+)")?\s*\/>/i;
const CODE_FENCE_RE = /```(?:xml)?/gi;

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/** Remove code fences and trim whitespace. */
function cleanXmlText(text: string): string {
	return text.replace(CODE_FENCE_RE, "").trim();
}

/** Extract text content from within a single XML tag. Returns empty string if not found. */
function extractTagText(xml: string, tag: string): string {
	const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
	const match = re.exec(xml);
	if (!match?.[1]) return "";
	return match[1].trim();
}

/** Extract text content of repeated child elements within a parent tag. */
function extractChildTexts(xml: string, parentTag: string, childTag: string): string[] {
	const parentRe = new RegExp(`<${parentTag}[^>]*>([\\s\\S]*?)</${parentTag}>`, "i");
	const parentMatch = parentRe.exec(xml);
	if (!parentMatch?.[1]) return [];

	const childRe = new RegExp(`<${childTag}[^>]*>([\\s\\S]*?)</${childTag}>`, "gi");
	const items: string[] = [];
	for (
		let match = childRe.exec(parentMatch[1]);
		match !== null;
		match = childRe.exec(parentMatch[1])
	) {
		const text = match[1]?.trim();
		if (text) items.push(text);
	}
	return items;
}

// ---------------------------------------------------------------------------
// Block parsers
// ---------------------------------------------------------------------------

function parseObservationBlock(block: string): ParsedObservation | null {
	// Minimal validation — must have at least a type or title
	const kind = extractTagText(block, "type");
	const title = extractTagText(block, "title");
	if (!kind && !title) return null;

	return {
		kind,
		title,
		narrative: extractTagText(block, "narrative"),
		subtitle: extractTagText(block, "subtitle") || null,
		facts: extractChildTexts(block, "facts", "fact"),
		concepts: extractChildTexts(block, "concepts", "concept"),
		filesRead: extractChildTexts(block, "files_read", "file"),
		filesModified: extractChildTexts(block, "files_modified", "file"),
	};
}

function parseSummaryBlock(block: string): ParsedSummary | null {
	const request = extractTagText(block, "request");
	const investigated = extractTagText(block, "investigated");
	const learned = extractTagText(block, "learned");
	const completed = extractTagText(block, "completed");
	const nextSteps = extractTagText(block, "next_steps");
	const notes = extractTagText(block, "notes");

	// At least one field must be populated
	if (!request && !investigated && !learned && !completed && !nextSteps && !notes) {
		return null;
	}

	return {
		request,
		investigated,
		learned,
		completed,
		nextSteps,
		notes,
		filesRead: extractChildTexts(block, "files_read", "file"),
		filesModified: extractChildTexts(block, "files_modified", "file"),
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse the observer LLM's XML response into structured data.
 *
 * Extracts all `<observation>` blocks and the last `<summary>` block.
 * Handles missing/empty tags gracefully.
 */
export function parseObserverResponse(raw: string): ParsedOutput {
	const cleaned = cleanXmlText(raw);

	// Extract observations
	const observations: ParsedObservation[] = [];
	const obsBlocks = cleaned.match(OBSERVATION_BLOCK_RE) ?? [];
	for (const block of obsBlocks) {
		const parsed = parseObservationBlock(block);
		if (parsed) observations.push(parsed);
	}

	// Extract summary (use last block if multiple)
	let summary: ParsedSummary | null = null;
	const summaryBlocks = cleaned.match(SUMMARY_BLOCK_RE) ?? [];
	const lastSummaryBlock = summaryBlocks.at(-1);
	if (lastSummaryBlock) {
		summary = parseSummaryBlock(lastSummaryBlock);
	}

	// Check for skip_summary
	const skipMatch = SKIP_SUMMARY_RE.exec(cleaned);
	const skipReason = skipMatch?.groups?.reason ?? null;

	return { observations, summary, skipSummaryReason: skipReason };
}

/** Return true if at least one observation has a title or narrative. */
export function hasMeaningfulObservation(observations: ParsedObservation[]): boolean {
	return observations.some((obs) => obs.title || obs.narrative);
}
