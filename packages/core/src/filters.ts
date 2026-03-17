/**
 * Filter builder for memory_items queries.
 *
 * Mirrors Python's _extend_memory_filter_clauses in codemem/store/search.py.
 * Builds WHERE clause fragments and parameter arrays from a MemoryFilters object.
 */

import { projectClause } from "./project.js";
import type { MemoryFilters } from "./types.js";

export interface OwnershipFilterContext {
	actorId: string;
	deviceId: string;
}

export interface FilterResult {
	clauses: string[];
	params: unknown[];
	joinSessions: boolean;
}

/**
 * Normalize a filter value that may be a single string or an array of strings
 * into a clean, non-empty array of trimmed strings.
 */
export function normalizeFilterStrings(value: string | string[] | undefined | null): string[] {
	if (value == null) return [];
	const items = Array.isArray(value) ? value : [value];
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const item of items) {
		const candidate = String(item).trim();
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		normalized.push(candidate);
	}
	return normalized;
}

export function normalizeWorkspaceKinds(value: string | string[] | undefined | null): string[] {
	return normalizeFilterStrings(value)
		.map((raw) => raw.toLowerCase())
		.filter(
			(raw, idx, arr) => (raw === "personal" || raw === "shared") && arr.indexOf(raw) === idx,
		);
}

export function normalizeVisibilityValues(value: string | string[] | undefined | null): string[] {
	return normalizeFilterStrings(value)
		.map((raw) => raw.toLowerCase())
		.filter((raw, idx, arr) => (raw === "private" || raw === "shared") && arr.indexOf(raw) === idx);
}

export function normalizeTrustStates(value: string | string[] | undefined | null): string[] {
	return normalizeFilterStrings(value)
		.map((raw) => raw.toLowerCase())
		.filter(
			(raw, idx, arr) =>
				(raw === "trusted" || raw === "legacy_unknown" || raw === "unreviewed") &&
				arr.indexOf(raw) === idx,
		);
}

/**
 * Add IN / NOT IN clauses for a multi-value filter column.
 * Mirrors Python's _add_multi_value_filter.
 */
function addMultiValueFilter(
	clauses: string[],
	params: unknown[],
	column: string,
	includeValues: string[],
	excludeValues: string[],
): void {
	if (includeValues.length > 0) {
		const placeholders = includeValues.map(() => "?").join(", ");
		clauses.push(`${column} IN (${placeholders})`);
		params.push(...includeValues);
	}
	if (excludeValues.length > 0) {
		const placeholders = excludeValues.map(() => "?").join(", ");
		clauses.push(`(${column} IS NULL OR ${column} NOT IN (${placeholders}))`);
		params.push(...excludeValues);
	}
}

/**
 * Build WHERE clause fragments from a MemoryFilters object.
 *
 * Returns clauses, params, and whether the sessions table must be joined.
 * The caller is responsible for prepending `memory_items.active = 1` or
 * similar base conditions — this function only appends filter-specific clauses.
 */
export function buildFilterClauses(filters: MemoryFilters | undefined | null): FilterResult {
	return buildFilterClausesWithContext(filters);
}

export function buildFilterClausesWithContext(
	filters: MemoryFilters | undefined | null,
	ownership?: OwnershipFilterContext,
): FilterResult {
	const result: FilterResult = { clauses: [], params: [], joinSessions: false };
	if (!filters) return result;

	const { clauses, params } = result;

	// Single kind filter
	if (filters.kind) {
		clauses.push("memory_items.kind = ?");
		params.push(filters.kind);
	}
	if (filters.session_id) {
		clauses.push("memory_items.session_id = ?");
		params.push(filters.session_id);
	}
	if (filters.since) {
		clauses.push("memory_items.created_at >= ?");
		params.push(filters.since);
	}

	const ownershipScope = String(filters.ownership_scope ?? "")
		.trim()
		.toLowerCase();
	if (ownership && (ownershipScope === "mine" || ownershipScope === "theirs")) {
		const ownedClause = "(memory_items.actor_id = ? OR memory_items.origin_device_id = ?)";
		if (ownershipScope === "mine") {
			clauses.push(ownedClause);
		} else {
			clauses.push(`NOT ${ownedClause}`);
		}
		params.push(ownership.actorId, ownership.deviceId);
	}

	// Project scoping — requires sessions JOIN
	if (filters.project) {
		const { clause, params: projectParams } = projectClause(filters.project);
		if (clause) {
			clauses.push(clause);
			params.push(...projectParams);
			result.joinSessions = true;
		}
	}

	// Visibility
	addMultiValueFilter(
		clauses,
		params,
		"memory_items.visibility",
		normalizeVisibilityValues(filters.include_visibility ?? filters.visibility),
		normalizeVisibilityValues(filters.exclude_visibility),
	);

	// Workspace IDs
	addMultiValueFilter(
		clauses,
		params,
		"memory_items.workspace_id",
		normalizeFilterStrings(filters.include_workspace_ids),
		normalizeFilterStrings(filters.exclude_workspace_ids),
	);

	// Workspace kinds
	addMultiValueFilter(
		clauses,
		params,
		"memory_items.workspace_kind",
		normalizeWorkspaceKinds(filters.include_workspace_kinds),
		normalizeWorkspaceKinds(filters.exclude_workspace_kinds),
	);

	// Actor IDs
	addMultiValueFilter(
		clauses,
		params,
		"memory_items.actor_id",
		normalizeFilterStrings(filters.include_actor_ids),
		normalizeFilterStrings(filters.exclude_actor_ids),
	);

	// Trust states
	addMultiValueFilter(
		clauses,
		params,
		"memory_items.trust_state",
		normalizeTrustStates(filters.include_trust_states),
		normalizeTrustStates(filters.exclude_trust_states),
	);

	return result;
}
