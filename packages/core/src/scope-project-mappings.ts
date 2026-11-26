import type { Database } from "./db.js";
import { type ScopeMapping, scopeIdsMatchingProjectPatterns } from "./scope-resolution.js";

/*
 * Which Projects a scope's current mappings point to, for sync admission rules
 * that refuse a scope because it holds a particular Project. Mappings of every
 * provenance count, and pattern-only mappings match with the same rules scope
 * resolution uses, so a rule sees the Projects that would actually land in the
 * scope.
 */

/** The scope's current mappings. */
export function readScopeMappings(db: Database, scopeId: string): ScopeMapping[] {
	return db
		.prepare(
			"SELECT workspace_identity, project_pattern, scope_id FROM project_scope_mappings WHERE scope_id = ?",
		)
		.all(scopeId) as ScopeMapping[];
}

/**
 * Whether one of the mappings points a Project with one of these identities to
 * its scope: an exact mapping names it as its workspace identity or project
 * pattern, or a pattern-only mapping matches it. `canonical` turns a stored
 * identity into the form the identities are given in; it defaults to the
 * identity itself.
 */
export function mappingsHoldProject(
	mappings: readonly ScopeMapping[],
	identities: Iterable<string>,
	canonical: (value: string) => string = (value) => value,
): boolean {
	const wanted = new Set(identities);
	if (wanted.size === 0) return false;
	const exact = mappings.some((mapping) =>
		[mapping.workspace_identity, mapping.project_pattern].some(
			(value) => typeof value === "string" && value.length > 0 && wanted.has(canonical(value)),
		),
	);
	if (exact) return true;
	return mappings.some((mapping) =>
		scopeIdsMatchingProjectPatterns([mapping], wanted).has(mapping.scope_id),
	);
}
