/**
 * FTS5 full-text search for memory items.
 *
 * Port of codemem/store/search.py — focused subset:
 * expandQuery, search, recencyScore, kindBonus, rerankResults.
 *
 * NOT ported: semantic/vector search, shared widening, personal_bias,
 * trust_penalty, working_set boosting, shadow logging.
 */

import { fromJson } from "./db.js";
import { buildFilterClauses } from "./filters.js";
import type { MemoryFilters, MemoryResult } from "./types.js";

// ---------------------------------------------------------------------------
// Types — MemoryStore is referenced structurally to avoid circular imports.
// search.ts takes a store param; store.ts imports the search function.
// ---------------------------------------------------------------------------

/** Structural type for the store parameter (avoids circular import). */
interface StoreHandle {
	readonly db: import("better-sqlite3").Database;
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
