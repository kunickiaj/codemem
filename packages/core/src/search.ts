/**
 * FTS5 full-text search, timeline, and explain for memory items.
 *
 * FTS5 MATCH queries and BM25 scoring use raw SQL (Drizzle has no FTS5 support).
 * Simple queries (anchor lookup, batch ID fetch, session projects) use Drizzle typed queries.
 * Dynamic filter queries use raw SQL since the filter builder returns SQL strings.
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import { fromJson } from "./db.js";
import {
	buildFilterClausesWithContext,
	normalizeFilterStrings,
	normalizeVisibilityValues,
	normalizeWorkspaceKinds,
} from "./filters.js";
import { parsePositiveMemoryId } from "./integers.js";
import { inferMemoryRole } from "./memory-quality.js";
import { projectMatchesFilter } from "./project.js";
import { sanitizeSearchQuery } from "./query-sanitizer.js";
import { memoryLooksRecapLike, queryPrefersRecap, recapPenaltyMultiplier } from "./recap-policy.js";
import { findByConcept, findByFile } from "./ref-queries.js";
import * as schema from "./schema.js";
import { canonicalMemoryKind } from "./summary-memory.js";
import type {
	ExplainError,
	ExplainItem,
	ExplainResponse,
	MemoryFilters,
	MemoryItem,
	MemoryItemResponse,
	MemoryResult,
	PackTraceCandidateScores,
	TimelineItemResponse,
} from "./types.js";

export interface ExplainOptions {
	includePackContext?: boolean;
}

/** Lazily wrap a better-sqlite3 Database in a Drizzle ORM instance. */
function getDrizzle(db: Database) {
	return drizzle(db, { schema });
}

/** Structural type for the store parameter (avoids circular import). */
export interface StoreHandle {
	readonly db: import("better-sqlite3").Database;
	readonly actorId: string;
	readonly deviceId: string;
	get(memoryId: number): MemoryItemResponse | null;
	memoryOwnedBySelf(item: MemoryItem | MemoryResult | Record<string, unknown>): boolean;
	recent(limit?: number, filters?: MemoryFilters | null, offset?: number): MemoryItemResponse[];
	recentByKinds(
		kinds: string[],
		limit?: number,
		filters?: MemoryFilters | null,
		offset?: number,
	): MemoryItemResponse[];
}

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

const PERSONAL_FIRST_BONUS = 0.45;
const TRUST_BIAS_LEGACY_UNKNOWN_PENALTY = 0.18;
const TRUST_BIAS_UNREVIEWED_PENALTY = 0.12;
const WIDEN_SHARED_DEFAULT_MIN_PERSONAL_RESULTS = 3;
const WIDEN_SHARED_DEFAULT_MIN_PERSONAL_SCORE = 0.0;
const WIDEN_SHARED_MAX_SHARED_RESULTS = 2;
const WIDEN_PROJECT_DEFAULT_MIN_RESULTS = 3;
const WIDEN_PROJECT_DEFAULT_MIN_SCORE = 0.0;
const WIDEN_PROJECT_DEFAULT_MAX_RESULTS = 3;
const NON_SUMMARY_RECAP_PENALTY = 2.5;
const NON_SUMMARY_OBSERVER_RECAP_PENALTY = 6.5;
const NON_TASK_TASKLIKE_PENALTY = 0.35;
const DURABLE_ROLE_BONUS = 0.12;
const GENERAL_ROLE_BONUS = 0.05;
const EPHEMERAL_ROLE_PENALTY = 0.45;
const EXPLICIT_RECAP_ROLE_BONUS = 0.08;
const PERSONAL_QUERY_PATTERNS = [
	/\bwhat did i\b/i,
	/\bmy notes\b/i,
	/\bmy last session\b/i,
	/\bmy machine\b/i,
];

/** FTS5 operators that must be stripped from user queries. */
const FTS5_OPERATORS = new Set(["or", "and", "not", "near", "phrase"]);

/** Low-signal filler words that should not dominate FTS candidate generation. */
const SEARCH_QUERY_STOP_WORDS = new Set([
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
	"on",
	"previous",
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

/**
 * Expand a user query string into an FTS5 MATCH expression.
 *
 * Extracts alphanumeric tokens, filters out FTS5 operators,
 * and joins multiple tokens with OR for broader matching.
 */
export function expandQuery(query: string): string {
	const rawTokens = query.match(/[A-Za-z0-9_]+/g);
	if (!rawTokens) return "";
	const operatorFiltered = rawTokens.filter((token) => {
		const lowered = token.toLowerCase();
		return !FTS5_OPERATORS.has(lowered);
	});
	const tokens = operatorFiltered.filter((token) => {
		const lowered = token.toLowerCase();
		return !SEARCH_QUERY_STOP_WORDS.has(lowered);
	});
	const effectiveTokens = tokens.length > 0 ? tokens : operatorFiltered;
	if (effectiveTokens.length === 0) return "";
	if (effectiveTokens.length === 1) return effectiveTokens[0] as string;
	return effectiveTokens.join(" OR ");
}

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
	const ageDays = Math.max(0, Math.floor((referenceNow.getTime() - parsed) / 86_400_000));
	return 1.0 / (1.0 + ageDays / 7.0);
}

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

function personalFirstEnabled(filters: MemoryFilters | undefined): boolean {
	if (!filters || filters.personal_first === undefined) return true;
	const value = filters.personal_first;
	if (typeof value === "string") {
		const lowered = value.trim().toLowerCase();
		if (["0", "false", "no", "off"].includes(lowered)) return false;
		if (["1", "true", "yes", "on"].includes(lowered)) return true;
	}
	return Boolean(value);
}

function trustBiasMode(filters: MemoryFilters | undefined): "off" | "soft" {
	const value = String(filters?.trust_bias ?? "off")
		.trim()
		.toLowerCase();
	return value === "soft" ? "soft" : "off";
}

function widenSharedWhenWeakEnabled(filters: MemoryFilters | undefined): boolean {
	if (!filters || filters.widen_shared_when_weak === undefined) return false;
	const value = filters.widen_shared_when_weak;
	if (typeof value === "string") {
		const lowered = value.trim().toLowerCase();
		if (["0", "false", "no", "off"].includes(lowered)) return false;
		if (["1", "true", "yes", "on"].includes(lowered)) return true;
	}
	return Boolean(value);
}

function widenSharedMinPersonalResults(filters: MemoryFilters | undefined): number {
	const value = filters?.widen_shared_min_personal_results;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return WIDEN_SHARED_DEFAULT_MIN_PERSONAL_RESULTS;
	}
	return Math.max(1, Math.trunc(value));
}

function widenSharedMinPersonalScore(filters: MemoryFilters | undefined): number {
	const value = filters?.widen_shared_min_personal_score;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return WIDEN_SHARED_DEFAULT_MIN_PERSONAL_SCORE;
	}
	return Math.max(0, value);
}

function queryBlocksSharedWidening(query: string): boolean {
	return PERSONAL_QUERY_PATTERNS.some((pattern) => pattern.test(query));
}

function filtersBlockSharedWidening(filters: MemoryFilters | undefined): boolean {
	if (!filters) return false;
	const ownershipScope = String(filters.ownership_scope ?? "")
		.trim()
		.toLowerCase();
	if (ownershipScope === "mine" || ownershipScope === "theirs") return true;
	const includeVisibility = normalizeVisibilityValues(
		filters.include_visibility ?? filters.visibility,
	);
	const excludeVisibility = normalizeVisibilityValues(filters.exclude_visibility);
	const includeWorkspaceIds = normalizeFilterStrings(filters.include_workspace_ids);
	const excludeWorkspaceIds = normalizeFilterStrings(filters.exclude_workspace_ids);
	const includeWorkspaceKinds = normalizeWorkspaceKinds(filters.include_workspace_kinds);
	const excludeWorkspaceKinds = normalizeWorkspaceKinds(filters.exclude_workspace_kinds);
	if (includeVisibility.length || includeWorkspaceIds.length || includeWorkspaceKinds.length)
		return true;
	if (excludeVisibility.includes("private") || excludeVisibility.includes("shared")) return true;
	if (excludeWorkspaceKinds.includes("shared") || excludeWorkspaceKinds.includes("personal")) {
		return true;
	}
	return excludeWorkspaceIds.some(
		(value) => value.startsWith("personal:") || value.startsWith("shared:"),
	);
}

function sharedWideningFilters(filters: MemoryFilters | undefined): MemoryFilters {
	return {
		...(filters ?? {}),
		visibility: undefined,
		ownership_scope: undefined,
		include_visibility: ["shared"],
		include_workspace_kinds: ["shared"],
		personal_first: false,
		widen_shared_when_weak: false,
	};
}

function widenProjectWhenWeakEnabled(filters: MemoryFilters | undefined): boolean {
	if (!filters || filters.widen_project_when_weak === undefined) return false;
	const value = filters.widen_project_when_weak;
	if (typeof value === "string") {
		const lowered = value.trim().toLowerCase();
		if (["0", "false", "no", "off"].includes(lowered)) return false;
		if (["1", "true", "yes", "on"].includes(lowered)) return true;
	}
	return Boolean(value);
}

function widenProjectMinResults(filters: MemoryFilters | undefined): number {
	const value = filters?.widen_project_min_results;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return WIDEN_PROJECT_DEFAULT_MIN_RESULTS;
	}
	return Math.max(1, Math.trunc(value));
}

function widenProjectMinScore(filters: MemoryFilters | undefined): number {
	const value = filters?.widen_project_min_score;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return WIDEN_PROJECT_DEFAULT_MIN_SCORE;
	}
	return Math.max(0, value);
}

function widenProjectMaxResults(filters: MemoryFilters | undefined): number {
	const value = filters?.widen_project_max_results;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return WIDEN_PROJECT_DEFAULT_MAX_RESULTS;
	}
	return Math.max(1, Math.trunc(value));
}

function queryBlocksProjectWidening(query: string): boolean {
	// A query that names real paths (contains `/` in a token) is almost always
	// scoped to the current project; cross-project broadening is noise, not help.
	// `queryPathHints` is intentionally loose and also classifies plain-English
	// tokens like "oauth v2.1" as hints via the `.` rule, so we filter down to
	// tokens that actually look like directory paths before short-circuiting.
	return queryPathHints(query).some((token) => token.includes("/"));
}

function projectWideningFilters(filters: MemoryFilters | undefined): MemoryFilters {
	return {
		...(filters ?? {}),
		project: undefined,
		widen_project_when_weak: false,
		widen_shared_when_weak: false,
	};
}

function markProjectWideningMetadata(store: StoreHandle, items: MemoryResult[]): MemoryResult[] {
	if (items.length === 0) return items;
	const sessionIds = new Set(
		items.map((item) => item.session_id).filter((id): id is number => !!id),
	);
	const sessionProjects = loadSessionProjects(store, sessionIds);
	return items.map((item) => {
		const sourceProject = sessionProjects.get(item.session_id) ?? null;
		return {
			...item,
			metadata: {
				...(item.metadata ?? {}),
				widened_from_project: true,
				...(sourceProject ? { source_project: sourceProject } : {}),
			},
		};
	});
}

function markWideningMetadata(items: MemoryResult[]): MemoryResult[] {
	return items.map((item) => ({
		...item,
		metadata: { ...(item.metadata ?? {}), widened_from_shared: true },
	}));
}

function personalBias(
	store: StoreHandle,
	item: MemoryResult,
	filters: MemoryFilters | undefined,
): number {
	if (!personalFirstEnabled(filters)) return 0.0;
	return store.memoryOwnedBySelf(item) ? PERSONAL_FIRST_BONUS : 0.0;
}

function searchQueryLooksTaskLike(query: string): boolean {
	const lowered = query.toLowerCase();
	for (const phrase of [
		"what should",
		"what do next",
		"next step",
		"next steps",
		"todo",
		"to do",
		"follow up",
		"continue",
	]) {
		if (lowered.includes(phrase)) return true;
	}
	return false;
}

function searchQueryLooksDecisionLike(query: string): boolean {
	const lowered = query.toLowerCase();
	for (const phrase of ["what did we decide", "decision", "why did we", "rationale", "tradeoff"]) {
		if (lowered.includes(phrase)) return true;
	}
	return false;
}

function searchQueryLooksTroubleshootingLike(query: string): boolean {
	const lowered = query.toLowerCase();
	const wordTokens = new Set(lowered.match(/[a-z0-9_]+/g) ?? []);
	for (const phrase of [
		"root cause",
		"what was the fix",
		"fix for",
		"how did we fix",
		"how did we debug",
		"what happened last time",
		"regression",
	]) {
		if (lowered.includes(phrase)) return true;
	}
	if (wordTokens.has("bug") || wordTokens.has("bugs")) return true;
	return false;
}

function searchQueryLooksContinuationLike(query: string): boolean {
	const lowered = query.toLowerCase();
	for (const phrase of [
		"what should we do next",
		"what remains",
		"continue",
		"next step",
		"next steps",
		"follow up",
	]) {
		if (lowered.includes(phrase)) return true;
	}
	return false;
}

function qualityDimensionBoost(item: MemoryResult, query: string): number {
	const decisionLike = searchQueryLooksDecisionLike(query);
	const troubleshootingLike = searchQueryLooksTroubleshootingLike(query);
	const continuationLike = searchQueryLooksContinuationLike(query);
	if (!decisionLike && !troubleshootingLike && !continuationLike) return 0.0;
	let boost = 0.0;
	if (decisionLike) {
		if (item.kind === "decision") boost += 0.2;
		if (item.kind === "discovery") boost += 0.08;
	}
	if (troubleshootingLike) {
		if (item.kind === "bugfix") boost += 0.24;
		if (item.kind === "discovery") boost += 0.16;
		if (item.kind === "decision") boost += 0.04;
	}
	if (continuationLike) {
		if (item.kind === "decision") boost += 0.1;
		if (item.kind === "feature") boost += 0.08;
		if (item.kind === "discovery") boost += 0.06;
	}
	return boost;
}

function roleAdjustmentForSearch(
	item: MemoryResult,
	preferSummary: boolean,
	taskLikeQuery: boolean,
): number {
	const inferred = inferMemoryRole({
		kind: item.kind,
		title: item.title,
		body_text: item.body_text,
		metadata: item.metadata,
	});
	if (preferSummary) {
		if (inferred.role === "recap") return EXPLICIT_RECAP_ROLE_BONUS;
		if (inferred.role === "ephemeral") return -0.1;
		return 0.0;
	}
	if (inferred.role === "durable") return DURABLE_ROLE_BONUS;
	if (inferred.role === "general") return GENERAL_ROLE_BONUS;
	if (taskLikeQuery && inferred.role === "ephemeral") return 0.0;
	if (inferred.role === "ephemeral") return -EPHEMERAL_ROLE_PENALTY;
	return 0.0;
}

function recapPenaltyForSearch(item: MemoryResult, preferSummary: boolean): number {
	if (preferSummary || !memoryLooksRecapLike(item)) return 0.0;
	const metadata = item.metadata ?? {};
	const multiplier = recapPenaltyMultiplier(item, preferSummary);
	if (metadata.source === "observer_summary")
		return NON_SUMMARY_OBSERVER_RECAP_PENALTY * multiplier;
	if (typeof metadata.request === "string" && typeof metadata.completed === "string") {
		return NON_SUMMARY_OBSERVER_RECAP_PENALTY * multiplier;
	}
	return NON_SUMMARY_RECAP_PENALTY * multiplier;
}

function itemLooksTaskLikeForSearch(item: MemoryResult): boolean {
	const text = `${item.title} ${item.body_text}`.toLowerCase();
	for (const marker of [
		"next step",
		"next steps",
		"follow-up",
		"follow up",
		"todo",
		"to do",
		"continue",
		"should do",
		"should we",
	]) {
		if (text.includes(marker)) return true;
	}
	return false;
}

function sharedTrustPenalty(
	store: StoreHandle,
	item: MemoryResult,
	filters: MemoryFilters | undefined,
): number {
	if (trustBiasMode(filters) !== "soft") return 0.0;
	if (store.memoryOwnedBySelf(item)) return 0.0;
	const metadata = item.metadata ?? {};
	const visibility = String(metadata.visibility ?? "")
		.trim()
		.toLowerCase();
	const workspaceKind = String(metadata.workspace_kind ?? "")
		.trim()
		.toLowerCase();
	if (visibility !== "shared" && workspaceKind !== "shared") return 0.0;
	const trustState = String(metadata.trust_state ?? "trusted")
		.trim()
		.toLowerCase();
	if (trustState === "legacy_unknown") return TRUST_BIAS_LEGACY_UNKNOWN_PENALTY;
	if (trustState === "unreviewed") return TRUST_BIAS_UNREVIEWED_PENALTY;
	return 0.0;
}

function canonicalPath(rawPath: string): string {
	let path = rawPath.trim().replaceAll("\\", "/");
	if (path.startsWith("./")) {
		path = path.slice(2);
	}
	const parts = path.split("/").filter((part) => part && part !== ".");
	if (parts.length === 0) return "";
	return parts.join("/").toLowerCase();
}

function pathSegments(path: string): string[] {
	const canonical = canonicalPath(path);
	if (!canonical) return [];
	return canonical.split("/");
}

function pathBasename(path: string): string {
	const segments = pathSegments(path);
	if (segments.length === 0) return "";
	return segments[segments.length - 1] ?? "";
}

function pathSegmentsOverlap(a: string[], b: string[]): boolean {
	if (a.length === 0 || b.length === 0) return false;
	if (a.length <= b.length) {
		return b.slice(b.length - a.length).join("/") === a.join("/");
	}
	return a.slice(a.length - b.length).join("/") === b.join("/");
}

function normalizeWorkingSetPaths(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		if (typeof raw !== "string") continue;
		const path = canonicalPath(raw);
		if (!path || seen.has(path)) continue;
		seen.add(path);
		normalized.push(path);
	}
	return normalized;
}

function memoryFilesModified(item: MemoryResult): string[] {
	const metadata = item.metadata ?? {};
	const rawPaths = metadata.files_modified;
	if (!Array.isArray(rawPaths)) return [];
	const normalized: string[] = [];
	for (const raw of rawPaths) {
		if (typeof raw !== "string") continue;
		const path = canonicalPath(raw);
		if (path) normalized.push(path);
	}
	return normalized;
}

function memoryFilesTouched(item: MemoryResult): string[] {
	const metadata = item.metadata ?? {};
	const collected: string[] = [];
	for (const key of ["files_modified", "files_read"] as const) {
		const rawPaths = metadata[key];
		if (!Array.isArray(rawPaths)) continue;
		for (const raw of rawPaths) {
			if (typeof raw !== "string") continue;
			const path = canonicalPath(raw);
			if (path) collected.push(path);
		}
	}
	return [...new Set(collected)];
}

function queryPathHints(query: string): string[] {
	const rawTokens = query.match(/[A-Za-z0-9_./-]+/g) ?? [];
	const paths = rawTokens
		.map((token) => token.trim())
		.filter((token) => token.includes("/") || token.includes("."));
	return [...new Set(paths)];
}

function queryConceptHints(query: string): string[] {
	const rawTokens = query.match(/[A-Za-z0-9_./-]+/g) ?? [];
	const contentTokens = rawTokens
		.map((token) => token.trim().toLowerCase())
		.filter(
			(token) =>
				token.length > 2 &&
				!token.includes("/") &&
				!token.includes(".") &&
				!FTS5_OPERATORS.has(token) &&
				!SEARCH_QUERY_STOP_WORDS.has(token),
		);
	const uniqueTokens = [...new Set(contentTokens)];
	return uniqueTokens.length === 1 ? uniqueTokens : [];
}

function queryPathOverlapBoost(item: MemoryResult, query: string): number {
	const hintedPaths = queryPathHints(query)
		.map((path) => canonicalPath(path))
		.filter(Boolean);
	if (hintedPaths.length === 0) return 0.0;
	const itemPaths = memoryFilesTouched(item);
	if (itemPaths.length === 0) return 0.0;
	const itemSegments = itemPaths.map((path) => pathSegments(path));
	const hintedSegments = hintedPaths.map((path) => pathSegments(path));
	let directHits = 0;
	for (const itemSegment of itemSegments) {
		if (hintedSegments.some((hintSegment) => pathSegmentsOverlap(itemSegment, hintSegment))) {
			directHits += 1;
		}
	}
	const itemBasenames = new Set(itemPaths.map((path) => pathBasename(path)).filter(Boolean));
	const hintedBasenames = new Set(hintedPaths.map((path) => pathBasename(path)).filter(Boolean));
	let basenameHits = 0;
	for (const basename of itemBasenames) {
		if (hintedBasenames.has(basename)) basenameHits += 1;
	}
	const boost = directHits * 0.18 + basenameHits * 0.06;
	return Math.min(0.18, boost);
}

function rowToMemoryResult(
	row: Record<string, unknown>,
	preserveFilteredKind: boolean,
): MemoryResult {
	const metadata: Record<string, unknown> = {
		...fromJson(row.metadata_json as string | null),
	};
	for (const key of [
		"actor_id",
		"actor_display_name",
		"visibility",
		"workspace_id",
		"workspace_kind",
		"origin_device_id",
		"origin_source",
		"trust_state",
	] as const) {
		const value = row[key];
		if (value != null) metadata[key] = value;
	}

	for (const key of ["files_modified", "files_read", "concepts"] as const) {
		const raw = row[key];
		if (typeof raw !== "string") continue;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) metadata[key] ??= parsed;
		} catch {
			// not valid JSON — ignore
		}
	}

	return {
		id: row.id as number,
		kind: preserveFilteredKind
			? (row.kind as string)
			: canonicalMemoryKind(row.kind as string, metadata),
		title: row.title as string,
		body_text: row.body_text as string,
		confidence: row.confidence as number,
		created_at: row.created_at as string,
		updated_at: row.updated_at as string,
		tags_text: (row.tags_text as string) ?? "",
		score: Number(row.score ?? 0),
		session_id: row.session_id as number,
		metadata,
		narrative: (row.narrative as string | null) ?? null,
		facts: (row.facts as string | null) ?? null,
	};
}

function fetchResultsByIds(
	store: StoreHandle,
	ids: number[],
	filters: MemoryFilters | undefined,
	preserveFilteredKind: boolean,
): MemoryResult[] {
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(", ");
	const params: unknown[] = [...ids];
	const whereClauses = [`memory_items.id IN (${placeholders})`, "memory_items.active = 1"];
	const filterResult = buildFilterClausesWithContext(filters, {
		actorId: store.actorId,
		deviceId: store.deviceId,
	});
	whereClauses.push(...filterResult.clauses);
	params.push(...filterResult.params);
	const joinClause = filterResult.joinSessions
		? "JOIN sessions ON sessions.id = memory_items.session_id"
		: "";
	const rows = store.db
		.prepare(
			`SELECT memory_items.*, 0 AS score
			 FROM memory_items
			 ${joinClause}
			 WHERE ${whereClauses.join(" AND ")}`,
		)
		.all(...params) as Record<string, unknown>[];
	return rows.map((row) => rowToMemoryResult(row, preserveFilteredKind));
}

/**
 * Boost score for memories whose files_modified overlap the current working set.
 *
 * Operates on in-memory metadata from already-fetched results, NOT the
 * memory_file_refs junction table. The junction table is used at candidate
 * sourcing time (see findCandidatesByFile and pack.ts integration) to pull
 * in memories that FTS/vector search missed. This reranker then scores them
 * alongside all other candidates using the metadata they already carry.
 */
function workingSetOverlapBoost(item: MemoryResult, workingSetPaths: string[]): number {
	if (workingSetPaths.length === 0) return 0.0;
	const itemPaths = memoryFilesModified(item);
	if (itemPaths.length === 0) return 0.0;

	const itemPathSegments = [...new Set(itemPaths)].map((path) => pathSegments(path));
	const workingSetSegments = [...new Set(workingSetPaths)].map((path) => pathSegments(path));
	const itemBasenames = new Set(itemPaths.map((path) => pathBasename(path)).filter(Boolean));
	const workingSetBasenames = new Set(
		workingSetPaths.map((path) => pathBasename(path)).filter(Boolean),
	);

	let directHits = 0;
	for (const itemSegment of itemPathSegments) {
		if (workingSetSegments.some((wsSegment) => pathSegmentsOverlap(itemSegment, wsSegment))) {
			directHits += 1;
		}
	}

	let basenameHits = 0;
	for (const basename of itemBasenames) {
		if (workingSetBasenames.has(basename)) basenameHits += 1;
	}

	const boost = directHits * 0.16 + basenameHits * 0.06;
	return Math.min(0.32, boost);
}

export function scoreResult(
	store: StoreHandle,
	item: MemoryResult,
	filters?: MemoryFilters,
	query = "",
	referenceNow = new Date(),
): PackTraceCandidateScores {
	const workingSetPaths = normalizeWorkingSetPaths(filters?.working_set_paths);
	const preferSummary = queryPrefersRecap(query);
	const taskLikeQuery = searchQueryLooksTaskLike(query);
	const recency = recencyScore(item.created_at, referenceNow);
	const kind = kindBonus(item.kind);
	const qualityBoost = qualityDimensionBoost(item, query);
	const roleAdjustment = roleAdjustmentForSearch(item, preferSummary, taskLikeQuery);
	const workingSetOverlap = workingSetOverlapBoost(item, workingSetPaths);
	const queryPathOverlap = queryPathOverlapBoost(item, query);
	const personalBiasValue = personalBias(store, item, filters);
	const sharedTrustPenaltyValue = sharedTrustPenalty(store, item, filters);
	const recapPenalty = recapPenaltyForSearch(item, preferSummary);
	const tasklikePenalty =
		!taskLikeQuery && itemLooksTaskLikeForSearch(item) ? NON_TASK_TASKLIKE_PENALTY : 0.0;
	const baseScore = Number.isFinite(item.score) ? item.score : null;
	const combinedScore =
		baseScore == null
			? null
			: baseScore * 1.5 +
				recency +
				kind +
				qualityBoost +
				roleAdjustment +
				workingSetOverlap +
				queryPathOverlap +
				personalBiasValue -
				sharedTrustPenaltyValue -
				recapPenalty -
				tasklikePenalty;

	return {
		base_score: baseScore,
		combined_score: combinedScore,
		recency,
		kind_bonus: kind,
		quality_boost: qualityBoost,
		role_adjustment: roleAdjustment,
		working_set_overlap: workingSetOverlap,
		query_path_overlap: queryPathOverlap,
		personal_bias: personalBiasValue,
		shared_trust_penalty: sharedTrustPenaltyValue,
		recap_penalty: recapPenalty,
		tasklike_penalty: tasklikePenalty,
		text_overlap: 0,
		tag_overlap: 0,
	};
}

/**
 * Re-rank search results by combining BM25 score, recency, kind bonus,
 * personal bias, and shared trust penalty.
 */
export function rerankResults(
	store: StoreHandle,
	results: MemoryResult[],
	limit: number,
	filters?: MemoryFilters,
	query = "",
): MemoryResult[] {
	const referenceNow = new Date();

	const scored = results.map((item) => ({
		item,
		combinedScore:
			scoreResult(store, item, filters, query, referenceNow).combined_score ??
			Number.NEGATIVE_INFINITY,
	}));

	scored.sort((a, b) => b.combinedScore - a.combinedScore);

	return scored.slice(0, limit).map((s) => s.item);
}

/**
 * Execute an FTS5 full-text search against memory_items.
 *
 * Uses expandQuery to prepare the MATCH expression, applies filters
 * via buildFilterClauses, and re-ranks results. Optionally widens to
 * shared workspaces when personal results are weak.
 */
export function search(
	store: StoreHandle,
	query: string,
	limit = 10,
	filters?: MemoryFilters,
): MemoryResult[] {
	const effectiveQuery = sanitizeSearchQuery(query).clean_query;
	const primary = searchOnce(store, effectiveQuery, limit, filters);
	const withShared = applySharedWidening(store, primary, effectiveQuery, filters);
	return applyProjectWidening(store, withShared, effectiveQuery, filters);
}

function applySharedWidening(
	store: StoreHandle,
	primary: MemoryResult[],
	effectiveQuery: string,
	filters: MemoryFilters | undefined,
): MemoryResult[] {
	if (
		!widenSharedWhenWeakEnabled(filters) ||
		!effectiveQuery ||
		queryBlocksSharedWidening(effectiveQuery) ||
		filtersBlockSharedWidening(filters)
	) {
		return primary;
	}

	const personalResults = primary.filter((item) => store.memoryOwnedBySelf(item));
	const strongestPersonalScore = personalResults[0]?.score ?? -Infinity;
	const personalStrongEnough =
		personalResults.length >= widenSharedMinPersonalResults(filters) &&
		strongestPersonalScore >= widenSharedMinPersonalScore(filters);
	if (personalStrongEnough) return primary;

	const shared = markWideningMetadata(
		searchOnce(
			store,
			effectiveQuery,
			WIDEN_SHARED_MAX_SHARED_RESULTS,
			sharedWideningFilters(filters),
		).filter((item) => !store.memoryOwnedBySelf(item)),
	);
	const seen = new Set(primary.map((item) => item.id));
	const combined = [...primary];
	let addedShared = 0;
	for (const item of shared) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		combined.push(item);
		addedShared += 1;
		if (addedShared >= WIDEN_SHARED_MAX_SHARED_RESULTS) break;
	}
	return combined;
}

function applyProjectWidening(
	store: StoreHandle,
	primary: MemoryResult[],
	effectiveQuery: string,
	filters: MemoryFilters | undefined,
): MemoryResult[] {
	const projectFilter = filters?.project?.trim();
	if (!projectFilter) return primary;
	if (
		!widenProjectWhenWeakEnabled(filters) ||
		!effectiveQuery ||
		queryBlocksProjectWidening(effectiveQuery)
	) {
		return primary;
	}

	const primaryProjectResults = primary.filter(
		(item) => item.metadata?.widened_from_project !== true,
	);
	const strongestPrimaryScore = primaryProjectResults[0]?.score ?? -Infinity;
	const primaryStrongEnough =
		primaryProjectResults.length >= widenProjectMinResults(filters) &&
		strongestPrimaryScore >= widenProjectMinScore(filters);
	if (primaryStrongEnough) return primary;

	const maxToAdd = widenProjectMaxResults(filters);
	const candidates = searchOnce(
		store,
		effectiveQuery,
		maxToAdd * 4,
		projectWideningFilters(filters),
	);
	const seen = new Set(primary.map((item) => item.id));
	const candidateSessionIds = new Set(
		candidates.map((item) => item.session_id).filter((id): id is number => !!id),
	);
	const candidateSessionProjects = loadSessionProjects(store, candidateSessionIds);

	const foreign: MemoryResult[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.id)) continue;
		const sourceProject = candidateSessionProjects.get(candidate.session_id) ?? null;
		if (sourceProject && projectMatchesFilter(projectFilter, sourceProject)) continue;
		foreign.push(candidate);
		seen.add(candidate.id);
		if (foreign.length >= maxToAdd) break;
	}
	if (foreign.length === 0) return primary;

	return [...primary, ...markProjectWideningMetadata(store, foreign)];
}

function searchOnce(
	store: StoreHandle,
	query: string,
	limit = 10,
	filters?: MemoryFilters,
): MemoryResult[] {
	const effectiveLimit = Math.max(1, Math.trunc(limit));
	const expanded = expandQuery(query);
	if (!expanded) return [];

	// Widen the SQL candidate set before reranking — kindBonus can promote items
	// that SQL ordering missed, so we fetch more than the final limit.
	const queryLimit = Math.min(Math.max(effectiveLimit * 4, effectiveLimit + 8), 200);

	const params: unknown[] = [expanded];
	const whereClauses = ["memory_items.active = 1", "memory_fts MATCH ?"];

	const filterResult = buildFilterClausesWithContext(filters, {
		actorId: store.actorId,
		deviceId: store.deviceId,
	});
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
	const preserveFilteredKind = typeof filters?.kind === "string" && filters.kind.trim().length > 0;
	const results = rows.map((row) => rowToMemoryResult(row, preserveFilteredKind));
	const indexedCandidateIds = [
		...queryPathHints(query).flatMap((path) =>
			findByFile(store.db, path, {
				limit: queryLimit,
				project: filters?.project,
				relation: "modified",
			}).map((row) => row.id),
		),
		...queryConceptHints(query).flatMap((concept) =>
			findByConcept(store.db, concept, {
				limit: queryLimit,
				project: filters?.project,
				since: filters?.since,
				kind: filters?.kind,
			}).map((row) => row.id),
		),
	];
	const seenIds = new Set(results.map((item) => item.id));
	const newIds = indexedCandidateIds.filter((id) => {
		if (seenIds.has(id)) return false;
		seenIds.add(id);
		return true;
	});
	const widened =
		newIds.length > 0
			? [...results, ...fetchResultsByIds(store, newIds, filters, preserveFilteredKind)]
			: results;

	return rerankResults(store, widened, effectiveLimit, filters, query);
}

/**
 * Return a chronological window of memories around an anchor.
 *
 * Finds an anchor by memoryId or query, then fetches neighbors in the
 * same session ordered by created_at.
 */
export function timeline(
	store: StoreHandle,
	query?: string | null,
	memoryId?: number | null,
	depthBefore = 3,
	depthAfter = 3,
	filters?: MemoryFilters | null,
): TimelineItemResponse[] {
	// Find anchor: prefer explicit memoryId, fall back to search
	let anchorRef: { id: number; session_id: number; created_at: string } | null = null;
	if (memoryId != null) {
		const row = store.get(memoryId);
		if (row) {
			anchorRef = { id: row.id, session_id: row.session_id, created_at: row.created_at };
		}
	}
	if (anchorRef == null && query) {
		const matches = search(store, query, 1, filters ?? undefined);
		if (matches.length > 0) {
			const m = matches[0] as MemoryResult;
			anchorRef = {
				id: m.id,
				session_id: m.session_id,
				created_at: m.created_at,
			};
		}
	}
	if (anchorRef == null) {
		return [];
	}

	return timelineAround(store, anchorRef, depthBefore, depthAfter, filters);
}

/** Fetch memories before/after an anchor within the same session. */
function timelineAround(
	store: StoreHandle,
	anchor: { id: number; session_id: number; created_at: string },
	depthBefore: number,
	depthAfter: number,
	filters?: MemoryFilters | null,
): TimelineItemResponse[] {
	const anchorId = anchor.id;
	const anchorCreatedAt = anchor.created_at;
	const anchorSessionId = anchor.session_id;

	if (!anchorId || !anchorCreatedAt) {
		return [];
	}

	const filterResult = buildFilterClausesWithContext(filters, {
		actorId: store.actorId,
		deviceId: store.deviceId,
	});
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
			 WHERE ${whereClause}
			   AND (
					memory_items.created_at < ?
					OR (memory_items.created_at = ? AND memory_items.id < ?)
			   )
			 ORDER BY memory_items.created_at DESC, memory_items.id DESC
			 LIMIT ?`,
		)
		.all(...baseParams, anchorCreatedAt, anchorCreatedAt, anchorId, depthBefore) as MemoryItem[];

	// After: newer memories, ascending
	const afterRows = store.db
		.prepare(
			`SELECT memory_items.*
			 FROM memory_items
			 ${joinClause}
			 WHERE ${whereClause}
			   AND (
					memory_items.created_at > ?
					OR (memory_items.created_at = ? AND memory_items.id > ?)
			   )
			 ORDER BY memory_items.created_at ASC, memory_items.id ASC
			 LIMIT ?`,
		)
		.all(...baseParams, anchorCreatedAt, anchorCreatedAt, anchorId, depthAfter) as MemoryItem[];

	// Re-fetch anchor row to get full columns (anchor from search may be partial)
	const d = getDrizzle(store.db);
	const anchorRow = d
		.select()
		.from(schema.memoryItems)
		.where(and(eq(schema.memoryItems.id, anchorId), eq(schema.memoryItems.active, 1)))
		.get() as MemoryItem | undefined;

	// Combine: reversed(before) + anchor + after
	const rows: MemoryItem[] = [...beforeRows.reverse()];
	if (anchorRow) {
		rows.push(anchorRow);
	}
	rows.push(...afterRows);

	return rows.map((row) => {
		const { metadata_json, ...rest } = row;
		return { ...rest, metadata_json: fromJson(metadata_json), linked_prompt: null };
	});
}

/**
 * Deduplicate an array of IDs, preserving order. Returns valid int IDs
 * and a list of values that could not be parsed as integers.
 */
export function dedupeOrderedIds(ids: unknown[]): { ordered: number[]; invalid: string[] } {
	const seen = new Set<number>();
	const ordered: number[] = [];
	const invalid: string[] = [];

	for (const rawId of ids) {
		const parsed = parsePositiveMemoryId(rawId);
		if (parsed == null) {
			invalid.push(String(rawId));
			continue;
		}
		if (seen.has(parsed)) continue;
		seen.add(parsed);
		ordered.push(parsed);
	}

	return { ordered, invalid };
}

/** Build an explain payload for a single memory item. */
function explainItem(
	item: MemoryResult,
	source: string,
	rank: number | null,
	queryTokens: string[],
	projectFilter: string | null | undefined,
	projectValue: string | null | undefined,
	includePackContext: boolean,
	referenceNow: Date,
): ExplainItem {
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
		project: projectValue ?? null,
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
			project_match: projectMatchesFilter(projectFilter, projectValue),
		},
		pack_context: includePackContext ? { included: null, section: null } : null,
	};
}

function loadItemsByIdsForExplain(
	store: StoreHandle,
	ids: number[],
	filters: MemoryFilters,
): {
	items: MemoryResult[];
	missingNotFound: number[];
	missingProjectMismatch: number[];
	missingFilterMismatch: number[];
} {
	if (ids.length === 0) {
		return {
			items: [],
			missingNotFound: [],
			missingProjectMismatch: [],
			missingFilterMismatch: [],
		};
	}

	const d = getDrizzle(store.db);
	const allRows = d
		.select()
		.from(schema.memoryItems)
		.where(and(eq(schema.memoryItems.active, 1), inArray(schema.memoryItems.id, ids)))
		.all() as MemoryItem[];
	const allFoundIds = new Set(allRows.map((item) => item.id));

	// Placeholders for the dynamic-filter raw SQL queries below
	const placeholders = ids.map(() => "?").join(", ");

	let projectScopedRows = allRows;
	let projectScopedIds = new Set(allFoundIds);
	if (filters.project) {
		const projectFiltersOnly: MemoryFilters = { project: filters.project };
		const projectFilterResult = buildFilterClausesWithContext(projectFiltersOnly, {
			actorId: store.actorId,
			deviceId: store.deviceId,
		});
		if (projectFilterResult.clauses.length > 0) {
			const projectJoin = projectFilterResult.joinSessions
				? "JOIN sessions ON sessions.id = memory_items.session_id"
				: "";
			projectScopedRows = store.db
				.prepare(
					`SELECT memory_items.*
				 FROM memory_items
				 ${projectJoin}
				 WHERE memory_items.active = 1
				   AND memory_items.id IN (${placeholders})
				   AND ${projectFilterResult.clauses.join(" AND ")}`,
				)
				.all(...ids, ...projectFilterResult.params) as MemoryItem[];
			projectScopedIds = new Set(projectScopedRows.map((item) => item.id));
		}
	}

	const filterResult = buildFilterClausesWithContext(filters, {
		actorId: store.actorId,
		deviceId: store.deviceId,
	});
	const joinClause = filterResult.joinSessions
		? "JOIN sessions ON sessions.id = memory_items.session_id"
		: "";
	const scopedRows = store.db
		.prepare(
			`SELECT memory_items.*
		 FROM memory_items
		 ${joinClause}
		 WHERE ${["memory_items.active = 1", `memory_items.id IN (${placeholders})`, ...filterResult.clauses].join(" AND ")}`,
		)
		.all(...ids, ...filterResult.params) as MemoryItem[];
	const scopedIds = new Set(scopedRows.map((item) => item.id));

	const missingNotFound = ids.filter((memoryId) => !allFoundIds.has(memoryId));
	const missingProjectMismatch = ids.filter(
		(memoryId) => allFoundIds.has(memoryId) && !projectScopedIds.has(memoryId),
	);
	const missingFilterMismatch = ids.filter(
		(memoryId) => projectScopedIds.has(memoryId) && !scopedIds.has(memoryId),
	);

	const items = scopedRows.map((row) => ({
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
		metadata: fromJson(row.metadata_json),
		narrative: row.narrative ?? null,
		facts: row.facts ?? null,
	}));

	return { items, missingNotFound, missingProjectMismatch, missingFilterMismatch };
}

function loadSessionProjects(
	store: StoreHandle,
	sessionIds: Set<number>,
): Map<number, string | null> {
	if (sessionIds.size === 0) return new Map();
	const orderedIds = [...sessionIds].sort((a, b) => a - b);
	const d = getDrizzle(store.db);
	const rows = d
		.select({ id: schema.sessions.id, project: schema.sessions.project })
		.from(schema.sessions)
		.where(inArray(schema.sessions.id, orderedIds))
		.all();
	return new Map(rows.map((row) => [row.id, row.project]));
}

/**
 * Explain search results with scoring breakdown.
 *
 * Accepts a query and/or explicit IDs, merges results, and returns a
 * detailed scoring payload for each item including retrieval source,
 * score components, and term matches.
 */
export function explain(
	store: StoreHandle,
	query?: string | null,
	ids?: unknown[] | null,
	limit = 10,
	filters?: MemoryFilters | null,
	options?: ExplainOptions,
): ExplainResponse {
	const includePackContext = options?.includePackContext ?? false;
	const normalizedQuery = (query ?? "").trim();
	const sanitized = normalizedQuery ? sanitizeSearchQuery(normalizedQuery) : null;
	const sanitizedQuery = sanitized?.clean_query ?? "";
	const { ordered: orderedIds, invalid: invalidIds } = dedupeOrderedIds(ids ?? []);

	const errors: ExplainError[] = [];
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
				project: null,
				requested_ids_count: orderedIds.length,
				returned_items_count: 0,
				include_pack_context: includePackContext,
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

	const {
		items: idRows,
		missingNotFound,
		missingProjectMismatch,
		missingFilterMismatch,
	} = loadItemsByIdsForExplain(store, orderedIds, filters ?? {});
	const idLookup = new Map(idRows.map((item) => [item.id, item]));

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
	const queryTokens = sanitizedQuery
		? (sanitizedQuery.match(/[A-Za-z0-9_]+/g) ?? []).map((t) => t.toLowerCase())
		: [];

	const sessionProjects = loadSessionProjects(
		store,
		new Set(orderedItems.map(({ item }) => item.session_id).filter((sessionId) => sessionId > 0)),
	);
	const referenceNow = new Date();
	const itemsPayload = orderedItems.map(({ item, source, rank }) =>
		explainItem(
			item,
			source,
			rank,
			queryTokens,
			filters?.project ?? null,
			sessionProjects.get(item.session_id) ?? null,
			includePackContext,
			referenceNow,
		),
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
	if (missingProjectMismatch.length > 0) {
		errors.push({
			code: "PROJECT_MISMATCH",
			field: "project",
			message: "some requested ids are outside the requested project scope",
			ids: missingProjectMismatch,
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
			...(sanitized?.was_sanitized ? { sanitized_query: sanitized.clean_query } : {}),
			project: filters?.project ?? null,
			requested_ids_count: orderedIds.length,
			returned_items_count: itemsPayload.length,
			include_pack_context: includePackContext,
		},
	};
}

/**
 * Find memory IDs that touch any of the given file paths, using the
 * memory_file_refs junction table index. Returns up to `limit` distinct
 * memory IDs ordered by creation date (newest first).
 *
 * This is used by the pack builder to source working-set candidates
 * that FTS/vector search would miss.
 */
