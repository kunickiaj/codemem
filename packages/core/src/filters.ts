/**
 * Filter builder for memory_items queries.
 *
 * Mirrors Python's _extend_memory_filter_clauses in codemem/store/search.py.
 * Builds WHERE clause fragments and parameter arrays from a MemoryFilters object.
 */

import { projectClause } from "./project.js";
import {
	LEGACY_SHARED_REVIEW_SCOPE_ID,
	LOCAL_DEFAULT_SCOPE_ID,
	MAX_SCOPE_IN_PARAMS,
} from "./scope-resolution.js";
import type { MemoryFilters } from "./types.js";

export interface OwnershipFilterContext {
	actorId: string;
	deviceId: string;
	claimedDeviceIds?: string[];
	legacyActorIds?: string[];
	/**
	 * Apply the local read boundary for replication scopes. This is opt-in so
	 * low-level filter unit tests and non-memory callers can keep using the pure
	 * filter builder, while store/search paths can make scope visibility a hard
	 * invariant.
	 */
	enforceScopeVisibility?: boolean;
	/**
	 * Pre-resolved set of scope_ids this device may read (see
	 * `resolveVisibleScopeIds` in scope-resolution.ts). When present, scope visibility is
	 * enforced with an index-eligible `scope_id IN (...)` predicate instead of
	 * the per-row EXISTS subqueries. Callers that cannot resolve the set up front
	 * (e.g. a context built without db access) omit it and fall back to the
	 * EXISTS predicate, which is semantically identical.
	 */
	visibleScopeIds?: readonly string[];
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

function cleanUniqueStrings(value: string[] | undefined): string[] {
	return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
}

// Mirror MemoryStore.buildOwnershipPredicate(): prefer the top-level column,
// then fall back to the metadata_json copy, and finally normalize a missing
// owner to '' (never NULL) so the `theirs` (NOT ...) comparison stays null-safe.
function ownershipColumnSql(column: string, jsonPath: string): string {
	return `COALESCE(
	NULLIF(TRIM(memory_items.${column}), ''),
	NULLIF(TRIM(CASE
		WHEN json_valid(COALESCE(memory_items.metadata_json, ''))
		THEN COALESCE(json_extract(memory_items.metadata_json, '${jsonPath}'), '')
		ELSE ''
	END), ''),
	''
)`;
}

const OWNERSHIP_ACTOR_SQL = ownershipColumnSql("actor_id", "$.actor_id");
const OWNERSHIP_ORIGIN_DEVICE_SQL = ownershipColumnSql("origin_device_id", "$.origin_device_id");

function ownershipPredicateSql(context: OwnershipFilterContext): {
	clause: string;
	params: string[];
} {
	const alternatives: string[] = [];
	const params: string[] = [];
	// Guard blank identity: an empty actorId/deviceId must NOT match every
	// ownerless row (mirrors the falsy checks in
	// MemoryStore.buildOwnershipPredicate()). Skip the equality alternative
	// when the value is empty rather than emitting `<expr> = ''`.
	const actorId = context.actorId.trim();
	if (actorId) {
		alternatives.push(`${OWNERSHIP_ACTOR_SQL} = ?`);
		params.push(actorId);
	}
	const deviceId = context.deviceId.trim();
	if (deviceId) {
		alternatives.push(`${OWNERSHIP_ORIGIN_DEVICE_SQL} = ?`);
		params.push(deviceId);
	}
	const claimedDeviceIds = cleanUniqueStrings(context.claimedDeviceIds);
	if (claimedDeviceIds.length > 0) {
		alternatives.push(
			`${OWNERSHIP_ORIGIN_DEVICE_SQL} IN (${claimedDeviceIds.map(() => "?").join(", ")})`,
		);
		params.push(...claimedDeviceIds);
	}
	const legacyActorIds = cleanUniqueStrings(context.legacyActorIds);
	if (legacyActorIds.length > 0) {
		alternatives.push(`${OWNERSHIP_ACTOR_SQL} IN (${legacyActorIds.map(() => "?").join(", ")})`);
		params.push(...legacyActorIds);
	}
	// No usable owner identity → nothing is "mine" (and `theirs` = everything).
	if (alternatives.length === 0) return { clause: "(0 = 1)", params };
	return { clause: `(${alternatives.join(" OR ")})`, params };
}

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
	const visibleScopeIds = context.visibleScopeIds;
	if (visibleScopeIds !== undefined && visibleScopeIds.length <= MAX_SCOPE_IN_PARAMS) {
		// Fast path: the visible scope-id set was resolved once per request (see
		// resolveVisibleScopeIds in scope-resolution.ts). A plain `scope_id IN (...)`
		// is index-eligible on idx_memory_items_scope_visibility_created, unlike the
		// EXISTS-based fallback below.
		//
		// Guarded by MAX_SCOPE_IN_PARAMS: each id is one bound parameter, so an
		// unrealistically large visible set would otherwise blow SQLite's variable
		// limit and throw at prepare time. Beyond the cap we fail safe to the
		// fixed-param EXISTS fallback, which is semantically identical.
		//
		// We deliberately do NOT TRIM memory_items.scope_id here. TRIM defeats the
		// index, and it is unnecessary: stored scope_ids are always trimmed on
		// write (op scope_id is .trim()ed), so no whitespace-padded values exist.
		// NULL scope_id (legacy rows pending backfill) is handled by the explicit
		// IS NULL branch; the empty string "" is included in the resolved set.
		const placeholders = visibleScopeIds.map(() => "?").join(", ");
		clauses.push(`(memory_items.scope_id IS NULL OR memory_items.scope_id IN (${placeholders}))`);
		params.push(...visibleScopeIds);
		return;
	}
	// Fallback path: no pre-resolved set (e.g. a context built without db access).
	// Semantically identical to the IN predicate above, but evaluated per row.
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
		const ownedPredicate = ownershipPredicateSql(ownership);
		if (ownershipScope === "mine") {
			clauses.push(ownedPredicate.clause);
		} else {
			clauses.push(`NOT ${ownedPredicate.clause}`);
		}
		params.push(...ownedPredicate.params);
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
