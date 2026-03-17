/**
 * Memory pack builder — port of codemem/store/packs.py.
 *
 * Builds a formatted "memory pack" from search results, organized into
 * sections (summary, timeline, observations) with token budgeting.
 *
 * Semantic candidate merging is supported via `buildMemoryPackAsync` or
 * by passing pre-computed semantic results to `buildMemoryPack`.
 *
 * NOT ported: fuzzy search, task/recall mode detection, exact dedup,
 * pack delta tracking.
 */

import type { Database } from "./db.js";
import type { StoreHandle } from "./search.js";
import { search } from "./search.js";
import type { MemoryFilters, MemoryResult, PackItem, PackResponse } from "./types.js";
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough token estimate: ~4 chars per token (matches Python heuristic). */
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
	if (items.length === 0) return "";
	const lines = [`## ${header}`, ...items.map(formatItem)];
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Pack item shape (what goes into items array)
// ---------------------------------------------------------------------------

function toPackItem(result: MemoryResult): PackItem {
	return {
		id: result.id,
		kind: result.kind,
		title: result.title,
		body: result.body_text,
		confidence: result.confidence,
		tags: result.tags_text,
		metadata: result.metadata,
	};
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
	ftsResults: MemoryResult[],
	semanticResults: MemoryResult[],
	limit: number,
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
	// Sort by score descending, then truncate to limit
	const merged = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
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

	// Step 1: search for matching memories (FTS)
	const ftsResults = search(store, context, effectiveLimit, filters);

	// Step 1b: merge semantic candidates when provided
	let results: MemoryResult[];
	if (semanticResults && semanticResults.length > 0) {
		const merge = mergeResults(ftsResults, semanticResults, effectiveLimit);
		results = merge.merged;
		ftsCount = merge.ftsCount;
		semanticCount = merge.semanticCount;
	} else {
		results = ftsResults;
		ftsCount = results.length;
	}

	// Step 3: fall back to recent if no search results
	if (results.length === 0) {
		fallbackUsed = true;
		const recentRows = store.recent(effectiveLimit, filters ?? null);
		results = recentRows.map((row) => ({
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

	// Step 2: categorize results
	const summaryItems = results.filter((r) => r.kind === "session_summary").slice(0, 1);
	const timelineItems = results.filter((r) => r.kind !== "session_summary").slice(0, 3);
	const timelineIds = new Set(timelineItems.map((r) => r.id));
	const observationItems = [...results]
		.filter((r) => r.kind !== "session_summary" && !timelineIds.has(r.id))
		.sort((a, b) => {
			const pa = OBSERVATION_KIND_PRIORITY[a.kind] ?? 99;
			const pb = OBSERVATION_KIND_PRIORITY[b.kind] ?? 99;
			return pa - pb;
		});

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
	].filter((s) => s.length > 0);

	const packText = sections.join("\n\n");

	// Collect all unique items across sections
	const seenIds = new Set<number>();
	const allItems: PackItem[] = [];
	const allItemIds: number[] = [];
	for (const item of [...budgetedSummary, ...budgetedTimeline, ...budgetedObservations]) {
		if (seenIds.has(item.id)) continue;
		seenIds.add(item.id);
		allItems.push(toPackItem(item));
		allItemIds.push(item.id);
	}

	return {
		context,
		items: allItems,
		item_ids: allItemIds,
		pack_text: packText,
		metrics: {
			total_items: allItems.length,
			pack_tokens: estimateTokens(packText),
			fallback_used: fallbackUsed,
			sources: { fts: ftsCount, semantic: semanticCount, fuzzy: 0 },
		},
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
