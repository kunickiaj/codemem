const MAX_QUERY_LENGTH = 250;
const MIN_QUERY_LENGTH = 10;
const QUOTE_CHARS = new Set(["'", '"']);

const SENTENCE_SPLIT_RE = /[.!?。！？\n]+/;
const TRAILING_QUESTION_RE = /[?？]\s*["']?\s*$/;
const INSTRUCTION_PREFIX_PATTERNS = [
	/^you are\b/i,
	/^output only\b/i,
	/^at task start\b/i,
	/^always emit\b/i,
	/^focus on\b/i,
	/^use outcome-focused\b/i,
	/^<\/?(?:summary|observation|request|facts|fact|notes|system|instructions?)>/i,
];

export type SanitizedQueryMethod =
	| "passthrough"
	| "instruction_prefix_trim"
	| "question_extraction"
	| "tail_sentence"
	| "tail_truncation";

export interface SanitizedQuery {
	clean_query: string;
	was_sanitized: boolean;
	method: SanitizedQueryMethod;
	reasons: string[];
}

function stripWrappingQuotes(value: string): string {
	let candidate = value.trim();
	while (
		candidate.length >= 2 &&
		QUOTE_CHARS.has(candidate[0] ?? "") &&
		candidate[0] === candidate[candidate.length - 1]
	) {
		candidate = candidate.slice(1, -1).trim();
	}
	if (QUOTE_CHARS.has(candidate[0] ?? "")) candidate = candidate.slice(1).trim();
	if (QUOTE_CHARS.has(candidate[candidate.length - 1] ?? ""))
		candidate = candidate.slice(0, -1).trim();
	return candidate;
}

function splitSegments(value: string): string[] {
	return value
		.split(/\n+/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function trimCandidate(value: string): string {
	const candidate = stripWrappingQuotes(value);
	if (candidate.length <= MAX_QUERY_LENGTH) return candidate;
	const nested = candidate
		.split(SENTENCE_SPLIT_RE)
		.map((segment) => stripWrappingQuotes(segment))
		.filter((segment) => segment.length >= MIN_QUERY_LENGTH && segment.length <= MAX_QUERY_LENGTH);
	if (nested.length > 0)
		return nested[nested.length - 1] ?? candidate.slice(-MAX_QUERY_LENGTH).trim();
	return candidate.slice(-MAX_QUERY_LENGTH).trim();
}

function looksInstructionLike(segment: string): boolean {
	const trimmed = segment.trim();
	if (!trimmed) return false;
	if (trimmed.length < MIN_QUERY_LENGTH) return false;
	return INSTRUCTION_PREFIX_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function looksContaminated(raw: string, segments: string[]): boolean {
	if (raw.includes("<") || raw.includes(">")) return true;
	if (looksInstructionLike(raw)) return true;
	if (
		raw.includes("Output only") ||
		raw.includes("Never mention") ||
		raw.includes("At task start")
	) {
		return true;
	}
	if (segments.some((segment) => looksInstructionLike(segment))) return true;
	return false;
}

function extractQuestionSentence(raw: string): string | null {
	const fragments = raw.match(/[^.!?。！？\n]+[.!?。！？]?/g) ?? [];
	for (const fragment of [...fragments].reverse()) {
		if (!fragment.includes("?") && !fragment.includes("？")) continue;
		const candidate = trimCandidate(fragment);
		if (candidate.length >= MIN_QUERY_LENGTH) return candidate;
	}
	return null;
}

function buildResult(
	rawQuery: string,
	cleanQuery: string,
	method: SanitizedQueryMethod,
	reasons: string[],
): SanitizedQuery {
	const finalQuery = cleanQuery.trim() || rawQuery.trim();
	return {
		clean_query: finalQuery,
		was_sanitized: finalQuery !== rawQuery.trim(),
		method: finalQuery === rawQuery.trim() ? "passthrough" : method,
		reasons,
	};
}

export function sanitizeSearchQuery(rawQuery: string): SanitizedQuery {
	const raw = String(rawQuery ?? "").trim();
	if (!raw) return buildResult("", "", "passthrough", []);

	const segments = splitSegments(raw);
	const contaminated = looksContaminated(raw, segments);
	if (raw.length <= MAX_QUERY_LENGTH && !contaminated) {
		return buildResult(raw, raw, "passthrough", []);
	}

	const reasons: string[] = [];

	if (segments.length > 1 && looksInstructionLike(segments[0] ?? "")) {
		const tail = segments.filter((segment, index) => index > 0 && !looksInstructionLike(segment));
		const candidate = trimCandidate(tail[tail.length - 1] ?? "");
		if (candidate.length >= MIN_QUERY_LENGTH) {
			reasons.push("instruction_prefix");
			return buildResult(raw, candidate, "instruction_prefix_trim", reasons);
		}
	}

	const questionSentence = extractQuestionSentence(raw);
	if (questionSentence) {
		reasons.push("question_sentence");
		return buildResult(raw, questionSentence, "question_extraction", reasons);
	}

	for (const segment of [...segments].reverse()) {
		if (!TRAILING_QUESTION_RE.test(segment)) continue;
		const candidate = trimCandidate(segment);
		if (candidate.length >= MIN_QUERY_LENGTH) {
			reasons.push("question_segment");
			return buildResult(raw, candidate, "question_extraction", reasons);
		}
	}

	if (!contaminated) {
		return buildResult(raw, raw, "passthrough", reasons);
	}

	for (const segment of [...segments].reverse()) {
		const candidate = trimCandidate(segment);
		if (candidate.length < MIN_QUERY_LENGTH) continue;
		if (candidate === raw && raw.length <= MAX_QUERY_LENGTH) continue;
		if (looksInstructionLike(candidate)) continue;
		reasons.push("tail_segment");
		return buildResult(raw, candidate, "tail_sentence", reasons);
	}

	const truncated = trimCandidate(raw);
	if (truncated.length >= MIN_QUERY_LENGTH && truncated !== raw) {
		reasons.push("tail_truncation");
		return buildResult(raw, truncated, "tail_truncation", reasons);
	}

	return buildResult(raw, raw, "passthrough", reasons);
}
