/**
 * FTS5 full-text search for memory items.
 *
 * Port of codemem/store/search.py — focused subset:
 * expandQuery, search, recencyScore, kindBonus, rerankResults,
 * timeline, explain.
 *
 * NOT ported: semantic/vector search, shared widening, personal_bias,
 * trust_penalty, working_set boosting, shadow logging, pack context.
 */

import { fromJson } from "./db.js";
import { buildFilterClauses } from "./filters.js";
import type { MemoryFilters, MemoryResult } from "./types.js";

// ---------------------------------------------------------------------------
// Types — MemoryStore is referenced structurally to avoid circular imports.
// search.ts takes a store param; store.ts imports the search function.
// ---------------------------------------------------------------------------

/** Structural type for the store parameter (avoids circular import). */
export interface StoreHandle {
	readonly db: import("better-sqlite3").Database;
	get(memoryId: number): Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Constants (mirrors codemem/memory_kinds.py MEMORY_KIND_BONUS)
// ---------------------------------------------------------------------------

const MEMORY_KIND_BONUS: Record<string, number> = {
	session_summary: 0.25,
	decision: 0.2,
	feature: 0.18,
	bugfix: 0.18,
	refactor: 0.17,
	note: 0.15,
	change: 0.12,
	discovery: 0.12,
	observation: 0.1,
	exploration: 0.1,
	entities: 0.05,
};

/** FTS5 operators that must be stripped from user queries. */
const FTS5_OPERATORS = new Set(["or", "and", "not", "near", "phrase"]);

// ---------------------------------------------------------------------------
// expandQuery
// ---------------------------------------------------------------------------

/**
 * Expand a user query string into an FTS5 MATCH expression.
 *
 * Extracts alphanumeric tokens, filters out FTS5 operators,
 * and joins multiple tokens with OR for broader matching.
 */
export function expandQuery(query: string): string {
	const rawTokens = query.match(/[A-Za-z0-9_]+/g);
	if (!rawTokens) return "";
	const tokens = rawTokens.filter((t) => !FTS5_OPERATORS.has(t.toLowerCase()));
	if (tokens.length === 0) return "";
	if (tokens.length === 1) return tokens[0] as string;
	return tokens.join(" OR ");
}

// ---------------------------------------------------------------------------
// recencyScore
// ---------------------------------------------------------------------------

/**
 * Compute a recency score for a memory based on its creation timestamp.
 *
 * Returns a value in (0, 1] where 1.0 means "just created" and the
 * score decays with a 7-day half-life: score = 1 / (1 + days_ago / 7).
 */
export function recencyScore(createdAt: string, now?: Date): number {
	const parsed = Date.parse(createdAt);
	if (Number.isNaN(parsed)) return 0.0;

	const referenceNow = now ?? new Date();
	// Use Math.floor to match Python's timedelta.days (integer truncation).
	const ageDays = Math.max(0, Math.floor((referenceNow.getTime() - parsed) / 86_400_000));
	return 1.0 / (1.0 + ageDays / 7.0);
}

// ---------------------------------------------------------------------------
// kindBonus
// ---------------------------------------------------------------------------

/**
 * Return a scoring bonus for a memory kind.
 *
 * Higher-signal kinds (decisions, features) get a larger bonus.
 * Unknown or null kinds return 0.
 */
export function kindBonus(kind: string | null): number {
	if (!kind) return 0.0;
	return MEMORY_KIND_BONUS[kind.trim().toLowerCase()] ?? 0.0;
}

// ---------------------------------------------------------------------------
// rerankResults
// ---------------------------------------------------------------------------

/**
 * Re-rank search results by combining BM25 score, recency, and kind bonus.
 *
 * Simplified version: does not apply personal_bias or trust_penalty
 * (those require actor resolution, deferred to a follow-up).
 */
export function rerankResults(results: MemoryResult[], limit: number): MemoryResult[] {
	const referenceNow = new Date();

	const scored = results.map((item) => ({
		item,
		combinedScore:
			item.score * 1.5 + recencyScore(item.created_at, referenceNow) + kindBonus(item.kind),
	}));

	scored.sort((a, b) => b.combinedScore - a.combinedScore);

	return scored.slice(0, limit).map((s) => s.item);
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * Execute an FTS5 full-text search against memory_items.
 *
 * Port of Python's _search_once — the core BM25 search path.
 * Uses expandQuery to prepare the MATCH expression, applies filters
 * via buildFilterClauses, and re-ranks results.
 */
export function search(
	store: StoreHandle,
	query: string,
	limit = 10,
	filters?: MemoryFilters,
): MemoryResult[] {
	const effectiveLimit = Math.max(1, Math.trunc(limit));
	const expanded = expandQuery(query);
	if (!expanded) return [];

	// Widen the SQL candidate set before reranking (matches Python's _search_once).
	// Reranking adds kindBonus which can promote items that SQL ordering missed.
	const queryLimit = Math.min(Math.max(effectiveLimit * 4, effectiveLimit + 8), 200);

	const params: unknown[] = [expanded];
	const whereClauses = ["memory_items.active = 1", "memory_fts MATCH ?"];

	const filterResult = buildFilterClauses(filters);
	whereClauses.push(...filterResult.clauses);
	params.push(...filterResult.params);

	const where = whereClauses.join(" AND ");
	const joinClause = filterResult.joinSessions
		? "JOIN sessions ON sessions.id = memory_items.session_id"
		: "";

	const sql = `
		SELECT memory_items.*,
			-bm25(memory_fts, 1.0, 1.0, 0.25) AS score,
			(1.0 / (1.0 + ((julianday('now') - julianday(memory_items.created_at)) / 7.0))) AS recency
		FROM memory_fts
		JOIN memory_items ON memory_items.id = memory_fts.rowid
		${joinClause}
		WHERE ${where}
		ORDER BY (score * 1.5 + recency) DESC, memory_items.created_at DESC, memory_items.id DESC
		LIMIT ?
	`;
	params.push(queryLimit);

	const rows = store.db.prepare(sql).all(...params) as Record<string, unknown>[];

	const results: MemoryResult[] = rows.map((row) => {
		const metadata: Record<string, unknown> = {
			...fromJson(row.metadata_json as string | null),
		};

		// Propagate files_modified into metadata when stored as a JSON array
		if (row.files_modified && typeof row.files_modified === "string") {
			try {
				const parsed: unknown = JSON.parse(row.files_modified as string);
				if (Array.isArray(parsed)) {
					metadata.files_modified ??= parsed;
				}
			} catch {
				// not valid JSON — ignore
			}
		}

		return {
			id: row.id as number,
			kind: row.kind as string,
			title: row.title as string,
			body_text: row.body_text as string,
			confidence: row.confidence as number,
			created_at: row.created_at as string,
			updated_at: row.updated_at as string,
			tags_text: (row.tags_text as string) ?? "",
			score: Number(row.score),
			session_id: row.session_id as number,
			metadata,
		};
	});

	return rerankResults(results, effectiveLimit);
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

/**
 * Return a chronological window of memories around an anchor.
 *
 * Port of Python's timeline() + _timeline_around() from search.py.
 * Finds an anchor by memoryId or query, then fetches neighbors in the
 * same session ordered by created_at.
 *
 * NOT ported: usage tracking (record_usage), _attach_prompt_links.
 */
export function timeline(
	store: StoreHandle,
	query?: string | null,
	memoryId?: number | null,
	depthBefore = 3,
	depthAfter = 3,
	filters?: MemoryFilters | null,
): Record<string, unknown>[] {
	// Find anchor: prefer explicit memoryId, fall back to search
	let anchor: Record<string, unknown> | null = null;
	if (memoryId != null) {
		anchor = store.get(memoryId);
	}
	if (anchor == null && query) {
		const matches = search(store, query, 1, filters ?? undefined);
		if (matches.length > 0) {
			// Convert MemoryResult to dict-like shape for consistency
			const m = matches[0] as MemoryResult;
			anchor = {
				id: m.id,
				session_id: m.session_id,
				created_at: m.created_at,
			};
		}
	}
	if (anchor == null) {
		return [];
	}

	return timelineAround(store, anchor, depthBefore, depthAfter, filters);
}

/**
 * Internal: fetch memories before/after an anchor within the same session.
 *
 * Port of Python's _timeline_around().
 */
function timelineAround(
	store: StoreHandle,
	anchor: Record<string, unknown>,
	depthBefore: number,
	depthAfter: number,
	filters?: MemoryFilters | null,
): Record<string, unknown>[] {
	const anchorId = anchor.id as number | undefined;
	const anchorCreatedAt = anchor.created_at as string | undefined;
	const anchorSessionId = anchor.session_id as number | undefined;

	if (!anchorId || !anchorCreatedAt) {
		return [];
	}

	const filterResult = buildFilterClauses(filters);
	const whereParts = ["memory_items.active = 1", ...filterResult.clauses];
	const baseParams = [...filterResult.params];

	if (anchorSessionId) {
		whereParts.push("memory_items.session_id = ?");
		baseParams.push(anchorSessionId);
	}

	const whereClause = whereParts.join(" AND ");
	const joinClause = filterResult.joinSessions
		? "JOIN sessions ON sessions.id = memory_items.session_id"
		: "";

	// Before: older memories, descending (we'll reverse later)
	const beforeRows = store.db
		.prepare(
			`SELECT memory_items.*
			 FROM memory_items
			 ${joinClause}
			 WHERE ${whereClause} AND memory_items.created_at < ?
			 ORDER BY memory_items.created_at DESC
			 LIMIT ?`,
		)
		.all(...baseParams, anchorCreatedAt, depthBefore) as Record<string, unknown>[];

	// After: newer memories, ascending
	const afterRows = store.db
		.prepare(
			`SELECT memory_items.*
			 FROM memory_items
			 ${joinClause}
			 WHERE ${whereClause} AND memory_items.created_at > ?
			 ORDER BY memory_items.created_at ASC
			 LIMIT ?`,
		)
		.all(...baseParams, anchorCreatedAt, depthAfter) as Record<string, unknown>[];

	// Re-fetch anchor row to get full columns (anchor from search may be partial)
	const anchorRow = store.db
		.prepare("SELECT * FROM memory_items WHERE id = ? AND active = 1")
		.get(anchorId) as Record<string, unknown> | undefined;

	// Combine: reversed(before) + anchor + after
	const rows: Record<string, unknown>[] = [...beforeRows.reverse()];
	if (anchorRow) {
		rows.push(anchorRow);
	}
	rows.push(...afterRows);

	// Parse metadata_json and add linked_prompt stub on each row.
	// linked_prompt is set by Python's _attach_prompt_links — not yet ported,
	// but the field must exist for MCP response shape stability.
	return rows.map((row) => ({
		...row,
		metadata_json: fromJson(row.metadata_json as string | null),
		linked_prompt: null,
	}));
}

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

/**
 * Deduplicate an array of IDs, preserving order. Returns valid int IDs
 * and a list of values that could not be parsed as integers.
 */
function dedupeOrderedIds(ids: unknown[]): { ordered: number[]; invalid: string[] } {
	const seen = new Set<number>();
	const ordered: number[] = [];
	const invalid: string[] = [];

	for (const rawId of ids) {
		// Reject booleans and floats explicitly (matches Python behavior)
		if (typeof rawId === "boolean" || (typeof rawId === "number" && !Number.isInteger(rawId))) {
			invalid.push(String(rawId));
			continue;
		}
		const parsed = Number(rawId);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			invalid.push(String(rawId));
			continue;
		}
		if (seen.has(parsed)) continue;
		seen.add(parsed);
		ordered.push(parsed);
	}

	return { ordered, invalid };
}

/**
 * Build an explain payload for a single memory item.
 *
 * Port of Python's _explain_item() — simplified: no personal_bias,
 * no project matching, no pack context, no semantic_boost.
 */
function explainItem(
	item: MemoryResult,
	source: string,
	rank: number | null,
	queryTokens: string[],
	referenceNow: Date,
): Record<string, unknown> {
	const text = `${item.title} ${item.body_text} ${item.tags_text}`.toLowerCase();
	const matchedTerms = queryTokens.filter((token) => text.includes(token));

	const baseScore: number | null =
		source === "query" || source === "query+id_lookup" ? item.score : null;
	const recencyComponent = recencyScore(item.created_at, referenceNow);
	const kindComponent = kindBonus(item.kind);

	let totalScore: number | null = null;
	if (baseScore != null) {
		totalScore = baseScore * 1.5 + recencyComponent + kindComponent;
	}

	return {
		id: item.id,
		kind: item.kind,
		title: item.title,
		created_at: item.created_at,
		project: null, // TODO: port project lookup via session
		retrieval: {
			source,
			rank,
		},
		score: {
			total: totalScore,
			components: {
				base: baseScore,
				recency: recencyComponent,
				kind_bonus: kindComponent,
				personal_bias: 0.0,
				semantic_boost: null,
			},
		},
		matches: {
			query_terms: matchedTerms,
			project_match: null, // TODO: port _project_matches_filter
		},
		pack_context: null, // TODO: port include_pack_context
	};
}

/**
 * Check whether a row matches the given filters (client-side enforcement).
 * Used for ID-based lookups in explain() to enforce the same scope as query results.
 */
function rowMatchesFilters(row: Record<string, unknown>, filters: MemoryFilters): boolean {
	if (filters.kind && row.kind !== filters.kind) return false;
	if (filters.include_visibility?.length) {
		if (!filters.include_visibility.includes(row.visibility as string)) return false;
	}
	if (filters.exclude_visibility?.length) {
		if (row.visibility != null && filters.exclude_visibility.includes(row.visibility as string))
			return false;
	}
	if (filters.include_actor_ids?.length) {
		if (!filters.include_actor_ids.includes(row.actor_id as string)) return false;
	}
	if (filters.exclude_actor_ids?.length) {
		if (row.actor_id != null && filters.exclude_actor_ids.includes(row.actor_id as string))
			return false;
	}
	if (filters.include_workspace_kinds?.length) {
		if (!filters.include_workspace_kinds.includes(row.workspace_kind as string)) return false;
	}
	if (filters.exclude_workspace_kinds?.length) {
		if (
			row.workspace_kind != null &&
			filters.exclude_workspace_kinds.includes(row.workspace_kind as string)
		)
			return false;
	}
	if (filters.include_trust_states?.length) {
		if (!filters.include_trust_states.includes(row.trust_state as string)) return false;
	}
	if (filters.exclude_trust_states?.length) {
		if (row.trust_state != null && filters.exclude_trust_states.includes(row.trust_state as string))
			return false;
	}
	return true;
}

/**
 * Explain search results with scoring breakdown.
 *
 * Port of Python's explain() from search.py. Accepts a query and/or
 * explicit IDs, merges results, and returns a detailed scoring payload
 * for each item.
 *
 * NOT ported: usage tracking, project mismatch checks, pack context,
 * _attach_prompt_links, personal_bias, semantic_boost.
 */
export function explain(
	store: StoreHandle,
	query?: string | null,
	ids?: unknown[] | null,
	limit = 10,
	filters?: MemoryFilters | null,
): Record<string, unknown> {
	const normalizedQuery = (query ?? "").trim();
	const { ordered: orderedIds, invalid: invalidIds } = dedupeOrderedIds(ids ?? []);

	const errors: Record<string, unknown>[] = [];
	if (invalidIds.length > 0) {
		errors.push({
			code: "INVALID_ARGUMENT",
			field: "ids",
			message: "some ids are not valid integers",
			ids: invalidIds,
		});
	}

	// Require at least one of query or ids
	if (!normalizedQuery && orderedIds.length === 0) {
		errors.push({
			code: "INVALID_ARGUMENT",
			field: "query",
			message: "at least one of query or ids is required",
		});
		return {
			items: [],
			missing_ids: [],
			errors,
			metadata: {
				query: null,
				requested_ids_count: orderedIds.length,
				returned_items_count: 0,
			},
		};
	}

	// Query-based results
	let queryResults: MemoryResult[] = [];
	if (normalizedQuery) {
		queryResults = search(
			store,
			normalizedQuery,
			Math.max(1, Math.trunc(limit)),
			filters ?? undefined,
		);
	}

	// Build rank map for query results
	const queryRank = new Map<number, number>();
	for (let i = 0; i < queryResults.length; i++) {
		queryRank.set((queryResults[i] as MemoryResult).id, i + 1);
	}

	// Load items by explicit IDs, enforcing the same filters as query-based results.
	const idLookup = new Map<number, MemoryResult>();
	const missingNotFound: number[] = [];
	const missingFilterMismatch: number[] = [];
	for (const memId of orderedIds) {
		const row = store.get(memId);
		if (!row || (row.active as number) === 0) {
			missingNotFound.push(memId);
			continue;
		}
		// Check that the row passes the same filters applied to query results.
		if (filters && !rowMatchesFilters(row, filters)) {
			missingFilterMismatch.push(memId);
			continue;
		}
		idLookup.set(memId, {
			id: row.id as number,
			kind: row.kind as string,
			title: row.title as string,
			body_text: row.body_text as string,
			confidence: (row.confidence as number) ?? 0,
			created_at: row.created_at as string,
			updated_at: row.updated_at as string,
			tags_text: (row.tags_text as string) ?? "",
			score: 0,
			session_id: row.session_id as number,
			metadata:
				typeof row.metadata_json === "object" && row.metadata_json != null
					? (row.metadata_json as Record<string, unknown>)
					: fromJson(row.metadata_json as string | null),
		});
	}

	// Merge: query results first, then id-lookup results not already seen
	const explicitIdSet = new Set(orderedIds);
	const selectedIds = new Set<number>();
	const orderedItems: Array<{ item: MemoryResult; source: string; rank: number | null }> = [];

	for (const item of queryResults) {
		selectedIds.add(item.id);
		const source = explicitIdSet.has(item.id) ? "query+id_lookup" : "query";
		orderedItems.push({ item, source, rank: queryRank.get(item.id) ?? null });
	}

	for (const memId of orderedIds) {
		if (selectedIds.has(memId)) continue;
		const item = idLookup.get(memId);
		if (!item) continue;
		orderedItems.push({ item, source: "id_lookup", rank: null });
		selectedIds.add(memId);
	}

	// Tokenize query for term matching
	const queryTokens = normalizedQuery
		? (normalizedQuery.match(/[A-Za-z0-9_]+/g) ?? []).map((t) => t.toLowerCase())
		: [];

	const referenceNow = new Date();
	const itemsPayload = orderedItems.map(({ item, source, rank }) =>
		explainItem(item, source, rank, queryTokens, referenceNow),
	);

	// Collect all missing IDs (requested but not returned)
	const missingIds = orderedIds.filter((id) => !selectedIds.has(id));

	if (missingNotFound.length > 0) {
		errors.push({
			code: "NOT_FOUND",
			field: "ids",
			message: "some requested ids were not found",
			ids: missingNotFound,
		});
	}
	if (missingFilterMismatch.length > 0) {
		errors.push({
			code: "FILTER_MISMATCH",
			field: "filters",
			message: "some requested ids do not match the provided filters",
			ids: missingFilterMismatch,
		});
	}

	return {
		items: itemsPayload,
		missing_ids: missingIds,
		errors,
		metadata: {
			query: normalizedQuery || null,
			project: null, // TODO: port project filter
			requested_ids_count: orderedIds.length,
			returned_items_count: itemsPayload.length,
			include_pack_context: false,
		},
	};
}
