/**
 * Memory pack builder — port of codemem/store/packs.py.
 *
 * Builds a formatted "memory pack" from search results, organized into
 * sections (summary, timeline, observations) with token budgeting.
 *
 * Ported: exact dedup, tag-overlap sorting, summary/observation fallback,
 *         support_count, separate section dedup, semantic candidate merging.
 *
 * Semantic candidate merging is supported via `buildMemoryPackAsync` or
 * by passing pre-computed semantic results to `buildMemoryPack`.
 *
 * NOT ported: fuzzy search, pack delta
 * tracking, discovery-token work estimation.
 */

import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import { buildFilterClausesWithContext } from "./filters.js";
import { inferMemoryRole, readArtifactClass } from "./memory-quality.js";
import { fusePackCandidates } from "./pack-fusion.js";
import { projectBasename } from "./project.js";
import { sanitizeSearchQuery } from "./query-sanitizer.js";
import { memoryLooksRecapLike, queryPrefersRecap } from "./recap-policy.js";
import { findByFile } from "./ref-queries.js";
import { MAX_RETRIEVAL_DIAGNOSTIC_EXPOSURES } from "./retrieval-ledger.js";
import type { StoreHandle } from "./search.js";
import {
	ownershipFilterContext,
	rerankResults,
	rowToMemoryResult,
	scoreResult,
	search,
	timeline,
} from "./search.js";
import {
	canonicalMemoryKind,
	getSummaryMetadata,
	isNativeSessionSummaryMemory,
	isSummaryLikeMemory,
	summaryContinuityFilter,
	summaryLikeSqlPredicate,
} from "./summary-memory.js";
import type {
	AutomaticContext,
	MemoryFilters,
	MemoryItemResponse,
	MemoryResult,
	PackFusionEvidence,
	PackItem,
	PackRenderOptions,
	PackResponse,
	PackTrace,
	PackTraceCandidate,
	PackTraceDisposition,
	PackTraceMode,
	PackTraceSection,
	RenderedPackItem,
	TimelineItemResponse,
} from "./types.js";
import { semanticSearch } from "./vectors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Kinds eligible for supplemental browsing, including legacy reader kinds. */
const OBSERVATION_KINDS = [
	"decision",
	"feature",
	"bugfix",
	"refactor",
	"change",
	"discovery",
	"exploration",
	"note",
];

const TASK_RECENCY_DAYS = 365;

const TASK_HINT_QUERY =
	"todo todos task tasks pending follow up follow-up next resume continue backlog pick up pick-up";

const RECALL_HINT_QUERY = "session summary recap remember last time previous work";

const PACK_BASELINE_BATCH_SIZE = 25;
const MAX_PACK_BASELINE_SCAN_ROWS = 250;
const MAX_SEMANTIC_REVALIDATION_IDS = 200;
const TRACE_CANDIDATE_LIMIT = Math.min(20, MAX_RETRIEVAL_DIAGNOSTIC_EXPOSURES);
const TRACE_PREVIEW_LIMIT = 160;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Parse a JSON-encoded facts string into an array of strings, or null. */
function parseFacts(raw: string | null): string[] | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			const strings = parsed.filter((item): item is string => typeof item === "string");
			return strings.length > 0 ? strings : null;
		}
	} catch {
		// not valid JSON — ignore
	}
	return null;
}

/**
 * Format a single memory item for pack output.
 *
 * Prefers structured content (narrative / facts) over body_text when
 * available. Falls back to the original single-line format when neither
 * structured field exists.
 */
type PackCompressionMode = "off" | "compact" | "ids";

const PACK_COMPRESSION_MODE_ENV = "CODEMEM_PACK_COMPRESSION";
const DEFAULT_PACK_COMPRESSION_MODE: PackCompressionMode = "compact";

function parsePackCompressionMode(value: string | undefined): PackCompressionMode | null {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return null;
	if (["0", "false", "none", "off", "disabled"].includes(normalized)) return "off";
	if (["compact", "compact-only", "compact_only", "default"].includes(normalized)) return "compact";
	if (["1", "true", "on", "ids", "all", "legacy"].includes(normalized)) return "ids";
	return null;
}

function resolvePackCompressionMode(explicit?: PackCompressionMode): PackCompressionMode {
	return (
		explicit ??
		parsePackCompressionMode(process.env[PACK_COMPRESSION_MODE_ENV]) ??
		DEFAULT_PACK_COMPRESSION_MODE
	);
}

function relatedSuffix(
	item: MemoryResult,
	clusterState?: ClusterCompressionState,
	options: { includeIds?: boolean } = {},
): string {
	const related = clusterState?.compressedByRepresentative.get(item.id);
	const relatedCount = related?.size ?? 0;
	if (relatedCount === 0) return "";
	if (!options.includeIds) return ` (+${relatedCount} related)`;
	const ids = [...(related ?? [])]
		.sort((a, b) => a - b)
		.map((id) => `[${id}]`)
		.join(", ");
	return ` (+${relatedCount} related: ${ids})`;
}

function formatItem(
	item: MemoryResult,
	clusterState?: ClusterCompressionState,
	options: { includeRelatedIds?: boolean } = {},
): string {
	const header = `[${item.id}] (${item.kind}) ${item.title}${relatedSuffix(item, clusterState, {
		includeIds: options.includeRelatedIds,
	})}`;
	const narrative = item.narrative || null;
	const facts = parseFacts(item.facts);

	if (narrative || facts) {
		let result = header;
		if (narrative) {
			result += `\n${narrative}`;
		}
		if (facts) {
			result += `\n\n${facts.map((f) => `- ${f}`).join("\n")}`;
		}
		return result;
	}

	// Fallback: original single-line format
	if (item.body_text) {
		return `${header} - ${item.body_text}`;
	}
	return header;
}

function joinPackSegments(
	segments: { text: string; item?: MemoryResult }[],
	renderedItems?: RenderedPackItem[],
): string {
	let text = "";
	const items = new Map<
		number,
		{ item: MemoryResult; spans: { start: number; end: number }[]; texts: string[] }
	>();
	for (const segment of segments) {
		const start = text.length;
		text += segment.text;
		if (!renderedItems || !segment.item) continue;
		const entry = items.get(segment.item.id) ?? { item: segment.item, spans: [], texts: [] };
		entry.spans.push({ start, end: text.length });
		entry.texts.push(segment.text);
		items.set(segment.item.id, entry);
	}
	for (const { item, spans, texts } of items.values()) {
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify([item.id, item.title, item.body_text, item.narrative, item.facts, texts]),
			)
			.digest("hex");
		renderedItems?.push({ id: item.id, fingerprint, spans });
	}
	return text;
}

function renderStandardPack(
	summary: MemoryResult[],
	timelineItems: MemoryResult[],
	observations: MemoryResult[],
	clusterState: ClusterCompressionState,
	options: { includeRelatedIds: boolean },
	renderedItems?: RenderedPackItem[],
): string {
	const segments: { text: string; item?: MemoryResult }[] = [];
	for (const [heading, items] of [
		["Summary", summary],
		["Timeline", timelineItems],
		["Observations", observations],
	] as const) {
		if (segments.length) segments.push({ text: "\n\n" });
		segments.push({ text: `## ${heading}\n` });
		items.forEach((item, index) => {
			if (index) segments.push({ text: "\n" });
			segments.push({ text: formatItem(item, clusterState, options), item });
		});
	}
	return joinPackSegments(segments, renderedItems);
}

function budgetStandardPack(
	summaryItems: MemoryResult[],
	timelineItems: MemoryResult[],
	observationItems: MemoryResult[],
	clusterState: ClusterCompressionState,
	options: { tokenBudget: number; includeRelatedIds: boolean },
): [MemoryResult[], MemoryResult[], MemoryResult[]] {
	const budgetedSummary: MemoryResult[] = [];
	for (const item of summaryItems) {
		const candidate = renderStandardPack([...budgetedSummary, item], [], [], clusterState, options);
		if (!fitsTokenBudget(candidate, options.tokenBudget)) break;
		budgetedSummary.push(item);
	}
	const budgetedTimeline: MemoryResult[] = [];
	for (const item of timelineItems) {
		const candidate = renderStandardPack(
			budgetedSummary,
			[...budgetedTimeline, item],
			[],
			clusterState,
			options,
		);
		if (!fitsTokenBudget(candidate, options.tokenBudget)) break;
		budgetedTimeline.push(item);
	}
	const budgetedObservations: MemoryResult[] = [];
	for (const item of observationItems) {
		const candidate = renderStandardPack(
			budgetedSummary,
			budgetedTimeline,
			[...budgetedObservations, item],
			clusterState,
			options,
		);
		if (!fitsTokenBudget(candidate, options.tokenBudget)) break;
		budgetedObservations.push(item);
	}
	return [budgetedSummary, budgetedTimeline, budgetedObservations];
}

function fitsTokenBudget(text: string, tokenBudget: number): boolean {
	return estimateTokens(text) <= tokenBudget;
}

function enforceTokenBudget(text: string, tokenBudget: number | null): string {
	if (tokenBudget == null || tokenBudget <= 0 || fitsTokenBudget(text, tokenBudget)) {
		return text;
	}
	return "";
}

// ---------------------------------------------------------------------------
// Compact mode rendering
// ---------------------------------------------------------------------------

const DEFAULT_COMPACT_DETAIL_COUNT = 3;
const COMPACT_FOOTER =
	"Use `memory_get` for one item, or `memory_get_observations(ids=[...])` for related IDs shown in the index.";

/** Single-line index entry for compact mode. */
function formatIndexLine(item: MemoryResult, clusterState?: ClusterCompressionState): string {
	return `[${item.id}] (${item.kind}) ${item.title}${relatedSuffix(item, clusterState, {
		includeIds: true,
	})}`;
}

/**
 * Render a compact pack: scannable index of all items, full detail for
 * selected items, and a footer guiding the model to fetch more on demand.
 *
 * `detailIds` controls which items get full rendering in the Detail section.
 * Under budget pressure, an item may be demoted from detail to index-only,
 * so the set may contain fewer items than `compactDetailCount`.
 */
function renderCompactPack(
	items: MemoryResult[],
	detailIds: Set<number>,
	clusterState?: ClusterCompressionState,
	renderedItems?: RenderedPackItem[],
): string {
	const segments: { text: string; item?: MemoryResult }[] = [{ text: "## Index\n" }];
	if (!items.length) segments.push({ text: "(no items)" });
	items.forEach((item, index) => {
		if (index) segments.push({ text: "\n" });
		segments.push({ text: formatIndexLine(item, clusterState), item });
	});
	segments.push({ text: "\n\n## Detail\n" });
	const detailItems = items.filter((item) => detailIds.has(item.id));
	if (!detailItems.length) segments.push({ text: "(no items)" });
	detailItems.forEach((item, index) => {
		if (index) segments.push({ text: "\n\n" });
		segments.push({ text: formatItem(item, clusterState, { includeRelatedIds: true }), item });
	});
	segments.push({ text: `\n\n${COMPACT_FOOTER}` });
	return joinPackSegments(segments, renderedItems);
}

// ---------------------------------------------------------------------------
// Pack item shape (what goes into items array)
// ---------------------------------------------------------------------------

function toPackItem(
	result: MemoryResult,
	dedupeState?: DedupeState,
	clusterState?: ClusterCompressionState,
): PackItem {
	const dupes = dedupeState?.duplicateIds.get(result.id);
	const compressed = clusterState?.compressedByRepresentative.get(result.id);
	const item: PackItem = {
		id: result.id,
		kind: result.kind,
		title: result.title,
		body: result.narrative || result.body_text,
		confidence: result.confidence,
		tags: result.tags_text,
		metadata: result.metadata,
	};
	const supportCount = 1 + (dupes?.size ?? 0) + (compressed?.size ?? 0);
	if (supportCount > 1) {
		item.support_count = supportCount;
	}
	if (dupes && dupes.size > 0) {
		item.duplicate_ids = [...dupes].sort((a, b) => a - b);
	}
	if (compressed && compressed.size > 0) {
		item.compressed_ids = [...compressed].sort((a, b) => a - b);
	}
	return item;
}

// ---------------------------------------------------------------------------
// Exact dedup (ports Python's _collapse_exact_duplicates)
// ---------------------------------------------------------------------------

/** Normalize text for dedup comparison: lowercase, trim, collapse whitespace. */
function normalizeDedupe(text: string): string {
	return text.trim().toLowerCase().split(/\s+/).join(" ");
}

/**
 * Build a collision-free dedup key for non-summary items.
 * Uses length-prefixed fields so pipe characters in content can't
 * cause collisions between distinct (kind, title, body) tuples.
 */
function exactDedupeKey(item: MemoryResult): string | null {
	if (isSummaryLike(item)) return null;
	const title = normalizeDedupe(item.title);
	const body = normalizeDedupe(item.body_text);
	if (!title && !body) return null;
	return `${item.kind.length}:${item.kind}|${title.length}:${title}|${body.length}:${body}`;
}

interface DedupeState {
	canonicalByKey: Map<string, number>;
	duplicateIds: Map<number, Set<number>>;
}

interface ClusterCompressionState {
	compressedByRepresentative: Map<number, Set<number>>;
	representativeByCompressedId: Map<number, number>;
	clusters: Array<{
		representative_id: number;
		compressed_ids: number[];
		overlap_words: string[];
		pattern:
			| "related_work"
			| "session_echo"
			| "operational_rule"
			| "recurring_failure"
			| "thematic_overlap";
	}>;
}

/**
 * Collapse exact duplicates: same kind+title+body → keep first (canonical).
 * Tracks duplicate IDs so support_count can report how many were collapsed.
 */
function collapseExactDuplicates(items: MemoryResult[], state: DedupeState): MemoryResult[] {
	const collapsed: MemoryResult[] = [];
	for (const item of items) {
		const key = exactDedupeKey(item);
		if (key === null) {
			collapsed.push(item);
			continue;
		}
		const canonicalId = state.canonicalByKey.get(key);
		if (canonicalId === undefined) {
			state.canonicalByKey.set(key, item.id);
			collapsed.push(item);
			continue;
		}
		if (canonicalId === item.id) {
			collapsed.push(item);
			continue;
		}
		// Track as duplicate of the canonical
		const existing = state.duplicateIds.get(canonicalId);
		if (existing) existing.add(item.id);
		else state.duplicateIds.set(canonicalId, new Set([item.id]));
	}
	return collapsed;
}

// ---------------------------------------------------------------------------
// Near-duplicate cluster compression (Phase B Layer 2)
// ---------------------------------------------------------------------------

const CLUSTER_STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"to",
	"in",
	"for",
	"of",
	"on",
	"with",
	"is",
	"was",
	"are",
	"were",
	"from",
	"this",
	"that",
	"it",
	"not",
	"no",
]);

function significantWords(title: string): Set<string> {
	return new Set(
		(title.toLowerCase().match(/\w+/g) ?? []).filter(
			(word) => word.length > 2 && !CLUSTER_STOP_WORDS.has(word),
		),
	);
}

function overlapWords(a: Set<string>, b: Set<string>): string[] {
	return [...a].filter((word) => b.has(word)).sort();
}

function chooseRepresentative(cluster: MemoryResult[]): MemoryResult {
	const sorted = [...cluster].sort((a, b) => {
		if (b.confidence !== a.confidence) return b.confidence - a.confidence;
		if (b.created_at !== a.created_at) return b.created_at.localeCompare(a.created_at);
		const aHasNarrative = a.narrative?.trim() ? 1 : 0;
		const bHasNarrative = b.narrative?.trim() ? 1 : 0;
		if (bHasNarrative !== aHasNarrative) return bHasNarrative - aHasNarrative;
		return a.id - b.id;
	});
	const first = sorted[0];
	if (!first) throw new Error("expected non-empty cluster");
	return first;
}

function clusterPattern(
	cluster: MemoryResult[],
): "related_work" | "session_echo" | "operational_rule" | "recurring_failure" | "thematic_overlap" {
	if (cluster.some((item) => isSummaryLike(item)) && cluster.some((item) => !isSummaryLike(item))) {
		return "session_echo";
	}
	if (cluster.every((item) => item.kind === "bugfix")) return "recurring_failure";
	if (cluster.some((item) => item.kind === "decision")) return "operational_rule";
	if (
		cluster.some((item) =>
			["change", "feature", "discovery", "refactor", "decision"].includes(item.kind),
		)
	) {
		return "related_work";
	}
	return "thematic_overlap";
}

function compressClusters(
	items: MemoryResult[],
	mode: PackTraceMode,
	state: ClusterCompressionState,
): MemoryResult[] {
	if (mode === "task" || items.length < 2) return items;

	const wordSets = new Map<number, Set<string>>();
	for (const item of items) wordSets.set(item.id, significantWords(item.title));

	const parent = new Map<number, number>();
	for (const item of items) parent.set(item.id, item.id);
	const find = (id: number): number => {
		const p = parent.get(id);
		if (p == null) throw new Error(`missing cluster parent for ${id}`);
		if (p === id) return id;
		const root = find(p);
		parent.set(id, root);
		return root;
	};
	const union = (a: number, b: number): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(rb, ra);
	};

	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			const a = items[i];
			const b = items[j];
			if (!a || !b) continue;
			const words = overlapWords(wordSets.get(a.id) ?? new Set(), wordSets.get(b.id) ?? new Set());
			if (words.length >= 3) union(a.id, b.id);
		}
	}

	const clustersByRoot = new Map<number, MemoryResult[]>();
	for (const item of items) {
		const root = find(item.id);
		const cluster = clustersByRoot.get(root);
		if (cluster) cluster.push(item);
		else clustersByRoot.set(root, [item]);
	}

	const compressedIds = new Set<number>();
	for (const cluster of clustersByRoot.values()) {
		if (cluster.length < 2) continue;
		const representative = chooseRepresentative(cluster);
		const related = cluster
			.filter((item) => item.id !== representative.id)
			.map((item) => item.id)
			.sort((a, b) => a - b);
		const allWords = cluster.map((item) => wordSets.get(item.id) ?? new Set<string>());
		const sharedWords = [...(allWords[0] ?? new Set<string>())]
			.filter((word) => allWords.every((set) => set.has(word)))
			.sort();

		state.compressedByRepresentative.set(representative.id, new Set(related));
		for (const id of related) {
			compressedIds.add(id);
			state.representativeByCompressedId.set(id, representative.id);
		}
		state.clusters.push({
			representative_id: representative.id,
			compressed_ids: related,
			overlap_words: sharedWords,
			pattern: clusterPattern(cluster),
		});
	}

	return items.filter((item) => !compressedIds.has(item.id));
}

// ---------------------------------------------------------------------------
// Tag-overlap sorting (ports Python's _sort_by_tag_overlap)
// ---------------------------------------------------------------------------

/** Sort items by tag overlap with the query, then by recency. */
function sortByTagOverlap(items: MemoryResult[], query: string): MemoryResult[] {
	const queryTokens = new Set((query.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(Boolean));
	if (queryTokens.size === 0) return items;

	return [...items].sort((a, b) => {
		const aOverlap = countOverlap(a.tags_text, queryTokens);
		const bOverlap = countOverlap(b.tags_text, queryTokens);
		if (bOverlap !== aOverlap) return bOverlap - aOverlap;
		// Tiebreak by recency (newest first)
		return (b.created_at ?? "").localeCompare(a.created_at ?? "");
	});
}

function countOverlap(tags: string, tokens: Set<string>): number {
	const tagSet = new Set(tags.split(/\s+/).filter(Boolean));
	let count = 0;
	for (const t of tokens) {
		if (tagSet.has(t)) count++;
	}
	return count;
}

function preview(text: string): string {
	const trimmed = text.trim().replace(/\s+/g, " ");
	if (trimmed.length <= TRACE_PREVIEW_LIMIT) return trimmed;
	return `${trimmed.slice(0, TRACE_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

function modeReasons(_context: string, mode: PackTraceMode, filters?: MemoryFilters): string[] {
	const reasons: string[] = [];
	if (mode === "task") {
		reasons.push("query matched task hints");
	} else if (mode === "recall") {
		reasons.push("query matched recap or recall hints");
	} else {
		reasons.push("using default retrieval mode");
	}
	if ((filters?.working_set_paths?.length ?? 0) > 0) {
		reasons.push("working set present");
	}
	return reasons;
}

function flattenDuplicateIds(dedupeState: DedupeState): number[] {
	return [...dedupeState.duplicateIds.values()].flatMap((ids) => [...ids]).sort((a, b) => a - b);
}

function flattenCompressedIds(state: ClusterCompressionState): number[] {
	return [...state.compressedByRepresentative.values()]
		.flatMap((ids) => [...ids])
		.sort((a, b) => a - b);
}

function collapsedGroups(
	dedupeState: DedupeState,
): Array<{ kept: number; dropped: number[]; support_count: number }> {
	return [...dedupeState.duplicateIds.entries()]
		.map(([kept, dropped]) => ({
			kept,
			dropped: [...dropped].sort((a, b) => a - b),
			support_count: 1 + dropped.size,
		}))
		.sort((a, b) => a.kept - b.kept);
}

function traceSection(
	itemId: number,
	sections: Record<PackTraceSection, number[]>,
): PackTraceSection | null {
	if (sections.summary.includes(itemId)) return "summary";
	if (sections.timeline.includes(itemId)) return "timeline";
	if (sections.observations.includes(itemId)) return "observations";
	return null;
}

function candidateReasons(
	item: MemoryResult,
	scores: ReturnType<typeof scoreResult>,
	section: PackTraceSection | null,
	disposition: PackTraceDisposition,
): string[] {
	const reasons: string[] = [];
	if ((scores.text_overlap ?? 0) > 0) reasons.push("matched query terms");
	if ((scores.tag_overlap ?? 0) > 0) reasons.push("matched tag overlap");
	if ((scores.working_set_overlap ?? 0) > 0) reasons.push("working-set overlap");
	if ((scores.query_path_overlap ?? 0) > 0) reasons.push("matched file path hints");
	if (isSummaryLike(item)) reasons.push("summary-like memory");
	if (section) reasons.push(`selected for ${section}`);
	if (disposition === "deduped") reasons.push("removed by exact dedupe");
	if (disposition === "compressed") reasons.push("compressed into a related representative item");
	if (disposition === "trimmed") reasons.push("trimmed by token budget");
	if (disposition === "dropped") reasons.push("not selected for final pack");
	return reasons.length > 0 ? reasons : ["included in retrieval pool"];
}

function semanticRejectionReasons(
	id: number,
	disposition: PackTraceDisposition,
	rejectedIds: Set<number>,
): string[] {
	if (disposition !== "dropped" || !rejectedIds.has(id)) return [];
	return ["automatic_semantic_only_without_keyword_support"];
}

export type PackArtifacts = {
	response: PackResponse;
	trace: PackTrace;
};

type PackUsageBaselineRow = { metadata_json: string | null; tokens_read: number | null };

type RawSemanticResult = Awaited<ReturnType<typeof semanticSearch>>[number];

function semanticMemoryResults(results: RawSemanticResult[]): MemoryResult[] {
	return results.map((result) => {
		let metadata: Record<string, unknown> = {};
		if (result.metadata_json) {
			try {
				const parsed = JSON.parse(result.metadata_json) as unknown;
				if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
					metadata = parsed as Record<string, unknown>;
				}
			} catch {
				// Invalid JSON metadata — use empty object
			}
		}
		return {
			id: result.id,
			kind: result.kind,
			title: result.title,
			body_text: result.body_text,
			confidence: result.confidence,
			created_at: result.created_at,
			updated_at: result.updated_at,
			tags_text: result.tags_text,
			score: result.score,
			session_id: result.session_id,
			metadata,
			narrative: result.narrative ?? null,
			facts: result.facts ?? null,
		};
	});
}

function queryContentTokens(query: string): Set<string> {
	const stopWords = new Set([
		"a",
		"about",
		"an",
		"and",
		"catch",
		"continue",
		"did",
		"do",
		"for",
		"happened",
		"how",
		"i",
		"last",
		"me",
		"next",
		"on",
		"previous",
		"recall",
		"recap",
		"remember",
		"remind",
		"session",
		"summarize",
		"summary",
		"the",
		"time",
		"up",
		"we",
		"what",
		"where",
		"work",
		"worked",
		"working",
	]);
	return new Set(
		(query.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
			(token) => token.length > 2 && !stopWords.has(token),
		),
	);
}

function textOverlapScore(item: MemoryResult, query: string): number {
	const tokens = queryContentTokens(query);
	if (tokens.size === 0) return 0;
	const haystack = `${item.title} ${item.body_text} ${item.tags_text}`.toLowerCase();
	let count = 0;
	for (const token of tokens) {
		if (haystack.includes(token)) count += 1;
	}
	return count;
}

function itemLooksTaskLike(item: MemoryResult): boolean {
	const text = `${item.title} ${item.body_text}`.toLowerCase();
	for (const marker of ["task:", "todo", "pending", "next step", "continue", "resume", "need to"]) {
		if (text.includes(marker)) return true;
	}
	return false;
}

function workingSetBasename(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	let end = normalized.length;
	while (end > 0 && normalized[end - 1] === "/") end -= 1;
	const start = normalized.lastIndexOf("/", end - 1) + 1;
	return normalized.slice(start, end);
}

function taskIntentQuery(query: string, filters?: MemoryFilters): string {
	// Hook builders append project, then the last five modified-file basenames.
	// Strip only a complete metadata-derived suffix, never retrieval text itself.
	const files = (filters?.working_set_paths ?? [])
		.filter((path) => path.trim().length > 0)
		.slice(-5)
		.map(workingSetBasename)
		.filter(Boolean);
	const suffix = [filters?.project, ...files].filter(Boolean).join(" ");
	if (!suffix || !query.endsWith(` ${suffix}`)) return query;
	return query.slice(0, -(suffix.length + 1));
}

function trimTaskRequest(query: string): string {
	const trimmed = query.trim();
	let end = trimmed.length;
	while (end > 0 && ".!?".includes(trimmed.charAt(end - 1))) end -= 1;
	// Match the former non-Unicode /i grammar without folding lookalike letters.
	return trimmed
		.slice(0, end)
		.trim()
		.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function taskCollectionEnd(request: string, tokens: RegExpExecArray[], index: number): number {
	const collection = tokens[index];
	if (!collection) return -1;
	if (
		[
			"tasks",
			"todo",
			"todos",
			"backlog",
			"followup",
			"followups",
			"follow-up",
			"follow-ups",
		].includes(collection[0])
	)
		return index + 1;
	const next = tokens[index + 1];
	if (collection[0] !== "follow" || !next || !["up", "ups"].includes(next[0])) return -1;
	// The existing collection spelling permits one literal space, not arbitrary whitespace.
	const separatorStart = collection.index + "follow".length;
	if (request.slice(separatorStart, next.index) !== " ") return -1;
	return index + 2;
}

function queryLooksLikeTasks(query: string): boolean {
	const request = trimTaskRequest(query);
	const tokens = [...request.matchAll(/\S+/g)];
	const word = (index: number) => tokens[index]?.[0];
	let index = 0;
	if (word(index) === "please") index += 1;
	const listing = word(index) === "show" || word(index) === "list";
	if (listing) {
		index += 1;
		if (word(index) === "me" || word(index) === "us") index += 1;
	} else if (index > 0) {
		return false;
	}
	// Bare collection labels and explicit listing requests express browsing intent.
	// A task word inside a technical question is not enough to broaden retrieval.
	while (["my", "our", "the", "pending", "open"].includes(word(index) ?? "")) index += 1;
	index = taskCollectionEnd(request, tokens, index);
	if (index < 0) return false;
	if (index === tokens.length) return true;
	if (!listing || !["for", "about", "in"].includes(word(index) ?? "")) return false;
	const topic = tokens[index + 1];
	if (!topic) return false;
	// Preserve the former single-line topic tail; whitespace before it may span lines.
	return !/[\n\r\u2028\u2029]/.test(request.slice(topic.index));
}

function queryLooksLikeRecall(query: string): boolean {
	const lowered = query.toLowerCase();
	for (const token of ["remember", "remind", "recall", "recap", "summary", "summarize"]) {
		if (lowered.includes(token)) return true;
	}
	for (const phrase of [
		"what did we do",
		"what did we work on",
		"what did we decide",
		"what happened",
		"last time",
		"previous session",
		"previous work",
		"where were we",
		"catch me up",
		"catch up",
	]) {
		if (lowered.includes(phrase)) return true;
	}
	return false;
}

function recallQueryWantsTimeline(query: string, options: { automatic: boolean }): boolean {
	// Automatic recall keeps retrieved facts, but must not add unrelated neighbors.
	if (options.automatic) return false;
	const lowered = query.toLowerCase();
	for (const phrase of [
		"what did we do",
		"what did we work on",
		"what did we decide",
		"what happened",
		"last time",
		"previous session",
		"previous work",
		"where were we",
		"catch me up",
		"catch up",
	]) {
		if (lowered.includes(phrase)) return true;
	}
	return false;
}

function prioritizeDefaultResults(
	results: MemoryResult[],
	limit: number,
	query: string,
): MemoryResult[] {
	const preferSummary = queryPrefersRecap(query);
	if (preferSummary) return results.slice(0, limit);
	// Keep the intentional recap demotion, preserving retrieval order within each group.
	return [...results]
		.sort((a, b) => Number(memoryLooksRecapLike(a)) - Number(memoryLooksRecapLike(b)))
		.slice(0, limit);
}

function toMemoryResult(row: MemoryItemResponse | TimelineItemResponse): MemoryResult {
	return {
		id: row.id,
		kind: canonicalMemoryKind(row.kind, row.metadata_json),
		title: row.title,
		body_text: row.body_text,
		confidence: row.confidence ?? 0,
		created_at: row.created_at,
		updated_at: row.updated_at,
		tags_text: row.tags_text ?? "",
		score: 0,
		session_id: row.session_id,
		metadata: row.metadata_json,
		narrative: row.narrative ?? null,
		facts: row.facts ?? null,
	};
}

function parseCreatedAt(value: string): number {
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return Number.NEGATIVE_INFINITY;
	return parsed;
}

function filterRecentResults(results: MemoryResult[], days: number): MemoryResult[] {
	const cutoff = Date.now() - days * 86_400_000;
	return results.filter((item) => parseCreatedAt(item.created_at) >= cutoff);
}

function prioritizeTaskFallback(results: MemoryResult[], limit: number): MemoryResult[] {
	const ordered = [...results].sort((a, b) =>
		(b.created_at ?? "").localeCompare(a.created_at ?? ""),
	);
	ordered.sort((a, b) => {
		const taskLikeDelta = Number(itemLooksTaskLike(b)) - Number(itemLooksTaskLike(a));
		if (taskLikeDelta !== 0) return taskLikeDelta;
		const rank = (kind: string): number => {
			if (kind === "note") return 0;
			if (kind === "decision") return 1;
			if (kind === "observation") return 2;
			return 3;
		};
		return rank(a.kind) - rank(b.kind);
	});
	return ordered.slice(0, limit);
}

function prioritizeRecallResults(
	results: MemoryResult[],
	limit: number,
	options: { preferSummary: boolean },
): MemoryResult[] {
	return [...results]
		.sort((a, b) => {
			if (options.preferSummary) return Number(isSummaryLike(b)) - Number(isSummaryLike(a));
			return Number(memoryLooksRecapLike(a)) - Number(memoryLooksRecapLike(b));
		})
		.slice(0, limit);
}

type RecentEligibility = {
	eligible: (item: MemoryResult) => boolean;
	summarySessionId: number | null | undefined;
};

const RECENT_UNRESTRICTED: RecentEligibility = {
	eligible: () => true,
	summarySessionId: undefined,
};

// Continuity is enforced inside the recent query so LIMIT counts eligible rows;
// the predicate remains as a defensive check rather than an OFFSET paging loop.
function recentEligible(
	store: StoreHandle,
	target: number,
	filters: MemoryFilters | undefined,
	eligibility: RecentEligibility,
	kinds?: string[],
): MemoryResult[] {
	const rows = kinds
		? store.recentByKinds(kinds, target, filters ?? null, 0, eligibility.summarySessionId)
		: store.recent(target, filters ?? null, 0, eligibility.summarySessionId);
	return rows.map(toMemoryResult).filter(eligibility.eligible);
}

function taskFallbackRecent(
	store: StoreHandle,
	limit: number,
	filters?: MemoryFilters,
	eligibility: RecentEligibility = RECENT_UNRESTRICTED,
): MemoryResult[] {
	const expandedLimit = limit * 3;
	return prioritizeTaskFallback(recentEligible(store, expandedLimit, filters, eligibility), limit);
}

function recallFallbackRecent(
	store: StoreHandle,
	limit: number,
	filters?: MemoryFilters,
	eligibility: RecentEligibility = RECENT_UNRESTRICTED,
): MemoryResult[] {
	const expandedLimit = limit * 4;
	const recentAll = recentEligible(store, expandedLimit, filters, eligibility);
	const summaries = recentAll.filter(isSummaryLike).slice(0, limit);
	if (summaries.length >= limit) return summaries.slice(0, limit);

	const summaryIds = new Set(summaries.map((item) => item.id));
	const remainder = recentAll.filter((item) => !summaryIds.has(item.id));
	const prioritized = prioritizeTaskFallback(remainder, limit - summaries.length);
	return [...summaries, ...prioritized];
}
function parseNonNegativeInt(value: unknown): number | null {
	if (value == null || typeof value === "boolean") return null;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return null;
	const intValue = Math.trunc(parsed);
	if (intValue < 0) return null;
	return intValue;
}

function dedupePositiveIds(values: unknown[]): number[] {
	const deduped: number[] = [];
	const seen = new Set<number>();
	for (const raw of values) {
		const parsed = parseNonNegativeInt(raw);
		if (parsed == null || parsed <= 0 || seen.has(parsed)) continue;
		seen.add(parsed);
		deduped.push(parsed);
	}
	return deduped;
}

function coercePackItemIds(value: unknown): { ids: number[]; valid: boolean } {
	if (!Array.isArray(value)) return { ids: [], valid: false };
	for (const raw of value) {
		if (raw == null || typeof raw === "boolean") return { ids: [], valid: false };
	}
	return { ids: dedupePositiveIds(value), valid: true };
}

function parseMetadataObject(value: unknown): Record<string, unknown> {
	return getSummaryMetadata(value);
}

function validatePackDeltaBaselineIds(
	store: StoreHandle,
	ids: number[],
	filters: MemoryFilters | null,
	summarySessionId: number | null | undefined,
): number[] | null {
	if (ids.length === 0) return null;
	const filterResult = buildFilterClausesWithContext(filters, ownershipFilterContext(store));
	const continuity = summaryContinuityFilter(summarySessionId);
	const placeholders = ids.map(() => "?").join(", ");
	const joinClause = filterResult.joinSessions
		? "JOIN sessions ON sessions.id = memory_items.session_id"
		: "";
	const whereParts = [
		"memory_items.active = 1",
		`memory_items.id IN (${placeholders})`,
		...filterResult.clauses,
		...continuity.clauses,
	];
	const rows = store.db
		.prepare(
			`SELECT memory_items.id
			 FROM memory_items
			 ${joinClause}
			 WHERE ${whereParts.join(" AND ")}`,
		)
		.all(...ids, ...filterResult.params, ...continuity.params) as Array<{ id: number }>;
	const visibleIds = new Set(rows.map((row) => row.id));
	if (visibleIds.size !== ids.length) return null;
	return ids.filter((id) => visibleIds.has(id));
}

function isSummaryLike(item: Pick<MemoryResult, "kind" | "metadata">): boolean {
	return isSummaryLikeMemory(item);
}

type AutomaticContinuity = {
	requested: boolean;
	sessionId: number | null;
};

function resolveAutomaticContinuity(
	store: StoreHandle,
	automaticContext?: AutomaticContext | null,
): AutomaticContinuity {
	if (automaticContext === undefined) return { requested: false, sessionId: null };
	if (automaticContext === null) return { requested: true, sessionId: null };
	const source = automaticContext.source.trim().toLowerCase();
	const hostSessionId = automaticContext.hostSessionId.trim();
	// The ledger's "unknown" placeholder is never a requester identity, even if a
	// row with that stream ID exists.
	if (!source || !hostSessionId || hostSessionId.toLowerCase() === "unknown") {
		return { requested: true, sessionId: null };
	}
	const row = store.db
		.prepare(
			`SELECT session_id
			 FROM opencode_sessions
			 WHERE source = ? AND stream_id = ?
			 LIMIT 1`,
		)
		.get(source, hostSessionId) as { session_id: number | null } | undefined;
	return { requested: true, sessionId: row?.session_id ?? null };
}

function automaticEligible(continuity: AutomaticContinuity, item: MemoryResult): boolean {
	if (!continuity.requested || !isSummaryLike(item)) return true;
	return continuity.sessionId != null && item.session_id === continuity.sessionId;
}

function automaticSummarySessionId(
	store: StoreHandle,
	automaticContext?: AutomaticContext | null,
): number | null | undefined {
	const continuity = resolveAutomaticContinuity(store, automaticContext);
	return continuity.requested ? continuity.sessionId : undefined;
}

function findLatestSummaryLike(
	store: StoreHandle,
	filters: MemoryFilters | undefined,
	continuity: AutomaticContinuity,
): MemoryResult | null {
	if (continuity.requested && continuity.sessionId == null) return null;
	const filterResult = buildFilterClausesWithContext(
		filters ?? null,
		ownershipFilterContext(store),
	);
	const whereParts = [
		"memory_items.active = 1",
		summaryLikeSqlPredicate(),
		...(continuity.requested ? ["memory_items.session_id = ?"] : []),
		...filterResult.clauses,
	];
	const joinClause = filterResult.joinSessions
		? "JOIN sessions ON sessions.id = memory_items.session_id"
		: "";
	const row = store.db
		.prepare(
			`SELECT memory_items.*
			 FROM memory_items
			 ${joinClause}
			 WHERE ${whereParts.join(" AND ")}
			 ORDER BY memory_items.created_at DESC, memory_items.id DESC
			 LIMIT 1`,
		)
		.get(
			...(continuity.requested ? [continuity.sessionId] : []),
			...filterResult.params,
		) as MemoryItemResponse | null;
	return row ? toMemoryResult(row) : null;
}

function getPackDeltaBaseline(
	store: StoreHandle,
	filters: MemoryFilters | null,
	summarySessionId: number | null | undefined,
): { previousPackIds: number[] | null; previousPackTokens: number | null } {
	const project = filters?.project ?? null;
	const projectBase = project ? projectBasename(project) : null;
	const metaProjectExpr =
		"CASE WHEN json_valid(metadata_json) = 1 THEN json_extract(metadata_json, '$.project') ELSE NULL END";
	let offset = 0;
	while (offset < MAX_PACK_BASELINE_SCAN_ROWS) {
		const batchLimit = Math.min(PACK_BASELINE_BATCH_SIZE, MAX_PACK_BASELINE_SCAN_ROWS - offset);
		const rows = project
			? (store.db
					.prepare(
						`SELECT metadata_json, tokens_read
						 FROM usage_events
						 WHERE event = 'pack'
						   AND (${metaProjectExpr} = ? OR ${metaProjectExpr} = ?)
						 ORDER BY created_at DESC
						 LIMIT ? OFFSET ?`,
					)
					.all(project, projectBase ?? project, batchLimit, offset) as PackUsageBaselineRow[])
			: (store.db
					.prepare(
						`SELECT metadata_json, tokens_read
						 FROM usage_events
						 WHERE event = 'pack'
						 ORDER BY created_at DESC
						 LIMIT ? OFFSET ?`,
					)
					.all(batchLimit, offset) as PackUsageBaselineRow[]);
		if (rows.length === 0) break;

		for (const row of rows) {
			const metadata = parseMetadataObject(row.metadata_json);
			if (project != null) {
				const rowProject = typeof metadata.project === "string" ? metadata.project : null;
				if (rowProject !== project && rowProject !== projectBase) continue;
			}
			if (!("pack_item_ids" in metadata)) continue;

			const { ids, valid } = coercePackItemIds(metadata.pack_item_ids);
			if (!valid) continue;
			const scopedIds = validatePackDeltaBaselineIds(store, ids, filters, summarySessionId);
			if (scopedIds == null) continue;

			const previousTokens =
				parseNonNegativeInt(metadata.pack_tokens) ?? parseNonNegativeInt(row.tokens_read);
			if (previousTokens == null) continue;

			return { previousPackIds: scopedIds, previousPackTokens: previousTokens };
		}

		offset += rows.length;
	}

	return { previousPackIds: null, previousPackTokens: null };
}

function resolveUsageSessionId(store: StoreHandle, project: string | null): number | null {
	if (!project) return null;
	const projectBase = projectBasename(project);
	const row = store.db
		.prepare(
			`SELECT id
			 FROM sessions
			 WHERE project = ? OR project = ?
			 ORDER BY started_at DESC, id DESC
			 LIMIT 1`,
		)
		.get(project, projectBase) as { id: number } | undefined;
	return row?.id ?? null;
}

function estimateWorkTokens(item: MemoryResult): number {
	const metadata = parseMetadataObject(item.metadata);
	const known = parseNonNegativeInt(metadata.discovery_tokens);
	if (known != null) return known;
	return Math.max(2000, estimateTokens(`${item.title} ${item.body_text}`.trim()));
}

function discoveryGroup(item: MemoryResult): string {
	const metadata = parseMetadataObject(item.metadata);
	const group = metadata.discovery_group;
	if (typeof group === "string" && group.trim().length > 0) return group.trim();
	return `memory:${item.id}`;
}

function avoidedWorkTokens(item: MemoryResult): { tokens: number; source: string } {
	const metadata = parseMetadataObject(item.metadata);
	const tokens = parseNonNegativeInt(metadata.discovery_tokens);
	if (tokens != null && tokens > 0) {
		const source =
			typeof metadata.discovery_source === "string" && metadata.discovery_source
				? metadata.discovery_source
				: "known";
		return { tokens, source };
	}
	return { tokens: 0, source: "unknown" };
}

function workSource(item: MemoryResult): "usage" | "estimate" {
	const metadata = parseMetadataObject(item.metadata);
	return metadata.discovery_source === "usage" ? "usage" : "estimate";
}

function recordPackUsage(store: StoreHandle, metrics: Record<string, unknown>): void {
	const now = new Date().toISOString();
	const tokensRead = parseNonNegativeInt(metrics.pack_tokens) ?? 0;
	const tokensSaved = parseNonNegativeInt(metrics.tokens_saved) ?? 0;
	const project = typeof metrics.project === "string" ? metrics.project : null;
	const sessionId = resolveUsageSessionId(store, project);
	try {
		store.db
			.prepare(
				`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
				 VALUES (?, 'pack', ?, 0, ?, ?, ?)`,
			)
			.run(
				sessionId,
				tokensRead,
				tokensSaved,
				now,
				JSON.stringify({
					...metrics,
					token_usage: {
						unit: "tokens",
						source: "estimate",
						input_direction: "pack_injected",
						output_direction: null,
						attempt_count: 1,
					},
				}),
			);
	} catch {
		// Non-fatal for pack building path
	}
}
// ---------------------------------------------------------------------------
// buildMemoryPack
// ---------------------------------------------------------------------------

/**
 * Build a memory pack: a formatted, categorized summary of memories
 * matching a given context string.
 *
 * Flow:
 * 1. Search for memories matching `context`
 * 2. Separate into summary / timeline / observations sections
 * 3. Fall back to recent() if search returns nothing
 * 4. Apply token budget (truncate items if budget exceeded)
 * 5. Format sections into pack_text
 */
/**
 * Fuse eligible channel ranks, retaining raw scores for diagnostics.
 */
function mergeResults(
	store: StoreHandle,
	ftsResults: MemoryResult[],
	semanticResults: MemoryResult[],
	limit: number,
	query: string,
	filters?: MemoryFilters,
	eligible: (item: MemoryResult) => boolean = () => true,
): {
	merged: MemoryResult[];
	candidates: MemoryResult[];
	semanticCandidates: MemoryResult[];
	ftsCount: number;
	semanticCount: number;
	fusion: Map<number, PackFusionEvidence>;
} {
	const scopedSemanticResults = rehydrateScopedCandidateResults(
		store,
		semanticResults,
		filters,
	).filter(eligible);
	const ftsIds = new Set(ftsResults.map((item) => item.id));
	// FTS candidates already passed eligibility in retrieval.search -> searchOnce.
	const semanticCount = scopedSemanticResults.filter((item) => !ftsIds.has(item.id)).length;
	const referenceNow = new Date();
	const ownership =
		store.buildOwnershipPredicate?.() ?? ((item: MemoryResult) => store.memoryOwnedBySelf(item));
	const ranked = fusePackCandidates(
		ftsResults,
		scopedSemanticResults,
		(item) =>
			scoreResult(store, { ...item, score: 0 }, filters, query, referenceNow, ownership)
				.combined_score ?? 0,
	);
	const hybrid =
		ranked.some(({ evidence }) => evidence.fts_rank != null) &&
		ranked.some(({ evidence }) => evidence.semantic_rank != null);
	const candidates = hybrid
		? ranked.map(({ item }) => item)
		: [...ftsResults, ...scopedSemanticResults];
	const merged = hybrid
		? candidates.slice(0, limit)
		: rerankResults(store, candidates, limit, filters, query);
	return {
		fusion: new Map(hybrid ? ranked.map(({ item, evidence }) => [item.id, evidence]) : []),
		merged,
		candidates,
		semanticCandidates: scopedSemanticResults,
		ftsCount: ftsResults.length,
		semanticCount,
	};
}

function validCandidateResultsById(candidates: MemoryResult[]): Map<number, MemoryResult> {
	const originalById = new Map<number, MemoryResult>();
	for (const item of candidates) {
		if (!Number.isSafeInteger(item.id) || item.id <= 0) continue;
		if (!Number.isFinite(item.score)) continue;
		const original = originalById.get(item.id);
		if (!original || item.score > original.score) originalById.set(item.id, item);
	}
	return originalById;
}

function rehydrateScopedCandidateResults(
	store: StoreHandle,
	candidates: MemoryResult[],
	filters?: MemoryFilters,
): MemoryResult[] {
	const originalById = validCandidateResultsById(candidates);
	const ids = [...originalById.keys()];
	if (ids.length === 0) return [];

	const filterResult = buildFilterClausesWithContext(
		filters ?? null,
		ownershipFilterContext(store),
	);
	const joinClause = filterResult.joinSessions
		? "JOIN sessions ON sessions.id = memory_items.session_id"
		: "";
	const scopedById = new Map<number, MemoryResult>();
	for (let offset = 0; offset < ids.length; offset += MAX_SEMANTIC_REVALIDATION_IDS) {
		const chunkIds = ids.slice(offset, offset + MAX_SEMANTIC_REVALIDATION_IDS);
		const placeholders = chunkIds.map(() => "?").join(", ");
		const rows = store.db
			.prepare(
				`SELECT memory_items.*
				 FROM memory_items
				 ${joinClause}
				 WHERE ${["memory_items.active = 1", `memory_items.id IN (${placeholders})`, ...filterResult.clauses].join(" AND ")}`,
			)
			.all(...chunkIds, ...filterResult.params) as Array<Record<string, unknown>>;

		for (const row of rows) {
			const id = Number(row.id);
			const original = originalById.get(id);
			if (!original) continue;
			const preserveFilteredKind =
				typeof filters?.kind === "string" && filters.kind.trim().length > 0;
			scopedById.set(
				id,
				rowToMemoryResult({ ...row, score: original.score }, preserveFilteredKind),
			);
		}
	}

	return ids.map((id) => scopedById.get(id)).filter((item): item is MemoryResult => !!item);
}

/**
 * Merge candidates discovered via the file-ref index into an existing result
 * set.  Returns the original array unchanged when no working-set paths are
 * provided or no new candidates are found.
 */
function mergeFileRefCandidates(
	store: StoreHandle,
	results: MemoryResult[],
	filters: MemoryFilters | undefined,
	effectiveLimit: number,
	summarySessionId?: number | null,
): MemoryResult[] {
	const workingSetPaths = filters?.working_set_paths;
	if (!workingSetPaths || !Array.isArray(workingSetPaths) || workingSetPaths.length === 0) {
		return results;
	}
	const validPaths = workingSetPaths.filter(
		(p): p is string => typeof p === "string" && p.length > 0,
	);
	if (validPaths.length === 0) return results;
	const existingIds = new Set(results.map((r) => r.id));
	const refCandidateIds = validPaths.flatMap((path) =>
		findByFile(store.db, path, {
			limit: effectiveLimit,
			project: filters?.project,
			relation: "modified",
			summarySessionId,
		}).map((row) => row.id),
	);
	const newIds = refCandidateIds.filter((id) => !existingIds.has(id));
	if (newIds.length === 0) return results;
	const refMemories = rehydrateScopedCandidateResults(
		store,
		newIds.map((id) => ({
			id,
			kind: "discovery",
			title: "",
			body_text: "",
			confidence: 0,
			created_at: "",
			updated_at: "",
			tags_text: "",
			score: 0,
			session_id: 0,
			metadata: {},
			narrative: null,
			facts: null,
		})),
		filters,
	);
	return [...results, ...refMemories];
}

function createPackRetrieval(
	store: StoreHandle,
	options: {
		limit: number;
		filters?: MemoryFilters;
		eligible: (item: MemoryResult) => boolean;
		summarySessionId?: number | null;
		requireKeywordSupport: boolean;
	},
) {
	const { limit, filters, eligible, summarySessionId } = options;
	// Each mutually exclusive pack mode merges at most once, so IDs identify
	// evidence from one fusion pass; this map is not a multi-query accumulator.
	const fusion = new Map<number, PackFusionEvidence>();
	const rejectedSemanticIds = new Set<number>();
	return {
		fusion,
		rejectedSemanticIds,
		search: (query: string) => search(store, query, limit, filters, eligible, summarySessionId),
		merge: (results: MemoryResult[], semantic: MemoryResult[], query: string) => {
			const merged = mergeResults(store, results, semantic, limit, query, filters, eligible);
			for (const [id, evidence] of merged.fusion) fusion.set(id, evidence);
			// Nearest neighbors have no calibrated confidence cutoff. Reject the batch
			// on automatic non-task misses, accepting paraphrase false negatives.
			if (options.requireKeywordSupport && results.length === 0) {
				for (const item of merged.semanticCandidates) rejectedSemanticIds.add(item.id);
				return { ...merged, merged: [], semanticCount: 0 };
			}
			return merged;
		},
		fileRefs: (results: MemoryResult[]) =>
			mergeFileRefCandidates(store, results, filters, limit, summarySessionId).filter(eligible),
	};
}

function withFusionScores(
	scores: ReturnType<typeof scoreResult>,
	fusion: PackFusionEvidence | undefined,
): ReturnType<typeof scoreResult> {
	if (!fusion) return scores;
	// Keep the legacy diagnostic calculation; fusion alone supplies the hybrid key.
	return { ...scores, fusion };
}

type PackCandidateExposure = { item: MemoryResult; query: string };
type PackRetrieval = ReturnType<typeof createPackRetrieval>;

interface PackRetrievalStage {
	effectiveLimit: number;
	continuity: AutomaticContinuity;
	eligible: (item: MemoryResult) => boolean;
	summarySessionId: number | null | undefined;
	recentEligibility: RecentEligibility;
	sanitized: ReturnType<typeof sanitizeSearchQuery>;
	retrievalContext: string;
	taskMode: boolean;
	recallMode: boolean;
	allowUnrelatedFallback: boolean;
	retrieval: PackRetrieval;
	fallbackUsed: boolean;
	ftsCount: number;
	semanticCount: number;
	retrievalQuery: string;
	results: MemoryResult[];
	candidateExposures: PackCandidateExposure[];
}

function exposePackCandidates(
	query: string,
	...candidateSets: readonly (readonly MemoryResult[])[]
): PackCandidateExposure[] {
	return candidateSets.flatMap((candidates) => candidates.map((item) => ({ item, query })));
}

function dedupePackCandidateExposures(
	exposures: readonly PackCandidateExposure[],
): PackCandidateExposure[] {
	const seen = new Set<number>();
	return exposures.filter(({ item }) => {
		if (seen.has(item.id)) return false;
		seen.add(item.id);
		return true;
	});
}

interface PackRetrievalInputs {
	store: StoreHandle;
	filters: MemoryFilters | undefined;
	semanticResults: MemoryResult[] | undefined;
	effectiveLimit: number;
	continuity: AutomaticContinuity;
	eligible: (item: MemoryResult) => boolean;
	summarySessionId: number | null | undefined;
	recentEligibility: RecentEligibility;
	retrievalContext: string;
	allowUnrelatedFallback: boolean;
	retrieval: PackRetrieval;
}

interface PackModeRetrieval {
	fallbackUsed: boolean;
	ftsCount: number;
	semanticCount: number;
	retrievalQuery: string;
	results: MemoryResult[];
	candidateExposures: PackCandidateExposure[];
}

function retrieveTaskPackCandidates(inputs: PackRetrievalInputs): PackModeRetrieval {
	const taskQuery = `${inputs.retrievalContext} ${TASK_HINT_QUERY}`.trim();
	const candidateExposures: PackCandidateExposure[] = [];
	let taskResults = inputs.retrieval.search(taskQuery);
	const ftsCount = taskResults.length;
	let semanticCount = 0;
	if (inputs.semanticResults && inputs.semanticResults.length > 0) {
		candidateExposures.push(...exposePackCandidates(taskQuery, taskResults));
		const merge = inputs.retrieval.merge(taskResults, inputs.semanticResults, taskQuery);
		taskResults = merge.merged;
		semanticCount = merge.semanticCount;
		candidateExposures.push(
			...exposePackCandidates(inputs.retrievalContext, merge.semanticCandidates),
		);
	}
	taskResults = inputs.retrieval.fileRefs(taskResults);
	candidateExposures.push(...exposePackCandidates(taskQuery, taskResults));
	if (taskResults.length === 0) {
		const results = taskFallbackRecent(
			inputs.store,
			inputs.effectiveLimit,
			inputs.filters,
			inputs.recentEligibility,
		);
		candidateExposures.push(...exposePackCandidates(taskQuery, results));
		return {
			fallbackUsed: true,
			ftsCount,
			semanticCount,
			retrievalQuery: taskQuery,
			results,
			candidateExposures,
		};
	}

	const actionableTaskResults = taskResults.filter((item) => !isSummaryLike(item));
	const recentTaskResults = filterRecentResults(
		actionableTaskResults.length > 0 ? actionableTaskResults : taskResults,
		TASK_RECENCY_DAYS,
	);
	let results = taskResults;
	if (actionableTaskResults.length > 0) results = actionableTaskResults;
	if (recentTaskResults.length > 0) results = recentTaskResults;
	return {
		fallbackUsed: false,
		ftsCount,
		semanticCount,
		retrievalQuery: taskQuery,
		results: results.slice(0, inputs.effectiveLimit),
		candidateExposures,
	};
}

function retrieveTopicalRecallCandidates(
	inputs: PackRetrievalInputs,
	recallQuery: string,
	preferSummary: boolean,
): {
	recallResults: MemoryResult[];
	ftsCount: number;
	retrievalQuery: string;
	candidateExposures: PackCandidateExposure[];
} {
	const candidateExposures: PackCandidateExposure[] = [];
	let recallResults = inputs.retrieval.search(recallQuery);
	let ftsCount = recallResults.length;
	let retrievalQuery = recallQuery;
	candidateExposures.push(...exposePackCandidates(recallQuery, recallResults));
	const topicalRecallQuery = [...queryContentTokens(recallQuery)].join(" ");
	if (preferSummary || !topicalRecallQuery) {
		return { recallResults, ftsCount, retrievalQuery, candidateExposures };
	}
	const needsTopicalRetry =
		recallResults.length === 0 ||
		recallResults.every(
			(item) => isSummaryLike(item) || textOverlapScore(item, topicalRecallQuery) === 0,
		);
	if (!needsTopicalRetry) {
		return { recallResults, ftsCount, retrievalQuery, candidateExposures };
	}
	const topicalResults = inputs.retrieval.search(topicalRecallQuery);
	candidateExposures.push(...exposePackCandidates(topicalRecallQuery, topicalResults));
	if (topicalResults.length > 0) {
		recallResults = topicalResults;
		ftsCount = topicalResults.length;
		retrievalQuery = topicalRecallQuery;
	}
	return { recallResults, ftsCount, retrievalQuery, candidateExposures };
}

function retrieveRecallTimeline(
	inputs: PackRetrievalInputs,
	results: MemoryResult[],
	preferSummary: boolean,
	wantsTimeline: boolean,
): MemoryResult[] | null {
	if (!wantsTimeline) return null;
	const anchor = preferSummary
		? results[0]
		: (results.find((item) => !isSummaryLike(item)) ?? results[0]);
	if (anchor == null) return null;
	const depthBefore = Math.max(0, Math.floor(inputs.effectiveLimit / 2));
	const depthAfter = Math.max(0, inputs.effectiveLimit - depthBefore - 1);
	const timelineRows = timeline(
		inputs.store,
		undefined,
		anchor.id,
		depthBefore,
		depthAfter,
		inputs.filters ?? null,
		inputs.summarySessionId,
	);
	if (timelineRows.length === 0) return null;
	return timelineRows.map(toMemoryResult).filter(inputs.eligible);
}

function retrieveRecallPackCandidates(inputs: PackRetrievalInputs): PackModeRetrieval {
	const recallQuery =
		inputs.retrievalContext.trim().length > 0 ? inputs.retrievalContext : RECALL_HINT_QUERY;
	const preferSummary = queryPrefersRecap(recallQuery);
	const wantsTimeline = recallQueryWantsTimeline(recallQuery, {
		automatic: inputs.continuity.requested,
	});
	const topical = retrieveTopicalRecallCandidates(inputs, recallQuery, preferSummary);
	let { recallResults, ftsCount, retrievalQuery } = topical;
	const candidateExposures = [...topical.candidateExposures];
	if (recallResults.length === 0 && inputs.allowUnrelatedFallback) {
		const hintResults = inputs.retrieval.search(RECALL_HINT_QUERY);
		candidateExposures.push(...exposePackCandidates(RECALL_HINT_QUERY, hintResults));
		recallResults = hintResults.filter(isSummaryLike);
		ftsCount = recallResults.length;
		retrievalQuery = RECALL_HINT_QUERY;
	}
	let semanticCount = 0;
	if (inputs.semanticResults && inputs.semanticResults.length > 0) {
		const merge = inputs.retrieval.merge(recallResults, inputs.semanticResults, recallQuery);
		recallResults = merge.merged;
		semanticCount = merge.semanticCount;
		candidateExposures.push(
			...exposePackCandidates(inputs.retrievalContext, merge.semanticCandidates),
		);
	}
	recallResults = inputs.retrieval.fileRefs(recallResults);
	candidateExposures.push(...exposePackCandidates(retrievalQuery, recallResults));
	let results = prioritizeRecallResults(recallResults, inputs.effectiveLimit, { preferSummary });
	let fallbackUsed = false;
	if (results.length === 0 && inputs.allowUnrelatedFallback) {
		fallbackUsed = true;
		results = recallFallbackRecent(
			inputs.store,
			inputs.effectiveLimit,
			inputs.filters,
			inputs.recentEligibility,
		);
		candidateExposures.push(...exposePackCandidates(retrievalQuery, results));
	}
	const timelineResults = retrieveRecallTimeline(inputs, results, preferSummary, wantsTimeline);
	if (timelineResults != null) {
		candidateExposures.push(...exposePackCandidates(retrievalQuery, timelineResults));
		results = timelineResults;
	}
	return {
		fallbackUsed,
		ftsCount,
		semanticCount,
		retrievalQuery,
		results,
		candidateExposures,
	};
}

function retrieveDefaultPackCandidates(inputs: PackRetrievalInputs): PackModeRetrieval {
	const ftsResults = inputs.retrieval.search(inputs.retrievalContext);
	const candidateExposures: PackCandidateExposure[] = [];
	let ftsCount: number;
	let semanticCount = 0;
	let results: MemoryResult[];
	if (inputs.semanticResults && inputs.semanticResults.length > 0) {
		const merge = inputs.retrieval.merge(
			ftsResults,
			inputs.semanticResults,
			inputs.retrievalContext,
		);
		results = prioritizeDefaultResults(
			merge.merged,
			inputs.effectiveLimit,
			inputs.retrievalContext,
		);
		ftsCount = merge.ftsCount;
		semanticCount = merge.semanticCount;
		candidateExposures.push(...exposePackCandidates(inputs.retrievalContext, merge.candidates));
	} else {
		results = prioritizeDefaultResults(ftsResults, inputs.effectiveLimit, inputs.retrievalContext);
		ftsCount = results.length;
		candidateExposures.push(...exposePackCandidates(inputs.retrievalContext, ftsResults));
	}
	results = inputs.retrieval.fileRefs(results);
	candidateExposures.push(...exposePackCandidates(inputs.retrievalContext, results));
	results = prioritizeDefaultResults(results, inputs.effectiveLimit, inputs.retrievalContext);
	if (results.length > 0 || !inputs.allowUnrelatedFallback) {
		return {
			fallbackUsed: false,
			ftsCount,
			semanticCount,
			retrievalQuery: inputs.retrievalContext,
			results,
			candidateExposures,
		};
	}
	results = recentEligible(
		inputs.store,
		inputs.effectiveLimit,
		inputs.filters,
		inputs.recentEligibility,
	);
	candidateExposures.push(...exposePackCandidates(inputs.retrievalContext, results));
	return {
		fallbackUsed: true,
		ftsCount,
		semanticCount,
		retrievalQuery: inputs.retrievalContext,
		results,
		candidateExposures,
	};
}

function retrievePackCandidates(
	store: StoreHandle,
	context: string,
	limit: number,
	filters: MemoryFilters | undefined,
	semanticResults: MemoryResult[] | undefined,
	automaticContext: AutomaticContext | null | undefined,
): PackRetrievalStage {
	const effectiveLimit = Math.max(1, Math.trunc(limit));
	const continuity = resolveAutomaticContinuity(store, automaticContext);
	const eligible = (item: MemoryResult) => automaticEligible(continuity, item);
	const summarySessionId = continuity.requested ? continuity.sessionId : undefined;
	const recentEligibility: RecentEligibility = { eligible, summarySessionId };
	const sanitized = sanitizeSearchQuery(context);
	const retrievalContext = sanitized.clean_query;
	const taskMode = queryLooksLikeTasks(taskIntentQuery(retrievalContext, filters));
	const recallMode = !taskMode && queryLooksLikeRecall(retrievalContext);
	const allowUnrelatedFallback = !continuity.requested || taskMode;
	const retrieval = createPackRetrieval(store, {
		limit: effectiveLimit,
		filters,
		eligible,
		summarySessionId,
		requireKeywordSupport: continuity.requested && !taskMode,
	});
	const inputs: PackRetrievalInputs = {
		store,
		filters,
		semanticResults,
		effectiveLimit,
		continuity,
		eligible,
		summarySessionId,
		recentEligibility,
		retrievalContext,
		allowUnrelatedFallback,
		retrieval,
	};
	let modeRetrieval: PackModeRetrieval;
	if (taskMode) modeRetrieval = retrieveTaskPackCandidates(inputs);
	else if (recallMode) modeRetrieval = retrieveRecallPackCandidates(inputs);
	else modeRetrieval = retrieveDefaultPackCandidates(inputs);

	return {
		effectiveLimit,
		continuity,
		eligible,
		summarySessionId,
		recentEligibility,
		sanitized,
		retrievalContext,
		taskMode,
		recallMode,
		allowUnrelatedFallback,
		retrieval,
		...modeRetrieval,
	};
}

interface PackAssemblyStage {
	summaryItems: MemoryResult[];
	timelineItems: MemoryResult[];
	observationItems: MemoryResult[];
	dedupeState: DedupeState;
	clusterState: ClusterCompressionState;
	modeLabel: PackTraceMode;
	compact: boolean;
	compactDetailCount: number;
	compressionMode: PackCompressionMode;
	candidateExposures: PackCandidateExposure[];
}

function packTraceMode(retrieval: PackRetrievalStage): PackTraceMode {
	if (retrieval.taskMode) return "task";
	if (retrieval.recallMode) return "recall";
	return "default";
}

function summaryResult(item: ReturnType<typeof findLatestSummaryLike>): MemoryResult | null {
	if (item == null) return null;
	return {
		id: item.id,
		kind: item.kind,
		title: item.title,
		body_text: item.body_text,
		confidence: item.confidence ?? 0,
		created_at: item.created_at,
		updated_at: item.updated_at,
		tags_text: item.tags_text ?? "",
		score: 0,
		session_id: item.session_id,
		metadata: item.metadata,
		narrative: item.narrative,
		facts: item.facts,
	};
}

function assembleSummarySection(
	store: StoreHandle,
	filters: MemoryFilters | undefined,
	retrieval: PackRetrievalStage,
): { items: MemoryResult[]; candidateExposures: PackCandidateExposure[] } {
	const directMatches =
		retrieval.recallMode && !queryPrefersRecap(retrieval.retrievalContext)
			? retrieval.results.filter((item) => isNativeSessionSummaryMemory(item))
			: retrieval.results.filter(isSummaryLike);
	if (directMatches.length > 0) return { items: directMatches.slice(0, 1), candidateExposures: [] };
	const allowFallback =
		queryPrefersRecap(retrieval.retrievalContext) ||
		(retrieval.allowUnrelatedFallback && !retrieval.recallMode);
	if (!allowFallback) return { items: [], candidateExposures: [] };
	const fallback = summaryResult(findLatestSummaryLike(store, filters, retrieval.continuity));
	if (fallback == null) return { items: [], candidateExposures: [] };
	return {
		items: [fallback],
		candidateExposures: exposePackCandidates(retrieval.retrievalQuery, [fallback]),
	};
}

function assembleObservationSections(
	store: StoreHandle,
	context: string,
	filters: MemoryFilters | undefined,
	retrieval: PackRetrievalStage,
): {
	timelineItems: MemoryResult[];
	observationItems: MemoryResult[];
	candidateExposures: PackCandidateExposure[];
} {
	const timelineItems = retrieval.results.filter((item) => !isSummaryLike(item)).slice(0, 3);
	const timelineIds = new Set(timelineItems.map((item) => item.id));
	let observationItems = retrieval.results.filter(
		(item) => !isSummaryLike(item) && !timelineIds.has(item.id),
	);
	if (retrieval.recallMode && observationItems.length === 0) {
		observationItems = retrieval.results.filter((item) => !isSummaryLike(item));
	}
	if (observationItems.length > 0 || !retrieval.allowUnrelatedFallback) {
		if (observationItems.length === 0) observationItems = [...timelineItems];
		return { timelineItems, observationItems, candidateExposures: [] };
	}
	const recentObservations = recentEligible(
		store,
		Math.max(retrieval.effectiveLimit * 3, 10),
		filters,
		retrieval.recentEligibility,
		OBSERVATION_KINDS,
	);
	if (recentObservations.length === 0) {
		return { timelineItems, observationItems: [...timelineItems], candidateExposures: [] };
	}
	observationItems = sortByTagOverlap(recentObservations, context);
	return {
		timelineItems,
		observationItems,
		candidateExposures: exposePackCandidates(retrieval.retrievalQuery, observationItems),
	};
}

function dedupeAndCompressPackSections(
	summaryItems: MemoryResult[],
	timelineItems: MemoryResult[],
	observationItems: MemoryResult[],
	modeLabel: PackTraceMode,
	compressionMode: PackCompressionMode,
	compact: boolean,
): {
	summaryItems: MemoryResult[];
	timelineItems: MemoryResult[];
	observationItems: MemoryResult[];
	dedupeState: DedupeState;
	clusterState: ClusterCompressionState;
} {
	const dedupeState: DedupeState = {
		canonicalByKey: new Map(),
		duplicateIds: new Map(),
	};
	const dedupedSummary = collapseExactDuplicates(summaryItems, dedupeState);
	const dedupedTimeline = collapseExactDuplicates(timelineItems, dedupeState);
	const dedupedObservations = collapseExactDuplicates(observationItems, dedupeState);
	const clusterState: ClusterCompressionState = {
		compressedByRepresentative: new Map(),
		representativeByCompressedId: new Map(),
		clusters: [],
	};
	const compressRelated = compressionMode === "ids" || (compressionMode === "compact" && compact);
	if (compressRelated) {
		const compressionPool = [
			...new Map(
				[...dedupedSummary, ...dedupedTimeline, ...dedupedObservations].map((item) => [
					item.id,
					item,
				]),
			).values(),
		];
		compressClusters(compressionPool, modeLabel, clusterState);
	}
	const compressedIds = new Set(flattenCompressedIds(clusterState));
	return {
		summaryItems: dedupedSummary.filter((item) => !compressedIds.has(item.id)),
		timelineItems: dedupedTimeline.filter((item) => !compressedIds.has(item.id)),
		observationItems: dedupedObservations.filter((item) => !compressedIds.has(item.id)),
		dedupeState,
		clusterState,
	};
}

function assemblePackSections(
	store: StoreHandle,
	context: string,
	filters: MemoryFilters | undefined,
	retrieval: PackRetrievalStage,
	options: {
		compact?: boolean;
		compactDetailCount?: number;
		compressionMode?: PackCompressionMode;
	},
): PackAssemblyStage {
	const summary = assembleSummarySection(store, filters, retrieval);
	const observations = assembleObservationSections(store, context, filters, retrieval);
	const modeLabel = packTraceMode(retrieval);
	const compact = options.compact ?? false;
	const compactDetailCount = options.compactDetailCount ?? DEFAULT_COMPACT_DETAIL_COUNT;
	const compressionMode = resolvePackCompressionMode(options.compressionMode);
	const sections = dedupeAndCompressPackSections(
		summary.items,
		observations.timelineItems,
		observations.observationItems,
		modeLabel,
		compressionMode,
		compact,
	);

	return {
		...sections,
		modeLabel,
		compact,
		compactDetailCount,
		compressionMode,
		candidateExposures: [...summary.candidateExposures, ...observations.candidateExposures],
	};
}

interface PackRenderStage {
	budgetedSummary: MemoryResult[];
	budgetedTimeline: MemoryResult[];
	budgetedObservations: MemoryResult[];
	packText: string;
	packTokens: number;
	renderedItems: RenderedPackItem[];
}

function compactPackCandidates(assembly: PackAssemblyStage): MemoryResult[] {
	return [
		...new Map(
			[...assembly.summaryItems, ...assembly.timelineItems, ...assembly.observationItems].map(
				(item) => [item.id, item],
			),
		).values(),
	];
}

function budgetCompactPack(
	candidates: MemoryResult[],
	detailCount: number,
	clusterState: ClusterCompressionState,
	tokenBudget: number | null,
): { items: MemoryResult[]; detailIds: Set<number> } {
	if (tokenBudget == null || tokenBudget <= 0) {
		return {
			items: candidates,
			detailIds: new Set(candidates.slice(0, detailCount).map((item) => item.id)),
		};
	}
	const items: MemoryResult[] = [];
	const detailIds = new Set<number>();
	let detailSlots = detailCount;
	for (const item of candidates) {
		if (detailSlots > 0) {
			const nextDetailIds = new Set(detailIds).add(item.id);
			const detailedPack = renderCompactPack([...items, item], nextDetailIds, clusterState);
			if (fitsTokenBudget(detailedPack, tokenBudget)) {
				items.push(item);
				detailIds.add(item.id);
				detailSlots--;
				continue;
			}
		}
		const indexedPack = renderCompactPack([...items, item], detailIds, clusterState);
		if (fitsTokenBudget(indexedPack, tokenBudget)) items.push(item);
	}
	return { items, detailIds };
}

function renderCompactPackSections(
	assembly: PackAssemblyStage,
	tokenBudget: number | null,
): PackRenderStage {
	const budgeted = budgetCompactPack(
		compactPackCandidates(assembly),
		assembly.compactDetailCount,
		assembly.clusterState,
		tokenBudget,
	);
	const renderedItems: RenderedPackItem[] = [];
	const packText = enforceTokenBudget(
		renderCompactPack(budgeted.items, budgeted.detailIds, assembly.clusterState, renderedItems),
		tokenBudget,
	);
	return {
		budgetedSummary: [],
		budgetedTimeline: budgeted.items,
		budgetedObservations: [],
		packText,
		packTokens: estimateTokens(packText),
		renderedItems,
	};
}

function renderStandardPackSections(
	assembly: PackAssemblyStage,
	tokenBudget: number | null,
): PackRenderStage {
	let budgetedSummary = assembly.summaryItems;
	let budgetedTimeline = assembly.timelineItems;
	let budgetedObservations = assembly.observationItems;
	if (tokenBudget != null && tokenBudget > 0) {
		[budgetedSummary, budgetedTimeline, budgetedObservations] = budgetStandardPack(
			assembly.summaryItems,
			assembly.timelineItems,
			assembly.observationItems,
			assembly.clusterState,
			{ tokenBudget, includeRelatedIds: assembly.compressionMode === "ids" },
		);
	}
	const renderedItems: RenderedPackItem[] = [];
	const packText = enforceTokenBudget(
		renderStandardPack(
			budgetedSummary,
			budgetedTimeline,
			budgetedObservations,
			assembly.clusterState,
			{ includeRelatedIds: assembly.compressionMode === "ids" },
			renderedItems,
		),
		tokenBudget,
	);
	return {
		budgetedSummary,
		budgetedTimeline,
		budgetedObservations,
		packText,
		packTokens: estimateTokens(packText),
		renderedItems,
	};
}

function renderPackSections(
	assembly: PackAssemblyStage,
	tokenBudget: number | null,
): PackRenderStage {
	if (assembly.compact) return renderCompactPackSections(assembly, tokenBudget);
	return renderStandardPackSections(assembly, tokenBudget);
}

interface PackSelectionStage {
	selectedItems: MemoryResult[];
	allItemIds: number[];
	allItems: PackItem[];
}

function selectedPackItemsById(render: PackRenderStage): Map<number, MemoryResult> {
	const selectedById = new Map<number, MemoryResult>();
	for (const item of [
		...render.budgetedSummary,
		...render.budgetedTimeline,
		...render.budgetedObservations,
	]) {
		if (!selectedById.has(item.id)) selectedById.set(item.id, item);
	}
	return selectedById;
}

function expandedSelectedIds(
	selectedById: Map<number, MemoryResult>,
	clusterState: ClusterCompressionState,
): Set<number> {
	const selectedIds = new Set<number>();
	for (const representativeId of selectedById.keys()) {
		selectedIds.add(representativeId);
		for (const compressedId of clusterState.compressedByRepresentative.get(representativeId) ??
			[]) {
			selectedIds.add(compressedId);
		}
	}
	return selectedIds;
}

function appendSelectedIdGroup(
	itemId: number,
	remainingIds: Set<number>,
	allItemIds: number[],
	clusterState: ClusterCompressionState,
): void {
	if (!remainingIds.has(itemId)) return;
	allItemIds.push(itemId);
	remainingIds.delete(itemId);
	for (const compressedId of clusterState.compressedByRepresentative.get(itemId) ?? []) {
		if (!remainingIds.has(compressedId)) continue;
		allItemIds.push(compressedId);
		remainingIds.delete(compressedId);
	}
}

function orderSelectedPackItems(
	results: MemoryResult[],
	renderedItems: MemoryResult[],
	selectedById: Map<number, MemoryResult>,
): MemoryResult[] {
	const selectedItems: MemoryResult[] = [];
	const remainingIds = new Set(selectedById.keys());
	for (const item of results) {
		if (!remainingIds.has(item.id)) continue;
		const selected = selectedById.get(item.id);
		if (selected == null) continue;
		selectedItems.push(selected);
		remainingIds.delete(item.id);
	}
	for (const item of renderedItems) {
		if (!remainingIds.has(item.id)) continue;
		selectedItems.push(item);
		remainingIds.delete(item.id);
	}
	return selectedItems;
}

function orderExpandedPackIds(
	results: MemoryResult[],
	renderedItems: MemoryResult[],
	selectedIds: Set<number>,
	clusterState: ClusterCompressionState,
): number[] {
	const allItemIds: number[] = [];
	const remainingIds = new Set(selectedIds);
	for (const item of results) {
		appendSelectedIdGroup(item.id, remainingIds, allItemIds, clusterState);
	}
	for (const item of renderedItems) {
		appendSelectedIdGroup(item.id, remainingIds, allItemIds, clusterState);
	}
	for (const cluster of clusterState.clusters) {
		appendSelectedIdGroup(cluster.representative_id, remainingIds, allItemIds, clusterState);
	}
	return allItemIds;
}

function appendMissingCompressedIds(allItemIds: number[], allItems: PackItem[]): void {
	const seenIds = new Set(allItemIds);
	for (const item of allItems) {
		for (const compressedId of item.compressed_ids ?? []) {
			if (seenIds.has(compressedId)) continue;
			seenIds.add(compressedId);
			allItemIds.push(compressedId);
		}
	}
}

function selectPackItems(
	results: MemoryResult[],
	assembly: PackAssemblyStage,
	render: PackRenderStage,
): PackSelectionStage {
	const { dedupeState, clusterState } = assembly;
	// Collect all unique rendered items across sections, but preserve relevance order.
	// `item_ids` should still include compressed-away IDs for fetch-more behavior.
	const renderedItems = [
		...render.budgetedSummary,
		...render.budgetedTimeline,
		...render.budgetedObservations,
	];
	const selectedById = selectedPackItemsById(render);
	const selectedItems = orderSelectedPackItems(results, renderedItems, selectedById);
	const allItemIds = orderExpandedPackIds(
		results,
		renderedItems,
		expandedSelectedIds(selectedById, clusterState),
		clusterState,
	);
	const allItems = selectedItems.map((item) => toPackItem(item, dedupeState, clusterState));
	appendMissingCompressedIds(allItemIds, allItems);
	return { selectedItems, allItemIds, allItems };
}

function packDeltaMetrics(
	store: StoreHandle,
	filters: MemoryFilters | undefined,
	summarySessionId: number | null | undefined,
	allItemIds: number[],
	packTokens: number,
): Pick<
	PackResponse["metrics"],
	"added_ids" | "removed_ids" | "retained_ids" | "pack_token_delta" | "pack_delta_available"
> {
	const { previousPackIds, previousPackTokens } = getPackDeltaBaseline(
		store,
		filters ?? null,
		summarySessionId,
	);
	const available = previousPackIds != null && previousPackTokens != null;
	const previousSet = new Set(previousPackIds ?? []);
	const currentSet = new Set(allItemIds);
	return {
		added_ids: available ? allItemIds.filter((id) => !previousSet.has(id)) : [],
		removed_ids: available ? (previousPackIds ?? []).filter((id) => !currentSet.has(id)) : [],
		retained_ids: available ? allItemIds.filter((id) => previousSet.has(id)) : [],
		pack_token_delta: available ? packTokens - (previousPackTokens ?? 0) : 0,
		pack_delta_available: available,
	};
}

function packWorkMetrics(
	selectedItems: MemoryResult[],
	packTokens: number,
): Pick<
	PackResponse["metrics"],
	"work_tokens" | "work_tokens_unique" | "tokens_saved" | "compression_ratio" | "overhead_tokens"
> {
	const workTokens = selectedItems.reduce((sum, item) => sum + estimateWorkTokens(item), 0);
	const groupedWork = new Map<string, number>();
	for (const item of selectedItems) {
		const key = discoveryGroup(item);
		const estimate = estimateWorkTokens(item);
		const existing = groupedWork.get(key) ?? 0;
		if (estimate > existing) groupedWork.set(key, estimate);
	}
	const workTokensUnique = [...groupedWork.values()].reduce((sum, value) => sum + value, 0);
	return {
		work_tokens: workTokens,
		work_tokens_unique: workTokensUnique,
		tokens_saved: Math.max(0, workTokensUnique - packTokens),
		compression_ratio: workTokensUnique > 0 ? packTokens / workTokensUnique : null,
		overhead_tokens: workTokensUnique > 0 ? packTokens - workTokensUnique : null,
	};
}

function avoidedPackWorkMetrics(
	selectedItems: MemoryResult[],
	packTokens: number,
): Pick<
	PackResponse["metrics"],
	| "avoided_work_tokens"
	| "avoided_work_saved"
	| "avoided_work_ratio"
	| "avoided_work_known_items"
	| "avoided_work_unknown_items"
	| "avoided_work_sources"
	| "savings_reliable"
> {
	let total = 0;
	let knownItems = 0;
	let unknownItems = 0;
	const sources: Record<string, number> = {};
	for (const item of selectedItems) {
		const avoided = avoidedWorkTokens(item);
		if (avoided.tokens <= 0) {
			unknownItems++;
			continue;
		}
		total += avoided.tokens;
		knownItems++;
		sources[avoided.source] = (sources[avoided.source] ?? 0) + 1;
	}
	return {
		avoided_work_tokens: total,
		avoided_work_saved: Math.max(0, total - packTokens),
		avoided_work_ratio: total > 0 ? total / Math.max(packTokens, 1) : null,
		avoided_work_known_items: knownItems,
		avoided_work_unknown_items: unknownItems,
		avoided_work_sources: sources,
		savings_reliable: knownItems + unknownItems > 0 ? knownItems >= unknownItems : true,
	};
}

function packWorkSourceMetrics(
	selectedItems: MemoryResult[],
): Pick<PackResponse["metrics"], "work_source" | "work_usage_items" | "work_estimate_items"> {
	const workSources = selectedItems.map(workSource);
	const usageItems = workSources.filter((source) => source === "usage").length;
	const estimateItems = workSources.length - usageItems;
	let source: "estimate" | "usage" | "mixed" = "estimate";
	if (usageItems > 0 && estimateItems > 0) source = "mixed";
	else if (usageItems > 0) source = "usage";
	return {
		work_source: source,
		work_usage_items: usageItems,
		work_estimate_items: estimateItems,
	};
}

function measurePackOutput(
	store: StoreHandle,
	tokenBudget: number | null,
	filters: MemoryFilters | undefined,
	retrieval: PackRetrievalStage,
	assembly: PackAssemblyStage,
	render: PackRenderStage,
	selection: PackSelectionStage,
): PackResponse["metrics"] {
	const { effectiveLimit, summarySessionId, fallbackUsed, ftsCount, semanticCount } = retrieval;
	const { modeLabel } = assembly;
	const { packTokens } = render;
	const { selectedItems, allItemIds, allItems } = selection;
	const fallbackLabel: "recent" | null = fallbackUsed ? "recent" : null;
	return {
		total_items: allItems.length,
		pack_tokens: packTokens,
		fallback_used: fallbackUsed,
		fallback: fallbackLabel,
		limit: effectiveLimit,
		token_budget: tokenBudget,
		project: filters?.project ?? null,
		pack_item_ids: allItemIds,
		mode: modeLabel,
		...packDeltaMetrics(store, filters, summarySessionId, allItemIds, packTokens),
		...packWorkMetrics(selectedItems, packTokens),
		...avoidedPackWorkMetrics(selectedItems, packTokens),
		...packWorkSourceMetrics(selectedItems),
		sources: { fts: ftsCount, semantic: semanticCount, fuzzy: 0 },
	};
}

type PackTraceSections = Record<PackTraceSection, number[]>;

interface PackTraceCandidateContext {
	store: StoreHandle;
	filters: MemoryFilters | undefined;
	retrieval: PackRetrieval;
	sectionsById: PackTraceSections;
	dedupedIds: Set<number>;
	compressedIds: Set<number>;
	trimmedIds: Set<number>;
	referenceNow: Date;
	ownership: (item: MemoryResult) => boolean;
}

function traceDisposition(
	itemId: number,
	section: PackTraceSection | null,
	context: PackTraceCandidateContext,
): PackTraceDisposition {
	if (section) return "selected";
	if (context.dedupedIds.has(itemId)) return "deduped";
	if (context.compressedIds.has(itemId)) return "compressed";
	if (context.trimmedIds.has(itemId)) return "trimmed";
	return "dropped";
}

function buildTraceCandidate(
	exposure: PackCandidateExposure,
	index: number,
	context: PackTraceCandidateContext,
): PackTraceCandidate {
	const { item, query } = exposure;
	const section = traceSection(item.id, context.sectionsById);
	const disposition = traceDisposition(item.id, section, context);
	const baseScores = scoreResult(
		context.store,
		item,
		context.filters,
		query,
		context.referenceNow,
		context.ownership,
	);
	const scores = {
		...withFusionScores(baseScores, context.retrieval.fusion.get(item.id)),
		text_overlap: textOverlapScore(item, query),
		tag_overlap: countOverlap(item.tags_text, queryContentTokens(query)),
	};
	const roleInference = inferMemoryRole({
		kind: item.kind,
		title: item.title,
		body_text: item.body_text,
		metadata: item.metadata ?? null,
	});
	return {
		id: item.id,
		rank: index + 1,
		kind: item.kind,
		title: item.title,
		preview: preview(item.narrative || item.body_text),
		scores,
		reasons: [
			...candidateReasons(item, scores, section, disposition),
			...semanticRejectionReasons(item.id, disposition, context.retrieval.rejectedSemanticIds),
		],
		disposition,
		section,
		artifact_class: readArtifactClass(item.metadata),
		inferred_role: roleInference.role,
		role_reason: roleInference.reason,
	};
}

function limitDiagnosticCandidates(candidates: PackTraceCandidate[]): PackTraceCandidate[] {
	const selected = candidates.filter((candidate) => candidate.disposition === "selected");
	const diagnostic = candidates
		.filter((candidate) => candidate.disposition !== "selected")
		.slice(0, TRACE_CANDIDATE_LIMIT);
	return [...selected, ...diagnostic].sort((left, right) => left.rank - right.rank);
}

function packTraceSections(render: PackRenderStage): PackTraceSections {
	return {
		summary: render.budgetedSummary.map((item) => item.id),
		timeline: render.budgetedTimeline.map((item) => item.id),
		observations: render.budgetedObservations.map((item) => item.id),
	};
}

function createPackTrace(
	context: string,
	tokenBudget: number | null,
	filters: MemoryFilters | undefined,
	retrieval: PackRetrievalStage,
	assembly: PackAssemblyStage,
	render: PackRenderStage,
	sectionsById: PackTraceSections,
	candidateCount: number,
	candidates: PackTraceCandidate[],
	dedupedIds: number[],
	trimmedIds: number[],
): PackTrace {
	return {
		version: 1,
		inputs: {
			query: context,
			...(retrieval.sanitized.was_sanitized ? { sanitized_query: retrieval.retrievalContext } : {}),
			project: filters?.project ?? null,
			working_set_files: [...(filters?.working_set_paths ?? [])],
			token_budget: tokenBudget,
			limit: retrieval.effectiveLimit,
		},
		mode: {
			selected: assembly.modeLabel,
			reasons: modeReasons(context, assembly.modeLabel, filters),
		},
		retrieval: { candidate_count: candidateCount, candidates },
		assembly: {
			deduped_ids: dedupedIds,
			collapsed_groups: collapsedGroups(assembly.dedupeState),
			compressed_clusters: assembly.clusterState.clusters,
			trimmed_ids: trimmedIds,
			trim_reasons:
				trimmedIds.length > 0
					? ["token budget exceeded; lower-priority items dropped after section ordering"]
					: [],
			sections: sectionsById,
		},
		output: {
			estimated_tokens: render.packTokens,
			truncated: trimmedIds.length > 0,
			section_counts: {
				summary: sectionsById.summary.length,
				timeline: sectionsById.timeline.length,
				observations: sectionsById.observations.length,
			},
			pack_text: render.packText,
		},
	};
}

function buildPackDiagnostics(
	store: StoreHandle,
	context: string,
	tokenBudget: number | null,
	filters: MemoryFilters | undefined,
	retrievalStage: PackRetrievalStage,
	assemblyStage: PackAssemblyStage,
	renderStage: PackRenderStage,
	selectionStage: PackSelectionStage,
): PackTrace {
	const { retrieval, retrievalQuery } = retrievalStage;
	const { summaryItems, timelineItems, observationItems, dedupeState, clusterState } =
		assemblyStage;
	const { selectedItems, allItemIds } = selectionStage;
	const sectionsById = packTraceSections(renderStage);
	const budgetedIds = new Set([...allItemIds]);
	const trimmedIds = [...summaryItems, ...timelineItems, ...observationItems]
		.map((item) => item.id)
		.filter((itemId) => !budgetedIds.has(itemId))
		.sort((a, b) => a - b);
	const dedupedIds = flattenDuplicateIds(dedupeState);
	const ownership =
		typeof store.buildOwnershipPredicate === "function"
			? store.buildOwnershipPredicate()
			: (item: MemoryResult) => store.memoryOwnedBySelf(item);
	const candidatePool = dedupePackCandidateExposures([
		...retrievalStage.candidateExposures,
		...assemblyStage.candidateExposures,
		...exposePackCandidates(retrievalQuery, selectedItems),
	]);
	const candidateContext: PackTraceCandidateContext = {
		store,
		filters,
		retrieval,
		sectionsById,
		dedupedIds: new Set(dedupedIds),
		compressedIds: new Set(flattenCompressedIds(clusterState)),
		trimmedIds: new Set(trimmedIds),
		referenceNow: new Date(),
		ownership,
	};
	const candidates = limitDiagnosticCandidates(
		candidatePool.map((exposure, index) => buildTraceCandidate(exposure, index, candidateContext)),
	);
	return createPackTrace(
		context,
		tokenBudget,
		filters,
		retrievalStage,
		assemblyStage,
		renderStage,
		sectionsById,
		candidatePool.length,
		candidates,
		dedupedIds,
		trimmedIds,
	);
}

function finalizePackArtifacts(
	store: StoreHandle,
	context: string,
	tokenBudget: number | null,
	filters: MemoryFilters | undefined,
	recordUsage: boolean,
	retrievalStage: PackRetrievalStage,
	assemblyStage: PackAssemblyStage,
	renderStage: PackRenderStage,
): PackArtifacts {
	const selectionStage = selectPackItems(retrievalStage.results, assemblyStage, renderStage);
	const { allItemIds, allItems } = selectionStage;
	const { packText, renderedItems } = renderStage;

	const metrics = measurePackOutput(
		store,
		tokenBudget,
		filters,
		retrievalStage,
		assemblyStage,
		renderStage,
		selectionStage,
	);

	const response: PackResponse = {
		context,
		items: allItems,
		item_ids: allItemIds,
		pack_text: packText,
		rendered_items: renderedItems,
		metrics,
	};

	const trace = buildPackDiagnostics(
		store,
		context,
		tokenBudget,
		filters,
		retrievalStage,
		assemblyStage,
		renderStage,
		selectionStage,
	);

	if (recordUsage) {
		recordPackUsage(store, metrics);
	}

	return { response, trace };
}

function buildPackArtifacts(
	store: StoreHandle,
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
	semanticResults?: MemoryResult[],
	options: {
		recordUsage: boolean;
		compact?: boolean;
		compactDetailCount?: number;
		compressionMode?: PackCompressionMode;
		automaticContext?: AutomaticContext | null;
	} = {
		recordUsage: true,
	},
): PackArtifacts {
	const retrievalStage = retrievePackCandidates(
		store,
		context,
		limit,
		filters,
		semanticResults,
		options.automaticContext,
	);
	const assemblyStage = assemblePackSections(store, context, filters, retrievalStage, options);
	const renderStage = renderPackSections(assemblyStage, tokenBudget);
	return finalizePackArtifacts(
		store,
		context,
		tokenBudget,
		filters,
		options.recordUsage,
		retrievalStage,
		assemblyStage,
		renderStage,
	);
}

export function buildMemoryPack(
	store: StoreHandle,
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
	semanticResults?: MemoryResult[],
	renderOptions?: PackRenderOptions,
	automaticContext?: AutomaticContext | null,
): PackResponse {
	return buildPackArtifacts(store, context, limit, tokenBudget, filters, semanticResults, {
		recordUsage: true,
		compact: renderOptions?.compact,
		compactDetailCount: renderOptions?.compactDetailCount,
		compressionMode: renderOptions?.compressionMode,
		automaticContext,
	}).response;
}

export function buildMemoryPackWithTrace(
	store: StoreHandle,
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
	semanticResults?: MemoryResult[],
	renderOptions?: PackRenderOptions,
	automaticContext?: AutomaticContext | null,
): PackArtifacts {
	return buildPackArtifacts(store, context, limit, tokenBudget, filters, semanticResults, {
		recordUsage: true,
		compact: renderOptions?.compact,
		compactDetailCount: renderOptions?.compactDetailCount,
		compressionMode: renderOptions?.compressionMode,
		automaticContext,
	});
}

export function buildMemoryPackTrace(
	store: StoreHandle,
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
	semanticResults?: MemoryResult[],
	renderOptions?: PackRenderOptions,
	automaticContext?: AutomaticContext | null,
): PackTrace {
	return buildPackArtifacts(store, context, limit, tokenBudget, filters, semanticResults, {
		recordUsage: false,
		compact: renderOptions?.compact,
		compactDetailCount: renderOptions?.compactDetailCount,
		compressionMode: renderOptions?.compressionMode,
		automaticContext,
	}).trace;
}

// ---------------------------------------------------------------------------
// Async pack builder (with semantic search)
// ---------------------------------------------------------------------------

/**
 * Build a memory pack with semantic candidate merging.
 *
 * This is the async version that runs `semanticSearch` against the
 * sqlite-vec `memory_vectors` table, then merges those candidates
 * with FTS results via the sync `buildMemoryPack`.
 *
 * Callers that don't want/need async can still use the sync
 * `buildMemoryPack` directly — semantic candidates simply won't
 * be included.
 */
export async function buildMemoryPackAsync(
	store: StoreHandle & { db: Database },
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
	renderOptions?: PackRenderOptions,
	automaticContext?: AutomaticContext | null,
): Promise<PackResponse> {
	// Run semantic search (returns [] when embeddings unavailable)
	let semResults: MemoryResult[] = [];
	const semanticQuery = sanitizeSearchQuery(context).clean_query;
	try {
		const raw = await semanticSearch(
			store.db,
			semanticQuery,
			limit,
			filters ?? null,
			ownershipFilterContext(store),
			automaticSummarySessionId(store, automaticContext),
		);
		semResults = semanticMemoryResults(raw);
	} catch {
		// Semantic search failure is non-fatal — fall through to FTS-only
	}

	return buildPackArtifacts(store, context, limit, tokenBudget, filters, semResults, {
		recordUsage: true,
		compact: renderOptions?.compact,
		compactDetailCount: renderOptions?.compactDetailCount,
		compressionMode: renderOptions?.compressionMode,
		automaticContext,
	}).response;
}

export async function buildMemoryPackWithTraceAsync(
	store: StoreHandle & { db: Database },
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
	renderOptions?: PackRenderOptions,
	automaticContext?: AutomaticContext | null,
): Promise<PackArtifacts> {
	let semResults: MemoryResult[] = [];
	const semanticQuery = sanitizeSearchQuery(context).clean_query;
	try {
		const raw = await semanticSearch(
			store.db,
			semanticQuery,
			limit,
			filters ?? null,
			ownershipFilterContext(store),
			automaticSummarySessionId(store, automaticContext),
		);
		semResults = semanticMemoryResults(raw);
	} catch {
		// Semantic search failure is non-fatal — fall through to FTS-only.
	}

	return buildPackArtifacts(store, context, limit, tokenBudget, filters, semResults, {
		recordUsage: true,
		compact: renderOptions?.compact,
		compactDetailCount: renderOptions?.compactDetailCount,
		compressionMode: renderOptions?.compressionMode,
		automaticContext,
	});
}

export async function buildMemoryPackTraceAsync(
	store: StoreHandle & { db: Database },
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
	renderOptions?: PackRenderOptions,
	automaticContext?: AutomaticContext | null,
): Promise<PackTrace> {
	let semResults: MemoryResult[] = [];
	const semanticQuery = sanitizeSearchQuery(context).clean_query;
	try {
		const raw = await semanticSearch(
			store.db,
			semanticQuery,
			limit,
			filters ?? null,
			ownershipFilterContext(store),
			automaticSummarySessionId(store, automaticContext),
		);
		semResults = semanticMemoryResults(raw);
	} catch {
		// Semantic search failure is non-fatal — fall through to FTS-only
	}

	return buildPackArtifacts(store, context, limit, tokenBudget, filters, semResults, {
		recordUsage: false,
		compact: renderOptions?.compact,
		compactDetailCount: renderOptions?.compactDetailCount,
		compressionMode: renderOptions?.compressionMode,
		automaticContext,
	}).trace;
}
