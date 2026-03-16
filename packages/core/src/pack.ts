/**
 * Memory pack builder — simplified port of codemem/store/packs.py.
 *
 * Builds a formatted "memory pack" from search results, organized into
 * sections (summary, timeline, observations) with token budgeting.
 *
 * NOT ported: semantic search, fuzzy search, task/recall mode detection,
 * _merge_ranked_results, exact dedup, pack delta tracking.
 */

import type { StoreHandle } from "./search.js";
import { search } from "./search.js";
import type { MemoryFilters, MemoryResult, PackItem, PackResponse } from "./types.js";

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
export function buildMemoryPack(
	store: StoreHandle,
	context: string,
	limit = 10,
	tokenBudget: number | null = null,
	filters?: MemoryFilters,
): PackResponse {
	const effectiveLimit = Math.max(1, Math.trunc(limit));
	let fallbackUsed = false;
	let ftsCount = 0;

	// Step 1: search for matching memories
	let results = search(store, context, effectiveLimit, filters);
	ftsCount = results.length;

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
	const observationItems = [...results]
		.filter((r) => r.kind !== "session_summary")
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
			sources: { fts: ftsCount, semantic: 0, fuzzy: 0 },
		},
	};
}
