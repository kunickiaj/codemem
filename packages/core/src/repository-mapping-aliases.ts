import { isAbsolute } from "node:path";
import type { Database } from "./db.js";
import { repositoryIdentityFromMetadata, resolveGitRepositoryIdentity } from "./project.js";
import type { ScopeMapping } from "./scope-resolution.js";

function normalizeIdentity(value: string | null | undefined): string | null {
	const cleaned = value?.trim();
	if (!cleaned) return null;
	return cleaned.replaceAll("\\", "/").replace(/\/+$/u, "") || cleaned;
}

export function repositoryIdentitiesByWorkspace(db: Database): Map<string, string> {
	const identities = new Map<string, string>();
	const rows = db
		.prepare(
			`SELECT cwd, metadata_json
			 FROM sessions
			 WHERE cwd IS NOT NULL AND TRIM(cwd) <> ''
			 ORDER BY id DESC`,
		)
		.all() as Array<{ cwd: string; metadata_json: string | null }>;
	const knownRepositoryIdentities = new Set<string>();
	for (const row of rows) {
		const cwd = normalizeIdentity(row.cwd);
		const repositoryIdentity = normalizeIdentity(repositoryIdentityFromMetadata(row.metadata_json));
		if (cwd && repositoryIdentity && !identities.has(cwd)) identities.set(cwd, repositoryIdentity);
		if (repositoryIdentity) knownRepositoryIdentities.add(repositoryIdentity);
	}
	const attemptedCwds = new Set<string>();
	for (const row of rows) {
		const cwd = normalizeIdentity(row.cwd);
		if (!cwd || identities.has(cwd) || attemptedCwds.has(cwd) || !isAbsolute(row.cwd)) continue;
		attemptedCwds.add(cwd);
		const repositoryIdentity = normalizeIdentity(resolveGitRepositoryIdentity(row.cwd)?.identity);
		if (repositoryIdentity && knownRepositoryIdentities.has(repositoryIdentity)) {
			identities.set(cwd, repositoryIdentity);
		}
	}
	return identities;
}

export function repositoryIdentityForWorkspace(
	repositoryIdentities: ReadonlyMap<string, string>,
	input: {
		cwd: string | null | undefined;
		gitRemote?: string | null;
		metadataJson?: string | null;
	},
): string | null {
	const recorded = normalizeIdentity(repositoryIdentityFromMetadata(input.metadataJson));
	if (recorded || normalizeIdentity(input.gitRemote)) return recorded;
	const cwd = normalizeIdentity(input.cwd);
	return cwd ? (repositoryIdentities.get(cwd) ?? null) : null;
}

function compareMappingPrecedence(left: ScopeMapping, right: ScopeMapping): number {
	const leftUpdatedAt = Date.parse(left.updated_at ?? "") || 0;
	const rightUpdatedAt = Date.parse(right.updated_at ?? "") || 0;
	return (
		(right.priority ?? 0) - (left.priority ?? 0) ||
		rightUpdatedAt - leftUpdatedAt ||
		(right.id ?? 0) - (left.id ?? 0)
	);
}

function mappedRepositoryIdentity(
	identity: string,
	repositoryIdentities: Map<string, string>,
	knownRepositoryIdentities: Set<string>,
): string | null {
	const recorded = repositoryIdentities.get(identity);
	if (recorded) return recorded;
	if (!isAbsolute(identity)) return null;
	const discovered = normalizeIdentity(resolveGitRepositoryIdentity(identity)?.identity);
	return discovered && knownRepositoryIdentities.has(discovered) ? discovered : null;
}

function mappingsGroupedByRepository<T extends ScopeMapping>(
	mappings: T[],
	repositoryIdentities: Map<string, string>,
): Map<string, T[]> {
	const grouped = new Map<string, T[]>();
	const knownRepositoryIdentities = new Set(repositoryIdentities.values());
	for (const mapping of mappings) {
		const identity = normalizeIdentity(mapping.workspace_identity);
		if (!identity) continue;
		const repositoryIdentity = mappedRepositoryIdentity(
			identity,
			repositoryIdentities,
			knownRepositoryIdentities,
		);
		if (!repositoryIdentity || repositoryIdentity === identity) continue;
		const repositoryMappings = grouped.get(repositoryIdentity) ?? [];
		repositoryMappings.push(mapping);
		grouped.set(repositoryIdentity, repositoryMappings);
	}
	return grouped;
}

/**
 * Treat an existing checkout-path mapping as a repository mapping after that
 * checkout gains trusted repository identity. This preserves pre-upgrade Space
 * assignments while making sibling worktrees inherit the same decision.
 */
export function withRepositoryMappingAliases<T extends ScopeMapping>(
	db: Database,
	mappings: T[],
	repositoryIdentities = repositoryIdentitiesByWorkspace(db),
): T[] {
	if (mappings.length === 0) return mappings;
	const explicitIdentities = new Set(
		mappings
			.map((mapping) => normalizeIdentity(mapping.workspace_identity))
			.filter((identity): identity is string => identity != null),
	);
	const mappingsByRepository = mappingsGroupedByRepository(mappings, repositoryIdentities);
	const aliases = new Map<string, T>();
	for (const [repositoryIdentity, repositoryMappings] of mappingsByRepository) {
		if (explicitIdentities.has(repositoryIdentity)) continue;
		const scopeIds = new Set(repositoryMappings.map((mapping) => mapping.scope_id));
		if (scopeIds.size !== 1) continue;
		const mapping = repositoryMappings.toSorted(compareMappingPrecedence)[0];
		if (mapping)
			aliases.set(repositoryIdentity, { ...mapping, workspace_identity: repositoryIdentity });
	}
	return [...mappings, ...aliases.values()];
}
