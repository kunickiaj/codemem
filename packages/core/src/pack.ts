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
import { memoryLooksRecapLike, queryPrefersRecap } from "./recap-policy.js";
import type { StoreHandle } from "./search.js";
import { rerankResults, search, timeline } from "./search.js";
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
	PackResponse,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Format a single memory item as a pack line. */
function formatItem(item: MemoryResult): string {
	const parts = [`[${item.id}]`, `(${item.kind})`, item.title];
	if (item.body_text) {
		parts.push("-", item.body_text);
	}
	return parts.join(" ");
}

/** Build a formatted section with header and items. */
function formatSection(header: string, items: MemoryResult[]): string {
	const heading = `## ${header}`;
	if (items.length === 0) return `${heading}\n`;
	return [heading, ...items.map(formatItem)].join("\n");
}

// ---------------------------------------------------------------------------
// Pack item shape (what goes into items array)
// ---------------------------------------------------------------------------

function toPackItem(result: MemoryResult, dedupeState?: DedupeState): PackItem {
	const dupes = dedupeState?.duplicateIds.get(result.id);
	const item: PackItem = {
		id: result.id,
		kind: result.kind,
		title: result.title,
		body: result.body_text,
		confidence: result.confidence,
		tags: result.tags_text,
		metadata: result.metadata,
	};
	if (dupes && dupes.size > 0) {
		item.support_count = 1 + dupes.size;
		item.duplicate_ids = [...dupes].sort((a, b) => a - b);
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

export function buildMemoryPack(
	store: StoreHandle,
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
	semanticResults?: MemoryResult[],
): PackResponse {
	const effectiveLimit = Math.max(1, Math.trunc(limit));
	let fallbackUsed = false;
	let ftsCount = 0;
	let semanticCount = 0;
	let results: MemoryResult[];
	const taskMode = queryLooksLikeTasks(context);
	const recallMode = !taskMode && queryLooksLikeRecall(context);

	if (taskMode) {
		const taskQuery = `${context} ${TASK_HINT_QUERY}`.trim();
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
				context,
			);
		}
	} else if (recallMode) {
		const recallQuery = context.trim().length > 0 ? context : RECALL_HINT_QUERY;
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
				}
			}
		}
		if (recallResults.length === 0) {
			recallResults = search(store, RECALL_HINT_QUERY, effectiveLimit, filters).filter(
				isSummaryLike,
			);
			ftsCount = recallResults.length;
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
		results = prioritizeRecallResults(recallResults, effectiveLimit, preferSummary, context);
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
		const ftsResults = search(store, context, effectiveLimit, filters);
		if (semanticResults && semanticResults.length > 0) {
			const merge = mergeResults(
				store,
				ftsResults,
				semanticResults,
				effectiveLimit,
				context,
				filters,
			);
			results = prioritizeDefaultResults(merge.merged, effectiveLimit, context);
			ftsCount = merge.ftsCount;
			semanticCount = merge.semanticCount;
		} else {
			results = prioritizeDefaultResults(ftsResults, effectiveLimit, context);
			ftsCount = results.length;
		}
		if (results.length === 0) {
			fallbackUsed = true;
			results = store.recent(effectiveLimit, filters ?? null).map(toMemoryResult);
		}
	}

	// Step 2: categorize results

	// Summary: prefer search match; only inject a global fallback when the user
	// explicitly wants a summary or we're in non-recall mode.
	const directSummaryMatches =
		recallMode && !queryPrefersRecap(context)
			? results.filter((item) => isNativeSessionSummaryMemory(item))
			: results.filter(isSummaryLike);
	let summaryItems = directSummaryMatches.slice(0, 1);
	const allowGlobalSummaryFallback = !recallMode || queryPrefersRecap(context);
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
	summaryItems = collapseExactDuplicates(summaryItems, dedupeState);
	timelineItems = collapseExactDuplicates(timelineItems, dedupeState);
	observationItems = collapseExactDuplicates(observationItems, dedupeState);

	// Step 4: apply token budget
	let budgetedSummary = summaryItems;
	let budgetedTimeline = timelineItems;
	let budgetedObservations = observationItems;

	if (tokenBudget != null && tokenBudget > 0) {
		let tokensUsed = 0;

		budgetedSummary = [];
		for (const item of summaryItems) {
			const cost = estimateTokens(formatItem(item));
			if (tokensUsed + cost > tokenBudget) break;
			tokensUsed += cost;
			budgetedSummary.push(item);
		}

		budgetedTimeline = [];
		for (const item of timelineItems) {
			const cost = estimateTokens(formatItem(item));
			if (tokensUsed + cost > tokenBudget) break;
			tokensUsed += cost;
			budgetedTimeline.push(item);
		}

		budgetedObservations = [];
		for (const item of observationItems) {
			const cost = estimateTokens(formatItem(item));
			if (tokensUsed + cost > tokenBudget) break;
			tokensUsed += cost;
			budgetedObservations.push(item);
		}
	}

	// Step 5: format sections
	const sections = [
		formatSection("Summary", budgetedSummary),
		formatSection("Timeline", budgetedTimeline),
		formatSection("Observations", budgetedObservations),
	];

	const packText = sections.join("\n\n");
	const packTokens = estimateTokens(packText);

	// Collect all unique items across sections, but preserve relevance order from
	// the ranked results when reporting item_ids/items.
	const seenIds = new Set<number>();
	const selectedById = new Map<number, MemoryResult>();
	for (const item of [...budgetedSummary, ...budgetedTimeline, ...budgetedObservations]) {
		if (seenIds.has(item.id)) continue;
		seenIds.add(item.id);
		selectedById.set(item.id, item);
	}

	const selectedItems: MemoryResult[] = [];
	const selectedIds = new Set(selectedById.keys());
	for (const item of results) {
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

	const allItems = selectedItems.map((item) => toPackItem(item, dedupeState));
	const allItemIds = selectedItems.map((item) => item.id);

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
	const modeLabel: "default" | "task" | "recall" = taskMode
		? "task"
		: recallMode
			? "recall"
			: "default";

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

	recordPackUsage(store, metrics);

	return {
		context,
		items: allItems,
		item_ids: allItemIds,
		pack_text: packText,
		metrics,
	};
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
): Promise<PackResponse> {
	// Run semantic search (returns [] when embeddings unavailable)
	let semResults: MemoryResult[] = [];
	try {
		const raw = await semanticSearch(store.db, context, limit, {
			project: filters?.project,
		});
		semResults = raw.map((r) => {
			// Parse metadata_json if present, matching FTS result shape
			let metadata: Record<string, unknown> = {};
			if (r.metadata_json) {
				try {
					const parsed = JSON.parse(r.metadata_json) as unknown;
					if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
						metadata = parsed as Record<string, unknown>;
					}
				} catch {
					// Invalid JSON metadata — use empty object
				}
			}
			return {
				id: r.id,
				kind: r.kind,
				title: r.title,
				body_text: r.body_text,
				confidence: r.confidence,
				created_at: r.created_at,
				updated_at: r.updated_at,
				tags_text: r.tags_text,
				score: r.score,
				session_id: r.session_id,
				metadata,
			};
		});
	} catch {
		// Semantic search failure is non-fatal — fall through to FTS-only
	}

	return buildMemoryPack(store, context, limit, tokenBudget, filters, semResults);
}
