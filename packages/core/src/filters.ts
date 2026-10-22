/**
 * Filter builder for memory_items queries.
 *
 * Mirrors Python's _extend_memory_filter_clauses in codemem/store/search.py.
 * Builds WHERE clause fragments and parameter arrays from a MemoryFilters object.
 */

import type { Database } from "./db.js";
import { matchingLocalCreationClause } from "./memory-creation-provenance.js";
import { localCreationSourceIds } from "./memory-local-capture.js";
import { projectColumnClause } from "./project.js";
import {
	LEGACY_SHARED_REVIEW_SCOPE_ID,
	LOCAL_DEFAULT_SCOPE_ID,
	MAX_SCOPE_IN_PARAMS,
	resolveVisibleScopeIds,
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
	 * the per-row EXISTS subqueries. Without this set, scopeVisibilityDb resolves
	 * the same decisions. Without either, SQL can grant only unmanaged access.
	 */
	visibleScopeIds?: readonly string[];
	scopeVisibilityDb?: Database;
	/** Public key of the actual runtime signing key; managed reads deny without it. */
	expectedPublicKey?: string;
	/** Lazy read-only actual-key loader; used only for managed scope candidates. */
	loadExpectedPublicKey?: () => string | undefined;
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

function localCreationSourcesForFilter(
	context: OwnershipFilterContext,
	visibleScopeIds: readonly string[] | undefined,
): string[] {
	const db = context.scopeVisibilityDb;
	if (!db || !visibleScopeIds) return [];
	const creationClause = matchingLocalCreationClause(db);
	if (!creationClause) return [];
	if (
		!db
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_source_bindings'",
			)
			.get()
	)
		return [];
	// Open the signing key only when matching creation evidence needs history access.
	const candidate = db
		.prepare(`SELECT 1 FROM memory_source_bindings msb
		JOIN memory_items ON memory_items.import_key = msb.entity_id
		WHERE msb.evidence = 'local_creation' AND ${creationClause}
		AND NOT EXISTS (SELECT 1 FROM json_each(?) visible WHERE visible.value = COALESCE(memory_items.scope_id, '')) LIMIT 1`)
		.get(JSON.stringify(visibleScopeIds));
	return candidate ? localCreationSourceIds(db, context.deviceId.trim(), context) : [];
}

function addScopeVisibilityFilter(
	clauses: string[],
	params: unknown[],
	context: OwnershipFilterContext | undefined,
	resolvedBranches?: FilterResult[],
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
	const visibleScopeIds =
		context.visibleScopeIds ??
		(context.scopeVisibilityDb
			? resolveVisibleScopeIds(context.scopeVisibilityDb, deviceId, context)
			: undefined);
	// Mutable origin fields cannot prove managed authorship. Retain this legacy
	// exception only for explicitly unmanaged scopes, even after membership loss.
	// A legacy 'local' origin with an import key may be a foreign replica.
	const unmanagedAuthored = `(memory_items.scope_id IN (
		SELECT scope_id FROM replication_scopes
		WHERE authority_type IN ('local', 'manual', 'invite')
	) AND ((${OWNERSHIP_ORIGIN_DEVICE_SQL} = ? AND ? <> 'local')
		OR (${OWNERSHIP_ORIGIN_DEVICE_SQL} = 'local'
			AND COALESCE(TRIM(memory_items.import_key), '') = '')))`;
	let authored = unmanagedAuthored;
	const authoredBranches: FilterResult[] = [
		{ clauses: [unmanagedAuthored], params: [deviceId, deviceId], joinSessions: false },
	];
	const sourceIds = localCreationSourcesForFilter(context, visibleScopeIds);
	if (sourceIds.length && context.scopeVisibilityDb) {
		// Immutable creation history can also remain readable in managed scopes.
		const bindingFilter = `msb.evidence = 'local_creation'
			AND msb.source_device_id IN (${sourceIds.map(() => "?").join(", ")})`;
		const creationClause = matchingLocalCreationClause(context.scopeVisibilityDb);
		authored = `(${authored} OR EXISTS (SELECT 1 FROM memory_source_bindings msb
			WHERE msb.entity_id = memory_items.import_key AND ${bindingFilter}
			AND ${creationClause}))`;
		// Drive this exceptional branch from creation bindings/import keys rather
		// than inspecting provenance JSON for every row in every unreadable scope.
		authoredBranches.push({
			clauses: [
				`memory_items.id IN (SELECT id FROM memory_items
					WHERE import_key IN (SELECT msb.entity_id FROM memory_source_bindings msb WHERE ${bindingFilter}))`,
				`${creationClause}`,
				`NOT COALESCE(${unmanagedAuthored}, 0)`,
			],
			params: [...sourceIds, deviceId, deviceId],
			joinSessions: false,
		});
	}
	if (visibleScopeIds !== undefined) {
		addResolvedScopeVisibilityFilter(
			clauses,
			params,
			visibleScopeIds,
			authored,
			deviceId,
			authoredBranches,
			resolvedBranches,
		);
		params.push(...sourceIds);
		return;
	}
	// DB-less callers cannot validate managed proof. Preserve local/manual/invite
	// membership behavior, but never let raw coordinator rows grant permission.
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
			  AND rs.authority_type IN ('local', 'manual', 'invite')
			  AND sm.membership_epoch >= rs.membership_epoch
		)
		OR ${authored}
	)`);
	params.push(
		"",
		LOCAL_DEFAULT_SCOPE_ID,
		LEGACY_SHARED_REVIEW_SCOPE_ID,
		deviceId,
		deviceId,
		deviceId,
	);
}

function addResolvedScopeVisibilityFilter(
	clauses: string[],
	params: unknown[],
	visibleScopeIds: readonly string[],
	authored: string,
	deviceId: string,
	authoredBranches: FilterResult[],
	resolvedBranches?: FilterResult[],
): void {
	let scopeClause = "0 = 1";
	const scopeParams: unknown[] = [];
	if (visibleScopeIds.length > MAX_SCOPE_IN_PARAMS) {
		scopeClause = "memory_items.scope_id IN (SELECT value FROM json_each(?))";
		scopeParams.push(JSON.stringify(visibleScopeIds));
	} else if (visibleScopeIds.length > 0) {
		scopeClause = `memory_items.scope_id IN (${visibleScopeIds.map(() => "?").join(", ")})`;
		scopeParams.push(...visibleScopeIds);
	}
	if (resolvedBranches) {
		// UNION ALL consumers must not count NULL, visible and authored rows twice.
		// Keep the full authored predicate, including immutable managed creation proof.
		resolvedBranches.push(
			{ clauses: ["memory_items.scope_id IS NULL"], params: [], joinSessions: false },
			{ clauses: [scopeClause], params: scopeParams, joinSessions: false },
			...authoredBranches.map((branch) => ({
				clauses: ["memory_items.scope_id IS NOT NULL", `NOT (${scopeClause})`, ...branch.clauses],
				params: [...scopeParams, ...branch.params],
				joinSessions: false,
			})),
		);
		return;
	}
	params.push(...scopeParams);
	clauses.push(`(memory_items.scope_id IS NULL OR ${scopeClause} OR ${authored})`);
	params.push(deviceId, deviceId);
}

/**
 * Disjoint equivalents of the central read filter for UNION ALL aggregates.
 * Unresolved/DB-less contexts retain the exact ordinary filter as one branch.
 * Resolve on every call: these branches are not an authorization cache.
 */
export function buildFilterBranchesWithContext(
	filters: MemoryFilters | undefined | null,
	ownership?: OwnershipFilterContext,
): FilterResult[] {
	if (ownership?.visibleScopeIds === undefined) {
		return [buildFilterClausesWithContext(filters, ownership)];
	}
	const branches: FilterResult[] = [];
	const clauses: string[] = [];
	const params: unknown[] = [];
	addScopeVisibilityFilter(clauses, params, ownership, branches);
	const common = buildFilterClausesWithContext(
		filters,
		ownership ? { ...ownership, enforceScopeVisibility: false } : undefined,
	);
	if (!branches.length) branches.push({ clauses, params, joinSessions: false });
	return branches.map((branch) => ({
		clauses: [...branch.clauses, ...common.clauses],
		params: [...branch.params, ...common.params],
		joinSessions: common.joinSessions,
	}));
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

function addProjectFilter(project: string | null | undefined, result: FilterResult): void {
	if (!project) return;
	// Session moves take precedence; redacted sessions fall back to readable memory attribution.
	const filter = projectColumnClause("COALESCE(sessions.project, memory_items.project)", project);
	if (!filter.clause) return;
	result.clauses.push(filter.clause);
	result.params.push(...filter.params);
	result.joinSessions = true;
}

export function buildFilterClausesWithContext(
	filters: MemoryFilters | undefined | null,
	ownership?: OwnershipFilterContext,
): FilterResult {
	const result: FilterResult = { clauses: [], params: [], joinSessions: false };
	const { clauses, params } = result;
	addScopeVisibilityFilter(clauses, params, ownership);
	if (!filters) return result;

	// Single kind filter — guard against non-string kinds from untyped
	// JSON request bodies (a number/bool would otherwise become a broken
	// bound parameter).
	if (typeof filters.kind === "string" && filters.kind) {
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

	addProjectFilter(filters.project, result);

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
