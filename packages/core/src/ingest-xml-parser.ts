/**
 * XML response parser for the observer LLM output.
 *
 * Ports codemem/xml_parser.py — uses regex-based parsing to extract
 * observations and session summaries from the observer's XML response.
 *
 * The observer output is structured XML, not arbitrary HTML, so regex
 * is sufficient (no DOM parser needed).
 */

import { isLowSignalObservation } from "./ingest-filters.js";
import type { ParsedObservation, ParsedOutput, ParsedSummary } from "./ingest-types.js";

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// Match <observation> with optional attributes (LLMs sometimes add kind="...")
const OBSERVATION_BLOCK_RE = /<observation[^>]*>.*?<\/observation>/gs;
const SUMMARY_BLOCK_RE = /<summary[^>]*>.*?<\/summary>/gs;
const SKIP_SUMMARY_RE =
	/<skip_summary(?:\s+reason="(?<reason>[^"]+)")?\s*(?:\/>|>\s*<\/skip_summary>)/i;
const CODE_FENCE_RE = /```(?:xml)?/gi;

const SUMMARY_FIELDS = new Set([
	"request",
	"investigated",
	"learned",
	"completed",
	"next_steps",
	"notes",
	"files_read",
	"files_modified",
]);

const OBSERVATION_CONCEPTS = new Set([
	"how-it-works",
	"why-it-exists",
	"what-changed",
	"problem-solution",
	"gotcha",
	"pattern",
	"trade-off",
]);

export const SUPPORTED_OBSERVATION_KINDS = new Set([
	"bugfix",
	"feature",
	"refactor",
	"change",
	"discovery",
	"decision",
	"exploration",
]);

export interface ObserverResponseStructuralDiagnostics {
	recognizedOutput: boolean;
	observationBlocks: number;
	retainedObservations: number;
	summaryBlocks: number;
	retainedSummaries: number;
	illegalObservationNestingInSummary: number;
	unknownSummaryFields: string[];
	unsupportedObservationKinds: string[];
	missingObservationKinds: number;
	discardedObservationBlocks: number;
	discardedSummaryBlocks: number;
	dataLoss: boolean;
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/** Remove code fences and trim whitespace. */
function cleanXmlText(text: string): string {
	return text.replace(CODE_FENCE_RE, "").trim();
}

function escapeRegExpLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract text content from within a single XML tag. Returns empty string if not found. */
function extractTagText(xml: string, tag: string): string {
	const escapedTag = escapeRegExpLiteral(tag);
	const re = new RegExp(`<${escapedTag}(?=[\\s/>])[^>]*>([\\s\\S]*?)</${escapedTag}>`, "i");
	const match = re.exec(xml);
	if (!match?.[1]) return "";
	return match[1].trim();
}

/** Extract text content of repeated child elements within a parent tag. */
function extractChildTexts(xml: string, parentTag: string, childTag: string): string[] {
	const escapedParentTag = escapeRegExpLiteral(parentTag);
	const escapedChildTag = escapeRegExpLiteral(childTag);
	const parentRe = new RegExp(
		`<${escapedParentTag}(?=[\\s/>])[^>]*>([\\s\\S]*?)</${escapedParentTag}>`,
		"i",
	);
	const parentMatch = parentRe.exec(xml);
	if (!parentMatch?.[1]) return [];

	const childRe = new RegExp(
		`<${escapedChildTag}(?=[\\s/>])[^>]*>([\\s\\S]*?)</${escapedChildTag}>`,
		"gi",
	);
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

function directChildFragments(
	block: string,
	rootTag: string,
): Array<{ tag: string; value: string; complete: boolean }> {
	const escapedRootTag = escapeRegExpLiteral(rootTag);
	const opening = new RegExp(`<${escapedRootTag}(?=[\\s/>])[^>]*>`, "i").exec(block);
	if (!opening) return [];
	const contentStart = opening.index + opening[0].length;
	const remainder = block.slice(contentStart);
	const closing = new RegExp(`</${escapedRootTag}>`, "i").exec(remainder);
	const inner = closing ? remainder.slice(0, closing.index) : remainder;
	const fragments: Array<{ tag: string; value: string; complete: boolean }> = [];
	const openingTagPattern = /<([A-Za-z_][\w:.-]*)/g;
	for (
		let match = openingTagPattern.exec(inner);
		match !== null;
		match = openingTagPattern.exec(inner)
	) {
		const tag = match[1]?.toLowerCase();
		if (!tag) continue;
		const tagEnd = openingTagEnd(inner, openingTagPattern.lastIndex);
		if (tagEnd < 0) break;
		const token = inner.slice(match.index, tagEnd + 1);
		openingTagPattern.lastIndex = tagEnd + 1;
		const childContentStart = (match.index ?? 0) + token.length;
		if (/\/\s*>$/.test(token)) {
			fragments.push({ tag, value: "", complete: true });
			continue;
		}
		const escapedTag = escapeRegExpLiteral(tag);
		const childClosing = new RegExp(`</${escapedTag}>`, "i").exec(inner.slice(childContentStart));
		if (!childClosing) {
			const unclosedRemainder = inner.slice(childContentStart);
			const nextKnownField = new RegExp(
				`<(?:${[...SUMMARY_FIELDS].map(escapeRegExpLiteral).join("|")})(?=[\\s/>])`,
				"i",
			).exec(unclosedRemainder);
			fragments.push({
				tag,
				value: nextKnownField
					? unclosedRemainder.slice(0, nextKnownField.index)
					: unclosedRemainder,
				complete: false,
			});
			if (!nextKnownField) break;
			openingTagPattern.lastIndex = childContentStart + nextKnownField.index;
			continue;
		}
		fragments.push({
			tag,
			value: inner.slice(childContentStart, childContentStart + childClosing.index),
			complete: true,
		});
		openingTagPattern.lastIndex = childContentStart + childClosing.index + childClosing[0].length;
	}
	return fragments;
}

function openingTagEnd(value: string, contentStart: number): number {
	let quote: '"' | "'" | null = null;
	let firstClosingBracket = -1;
	for (let index = contentStart; index < value.length; index += 1) {
		const character = value[index];
		if (character === ">") {
			if (firstClosingBracket < 0) firstClosingBracket = index;
			if (quote === null) return index;
			continue;
		}
		if (character !== '"' && character !== "'") continue;
		if (quote === character) quote = null;
		else if (quote === null) quote = character;
	}
	return firstClosingBracket;
}

function directChildTagNames(block: string, rootTag: string): string[] {
	return directChildFragments(block, rootTag).map(({ tag }) => tag);
}

function observationKind(block: string): string {
	const type = extractTagText(block, "type");
	if (type) return type.trim().toLowerCase();
	const attribute = /<observation\b[^>]*\bkind=["']([^"']+)["']/i.exec(block)?.[1];
	return attribute?.trim().toLowerCase() ?? "";
}

// ---------------------------------------------------------------------------
// Block parsers
// ---------------------------------------------------------------------------

function parseObservationBlock(block: string): ParsedObservation | null {
	// Minimal validation — must have at least a type or title
	const kind = observationKind(block);
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

/** Inspect permissively parsed output without changing production parser behavior. */
export function inspectObserverResponseStructure(
	raw: string,
	parsed: ParsedOutput = parseObserverResponse(raw),
): ObserverResponseStructuralDiagnostics {
	const cleaned = cleanXmlText(raw);
	const observationBlockValues = cleaned.match(OBSERVATION_BLOCK_RE) ?? [];
	const observationBlocks = cleaned.match(/<observation(?:\s|>)/gi)?.length ?? 0;
	const summaryBlockValues = cleaned.match(SUMMARY_BLOCK_RE) ?? [];
	const summaryBlocks = cleaned.match(/<summary(?:\s|>)/gi)?.length ?? 0;
	const skipMatch = SKIP_SUMMARY_RE.exec(cleaned);
	const unlabeledSkipSummary = skipMatch !== null && !skipMatch.groups?.reason;
	const recognizedOutput = observationBlocks > 0 || summaryBlocks > 0 || skipMatch !== null;
	const illegalObservationNestingInSummary = summaryBlockValues.reduce(
		(count, block) => count + (block.match(/<observation(?:\s|>)/gi)?.length ?? 0),
		0,
	);
	const unknownSummaryFields = [
		...new Set(
			summaryBlockValues
				.flatMap((block) => directChildTagNames(block, "summary"))
				.filter((field) => field !== "observation" && !SUMMARY_FIELDS.has(field)),
		),
	].sort();
	const unsupportedObservationKinds = [
		...new Set(
			observationBlockValues
				.map(observationKind)
				.filter((kind) => kind && !SUPPORTED_OBSERVATION_KINDS.has(kind)),
		),
	].sort();
	const missingObservationKinds = observationBlockValues.filter(
		(block) => !observationKind(block) && parseObservationBlock(block) !== null,
	).length;
	const retainedSummaries = parsed.summary ? 1 : 0;
	const discardedObservationBlocks = Math.max(0, observationBlocks - parsed.observations.length);
	const discardedSummaryBlocks = Math.max(0, summaryBlocks - retainedSummaries);
	const malformedRetainedChildren = [...observationBlockValues, ...summaryBlockValues].some(
		(block) => {
			const rootTag = /^\s*<([A-Za-z_][\w:.-]*)/i.exec(block)?.[1];
			return rootTag
				? directChildFragments(block, rootTag).some((fragment) => !fragment.complete)
				: false;
		},
	);

	return {
		recognizedOutput,
		observationBlocks,
		retainedObservations: parsed.observations.length,
		summaryBlocks,
		retainedSummaries,
		illegalObservationNestingInSummary,
		unknownSummaryFields,
		unsupportedObservationKinds,
		missingObservationKinds,
		discardedObservationBlocks,
		discardedSummaryBlocks,
		dataLoss:
			(cleaned.length > 0 && !recognizedOutput) ||
			(parsed.summary !== null && parsed.skipSummaryReason !== null) ||
			unlabeledSkipSummary ||
			discardedObservationBlocks > 0 ||
			discardedSummaryBlocks > 0 ||
			unknownSummaryFields.length > 0 ||
			unsupportedObservationKinds.length > 0 ||
			missingObservationKinds > 0 ||
			malformedRetainedChildren,
	};
}

/** Return true when a completed observer response needs one structural repair attempt. */
export function shouldRepairObserverResponse(raw: string | null, parsed: ParsedOutput): boolean {
	if (!raw) return false;
	const hasStructuredOutput =
		parsed.observations.length > 0 || parsed.summary !== null || parsed.skipSummaryReason !== null;
	return !hasStructuredOutput || inspectObserverResponseStructure(raw, parsed).dataLoss;
}

// Fail closed on rewritten content: a repair may add recovered observations or correct
// an invalid kind, but every other parsed field must survive modulo whitespace reflow.
function observationContentKey(observation: ParsedObservation): string {
	const normalizedList = (values: string[]) => values.map(normalizeRecoverableText).sort();
	return JSON.stringify({
		title: normalizeRecoverableText(observation.title),
		narrative: normalizeRecoverableText(observation.narrative),
		subtitle: observation.subtitle ? normalizeRecoverableText(observation.subtitle) : null,
		facts: normalizedList(observation.facts),
		concepts: normalizedList(observation.concepts),
		filesRead: normalizedList(observation.filesRead),
		filesModified: normalizedList(observation.filesModified),
	});
}

function preservesParsedObservations(
	initialObservations: ParsedObservation[],
	repairedObservations: ParsedObservation[],
	initialRaw?: string | null,
): boolean {
	return (
		remainingAfterPreservedObservations(initialObservations, repairedObservations, initialRaw) !==
		null
	);
}

function remainingAfterPreservedObservations(
	initialObservations: ParsedObservation[],
	repairedObservations: ParsedObservation[],
	initialRaw?: string | null,
): ParsedObservation[] | null {
	const remaining = [...repairedObservations];
	const unmatched: Array<{ observation: ParsedObservation; fragment: string | null }> = [];
	const retainedFragments = initialRaw
		? completeBlockMatches(cleanXmlText(initialRaw), OBSERVATION_BLOCK_RE).flatMap(({ value }) =>
				parseObservationBlock(value) ? [value] : [],
			)
		: [];
	for (const [index, observation] of initialObservations.entries()) {
		const key = observationContentKey(observation);
		const matchIndex = remaining.findIndex(
			(candidate) =>
				candidate.kind === observation.kind && observationContentKey(candidate) === key,
		);
		if (matchIndex < 0) {
			unmatched.push({ observation, fragment: retainedFragments[index] ?? null });
			continue;
		}
		remaining.splice(matchIndex, 1);
	}
	for (const { observation, fragment } of unmatched) {
		const canCorrectKind = !SUPPORTED_OBSERVATION_KINDS.has(observation.kind);
		const canRecoverFields =
			fragment !== null && hasRecoverableObservationEnrichment(fragment, observation);
		if (!canCorrectKind && !canRecoverFields) return null;
		const matchIndex = remaining.findIndex((candidate) => {
			const kindMatches = canCorrectKind
				? SUPPORTED_OBSERVATION_KINDS.has(candidate.kind)
				: candidate.kind === observation.kind;
			return (
				kindMatches &&
				preservesParsedObservationFields(observation, candidate, fragment) &&
				(fragment
					? observationMatchesRecoveredFields(fragment, candidate)
					: observationContentKey(candidate) === observationContentKey(observation))
			);
		});
		if (matchIndex < 0) return null;
		remaining.splice(matchIndex, 1);
	}
	return remaining;
}

function preservesParsedObservationFields(
	initial: ParsedObservation,
	repaired: ParsedObservation,
	fragment: string | null,
): boolean {
	return (
		preservesRetainedScalar(initial.title, repaired.title, fragment, "title") &&
		preservesRetainedScalar(initial.narrative, repaired.narrative, fragment, "narrative") &&
		preservesRetainedScalar(initial.subtitle, repaired.subtitle, fragment, "subtitle") &&
		preservesRetainedList(
			initial.facts,
			repaired.facts,
			fragment ? extractRecoverableChildTexts(fragment, "facts", "fact") : [],
		) &&
		preservesRetainedList(
			initial.concepts,
			repaired.concepts,
			fragment ? extractRecoverableChildTexts(fragment, "concepts", "concept") : [],
		) &&
		preservesRetainedList(
			initial.filesRead,
			repaired.filesRead,
			fragment ? extractRecoverableChildTexts(fragment, "files_read", "file") : [],
		) &&
		preservesRetainedList(
			initial.filesModified,
			repaired.filesModified,
			fragment ? extractRecoverableChildTexts(fragment, "files_modified", "file") : [],
		)
	);
}

function preservesRetainedScalar(
	initial: string | null,
	repaired: string | null,
	fragment: string | null,
	tag: string,
): boolean {
	if (hasVisibleText(initial ?? "")) {
		return normalizeRecoverableText(repaired ?? "") === normalizeRecoverableText(initial ?? "");
	}
	if (!hasVisibleText(repaired ?? "")) return true;
	const recovered = fragment ? extractRecoverableTagText(fragment, tag) : null;
	return (
		recovered !== null &&
		hasVisibleText(recovered.value) &&
		matchesRecoverableText(recovered, repaired)
	);
}

function preservesRetainedList(
	initial: string[],
	repaired: string[],
	recovered: RecoverableText[],
	unknownValues: RecoverableText[] = [],
): boolean {
	const repairedExtras = [...repaired];
	for (const item of initial) {
		const normalized = normalizeRecoverableText(item);
		const index = repairedExtras.findIndex(
			(candidate) => normalizeRecoverableText(candidate) === normalized,
		);
		if (index < 0) return false;
		repairedExtras.splice(index, 1);
	}
	const unmatchedRecovered: RecoverableText[] = [];
	const initialMatches = [...initial];
	for (const item of recovered) {
		const normalized = normalizeRecoverableText(item.value);
		const index = initialMatches.findIndex((candidate) => {
			const normalizedCandidate = normalizeRecoverableText(candidate);
			return item.complete
				? normalizedCandidate === normalized
				: normalizedCandidate.startsWith(normalized);
		});
		if (index < 0) unmatchedRecovered.push(item);
		else initialMatches.splice(index, 1);
	}
	const orderedRecovered = [
		...unmatchedRecovered.filter((item) => item.complete),
		...unmatchedRecovered.filter((item) => !item.complete),
	];
	for (const item of orderedRecovered) {
		const normalized = normalizeRecoverableText(item.value);
		const index = repairedExtras.findIndex((candidate) => {
			const normalizedCandidate = normalizeRecoverableText(candidate);
			return item.complete
				? normalizedCandidate === normalized
				: normalizedCandidate.startsWith(normalized);
		});
		if (index < 0) return false;
		repairedExtras.splice(index, 1);
	}
	for (const item of repairedExtras) {
		const matchIndex = unknownValues.findIndex((value) => matchesRecoverableText(value, item));
		if (matchIndex < 0) return false;
		unknownValues.splice(matchIndex, 1);
	}
	return true;
}

function hasRecoverableObservationEnrichment(
	fragment: string,
	initial: ParsedObservation,
): boolean {
	const scalarFields = [
		["title", initial.title],
		["narrative", initial.narrative],
		["subtitle", initial.subtitle],
	] as const;
	if (
		scalarFields.some(([tag, value]) => {
			const recovered = extractRecoverableTagText(fragment, tag);
			return (
				recovered !== null &&
				hasVisibleText(recovered.value) &&
				!matchesRecoverableText(recovered, value)
			);
		})
	) {
		return true;
	}
	return (
		!preservesRecoverableItems(
			extractRecoverableChildTexts(fragment, "facts", "fact"),
			initial.facts,
		) ||
		!preservesRecoverableItems(
			extractRecoverableChildTexts(fragment, "concepts", "concept"),
			initial.concepts,
		) ||
		!preservesRecoverableItems(
			extractRecoverableChildTexts(fragment, "files_read", "file"),
			initial.filesRead,
		) ||
		!preservesRecoverableItems(
			extractRecoverableChildTexts(fragment, "files_modified", "file"),
			initial.filesModified,
		)
	);
}

function hasVisibleText(value: string): boolean {
	return visibleTextForComparison(value).length > 0;
}

function visibleTextForComparison(value: string): string {
	let visible = "";
	let index = 0;
	while (index < value.length) {
		if (value[index] !== "<") {
			visible += value[index];
			index += 1;
			continue;
		}
		const closingBracket = value.indexOf(">", index + 1);
		if (closingBracket < 0) {
			visible += value.slice(index);
			break;
		}
		visible += " ";
		index = closingBracket + 1;
	}
	return normalizeRecoverableText(visible);
}

function preservesStringItems(initialItems: string[], repairedItems: string[]): boolean {
	const repairedCounts = new Map<string, number>();
	for (const item of repairedItems) {
		const normalized = normalizeRecoverableText(item);
		repairedCounts.set(normalized, (repairedCounts.get(normalized) ?? 0) + 1);
	}
	for (const item of initialItems) {
		const normalized = normalizeRecoverableText(item);
		const remaining = repairedCounts.get(normalized) ?? 0;
		if (remaining === 0) return false;
		repairedCounts.set(normalized, remaining - 1);
	}
	return true;
}

function preservesPopulatedSummaryFields(
	initialSummary: ParsedSummary | null,
	repairedSummary: ParsedSummary | null,
	allowMergedValues = false,
	initialRaw?: string | null,
): boolean {
	if (!initialSummary) return true;
	if (!repairedSummary) return false;
	const scalarFields = [
		["request", "request"],
		["investigated", "investigated"],
		["learned", "learned"],
		["completed", "completed"],
		["nextSteps", "next_steps"],
		["notes", "notes"],
	] as const;
	const listFields = ["filesRead", "filesModified"] as const;
	const retainedFragment = initialRaw
		? completeBlockMatches(cleanXmlText(initialRaw), SUMMARY_BLOCK_RE).at(-1)?.value
		: undefined;
	const recoverableUnknownValues = retainedFragment
		? recoverableUnknownSummaryValues(retainedFragment)
		: [];
	const unusedUnknownValues = [...recoverableUnknownValues];
	return (
		scalarFields.every(([field, tag]) => {
			if (!hasVisibleText(initialSummary[field])) {
				if (!hasVisibleText(repairedSummary[field])) return true;
				const recovered = retainedFragment
					? extractRecoverableTagText(retainedFragment, tag)
					: null;
				if (recovered && hasVisibleText(recovered.value)) {
					return allowMergedValues
						? containsRecoverableText(recovered, repairedSummary[field])
						: matchesRecoverableText(recovered, repairedSummary[field]);
				}
				if (allowMergedValues) return true;
				const matchIndex = unusedUnknownValues.findIndex((value) =>
					matchesRecoverableText(value, repairedSummary[field]),
				);
				if (matchIndex < 0) return false;
				unusedUnknownValues.splice(matchIndex, 1);
				return true;
			}
			const initialValue = normalizeRecoverableText(initialSummary[field]);
			const repairedValue = normalizeRecoverableText(repairedSummary[field]);
			return allowMergedValues
				? repairedValue.includes(initialValue)
				: repairedValue === initialValue;
		}) &&
		listFields.every((field) => {
			if (allowMergedValues) {
				return preservesStringItems(initialSummary[field], repairedSummary[field]);
			}
			const parentTag = field === "filesRead" ? "files_read" : "files_modified";
			return preservesRetainedList(
				initialSummary[field],
				repairedSummary[field],
				retainedFragment ? extractRecoverableChildTexts(retainedFragment, parentTag, "file") : [],
				unusedUnknownValues,
			);
		})
	);
}

function mergedSummaryValuesAreGrounded(
	initialRaw: string | null | undefined,
	repairedSummary: ParsedSummary,
): boolean {
	if (!initialRaw) return false;
	const summaryBlocks = allSummaryFragments(initialRaw);
	if (summaryBlocks.length === 0) return false;
	const directChildren = summaryBlocks.map((block) => directChildFragments(block, "summary"));
	const unusedUnknownValues = summaryBlocks
		.flatMap(recoverableUnknownSummaryValues)
		.map(({ value, complete }) => ({ value: normalizeRecoverableText(value), complete }));
	const scalarFields = [
		["request", "request"],
		["investigated", "investigated"],
		["learned", "learned"],
		["completed", "completed"],
		["nextSteps", "next_steps"],
		["notes", "notes"],
	] as const;
	for (const [field, tag] of scalarFields) {
		const actual = repairedSummary[field];
		if (!hasVisibleText(actual)) continue;
		const sources: GroundingText[] = directChildren.flatMap((children, fragmentIndex) =>
			children.flatMap((child) => {
				if (child.tag !== tag) return [];
				const value = visibleTextForComparison(child.value);
				return value
					? [
							{
								value,
								complete: child.complete,
								mayComplete: !child.complete && fragmentIndex === directChildren.length - 1,
							},
						]
					: [];
			}),
		);
		if (!consumeComposedRecoverableValues(actual, sources, unusedUnknownValues)) return false;
	}
	const listFields = [
		["filesRead", "files_read"],
		["filesModified", "files_modified"],
	] as const;
	for (const [field, parentTag] of listFields) {
		const sources = summaryBlocks
			.flatMap((block, fragmentIndex) =>
				extractRecoverableChildTexts(block, parentTag, "file").map(({ value, complete }) => ({
					value: normalizeRecoverableText(value),
					complete,
					mayComplete: !complete && fragmentIndex === summaryBlocks.length - 1,
				})),
			)
			.sort((a, b) => Number(b.complete) - Number(a.complete));
		for (const actual of repairedSummary[field]) {
			const normalizedActual = normalizeRecoverableText(actual);
			const sourceIndex = sources.findIndex(
				(source) =>
					source.value === normalizedActual ||
					(source.mayComplete && normalizedActual.startsWith(source.value)),
			);
			if (sourceIndex >= 0) {
				sources.splice(sourceIndex, 1);
				continue;
			}
			const unknownIndex = unusedUnknownValues.findIndex(
				(source) => source.value === normalizedActual,
			);
			if (unknownIndex < 0) return false;
			unusedUnknownValues.splice(unknownIndex, 1);
		}
	}
	return true;
}

function consumeComposedRecoverableValues(
	actual: string,
	sources: GroundingText[],
	unknownValues: RecoverableText[],
): boolean {
	const normalizedActual = visibleTextForComparison(actual);
	const candidates = [
		...sources.map(({ value, complete, mayComplete }) => ({
			value: normalizeRecoverableText(value),
			complete,
			mayComplete,
			unknownIndex: -1,
		})),
		...unknownValues.map(({ value, complete }, unknownIndex) => ({
			value,
			complete,
			mayComplete: false,
			unknownIndex,
		})),
	]
		.filter(({ value }) => value.length > 0)
		.map((candidate) => ({ ...candidate, index: normalizedActual.indexOf(candidate.value) }))
		.filter(({ index }) => index >= 0)
		.sort(
			(a, b) =>
				a.index - b.index || b.value.length - a.value.length || a.unknownIndex - b.unknownIndex,
		);
	const selected: typeof candidates = [];
	let literalEnd = -1;
	for (const candidate of candidates) {
		if (candidate.index < literalEnd) continue;
		selected.push(candidate);
		literalEnd = candidate.index + candidate.value.length;
	}
	if (selected.length === 0) return false;
	const selectedSourceValues = new Set(
		selected.filter((candidate) => candidate.unknownIndex < 0).map((candidate) => candidate.value),
	);
	if (
		[...new Set(sources.map((source) => normalizeRecoverableText(source.value)))].some(
			(value) => !selectedSourceValues.has(value),
		)
	) {
		return false;
	}
	let remaining = "";
	let cursor = 0;
	const consumedUnknownIndexes = new Set<number>();
	for (const [index, candidate] of selected.entries()) {
		remaining += normalizedActual.slice(cursor, candidate.index);
		const nextCandidate = selected[index + 1];
		cursor = candidate.mayComplete
			? (nextCandidate?.index ?? normalizedActual.length)
			: candidate.index + candidate.value.length;
		if (candidate.unknownIndex >= 0) consumedUnknownIndexes.add(candidate.unknownIndex);
	}
	remaining += normalizedActual.slice(cursor);
	const residue = remaining
		.replace(/\b(?:and|then)\b/gi, " ")
		.replace(/[\s,.;:|/&+()[\]{}-]+/g, "");
	if (residue.length > 0) return false;
	for (const index of [...consumedUnknownIndexes].sort((a, b) => b - a)) {
		unknownValues.splice(index, 1);
	}
	return true;
}

function completeBlockMatches(
	raw: string,
	pattern: RegExp,
): Array<{ index: number; value: string }> {
	return [...raw.matchAll(new RegExp(pattern.source, pattern.flags))].flatMap((match) =>
		match.index == null ? [] : [{ index: match.index, value: match[0] }],
	);
}

function rootBlockBoundaries(raw: string): number[] {
	return [...raw.matchAll(/<(?:observation|summary|skip_summary)(?:\s|>)/gi)].flatMap((match) =>
		match.index == null ? [] : [match.index],
	);
}

function blockFragment(
	raw: string,
	start: number,
	complete: string | undefined,
	boundaries: number[],
): string {
	if (complete) return complete;
	const end = boundaries.find((boundary) => boundary > start) ?? raw.length;
	return raw.slice(start, end);
}

function allSummaryFragments(raw: string): string[] {
	const cleaned = cleanXmlText(raw);
	const completeByStart = new Map(
		completeBlockMatches(cleaned, SUMMARY_BLOCK_RE).map((match) => [match.index, match.value]),
	);
	const boundaries = rootBlockBoundaries(cleaned);
	const summaryStarts = [...cleaned.matchAll(/<summary(?:\s|>)/gi)].flatMap((opening) =>
		opening.index == null ? [] : [opening.index],
	);
	return summaryStarts.map((start, index) => {
		const complete = completeByStart.get(start);
		const nextSummaryStart = summaryStarts[index + 1];
		if (complete && nextSummaryStart !== undefined && nextSummaryStart < start + complete.length) {
			return cleaned.slice(start, nextSummaryStart);
		}
		return blockFragment(cleaned, start, complete, boundaries);
	});
}

interface RecoverableText {
	value: string;
	complete: boolean;
}

interface GroundingText extends RecoverableText {
	mayComplete: boolean;
}

function extractRecoverableTagText(xml: string, tag: string): RecoverableText | null {
	const escapedTag = escapeRegExpLiteral(tag);
	const opening = new RegExp(`<${escapedTag}(?=[\\s/>])[^>]*>`, "i").exec(xml);
	if (!opening) return null;
	const contentStart = opening.index + opening[0].length;
	const remainder = xml.slice(contentStart);
	const closing = new RegExp(`</${escapedTag}>`, "i").exec(remainder);
	const value = (
		closing ? remainder.slice(0, closing.index) : (remainder.split("<", 1)[0] ?? "")
	).trim();
	return { value, complete: closing !== null };
}

function matchesRecoverableText(recovered: RecoverableText | null, actual: string | null): boolean {
	if (!recovered || !hasVisibleText(recovered.value)) return true;
	const normalizedRecovered = normalizeRecoverableText(recovered.value);
	const normalizedActual = normalizeRecoverableText(actual ?? "");
	return recovered.complete
		? normalizedActual === normalizedRecovered
		: normalizedActual.startsWith(normalizedRecovered);
}

function containsRecoverableText(
	recovered: RecoverableText | null,
	actual: string | null,
): boolean {
	if (!recovered || !hasVisibleText(recovered.value)) return true;
	return normalizeRecoverableText(actual ?? "").includes(normalizeRecoverableText(recovered.value));
}

function normalizeRecoverableText(value: string): string {
	return value
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&amp;/gi, "&")
		.replace(/\s+/g, " ")
		.trim();
}

function extractRecoverableChildTexts(
	xml: string,
	parentTag: string,
	childTag: string,
): RecoverableText[] {
	const escapedParentTag = escapeRegExpLiteral(parentTag);
	const escapedChildTag = escapeRegExpLiteral(childTag);
	const parentOpening = new RegExp(`<${escapedParentTag}(?=[\\s/>])[^>]*>`, "i").exec(xml);
	if (!parentOpening) return [];
	const parentContentStart = parentOpening.index + parentOpening[0].length;
	const parentRemainder = xml.slice(parentContentStart);
	const parentClosing = new RegExp(`</${escapedParentTag}>`, "i").exec(parentRemainder);
	const siblingContainer = /<(?:facts|concepts|files_read|files_modified)(?:\s|>)/i.exec(
		parentRemainder,
	);
	const parentEnd = Math.min(
		parentClosing?.index ?? parentRemainder.length,
		siblingContainer?.index ?? parentRemainder.length,
	);
	const parentContent = parentRemainder.slice(0, parentEnd);
	const openings = [
		...parentContent.matchAll(new RegExp(`<${escapedChildTag}(?=[\\s/>])[^>]*>`, "gi")),
	];
	return openings.flatMap((opening, index) => {
		if (opening.index == null) return [];
		const contentStart = opening.index + opening[0].length;
		const nextOpening = openings[index + 1]?.index ?? parentContent.length;
		const remainder = parentContent.slice(contentStart, nextOpening);
		const closing = new RegExp(`</${escapedChildTag}>`, "i").exec(remainder);
		const value = (
			closing ? remainder.slice(0, closing.index) : (remainder.split("<", 1)[0] ?? "")
		).trim();
		return hasVisibleText(value) ? [{ value, complete: closing !== null }] : [];
	});
}

function preservesRecoverableItems(recovered: RecoverableText[], actual: string[]): boolean {
	const remaining = [...actual];
	for (const item of recovered.filter((candidate) => candidate.complete)) {
		const normalizedItem = normalizeRecoverableText(item.value);
		const matchIndex = remaining.findIndex(
			(candidate) => normalizeRecoverableText(candidate) === normalizedItem,
		);
		if (matchIndex < 0) return false;
		remaining.splice(matchIndex, 1);
	}
	for (const item of recovered.filter((candidate) => !candidate.complete)) {
		const normalizedItem = normalizeRecoverableText(item.value);
		const matchIndex = remaining.findIndex((candidate) =>
			normalizeRecoverableText(candidate).startsWith(normalizedItem),
		);
		if (matchIndex < 0) return false;
		remaining.splice(matchIndex, 1);
	}
	return true;
}

function discardedObservationFragments(raw: string): string[] {
	const cleaned = cleanXmlText(raw);
	const completeByStart = new Map(
		completeBlockMatches(cleaned, OBSERVATION_BLOCK_RE).map((match) => [match.index, match.value]),
	);
	const boundaries = rootBlockBoundaries(cleaned);
	return [...cleaned.matchAll(/<observation(?:\s|>)/gi)].flatMap((opening) => {
		if (opening.index == null) return [];
		const complete = completeByStart.get(opening.index);
		if (complete && parseObservationBlock(complete) !== null) return [];
		return [blockFragment(cleaned, opening.index, complete, boundaries)];
	});
}

function discardedSummaryFragments(raw: string, parsed: ParsedOutput): string[] {
	const cleaned = cleanXmlText(raw);
	const completeMatches = completeBlockMatches(cleaned, SUMMARY_BLOCK_RE);
	const completeByStart = new Map(completeMatches.map((match) => [match.index, match.value]));
	const retainedStart = parsed.summary ? completeMatches.at(-1)?.index : undefined;
	const boundaries = rootBlockBoundaries(cleaned);
	return [...cleaned.matchAll(/<summary(?:\s|>)/gi)].flatMap((opening) => {
		if (opening.index == null || opening.index === retainedStart) return [];
		return [blockFragment(cleaned, opening.index, completeByStart.get(opening.index), boundaries)];
	});
}

function observationMatchesRecoveredFields(
	fragment: string,
	observation: ParsedObservation,
	additionalGrounding = "",
): boolean {
	const recoveredKind = extractRecoverableTagText(fragment, "type");
	const kind = (recoveredKind?.value || observationKind(fragment)).trim().toLowerCase();
	const kindCouldBeSupportedPrefix = [...SUPPORTED_OBSERVATION_KINDS].some((supported) =>
		supported.startsWith(kind),
	);
	const kindMatches =
		!kind ||
		(recoveredKind?.complete === false
			? kindCouldBeSupportedPrefix
				? observation.kind.startsWith(kind)
				: SUPPORTED_OBSERVATION_KINDS.has(observation.kind)
			: observation.kind === kind ||
				(!SUPPORTED_OBSERVATION_KINDS.has(kind) &&
					SUPPORTED_OBSERVATION_KINDS.has(observation.kind)));
	return (
		kindMatches &&
		matchesRecoverableText(extractRecoverableTagText(fragment, "title"), observation.title) &&
		matchesRecoverableText(
			extractRecoverableTagText(fragment, "narrative"),
			observation.narrative,
		) &&
		matchesRecoverableText(extractRecoverableTagText(fragment, "subtitle"), observation.subtitle) &&
		preservesRecoverableItems(
			extractRecoverableChildTexts(fragment, "facts", "fact"),
			observation.facts,
		) &&
		preservesRecoverableItems(
			extractRecoverableChildTexts(fragment, "concepts", "concept"),
			observation.concepts,
		) &&
		preservesRecoverableItems(
			extractRecoverableChildTexts(fragment, "files_read", "file"),
			observation.filesRead,
		) &&
		preservesRecoverableItems(
			extractRecoverableChildTexts(fragment, "files_modified", "file"),
			observation.filesModified,
		) &&
		addedObservationFieldsAreGrounded(fragment, observation, additionalGrounding)
	);
}

function addedObservationFieldsAreGrounded(
	fragment: string,
	observation: ParsedObservation,
	additionalGrounding: string,
): boolean {
	const source = normalizeRecoverableText(
		`${visibleTextForComparison(fragment)} ${additionalGrounding}`,
	).toLowerCase();
	const scalarFields = [
		["title", observation.title],
		["subtitle", observation.subtitle ?? ""],
		["narrative", observation.narrative],
	] as const;
	if (
		scalarFields.some(
			([tag, value]) =>
				hasVisibleText(value) &&
				!hasVisibleText(extractRecoverableTagText(fragment, tag)?.value ?? "") &&
				!valueIsComposedFromSource(value, source),
		)
	) {
		return false;
	}
	return (
		addedItemsAreGrounded(
			extractRecoverableChildTexts(fragment, "facts", "fact"),
			observation.facts,
			source,
		) &&
		addedItemsAreGrounded(
			extractRecoverableChildTexts(fragment, "concepts", "concept"),
			observation.concepts,
			source,
			(value) => OBSERVATION_CONCEPTS.has(value.trim().toLowerCase()),
		) &&
		addedItemsAreGrounded(
			extractRecoverableChildTexts(fragment, "files_read", "file"),
			observation.filesRead,
			source,
			(value) => isGroundedProsePath(value, source),
		) &&
		addedItemsAreGrounded(
			extractRecoverableChildTexts(fragment, "files_modified", "file"),
			observation.filesModified,
			source,
			(value) => isGroundedProsePath(value, source),
		)
	);
}

function valueIsComposedFromSource(value: string, source: string): boolean {
	const segments = normalizeRecoverableText(value)
		.toLowerCase()
		.split(/(?:[!?;]+|\.(?=\s|$)|\s+[—–]\s+)/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	return segments.length > 0 && segments.every((segment) => isGroundedProsePhrase(segment, source));
}

function addedItemsAreGrounded(
	recovered: RecoverableText[],
	actual: string[],
	source: string,
	allowAddition: (value: string) => boolean = (value) => valueIsComposedFromSource(value, source),
): boolean {
	const remaining = [...actual];
	for (const item of recovered) {
		const matchIndex = remaining.findIndex((candidate) => matchesRecoverableText(item, candidate));
		if (matchIndex >= 0) remaining.splice(matchIndex, 1);
	}
	return remaining.every(allowAddition);
}

function summaryMatchesRecoveredFields(
	fragment: string,
	summary: ParsedSummary,
	allowMergedValues: boolean,
): boolean {
	const scalarFields = [
		["request", "request"],
		["investigated", "investigated"],
		["learned", "learned"],
		["completed", "completed"],
		["next_steps", "nextSteps"],
		["notes", "notes"],
	] as const;
	const repairedValues = [
		summary.request,
		summary.investigated,
		summary.learned,
		summary.completed,
		summary.nextSteps,
		summary.notes,
		...summary.filesRead,
		...summary.filesModified,
	];
	return (
		scalarFields.every(([tag, field]) =>
			(allowMergedValues ? containsRecoverableText : matchesRecoverableText)(
				extractRecoverableTagText(fragment, tag),
				summary[field],
			),
		) &&
		preservesRecoverableItems(
			extractRecoverableChildTexts(fragment, "files_read", "file"),
			summary.filesRead,
		) &&
		preservesRecoverableItems(
			extractRecoverableChildTexts(fragment, "files_modified", "file"),
			summary.filesModified,
		) &&
		recoverableUnknownSummaryValues(fragment).every((recovered) =>
			repairedValues.some((value) =>
				(allowMergedValues ? containsRecoverableText : matchesRecoverableText)(recovered, value),
			),
		)
	);
}

function recoverableUnknownSummaryValues(fragment: string): RecoverableText[] {
	const completeSummary = /<\/summary>\s*$/i.test(fragment.trim());
	return directChildFragments(fragment, "summary")
		.filter(({ tag }) => tag !== "observation" && !SUMMARY_FIELDS.has(tag))
		.flatMap(({ value: rawValue, complete }) => {
			const value = visibleTextForComparison(rawValue);
			return value ? [{ value, complete: complete || completeSummary }] : [];
		});
}

function recoversUnknownSummaryFields(
	initialRaw: string | null | undefined,
	repairedSummary: ParsedSummary | null,
): boolean {
	if (!initialRaw) return true;
	const unknownValues = completeBlockMatches(cleanXmlText(initialRaw), SUMMARY_BLOCK_RE).flatMap(
		({ value: block }) => recoverableUnknownSummaryValues(block),
	);
	if (unknownValues.length === 0) return true;
	if (!repairedSummary) return false;
	const repairedValues = [
		repairedSummary.request,
		repairedSummary.investigated,
		repairedSummary.learned,
		repairedSummary.completed,
		repairedSummary.nextSteps,
		repairedSummary.notes,
		...repairedSummary.filesRead,
		...repairedSummary.filesModified,
	];
	return unknownValues.every((recovered) =>
		repairedValues.some((value) => containsRecoverableText(recovered, value)),
	);
}

function recoversDiscardedBlocks(
	initialRaw: string | null | undefined,
	initialParsed: ParsedOutput,
	repairedParsed: ParsedOutput,
): boolean {
	if (!initialRaw) return true;
	const initialDiagnostics = inspectObserverResponseStructure(initialRaw, initialParsed);
	const recoveredObservations = remainingAfterPreservedObservations(
		initialParsed.observations,
		repairedParsed.observations,
		initialRaw,
	);
	if (!recoveredObservations) return false;
	const discardedObservations = discardedObservationFragments(initialRaw);
	if (discardedObservations.length < initialDiagnostics.discardedObservationBlocks) return false;
	for (const fragment of discardedObservations) {
		const surroundingProse = proseOutsideRootBlocks(initialRaw).join(" ");
		const matchIndex = recoveredObservations.findIndex((observation) =>
			observationMatchesRecoveredFields(fragment, observation, surroundingProse),
		);
		if (matchIndex < 0) return false;
		recoveredObservations.splice(matchIndex, 1);
	}
	if (
		recoveredObservations.length > 0 &&
		!observationsAreGroundedInPlainProse(plainProseSource(initialRaw) ?? "", recoveredObservations)
	) {
		return false;
	}
	if (!preservesProseOutsideRootBlocks(initialRaw, repairedParsed)) return false;
	const discardedSummaries = discardedSummaryFragments(initialRaw, initialParsed);
	if (discardedSummaries.length < initialDiagnostics.discardedSummaryBlocks) return false;
	const allowMergedSummaryValues = initialDiagnostics.summaryBlocks > 1;
	return (
		discardedSummaries.length === 0 ||
		(repairedParsed.summary !== null &&
			discardedSummaries.every((fragment) =>
				summaryMatchesRecoveredFields(
					fragment,
					repairedParsed.summary as ParsedSummary,
					allowMergedSummaryValues,
				),
			))
	);
}

function preservesProseOutsideRootBlocks(initialRaw: string, repaired: ParsedOutput): boolean {
	const proseFragments = proseOutsideRootBlocks(initialRaw);
	if (proseFragments.length === 0) return true;
	const repairedValues = [
		...repaired.observations.flatMap((observation) => [
			observation.title,
			observation.subtitle ?? "",
			observation.narrative,
			...observation.facts,
		]),
		...(repaired.summary
			? [
					repaired.summary.request,
					repaired.summary.investigated,
					repaired.summary.learned,
					repaired.summary.completed,
					repaired.summary.nextSteps,
					repaired.summary.notes,
				]
			: []),
	].map((value) => normalizeRecoverableText(value).toLowerCase());
	return proseFragments.every((fragment) =>
		repairedValues.some((value) => value.includes(fragment)),
	);
}

function proseOutsideRootBlocks(raw: string): string[] {
	const cleaned = cleanXmlText(raw);
	const boundaries = rootBlockBoundaries(cleaned);
	if (boundaries.length === 0) return [];
	const fragments: string[] = [];
	let cursor = 0;
	for (const [index, start] of boundaries.entries()) {
		if (start < cursor) continue;
		const prose = visibleTextForComparison(cleaned.slice(cursor, start));
		if (prose) fragments.push(normalizeRecoverableText(prose).toLowerCase());
		const remainder = cleaned.slice(start);
		const rootName = /^<([A-Za-z_][\w:.-]*)/i.exec(remainder)?.[1]?.toLowerCase();
		const completePattern =
			rootName === "observation"
				? /^<observation[^>]*>.*?<\/observation>/is
				: rootName === "summary"
					? /^<summary[^>]*>.*?<\/summary>/is
					: /^<skip_summary(?:\s+reason="[^"]+")?\s*(?:\/>|>\s*<\/skip_summary>)/i;
		const complete = completePattern.exec(remainder)?.[0];
		cursor = complete ? start + complete.length : (boundaries[index + 1] ?? cleaned.length);
	}
	const trailing = visibleTextForComparison(cleaned.slice(cursor));
	if (trailing) fragments.push(normalizeRecoverableText(trailing).toLowerCase());
	return fragments;
}

function observationsAreGroundedInPlainProse(
	prose: string,
	observations: ParsedObservation[],
): boolean {
	if (observations.length > 1) return false;
	if (observations.length === 0) return true;
	const observation = observations[0];
	if (!observation) return false;
	const title = normalizeRecoverableText(observation.title).toLowerCase();
	const narrative = normalizeRecoverableText(observation.narrative).toLowerCase();
	return (
		narrative === prose &&
		isGroundedProsePhrase(title, prose) &&
		(!hasVisibleText(observation.subtitle ?? "") ||
			isGroundedProsePhrase(observation.subtitle as string, prose)) &&
		observation.facts.every((value) => isGroundedProsePhrase(value, prose)) &&
		observation.concepts.every((value) => OBSERVATION_CONCEPTS.has(value.trim().toLowerCase())) &&
		[...observation.filesRead, ...observation.filesModified].every((value) =>
			isGroundedProsePath(value, prose),
		)
	);
}

function isGroundedProsePhrase(value: string, prose: string): boolean {
	const normalized = normalizeRecoverableText(value).toLowerCase();
	if (!normalized) return false;
	const comparable = normalized.replace(/[.!?]+$/, "");
	for (const segment of prose
		.split(/(?:[!?;]+|\.(?=\s|$)|\s+[—–]\s+)/)
		.map((part) => part.trim())) {
		if (!segment) continue;
		const index = segment.indexOf(comparable);
		if (index < 0) continue;
		const before = segment[index - 1];
		const after = segment[index + comparable.length];
		if ((before && /[\p{L}\p{N}_]/u.test(before)) || (after && /[\p{L}\p{N}_]/u.test(after))) {
			continue;
		}
		const negations =
			segment.match(
				/\b(?:not|no|never|without|cannot|can't|unable|failed|none|neither|nor|lacks?|missing|absent|\w+n't)\b/g,
			) ?? [];
		if (
			/(?:\b(?:non|un|mis)-)$/.test(segment.slice(0, index)) ||
			negations.some(
				(negation) => !new RegExp(`\\b${escapeRegExpLiteral(negation)}\\b`).test(comparable),
			)
		) {
			continue;
		}
		return true;
	}
	return false;
}

function isGroundedProsePath(value: string, prose: string): boolean {
	const normalized = normalizeRecoverableText(value).toLowerCase();
	if (!normalized) return false;
	let index = prose.indexOf(normalized);
	while (index >= 0) {
		const before = prose[index - 1];
		const after = prose[index + normalized.length];
		const afterNext = prose[index + normalized.length + 1];
		const afterIsTerminalPunctuation =
			Boolean(after && /[.,;:!?]/.test(after)) && (!afterNext || /\s/.test(afterNext));
		if (
			(!before || !/[\p{L}\p{N}_./-]/u.test(before)) &&
			(!after || !/[\p{L}\p{N}_./-]/u.test(after) || afterIsTerminalPunctuation)
		) {
			return true;
		}
		index = prose.indexOf(normalized, index + 1);
	}
	return false;
}

function summaryIsGroundedInPlainProse(
	prose: string,
	summary: ParsedSummary | null,
	requireFullCoverage: boolean,
): boolean {
	if (!summary) return false;
	const scalarValues = [
		summary.request,
		summary.investigated,
		summary.learned,
		summary.completed,
		summary.nextSteps,
		summary.notes,
	].filter(hasVisibleText);
	const paths = [...summary.filesRead, ...summary.filesModified];
	if (scalarValues.length === 0 && paths.length === 0) return false;
	if (!scalarValues.every((value) => isGroundedProsePhrase(value, prose))) return false;
	if (!paths.every((value) => isGroundedProsePath(value, prose))) {
		return false;
	}
	if (!requireFullCoverage) return true;
	const normalizedValues = scalarValues.map((value) =>
		normalizeRecoverableText(value)
			.toLowerCase()
			.replace(/[.!?]+$/, ""),
	);
	return prose
		.split(/(?:[!?;]+|\.(?=\s|$)|\s+[—–]\s+)/)
		.map((part) => part.trim())
		.filter(Boolean)
		.every((segment) => normalizedValues.some((value) => value === segment));
}

function plainProseSource(initialRaw: string | null | undefined): string | null {
	if (!initialRaw) return null;
	const cleaned = cleanXmlText(initialRaw);
	if (!cleaned) return null;
	if (rootBlockBoundaries(cleaned).length === 0) {
		const visible = visibleTextForComparison(cleaned);
		return visible ? normalizeRecoverableText(visible).toLowerCase() : null;
	}
	if (/<\/?[A-Za-z_][\w:.-]*(?:\s|\/?>)/.test(cleaned)) return null;
	return normalizeRecoverableText(cleaned).toLowerCase();
}

function proseLooksLowSignal(prose: string): boolean {
	const normalized = prose.replace(/[.!?]+$/, "").trim();
	return (
		isLowSignalObservation(prose) ||
		/^(?:ok|okay|yes|no|thanks|thank you|got it|understood|approved|sounds good|sure)$/.test(
			normalized,
		)
	);
}

function repairedOutputIsGroundedInPlainProse(
	initialRaw: string | null | undefined,
	repairedParsed: ParsedOutput,
): boolean {
	const prose = plainProseSource(initialRaw);
	if (!prose) return false;
	if (repairedParsed.skipSummaryReason !== null) {
		return (
			repairedParsed.skipSummaryReason.trim().toLowerCase() === "low-signal" &&
			repairedParsed.observations.length === 0 &&
			repairedParsed.summary === null &&
			proseLooksLowSignal(prose)
		);
	}
	if (
		!summaryIsGroundedInPlainProse(
			prose,
			repairedParsed.summary,
			repairedParsed.observations.length === 0,
		)
	) {
		return false;
	}
	return observationsAreGroundedInPlainProse(prose, repairedParsed.observations);
}

function hasRecoveredUsableObservation(
	initialObservations: ParsedObservation[],
	repairedObservations: ParsedObservation[],
): boolean {
	const initialKindsByContent = new Map<string, string[]>();
	for (const observation of initialObservations) {
		const key = observationContentKey(observation);
		const kinds = initialKindsByContent.get(key) ?? [];
		kinds.push(observation.kind);
		initialKindsByContent.set(key, kinds);
	}
	return repairedObservations.some((observation) => {
		if (!SUPPORTED_OBSERVATION_KINDS.has(observation.kind)) return false;
		const initialKinds = initialKindsByContent.get(observationContentKey(observation));
		return !initialKinds?.some((kind) => SUPPORTED_OBSERVATION_KINDS.has(kind));
	});
}

/** Prefer a repair only when it improves or replaces unusable observer output. */
export function shouldPreferRepairedObserverResponse(
	initialParsed: ParsedOutput,
	repairedRaw: string | null,
	repairedParsed: ParsedOutput,
	initialRaw?: string | null,
): boolean {
	if (!repairedRaw) return false;
	const initialHasStructuredOutput =
		initialParsed.observations.length > 0 ||
		initialParsed.summary !== null ||
		initialParsed.skipSummaryReason !== null;
	const repairedHasStructuredOutput =
		repairedParsed.observations.length > 0 ||
		repairedParsed.summary !== null ||
		repairedParsed.skipSummaryReason !== null;
	const repairedHasNoDataLoss = !inspectObserverResponseStructure(repairedRaw, repairedParsed)
		.dataLoss;
	const repairedHasConsistentSummaryDecision =
		repairedParsed.summary === null || repairedParsed.skipSummaryReason === null;
	const initialHasContradictorySummaryDecision =
		initialParsed.summary !== null && initialParsed.skipSummaryReason !== null;
	const initialDiagnostics = initialRaw
		? inspectObserverResponseStructure(initialRaw, initialParsed)
		: null;
	const recoveredUsableSummary =
		initialParsed.summary === null &&
		repairedParsed.summary !== null &&
		(initialDiagnostics?.discardedSummaryBlocks ?? 0) > 0;
	const allowMergedSummaryValues = (initialDiagnostics?.summaryBlocks ?? 0) > 1;
	const requiresSummaryGrounding =
		allowMergedSummaryValues ||
		(initialParsed.summary === null && (initialDiagnostics?.discardedSummaryBlocks ?? 0) > 0);
	const mergedSummaryValuesArePreserved =
		!requiresSummaryGrounding ||
		(repairedParsed.summary !== null &&
			mergedSummaryValuesAreGrounded(initialRaw, repairedParsed.summary));
	const introducedSummaryIsGrounded =
		initialParsed.summary !== null ||
		repairedParsed.summary === null ||
		(initialDiagnostics?.discardedSummaryBlocks ?? 0) > 0 ||
		(initialRaw !== null &&
			initialRaw !== undefined &&
			summaryIsGroundedInPlainProse(
				normalizeRecoverableText(visibleTextForComparison(initialRaw)).toLowerCase(),
				repairedParsed.summary,
				false,
			));
	if (!initialHasStructuredOutput) {
		if (initialRaw !== null && initialRaw !== undefined && !cleanXmlText(initialRaw)) return false;
		if (plainProseSource(initialRaw) !== null) {
			return (
				repairedHasStructuredOutput &&
				repairedHasNoDataLoss &&
				repairedHasConsistentSummaryDecision &&
				repairedOutputIsGroundedInPlainProse(initialRaw, repairedParsed)
			);
		}
		return (
			repairedHasStructuredOutput &&
			repairedHasNoDataLoss &&
			repairedHasConsistentSummaryDecision &&
			introducedSummaryIsGrounded &&
			mergedSummaryValuesArePreserved &&
			recoversUnknownSummaryFields(initialRaw, repairedParsed.summary) &&
			recoversDiscardedBlocks(initialRaw, initialParsed, repairedParsed)
		);
	}
	const recoveredUsableObservation = hasRecoveredUsableObservation(
		initialParsed.observations,
		repairedParsed.observations,
	);
	return (
		repairedHasStructuredOutput &&
		repairedHasNoDataLoss &&
		repairedHasConsistentSummaryDecision &&
		introducedSummaryIsGrounded &&
		mergedSummaryValuesArePreserved &&
		recoversUnknownSummaryFields(initialRaw, repairedParsed.summary) &&
		recoversDiscardedBlocks(initialRaw, initialParsed, repairedParsed) &&
		preservesParsedObservations(
			initialParsed.observations,
			repairedParsed.observations,
			initialRaw,
		) &&
		preservesPopulatedSummaryFields(
			initialParsed.summary,
			repairedParsed.summary,
			allowMergedSummaryValues,
			initialRaw,
		) &&
		(initialParsed.skipSummaryReason !== null
			? repairedParsed.skipSummaryReason === initialParsed.skipSummaryReason ||
				(repairedParsed.skipSummaryReason === null &&
					(recoveredUsableObservation ||
						recoveredUsableSummary ||
						initialHasContradictorySummaryDecision))
			: initialParsed.summary === null || repairedParsed.skipSummaryReason === null)
	);
}

/** Return true if at least one observation has a title or narrative. */
export function hasMeaningfulObservation(observations: ParsedObservation[]): boolean {
	return observations.some((obs) => obs.title || obs.narrative);
}
