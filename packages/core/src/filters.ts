/**
 * Filter builder for memory_items queries.
 *
 * Mirrors Python's _extend_memory_filter_clauses in codemem/store/search.py.
 * Builds WHERE clause fragments and parameter arrays from a MemoryFilters object.
 */

import { projectClause } from "./project.js";
import { LOCAL_DEFAULT_SCOPE_ID } from "./scope-resolution.js";
import type { MemoryFilters } from "./types.js";

export interface OwnershipFilterContext {
	actorId: string;
	deviceId: string;
	/**
	 * Apply the local read boundary for replication scopes. This is opt-in so
	 * low-level filter unit tests and non-memory callers can keep using the pure
	 * filter builder, while store/search paths can make scope visibility a hard
	 * invariant.
	 */
	enforceScopeVisibility?: boolean;
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

const LEGACY_SHARED_REVIEW_SCOPE_ID = "legacy-shared-review";

function addScopeVisibilityFilter(
	clauses: string[],
	params: unknown[],
	context: OwnershipFilterContext | undefined,
): void {
	if (!context?.enforceScopeVisibility) return;
	const deviceId = context.deviceId.trim();
	if (!deviceId) {
		clauses.push("0 = 1");
		return;
	}
	// Blank/NULL scope_id is treated as local-default for read visibility.
	// Migration backfill promotes legacy rows to explicit scopes asynchronously,
	// but until that completes those rows must remain visible to their owning
	// device exactly the way local-default rows are.
	clauses.push(`(
		COALESCE(TRIM(memory_items.scope_id), '') IN (?, ?, ?)
		OR EXISTS (
			SELECT 1
			FROM replication_scopes rs
			WHERE rs.scope_id = memory_items.scope_id
			  AND rs.status = 'active'
			  AND rs.authority_type = 'local'
		)
		OR EXISTS (
			SELECT 1
			FROM scope_memberships sm
			JOIN replication_scopes rs ON rs.scope_id = sm.scope_id
			WHERE sm.scope_id = memory_items.scope_id
			  AND sm.device_id = ?
			  AND sm.status = 'active'
			  AND rs.status = 'active'
			  AND sm.membership_epoch >= rs.membership_epoch
		)
	)`);
	params.push("", LOCAL_DEFAULT_SCOPE_ID, LEGACY_SHARED_REVIEW_SCOPE_ID, deviceId);
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
	const { clauses, params } = result;
	addScopeVisibilityFilter(clauses, params, ownership);
	if (!filters) return result;

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
		const ownedClause =
			"(COALESCE(memory_items.actor_id, '') = ? OR COALESCE(memory_items.origin_device_id, '') = ?)";
		if (ownershipScope === "mine") {
			clauses.push(ownedClause);
		} else {
			clauses.push(
				"(COALESCE(memory_items.actor_id, '') != ? AND COALESCE(memory_items.origin_device_id, '') != ?)",
			);
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

	// Replication scope filters. These are an explicit narrowing layer and are
	// always intersected with the central scope-visibility gate above when the
	// caller enables it.
	addMultiValueFilter(
		clauses,
		params,
		"memory_items.scope_id",
		normalizeFilterStrings(filters.include_scope_ids ?? filters.scope_id),
		normalizeFilterStrings(filters.exclude_scope_ids),
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
