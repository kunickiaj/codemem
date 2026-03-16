/**
 * Filter builder for memory_items queries.
 *
 * Mirrors Python's _extend_memory_filter_clauses in codemem/store/search.py.
 * Builds WHERE clause fragments and parameter arrays from a MemoryFilters object.
 */

import type { MemoryFilters } from "./types.js";

export interface FilterResult {
	clauses: string[];
	params: unknown[];
	joinSessions: boolean;
}

/**
 * Normalize a filter value that may be a single string or an array of strings
 * into a clean, non-empty array of trimmed strings.
 */
function normalizeStringArray(value: string | string[] | undefined | null): string[] {
	if (value == null) return [];
	const items = Array.isArray(value) ? value : [value];
	return items.map((s) => String(s).trim()).filter((s) => s.length > 0);
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
	const result: FilterResult = { clauses: [], params: [], joinSessions: false };
	if (!filters) return result;

	const { clauses, params } = result;

	// Single kind filter
	if (filters.kind) {
		clauses.push("memory_items.kind = ?");
		params.push(filters.kind);
	}

	// Project scoping — requires sessions JOIN
	if (filters.project) {
		clauses.push("sessions.project = ?");
		params.push(filters.project);
		result.joinSessions = true;
	}

	// Visibility
	addMultiValueFilter(
		clauses,
		params,
		"memory_items.visibility",
		normalizeStringArray(filters.include_visibility),
		normalizeStringArray(filters.exclude_visibility),
	);

	// Workspace IDs
	addMultiValueFilter(
		clauses,
		params,
		"memory_items.workspace_id",
		normalizeStringArray(filters.include_workspace_ids),
		normalizeStringArray(filters.exclude_workspace_ids),
	);

	// Workspace kinds
	addMultiValueFilter(
		clauses,
		params,
		"memory_items.workspace_kind",
		normalizeStringArray(filters.include_workspace_kinds),
		normalizeStringArray(filters.exclude_workspace_kinds),
	);

	// Actor IDs
	addMultiValueFilter(
		clauses,
		params,
		"memory_items.actor_id",
		normalizeStringArray(filters.include_actor_ids),
		normalizeStringArray(filters.exclude_actor_ids),
	);

	// Trust states
	addMultiValueFilter(
		clauses,
		params,
		"memory_items.trust_state",
		normalizeStringArray(filters.include_trust_states),
		normalizeStringArray(filters.exclude_trust_states),
	);

	return result;
}
