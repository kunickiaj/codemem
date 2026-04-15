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

import type { Database } from "./db.js";
import { buildFilterClausesWithContext } from "./filters.js";
import { projectBasename } from "./project.js";
import { sanitizeSearchQuery } from "./query-sanitizer.js";
import { memoryLooksRecapLike, queryPrefersRecap } from "./recap-policy.js";
import { findByFile } from "./ref-queries.js";
import type { StoreHandle } from "./search.js";
import { rerankResults, scoreResult, search, timeline } from "./search.js";
import {
	canonicalMemoryKind,
	getSummaryMetadata,
	isNativeSessionSummaryMemory,
	isSummaryLikeMemory,
} from "./summary-memory.js";
import type {
	MemoryFilters,
	MemoryItemResponse,
	MemoryResult,
	PackItem,
	PackRenderOptions,
	PackResponse,
	PackTrace,
	PackTraceCandidate,
	PackTraceDisposition,
	PackTraceMode,
	PackTraceSection,
	TimelineItemResponse,
} from "./types.js";
import { semanticSearch } from "./vectors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Observation kind priority — higher-signal kinds sort first. */
const OBSERVATION_KIND_PRIORITY: Record<string, number> = {
	decision: 0,
	feature: 1,
	bugfix: 2,
	refactor: 3,
	change: 4,
	discovery: 5,
	exploration: 6,
	note: 7,
};

const TASK_RECENCY_DAYS = 365;

const TASK_HINT_QUERY =
	"todo todos task tasks pending follow up follow-up next resume continue backlog pick up pick-up";

const RECALL_HINT_QUERY = "session summary recap remember last time previous work";

const TRACE_CANDIDATE_LIMIT = 20;
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
function relatedSuffix(item: MemoryResult, clusterState?: ClusterCompressionState): string {
	const relatedCount = clusterState?.compressedByRepresentative.get(item.id)?.size ?? 0;
	return relatedCount > 0 ? ` (+${relatedCount} related)` : "";
}

function formatItem(item: MemoryResult, clusterState?: ClusterCompressionState): string {
	const header = `[${item.id}] (${item.kind}) ${item.title}${relatedSuffix(item, clusterState)}`;
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

/** Build a formatted section with header and items. */
function formatSection(
	header: string,
	items: MemoryResult[],
	clusterState?: ClusterCompressionState,
): string {
	const heading = `## ${header}`;
	if (items.length === 0) return `${heading}\n`;
	return [heading, ...items.map((item) => formatItem(item, clusterState))].join("\n");
}

// ---------------------------------------------------------------------------
// Compact mode rendering
// ---------------------------------------------------------------------------

const DEFAULT_COMPACT_DETAIL_COUNT = 3;
const COMPACT_FOOTER = "Use `memory_get` or `memory_search` to fetch detail for any item by [ID].";

/** Single-line index entry for compact mode. */
function formatIndexLine(item: MemoryResult, clusterState?: ClusterCompressionState): string {
	return `[${item.id}] (${item.kind}) ${item.title}${relatedSuffix(item, clusterState)}`;
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
): string {
	const indexSection = `## Index\n${items.length > 0 ? items.map((item) => formatIndexLine(item, clusterState)).join("\n") : "(no items)"}`;

	const detailItems = items.filter((item) => detailIds.has(item.id));
	const detailSection =
		detailItems.length > 0
			? `## Detail\n${detailItems.map((item) => formatItem(item, clusterState)).join("\n\n")}`
			: "## Detail\n(no items)";

	return `${indexSection}\n\n${detailSection}\n\n${COMPACT_FOOTER}`;
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

type PackArtifacts = {
	response: PackResponse;
	trace: PackTrace;
};

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

function queryLooksLikeTasks(query: string): boolean {
	const lowered = query.toLowerCase();
	for (const token of [
		"todo",
		"todos",
		"pending",
		"task",
		"tasks",
		"next",
		"resume",
		"continue",
		"backlog",
	]) {
		if (lowered.includes(token)) return true;
	}
	for (const phrase of [
		"follow up",
		"follow-up",
		"followups",
		"pick up",
		"pick-up",
		"left off",
		"where we left off",
		"work on next",
		"what's next",
		"what was next",
	]) {
		if (lowered.includes(phrase)) return true;
	}
	return false;
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

function recallQueryWantsTimeline(query: string): boolean {
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
	const ordered = [...results];
	ordered.sort((a, b) => {
		if (!preferSummary) {
			const recapDelta = Number(memoryLooksRecapLike(a)) - Number(memoryLooksRecapLike(b));
			if (recapDelta !== 0) return recapDelta;
			const taskLikeDelta = Number(itemLooksTaskLike(a)) - Number(itemLooksTaskLike(b));
			if (taskLikeDelta !== 0) return taskLikeDelta;
			const rank = (item: MemoryResult): number => {
				if (item.kind === "decision") return 0;
				if (item.kind === "bugfix") return 1;
				if (item.kind === "discovery") return 2;
				if (item.kind === "refactor") return 3;
				if (item.kind === "feature") return 4;
				if (item.kind === "exploration") return 5;
				if (item.kind === "note") return 6;
				if (item.kind === "observation") return 7;
				if (item.kind === "change") return 8;
				if (item.kind === "entities") return 9;
				return 10;
			};
			const rankDelta = rank(a) - rank(b);
			if (rankDelta !== 0) return rankDelta;
		}
		const overlapDelta = textOverlapScore(b, query) - textOverlapScore(a, query);
		if (overlapDelta !== 0) return overlapDelta;
		return 0;
	});
	return ordered.slice(0, limit);
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

function prioritizeTaskResults(results: MemoryResult[], limit: number, query = ""): MemoryResult[] {
	const ordered = [...results].sort((a, b) =>
		(b.created_at ?? "").localeCompare(a.created_at ?? ""),
	);
	ordered.sort((a, b) => {
		const overlapDelta = textOverlapScore(b, query) - textOverlapScore(a, query);
		if (overlapDelta !== 0) return overlapDelta;
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
	preferSummary: boolean,
	query: string,
): MemoryResult[] {
	const ordered = [...results].sort((a, b) =>
		(b.created_at ?? "").localeCompare(a.created_at ?? ""),
	);
	ordered.sort((a, b) => {
		const rank = (item: MemoryResult): number => {
			if (preferSummary) {
				if (isSummaryLike(item)) return 0;
				if (item.kind === "decision") return 1;
				if (item.kind === "note") return 2;
				if (item.kind === "observation") return 3;
				if (item.kind === "entities") return 4;
				return 5;
			}
			if (itemLooksTaskLike(item)) return 8;
			if (item.kind === "decision") return 0;
			if (item.kind === "bugfix") return 1;
			if (item.kind === "discovery") return 2;
			if (item.kind === "exploration") return 3;
			if (isSummaryLike(item)) return 4;
			if (item.kind === "note") return 5;
			if (item.kind === "observation") return 6;
			if (item.kind === "entities") return 7;
			return 5;
		};
		if (!preferSummary) {
			const rankDelta = rank(a) - rank(b);
			if (rankDelta !== 0) return rankDelta;
			const recapDelta = Number(memoryLooksRecapLike(a)) - Number(memoryLooksRecapLike(b));
			if (recapDelta !== 0) return recapDelta;
		}
		const overlapDelta = textOverlapScore(b, query) - textOverlapScore(a, query);
		if (overlapDelta !== 0) return overlapDelta;
		return rank(a) - rank(b);
	});
	return ordered.slice(0, limit);
}

function taskFallbackRecent(
	store: StoreHandle,
	limit: number,
	filters?: MemoryFilters,
): MemoryResult[] {
	const expandedLimit = Math.max(limit * 3, limit);
	const recentRows = store.recent(expandedLimit, filters ?? null);
	return prioritizeTaskResults(recentRows.map(toMemoryResult), limit);
}

function recallFallbackRecent(
	store: StoreHandle,
	limit: number,
	filters?: MemoryFilters,
): MemoryResult[] {
	const expandedLimit = Math.max(limit * 4, limit);
	const recentAll = store.recent(expandedLimit, filters ?? null).map(toMemoryResult);
	const summaries = recentAll.filter(isSummaryLike).slice(0, limit);
	if (summaries.length >= limit) return summaries.slice(0, limit);

	const summaryIds = new Set(summaries.map((item) => item.id));
	const remainder = recentAll.filter((item) => !summaryIds.has(item.id));
	const prioritized = prioritizeTaskResults(remainder, limit - summaries.length);
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

function isSummaryLike(item: Pick<MemoryResult, "kind" | "metadata">): boolean {
	return isSummaryLikeMemory(item);
}

function findLatestSummaryLike(store: StoreHandle, filters?: MemoryFilters): MemoryResult | null {
	const filterResult = buildFilterClausesWithContext(filters ?? null, {
		actorId: store.actorId,
		deviceId: store.deviceId,
	});
	const whereParts = [
		"memory_items.active = 1",
		"(memory_items.kind = 'session_summary' OR json_extract(memory_items.metadata_json, '$.is_summary') = 1)",
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
		.get(...filterResult.params) as MemoryItemResponse | null;
	return row ? toMemoryResult(row) : null;
}

function getPackDeltaBaseline(
	store: StoreHandle,
	project: string | null,
): { previousPackIds: number[] | null; previousPackTokens: number | null } {
	const projectBase = project ? projectBasename(project) : null;
	const metaProjectExpr =
		"CASE WHEN json_valid(metadata_json) = 1 THEN json_extract(metadata_json, '$.project') ELSE NULL END";
	const rows = project
		? (store.db
				.prepare(
					`SELECT metadata_json, tokens_read
					 FROM usage_events
					 WHERE event = 'pack'
					   AND (${metaProjectExpr} = ? OR ${metaProjectExpr} = ?)
					 ORDER BY created_at DESC
					 LIMIT 25`,
				)
				.all(project, projectBase ?? project) as Array<{
				metadata_json: string | null;
				tokens_read: number | null;
			}>)
		: (store.db
				.prepare(
					`SELECT metadata_json, tokens_read
					 FROM usage_events
					 WHERE event = 'pack'
					 ORDER BY created_at DESC
					 LIMIT 25`,
				)
				.all() as Array<{ metadata_json: string | null; tokens_read: number | null }>);

	for (const row of rows) {
		const metadata = parseMetadataObject(row.metadata_json);
		if (project != null) {
			const rowProject = typeof metadata.project === "string" ? metadata.project : null;
			if (rowProject !== project && rowProject !== projectBase) continue;
		}
		if (!("pack_item_ids" in metadata)) continue;

		const { ids, valid } = coercePackItemIds(metadata.pack_item_ids);
		if (!valid) continue;

		const previousTokens =
			parseNonNegativeInt(metadata.pack_tokens) ?? parseNonNegativeInt(row.tokens_read);
		if (previousTokens == null) continue;

		return { previousPackIds: ids, previousPackTokens: previousTokens };
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
			.run(sessionId, tokensRead, tokensSaved, now, JSON.stringify(metrics));
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
 * Merge FTS and semantic results by ID, keeping the higher score for dupes.
 * Matches Python's always-merge behavior when semantic results are available.
 */
function mergeResults(
	store: StoreHandle,
	ftsResults: MemoryResult[],
	semanticResults: MemoryResult[],
	limit: number,
	query: string,
	filters?: MemoryFilters,
): { merged: MemoryResult[]; ftsCount: number; semanticCount: number } {
	const seen = new Map<number, MemoryResult>();
	for (const r of ftsResults) {
		const existing = seen.get(r.id);
		if (!existing || r.score > existing.score) seen.set(r.id, r);
	}
	let semanticCount = 0;
	for (const r of semanticResults) {
		if (!seen.has(r.id)) semanticCount++;
		const existing = seen.get(r.id);
		if (!existing || r.score > existing.score) seen.set(r.id, r);
	}
	const merged = rerankResults(store, [...seen.values()], limit, filters, query);
	return { merged, ftsCount: ftsResults.length, semanticCount };
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
		}).map((row) => row.id),
	);
	const newIds = refCandidateIds.filter((id) => !existingIds.has(id));
	if (newIds.length === 0) return results;
	const refMemories = newIds
		.map((id) => store.get(id))
		.filter((m): m is NonNullable<typeof m> => m != null)
		.map(toMemoryResult);
	return [...results, ...refMemories];
}

function buildPackArtifacts(
	store: StoreHandle,
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
	semanticResults?: MemoryResult[],
	options: { recordUsage: boolean; compact?: boolean; compactDetailCount?: number } = {
		recordUsage: true,
	},
): PackArtifacts {
	const effectiveLimit = Math.max(1, Math.trunc(limit));
	const retrievalContext = sanitizeSearchQuery(context).clean_query;
	let fallbackUsed = false;
	let ftsCount = 0;
	let semanticCount = 0;
	let retrievalResults: MemoryResult[] = [];
	let retrievalQuery = retrievalContext;
	let results: MemoryResult[];
	const taskMode = queryLooksLikeTasks(retrievalContext);
	const recallMode = !taskMode && queryLooksLikeRecall(retrievalContext);

	if (taskMode) {
		const taskQuery = `${retrievalContext} ${TASK_HINT_QUERY}`.trim();
		retrievalQuery = taskQuery;
		let taskResults = search(store, taskQuery, effectiveLimit, filters);
		ftsCount = taskResults.length;
		if (semanticResults && semanticResults.length > 0) {
			const merge = mergeResults(
				store,
				taskResults,
				semanticResults,
				effectiveLimit,
				taskQuery,
				filters,
			);
			taskResults = merge.merged;
			semanticCount = merge.semanticCount;
		}
		taskResults = mergeFileRefCandidates(store, taskResults, filters, effectiveLimit);
		retrievalResults = [...taskResults];
		if (taskResults.length === 0) {
			fallbackUsed = true;
			results = taskFallbackRecent(store, effectiveLimit, filters);
		} else {
			const actionableTaskResults = taskResults.filter((item) => !isSummaryLike(item));
			const recentTaskResults = filterRecentResults(
				actionableTaskResults.length > 0 ? actionableTaskResults : taskResults,
				TASK_RECENCY_DAYS,
			);
			results = prioritizeTaskResults(
				recentTaskResults.length > 0
					? recentTaskResults
					: actionableTaskResults.length > 0
						? actionableTaskResults
						: taskResults,
				effectiveLimit,
				retrievalContext,
			);
		}
	} else if (recallMode) {
		const recallQuery = retrievalContext.trim().length > 0 ? retrievalContext : RECALL_HINT_QUERY;
		retrievalQuery = recallQuery;
		const preferSummary = queryPrefersRecap(recallQuery);
		const wantsTimeline = recallQueryWantsTimeline(recallQuery);
		const topicalRecallQuery = [...queryContentTokens(recallQuery)].join(" ");
		let recallResults = search(store, recallQuery, effectiveLimit, filters);
		ftsCount = recallResults.length;
		if (!preferSummary && topicalRecallQuery) {
			const needsTopicalRetry =
				recallResults.length === 0 ||
				recallResults.every(
					(item) => isSummaryLike(item) || textOverlapScore(item, topicalRecallQuery) === 0,
				);
			if (needsTopicalRetry) {
				const topicalResults = search(store, topicalRecallQuery, effectiveLimit, filters);
				if (topicalResults.length > 0) {
					recallResults = topicalResults;
					ftsCount = topicalResults.length;
					retrievalQuery = topicalRecallQuery;
				}
			}
		}
		if (recallResults.length === 0) {
			recallResults = search(store, RECALL_HINT_QUERY, effectiveLimit, filters).filter(
				isSummaryLike,
			);
			ftsCount = recallResults.length;
			retrievalQuery = RECALL_HINT_QUERY;
		}
		if (semanticResults && semanticResults.length > 0) {
			const merge = mergeResults(
				store,
				recallResults,
				semanticResults,
				effectiveLimit,
				recallQuery,
				filters,
			);
			recallResults = merge.merged;
			semanticCount = merge.semanticCount;
		}
		recallResults = mergeFileRefCandidates(store, recallResults, filters, effectiveLimit);
		retrievalResults = [...recallResults];
		results = prioritizeRecallResults(
			recallResults,
			effectiveLimit,
			preferSummary,
			retrievalContext,
		);
		if (results.length === 0) {
			fallbackUsed = true;
			results = recallFallbackRecent(store, effectiveLimit, filters);
		}
		const anchor = preferSummary
			? results[0]
			: (results.find((item) => !isSummaryLike(item)) ?? results[0]);
		const anchorId = anchor?.id;
		if (wantsTimeline && anchorId != null) {
			const depthBefore = Math.max(0, Math.floor(effectiveLimit / 2));
			const depthAfter = Math.max(0, effectiveLimit - depthBefore - 1);
			const timelineRows = timeline(
				store,
				undefined,
				anchorId,
				depthBefore,
				depthAfter,
				filters ?? null,
			);
			if (timelineRows.length > 0) {
				results = timelineRows.map(toMemoryResult);
			}
		}
	} else {
		const ftsResults = search(store, retrievalContext, effectiveLimit, filters);
		if (semanticResults && semanticResults.length > 0) {
			const merge = mergeResults(
				store,
				ftsResults,
				semanticResults,
				effectiveLimit,
				retrievalContext,
				filters,
			);
			results = prioritizeDefaultResults(merge.merged, effectiveLimit, retrievalContext);
			ftsCount = merge.ftsCount;
			semanticCount = merge.semanticCount;
			retrievalResults = [...merge.merged];
		} else {
			results = prioritizeDefaultResults(ftsResults, effectiveLimit, retrievalContext);
			ftsCount = results.length;
			retrievalResults = [...ftsResults];
		}
		results = mergeFileRefCandidates(store, results, filters, effectiveLimit);
		results = prioritizeDefaultResults(results, effectiveLimit, retrievalContext);

		if (results.length === 0) {
			fallbackUsed = true;
			results = store.recent(effectiveLimit, filters ?? null).map(toMemoryResult);
		}
	}

	// Step 2: categorize results

	// Summary: prefer search match; only inject a global fallback when the user
	// explicitly wants a summary or we're in non-recall mode.
	const directSummaryMatches =
		recallMode && !queryPrefersRecap(retrievalContext)
			? results.filter((item) => isNativeSessionSummaryMemory(item))
			: results.filter(isSummaryLike);
	let summaryItems = directSummaryMatches.slice(0, 1);
	const allowGlobalSummaryFallback = !recallMode || queryPrefersRecap(retrievalContext);
	if (summaryItems.length === 0 && allowGlobalSummaryFallback) {
		const s = findLatestSummaryLike(store, filters);
		if (s) {
			summaryItems = [
				{
					id: s.id,
					kind: s.kind,
					title: s.title,
					body_text: s.body_text,
					confidence: s.confidence ?? 0,
					created_at: s.created_at,
					updated_at: s.updated_at,
					tags_text: s.tags_text ?? "",
					score: 0,
					session_id: s.session_id,
					metadata: s.metadata,
					narrative: s.narrative,
					facts: s.facts,
				},
			];
		}
	}

	let timelineItems = results.filter((r) => !isSummaryLike(r)).slice(0, 3);
	const timelineIds = new Set(timelineItems.map((r) => r.id));

	// Observations: from search results, then fall back to recent by observation kinds
	const OBSERVATION_KINDS = Object.keys(OBSERVATION_KIND_PRIORITY);
	let observationItems = [...results]
		.filter((r) => !isSummaryLike(r) && !timelineIds.has(r.id))
		.sort((a, b) => {
			const pa = OBSERVATION_KIND_PRIORITY[a.kind] ?? 99;
			const pb = OBSERVATION_KIND_PRIORITY[b.kind] ?? 99;
			return pa - pb;
		});

	if (recallMode && observationItems.length === 0) {
		observationItems = results.filter((r) => !isSummaryLike(r));
	}

	if (observationItems.length === 0) {
		const recentObs = store.recentByKinds(
			OBSERVATION_KINDS,
			Math.max(effectiveLimit * 3, 10),
			filters ?? null,
		);
		observationItems = recentObs.map((row) => ({
			id: row.id,
			kind: row.kind,
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
		}));
	}

	if (observationItems.length === 0) {
		observationItems = [...timelineItems];
	}

	// Sort observations by tag overlap with context, then by kind priority
	observationItems = sortByTagOverlap(observationItems, context);

	// Exact dedup across all sections
	const dedupeState: DedupeState = {
		canonicalByKey: new Map(),
		duplicateIds: new Map(),
	};
	const modeLabel: PackTraceMode = taskMode ? "task" : recallMode ? "recall" : "default";
	summaryItems = collapseExactDuplicates(summaryItems, dedupeState);
	timelineItems = collapseExactDuplicates(timelineItems, dedupeState);
	observationItems = collapseExactDuplicates(observationItems, dedupeState);

	const clusterState: ClusterCompressionState = {
		compressedByRepresentative: new Map(),
		representativeByCompressedId: new Map(),
		clusters: [],
	};
	const compressionPoolSeen = new Set<number>();
	const compressionPool: MemoryResult[] = [];
	for (const item of [...summaryItems, ...timelineItems, ...observationItems]) {
		if (compressionPoolSeen.has(item.id)) continue;
		compressionPoolSeen.add(item.id);
		compressionPool.push(item);
	}
	compressClusters(compressionPool, modeLabel, clusterState);
	const compressedSectionIds = new Set(flattenCompressedIds(clusterState));
	summaryItems = summaryItems.filter((item) => !compressedSectionIds.has(item.id));
	timelineItems = timelineItems.filter((item) => !compressedSectionIds.has(item.id));
	observationItems = observationItems.filter((item) => !compressedSectionIds.has(item.id));

	// Step 4: apply token budget
	// Step 5: format sections
	//
	// Compact mode flattens all items into a single list, budgets using
	// index-line costs for items beyond the detail count, and renders a
	// scannable Index + Detail layout instead of Summary/Timeline/Observations.

	const compact = options.compact ?? false;
	const compactDetailCount = options.compactDetailCount ?? DEFAULT_COMPACT_DETAIL_COUNT;

	let budgetedSummary: MemoryResult[];
	let budgetedTimeline: MemoryResult[];
	let budgetedObservations: MemoryResult[];
	let packText: string;

	if (compact) {
		// Flatten all items, dedupe by id, preserve order
		const seen = new Set<number>();
		const allCandidates: MemoryResult[] = [];
		for (const item of [...summaryItems, ...timelineItems, ...observationItems]) {
			if (seen.has(item.id)) continue;
			seen.add(item.id);
			allCandidates.push(item);
		}

		const budgetedItems: MemoryResult[] = [];
		const detailIds = new Set<number>();

		if (tokenBudget != null && tokenBudget > 0) {
			let tokensUsed = 0;
			let detailSlots = compactDetailCount;
			for (const item of allCandidates) {
				const indexCost = estimateTokens(formatIndexLine(item, clusterState));
				if (detailSlots > 0) {
					// Detail items appear in both Index and Detail — charge both.
					const fullCost = indexCost + estimateTokens(formatItem(item, clusterState));
					if (tokensUsed + fullCost <= tokenBudget) {
						tokensUsed += fullCost;
						budgetedItems.push(item);
						detailIds.add(item.id);
						detailSlots--;
						continue;
					}
					// Detail too expensive — demote to index-only below.
				}
				// Index-only: skip if even the index line doesn't fit.
				if (tokensUsed + indexCost > tokenBudget) continue;
				tokensUsed += indexCost;
				budgetedItems.push(item);
			}
		} else {
			budgetedItems.push(...allCandidates);
			for (const item of allCandidates.slice(0, compactDetailCount)) {
				detailIds.add(item.id);
			}
		}

		packText = renderCompactPack(budgetedItems, detailIds, clusterState);
		// For downstream metrics, put everything in timeline (compact flattens sections)
		budgetedSummary = [];
		budgetedTimeline = budgetedItems;
		budgetedObservations = [];
	} else {
		budgetedSummary = summaryItems;
		budgetedTimeline = timelineItems;
		budgetedObservations = observationItems;

		if (tokenBudget != null && tokenBudget > 0) {
			let tokensUsed = 0;

			budgetedSummary = [];
			for (const item of summaryItems) {
				const cost = estimateTokens(formatItem(item, clusterState));
				if (tokensUsed + cost > tokenBudget) break;
				tokensUsed += cost;
				budgetedSummary.push(item);
			}

			budgetedTimeline = [];
			for (const item of timelineItems) {
				const cost = estimateTokens(formatItem(item, clusterState));
				if (tokensUsed + cost > tokenBudget) break;
				tokensUsed += cost;
				budgetedTimeline.push(item);
			}

			budgetedObservations = [];
			for (const item of observationItems) {
				const cost = estimateTokens(formatItem(item, clusterState));
				if (tokensUsed + cost > tokenBudget) break;
				tokensUsed += cost;
				budgetedObservations.push(item);
			}
		}

		const sections = [
			formatSection("Summary", budgetedSummary, clusterState),
			formatSection("Timeline", budgetedTimeline, clusterState),
			formatSection("Observations", budgetedObservations, clusterState),
		];
		packText = sections.join("\n\n");
	}

	const packTokens = estimateTokens(packText);

	// Collect all unique rendered items across sections, but preserve relevance order.
	// `item_ids` should still include compressed-away IDs for fetch-more behavior.
	const seenIds = new Set<number>();
	const selectedById = new Map<number, MemoryResult>();
	for (const item of [...budgetedSummary, ...budgetedTimeline, ...budgetedObservations]) {
		if (seenIds.has(item.id)) continue;
		seenIds.add(item.id);
		selectedById.set(item.id, item);
	}
	const allSelectedIds = new Set<number>();
	for (const representativeId of selectedById.keys()) {
		allSelectedIds.add(representativeId);
		for (const compressedId of clusterState.compressedByRepresentative.get(representativeId) ??
			[]) {
			allSelectedIds.add(compressedId);
		}
	}

	const selectedItems: MemoryResult[] = [];
	const selectedIds = new Set(selectedById.keys());
	const allItemIds: number[] = [];
	const orderedAllSelectedIds = new Set(allSelectedIds);
	for (const item of results) {
		if (orderedAllSelectedIds.has(item.id)) {
			allItemIds.push(item.id);
			orderedAllSelectedIds.delete(item.id);
			for (const compressedId of clusterState.compressedByRepresentative.get(item.id) ?? []) {
				if (!orderedAllSelectedIds.has(compressedId)) continue;
				allItemIds.push(compressedId);
				orderedAllSelectedIds.delete(compressedId);
			}
		}
		if (!selectedIds.has(item.id)) continue;
		const selected = selectedById.get(item.id);
		if (!selected) continue;
		selectedItems.push(selected);
		selectedIds.delete(item.id);
	}
	for (const item of [...budgetedSummary, ...budgetedTimeline, ...budgetedObservations]) {
		if (!selectedIds.has(item.id)) continue;
		selectedItems.push(item);
		selectedIds.delete(item.id);
	}
	for (const item of [...budgetedSummary, ...budgetedTimeline, ...budgetedObservations]) {
		if (!orderedAllSelectedIds.has(item.id)) continue;
		allItemIds.push(item.id);
		orderedAllSelectedIds.delete(item.id);
		for (const compressedId of clusterState.compressedByRepresentative.get(item.id) ?? []) {
			if (!orderedAllSelectedIds.has(compressedId)) continue;
			allItemIds.push(compressedId);
			orderedAllSelectedIds.delete(compressedId);
		}
	}
	for (const cluster of clusterState.clusters) {
		if (!orderedAllSelectedIds.has(cluster.representative_id)) continue;
		allItemIds.push(cluster.representative_id);
		orderedAllSelectedIds.delete(cluster.representative_id);
		for (const compressedId of cluster.compressed_ids) {
			if (!orderedAllSelectedIds.has(compressedId)) continue;
			allItemIds.push(compressedId);
			orderedAllSelectedIds.delete(compressedId);
		}
	}

	const allItems = selectedItems.map((item) => toPackItem(item, dedupeState, clusterState));
	const seenAllItemIds = new Set(allItemIds);
	for (const item of allItems) {
		for (const compressedId of item.compressed_ids ?? []) {
			if (seenAllItemIds.has(compressedId)) continue;
			seenAllItemIds.add(compressedId);
			allItemIds.push(compressedId);
		}
	}

	const { previousPackIds, previousPackTokens } = getPackDeltaBaseline(
		store,
		filters?.project ?? null,
	);
	const packDeltaAvailable = previousPackIds != null && previousPackTokens != null;
	const previousSet = new Set(previousPackIds ?? []);
	const currentSet = new Set(allItemIds);
	const addedIds = packDeltaAvailable ? allItemIds.filter((id) => !previousSet.has(id)) : [];
	const removedIds = packDeltaAvailable
		? (previousPackIds ?? []).filter((id) => !currentSet.has(id))
		: [];
	const retainedIds = packDeltaAvailable ? allItemIds.filter((id) => previousSet.has(id)) : [];
	const packTokenDelta = packDeltaAvailable ? packTokens - (previousPackTokens ?? 0) : 0;

	const workTokens = selectedItems.reduce((sum, item) => sum + estimateWorkTokens(item), 0);
	const groupedWork = new Map<string, number>();
	for (const item of selectedItems) {
		const key = discoveryGroup(item);
		const estimate = estimateWorkTokens(item);
		const existing = groupedWork.get(key) ?? 0;
		if (estimate > existing) groupedWork.set(key, estimate);
	}
	const workTokensUnique = [...groupedWork.values()].reduce((sum, value) => sum + value, 0);
	const tokensSaved = Math.max(0, workTokensUnique - packTokens);

	let avoidedWorkTokensTotal = 0;
	let avoidedKnownItems = 0;
	let avoidedUnknownItems = 0;
	const avoidedWorkSources: Record<string, number> = {};
	for (const item of selectedItems) {
		const avoided = avoidedWorkTokens(item);
		if (avoided.tokens > 0) {
			avoidedWorkTokensTotal += avoided.tokens;
			avoidedKnownItems += 1;
			avoidedWorkSources[avoided.source] = (avoidedWorkSources[avoided.source] ?? 0) + 1;
		} else {
			avoidedUnknownItems += 1;
		}
	}
	const avoidedWorkSaved = Math.max(0, avoidedWorkTokensTotal - packTokens);
	const avoidedWorkRatio =
		avoidedWorkTokensTotal > 0 ? avoidedWorkTokensTotal / Math.max(packTokens, 1) : null;

	const workSources = selectedItems.map(workSource);
	const workUsageItems = workSources.filter((source) => source === "usage").length;
	const workEstimateItems = workSources.length - workUsageItems;
	const workSourceLabel: "estimate" | "usage" | "mixed" =
		workUsageItems > 0 && workEstimateItems > 0
			? "mixed"
			: workUsageItems > 0
				? "usage"
				: "estimate";

	const compressionRatio = workTokensUnique > 0 ? packTokens / workTokensUnique : null;
	const overheadTokens = workTokensUnique > 0 ? packTokens - workTokensUnique : null;
	const fallbackLabel: "recent" | null = fallbackUsed ? "recent" : null;
	const metrics = {
		total_items: allItems.length,
		pack_tokens: packTokens,
		fallback_used: fallbackUsed,
		fallback: fallbackLabel,
		limit: effectiveLimit,
		token_budget: tokenBudget,
		project: filters?.project ?? null,
		pack_item_ids: allItemIds,
		mode: modeLabel,
		added_ids: addedIds,
		removed_ids: removedIds,
		retained_ids: retainedIds,
		pack_token_delta: packTokenDelta,
		pack_delta_available: packDeltaAvailable,
		work_tokens: workTokens,
		work_tokens_unique: workTokensUnique,
		tokens_saved: tokensSaved,
		compression_ratio: compressionRatio,
		overhead_tokens: overheadTokens,
		avoided_work_tokens: avoidedWorkTokensTotal,
		avoided_work_saved: avoidedWorkSaved,
		avoided_work_ratio: avoidedWorkRatio,
		avoided_work_known_items: avoidedKnownItems,
		avoided_work_unknown_items: avoidedUnknownItems,
		avoided_work_sources: avoidedWorkSources,
		work_source: workSourceLabel,
		work_usage_items: workUsageItems,
		work_estimate_items: workEstimateItems,
		savings_reliable:
			avoidedKnownItems + avoidedUnknownItems > 0 ? avoidedKnownItems >= avoidedUnknownItems : true,
		sources: { fts: ftsCount, semantic: semanticCount, fuzzy: 0 },
	};

	const response: PackResponse = {
		context,
		items: allItems,
		item_ids: allItemIds,
		pack_text: packText,
		metrics,
	};

	const sectionsById: Record<PackTraceSection, number[]> = {
		summary: budgetedSummary.map((item) => item.id),
		timeline: budgetedTimeline.map((item) => item.id),
		observations: budgetedObservations.map((item) => item.id),
	};
	const budgetedIds = new Set([...allItemIds]);
	const trimmedIds = [...summaryItems, ...timelineItems, ...observationItems]
		.map((item) => item.id)
		.filter((itemId) => !budgetedIds.has(itemId))
		.sort((a, b) => a - b);
	const dedupedIds = flattenDuplicateIds(dedupeState);
	const dedupedIdSet = new Set(dedupedIds);
	const compressedIds = flattenCompressedIds(clusterState);
	const compressedIdSet = new Set(compressedIds);
	const trimmedIdSet = new Set(trimmedIds);
	const referenceNow = new Date();
	const tracePool = retrievalResults.slice(0, TRACE_CANDIDATE_LIMIT);
	const traceCandidates: PackTraceCandidate[] = tracePool.map((item, index) => {
		const section = traceSection(item.id, sectionsById);
		const disposition: PackTraceDisposition = section
			? "selected"
			: dedupedIdSet.has(item.id)
				? "deduped"
				: compressedIdSet.has(item.id)
					? "compressed"
					: trimmedIdSet.has(item.id)
						? "trimmed"
						: "dropped";
		const baseScores = scoreResult(store, item, filters, retrievalQuery, referenceNow);
		const scoredCandidate = {
			...baseScores,
			text_overlap: textOverlapScore(item, retrievalQuery),
			tag_overlap: countOverlap(item.tags_text, queryContentTokens(retrievalQuery)),
		};
		return {
			id: item.id,
			rank: index + 1,
			kind: item.kind,
			title: item.title,
			preview: preview(item.narrative || item.body_text),
			scores: scoredCandidate,
			reasons: candidateReasons(item, scoredCandidate, section, disposition),
			disposition,
			section,
		};
	});

	const trace: PackTrace = {
		version: 1,
		inputs: {
			query: context,
			project: filters?.project ?? null,
			working_set_files: [...(filters?.working_set_paths ?? [])],
			token_budget: tokenBudget,
			limit: effectiveLimit,
		},
		mode: {
			selected: modeLabel,
			reasons: modeReasons(context, modeLabel, filters),
		},
		retrieval: {
			candidate_count: traceCandidates.length,
			candidates: traceCandidates,
		},
		assembly: {
			deduped_ids: dedupedIds,
			collapsed_groups: collapsedGroups(dedupeState),
			compressed_clusters: clusterState.clusters,
			trimmed_ids: trimmedIds,
			trim_reasons:
				trimmedIds.length > 0
					? ["token budget exceeded; lower-priority items dropped after section ordering"]
					: [],
			sections: sectionsById,
		},
		output: {
			estimated_tokens: packTokens,
			truncated: trimmedIds.length > 0,
			section_counts: {
				summary: sectionsById.summary.length,
				timeline: sectionsById.timeline.length,
				observations: sectionsById.observations.length,
			},
			pack_text: packText,
		},
	};

	if (options.recordUsage) {
		recordPackUsage(store, metrics);
	}

	return { response, trace };
}

export function buildMemoryPack(
	store: StoreHandle,
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
	semanticResults?: MemoryResult[],
	renderOptions?: PackRenderOptions,
): PackResponse {
	return buildPackArtifacts(store, context, limit, tokenBudget, filters, semanticResults, {
		recordUsage: true,
		compact: renderOptions?.compact,
		compactDetailCount: renderOptions?.compactDetailCount,
	}).response;
}

export function buildMemoryPackTrace(
	store: StoreHandle,
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
	semanticResults?: MemoryResult[],
	renderOptions?: PackRenderOptions,
): PackTrace {
	return buildPackArtifacts(store, context, limit, tokenBudget, filters, semanticResults, {
		recordUsage: false,
		compact: renderOptions?.compact,
		compactDetailCount: renderOptions?.compactDetailCount,
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
): Promise<PackResponse> {
	// Run semantic search (returns [] when embeddings unavailable)
	let semResults: MemoryResult[] = [];
	const semanticQuery = sanitizeSearchQuery(context).clean_query;
	try {
		const raw = await semanticSearch(store.db, semanticQuery, limit, {
			project: filters?.project,
		});
		semResults = semanticMemoryResults(raw);
	} catch {
		// Semantic search failure is non-fatal — fall through to FTS-only
	}

	return buildPackArtifacts(store, context, limit, tokenBudget, filters, semResults, {
		recordUsage: true,
		compact: renderOptions?.compact,
		compactDetailCount: renderOptions?.compactDetailCount,
	}).response;
}

export async function buildMemoryPackTraceAsync(
	store: StoreHandle & { db: Database },
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
	renderOptions?: PackRenderOptions,
): Promise<PackTrace> {
	let semResults: MemoryResult[] = [];
	const semanticQuery = sanitizeSearchQuery(context).clean_query;
	try {
		const raw = await semanticSearch(store.db, semanticQuery, limit, {
			project: filters?.project,
		});
		semResults = semanticMemoryResults(raw);
	} catch {
		// Semantic search failure is non-fatal — fall through to FTS-only
	}

	return buildPackArtifacts(store, context, limit, tokenBudget, filters, semResults, {
		recordUsage: false,
		compact: renderOptions?.compact,
		compactDetailCount: renderOptions?.compactDetailCount,
	}).trace;
}
