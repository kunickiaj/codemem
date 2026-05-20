/**
 * Sticky-rules band for memory packs. Pulls rules whose applies_to layer is
 * broader than the active project so they ride along on every pack request,
 * fighting long-context attention dilution.
 *
 * Sharing-domain wall: queries inherit the same scope_id filter the rest of
 * pack composition uses, so a user-scope rule recorded in one sharing
 * domain never bleeds into packs assembled for projects in a different
 * domain.
 *
 * The (applies_to, applies_to_key) composite index from G1.1 backs every
 * lookup; verify EXPLAIN QUERY PLAN if you change the WHERE shape.
 */

import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { APPLIES_TO_LAYERS, type AppliesTo } from "./applicability.js";
import * as schema from "./schema.js";
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

interface StoreLike {
	db: { prepare: (sql: string) => unknown };
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

/**
 * Load sticky-rule memories layered by applies_to, ordered user → org →
 * toolchain → project. Each layer is capped by its budget. Memories are
 * filtered to active + non-deleted and (when scope filtering is requested)
 * to the matching sharing domain(s).
 */
export function loadStickyRulesForPack(
	store: StoreLike,
	inputs?: StickyRulesInputs,
): StickyRulesBand {
	const budgets = resolveBudgets(inputs?.budgets);
	// biome-ignore lint/suspicious/noExplicitAny: typed via drizzle internals
	const d = drizzle(store.db as any, { schema });

	const baseWhere = and(eq(schema.memoryItems.active, 1), isNull(schema.memoryItems.deleted_at));

	const scopeFilter =
		inputs?.scopeIds && inputs.scopeIds.length > 0
			? or(
					inArray(schema.memoryItems.scope_id, inputs.scopeIds),
					isNull(schema.memoryItems.scope_id),
					eq(schema.memoryItems.scope_id, ""),
				)
			: undefined;

	function queryLayer(layer: AppliesTo, key: string | null | undefined, limit: number) {
		if (limit <= 0) return [];
		const requiresKey = layer === "org" || layer === "toolchain";
		if (requiresKey && (key == null || key.length === 0)) return [];
		const layerFilter = eq(schema.memoryItems.applies_to, layer);
		const keyFilter = requiresKey
			? eq(schema.memoryItems.applies_to_key, key as string)
			: undefined;
		const where = and(baseWhere, layerFilter, keyFilter, scopeFilter);
		return d
			.select()
			.from(schema.memoryItems)
			.where(where)
			.orderBy(desc(schema.memoryItems.updated_at), desc(schema.memoryItems.id))
			.limit(limit)
			.all() as MemoryItem[];
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
