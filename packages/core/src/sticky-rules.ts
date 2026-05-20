/**
 * Sticky-rules band for memory packs. Pulls rules whose applies_to layer is
 * broader than the active project so they ride along on every pack request,
 * fighting long-context attention dilution.
 *
 * Scope-visibility wall: every layer query goes through
 * `buildFilterClausesWithContext({ enforceScopeVisibility: true })` so the
 * sticky band honors the same scope-membership gates as `search`/`recent`.
 * A user-scope rule recorded in a sharing domain the current device cannot
 * read will not appear in packs assembled for projects the device can read.
 *
 * The (applies_to, applies_to_key) composite index from G1.1 backs every
 * lookup; verify EXPLAIN QUERY PLAN if you change the WHERE shape.
 */

import { APPLIES_TO_LAYERS, type AppliesTo } from "./applicability.js";
import type { Database } from "./db.js";
import { buildFilterClausesWithContext } from "./filters.js";
import type { MemoryFilters, MemoryItem } from "./types.js";

export interface StickyRuleBudgets {
	user: number;
	org: number;
	toolchain: number;
}

export const STICKY_RULES_DEFAULT_BUDGETS: StickyRuleBudgets = {
	user: 5,
	org: 3,
	toolchain: 3,
};

export interface StickyRulesBand {
	user: MemoryItem[];
	org: MemoryItem[];
	toolchain: MemoryItem[];
	project: MemoryItem[];
	/** Memory IDs included in the band, useful for deduping retrieval results. */
	ids: number[];
}

export interface StickyRulesInputs {
	scopeIds?: string[] | null;
	orgKey?: string | null;
	toolchainKey?: string | null;
	budgets?: Partial<StickyRuleBudgets>;
}

interface StickyRulesStore {
	db: Database;
	actorId: string;
	deviceId: string;
}

function resolveBudgets(budgets?: Partial<StickyRuleBudgets>): StickyRuleBudgets {
	return {
		user: budgets?.user ?? STICKY_RULES_DEFAULT_BUDGETS.user,
		org: budgets?.org ?? STICKY_RULES_DEFAULT_BUDGETS.org,
		toolchain: budgets?.toolchain ?? STICKY_RULES_DEFAULT_BUDGETS.toolchain,
	};
}

/**
 * Resolve the sticky-rule inputs for a pack request from its memory filter.
 * Mirrors the filter's scope_id list so the sharing-domain wall is preserved
 * by construction — callers cannot accidentally pull rules from a domain the
 * pack itself is filtering out.
 *
 * Note: this helper does NOT extract org/toolchain keys. The pack-side
 * `MemoryFilters` shape has no field for them today; until callers thread a
 * project-identity-derived key into the request, the org/toolchain layers
 * stay empty by design.
 */
export function stickyRuleInputsFromFilters(filters: MemoryFilters | undefined): StickyRulesInputs {
	if (!filters) return {};
	const inputs: StickyRulesInputs = {};
	if (filters.scope_id) {
		inputs.scopeIds = Array.isArray(filters.scope_id) ? filters.scope_id : [filters.scope_id];
	} else if (filters.include_scope_ids && filters.include_scope_ids.length > 0) {
		inputs.scopeIds = filters.include_scope_ids;
	}
	return inputs;
}

function rowToMemoryItem(row: Record<string, unknown>): MemoryItem {
	return row as unknown as MemoryItem;
}

/**
 * Load sticky-rule memories layered by applies_to, ordered user → org →
 * toolchain → project. Each layer is capped by its budget. Memories are
 * filtered to active + non-deleted, gated by scope visibility for the
 * caller's device, and (when scope filtering is requested) narrowed to
 * the matching sharing domain(s).
 */
export function loadStickyRulesForPack(
	store: StickyRulesStore,
	inputs?: StickyRulesInputs,
): StickyRulesBand {
	const budgets = resolveBudgets(inputs?.budgets);
	const ownership = {
		actorId: store.actorId,
		deviceId: store.deviceId,
		enforceScopeVisibility: true,
	};

	function queryLayer(layer: AppliesTo, key: string | null | undefined, limit: number) {
		if (limit <= 0) return [];
		const requiresKey = layer === "org" || layer === "toolchain";
		if (requiresKey && (key == null || key.length === 0)) return [];

		// Build the scope-visibility-gated WHERE off MemoryFilters so we
		// reuse the exact gate `search`/`recent` use. scope_id narrowing
		// is layered on top of that gate, not in place of it.
		const memoryFilters: MemoryFilters = {};
		if (inputs?.scopeIds && inputs.scopeIds.length > 0) {
			memoryFilters.include_scope_ids = inputs.scopeIds;
		}
		const filterResult = buildFilterClausesWithContext(memoryFilters, ownership);
		const clauses: string[] = [
			"memory_items.active = 1",
			"memory_items.deleted_at IS NULL",
			"memory_items.applies_to = ?",
			...filterResult.clauses,
		];
		const params: unknown[] = [layer, ...filterResult.params];
		if (requiresKey) {
			clauses.push("memory_items.applies_to_key = ?");
			params.push(key);
		}
		const joinClause = filterResult.joinSessions
			? "JOIN sessions ON sessions.id = memory_items.session_id"
			: "";
		const sql = `SELECT memory_items.*
			FROM memory_items
			${joinClause}
			WHERE ${clauses.join(" AND ")}
			ORDER BY memory_items.updated_at DESC, memory_items.id DESC
			LIMIT ?`;
		params.push(limit);
		const rows = store.db.prepare(sql).all(...params) as Record<string, unknown>[];
		return rows.map(rowToMemoryItem);
	}

	// Project-layer is intentionally excluded from the sticky band: every
	// memory defaults to applies_to='project', so pulling that layer would
	// duplicate retrieval results and re-emit normal memories as "rules".
	// The sticky band is for memories the user (or a future observer-driven
	// inference pass) has promoted to a layer broader than the project. The
	// project slot is kept on the response type for forward compatibility;
	// a follow-up may opt-in pull a typed `kind='rule'` project subset
	// without re-introducing the whole project tree.
	const band: StickyRulesBand = {
		user: queryLayer("user", null, budgets.user),
		org: queryLayer("org", inputs?.orgKey ?? null, budgets.org),
		toolchain: queryLayer("toolchain", inputs?.toolchainKey ?? null, budgets.toolchain),
		project: [],
		ids: [],
	};

	const seen = new Set<number>();
	for (const layer of APPLIES_TO_LAYERS) {
		for (const item of band[layer]) {
			if (seen.has(item.id)) continue;
			seen.add(item.id);
			band.ids.push(item.id);
		}
	}

	return band;
}
