import type { Database } from "./db.js";
import {
	canonicalRepositoryProjectIdentity,
	repositoryIdentitiesByWorkspace,
	repositoryIdentityForWorkspace,
} from "./repository-mapping-aliases.js";
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

interface StoredProjectEvidence {
	project: string | null;
	cwd: string | null;
	session_project: string | null;
	git_remote: string | null;
	metadata_json: string | null;
}

/** The Projects, canonical, whose memories the scope already stores. */
function projectsStoredInScope(
	db: Database,
	scopeId: string,
	repositoryIdentities: ReadonlyMap<string, string>,
): Set<string> {
	const canonical = (value: string | null): string[] =>
		value ? [canonicalRepositoryProjectIdentity(repositoryIdentities, value)] : [];
	// Each session's own repository evidence counts, because the global alias map
	// leaves out a checkout path that held more than one repository.
	const stored = db
		.prepare(
			`SELECT DISTINCT memory.project, session.cwd, session.project AS session_project,
			        session.git_remote, session.metadata_json
			 FROM memory_items AS memory
			 LEFT JOIN sessions AS session ON session.id = memory.session_id
			 WHERE memory.scope_id = ?`,
		)
		.all(scopeId) as StoredProjectEvidence[];
	return new Set(
		stored.flatMap((row) => [
			...canonical(row.project),
			...canonical(row.cwd),
			...canonical(row.session_project),
			...canonical(
				repositoryIdentityForWorkspace(repositoryIdentities, {
					cwd: row.cwd,
					gitRemote: row.git_remote,
					metadataJson: row.metadata_json,
				}),
			),
		]),
	);
}

/**
 * Returns whether the scope holds a Project: a mapping of any provenance
 * points the Project to it, or it already stores memories of the Project. Every
 * sync admission rule that refuses a scope for the Projects in it asks this.
 * Built once per scope.
 */
export function projectsHeldInScope(db: Database, scopeId: string): (projectId: string) => boolean {
	const repositoryIdentities = repositoryIdentitiesByWorkspace(db);
	const canonical = (value: string) =>
		canonicalRepositoryProjectIdentity(repositoryIdentities, value);
	const mappings = readScopeMappings(db, scopeId);
	const stored = projectsStoredInScope(db, scopeId, repositoryIdentities);
	return (projectId) =>
		stored.has(canonical(projectId)) ||
		mappingsHoldProject(mappings, new Set([projectId, canonical(projectId)]), canonical);
}
