import { isAbsolute } from "node:path";
import type { Database } from "./db.js";
import { repositoryIdentityFromMetadata, resolveGitRepositoryIdentity } from "./project.js";
import type { ScopeMapping } from "./scope-resolution.js";

const GIT_IDENTITY_CACHE_TTL_MS = 5_000;
const GIT_IDENTITY_CACHE_MAX_ENTRIES = 256;
const gitIdentityCache = new Map<string, { expiresAt: number; identity: string | null }>();

function normalizeIdentity(value: string | null | undefined): string | null {
	const cleaned = value?.trim();
	if (!cleaned) return null;
	return cleaned.replaceAll("\\", "/").replace(/\/+$/u, "") || cleaned;
}

function cachedGitRepositoryIdentity(cwd: string): string | null {
	const normalizedCwd = normalizeIdentity(cwd);
	if (!normalizedCwd) return null;
	const now = Date.now();
	const cached = gitIdentityCache.get(normalizedCwd);
	if (cached && cached.expiresAt > now) return cached.identity;
	const identity = normalizeIdentity(resolveGitRepositoryIdentity(cwd)?.identity);
	if (gitIdentityCache.size >= GIT_IDENTITY_CACHE_MAX_ENTRIES) {
		const oldestKey = gitIdentityCache.keys().next().value;
		if (oldestKey) gitIdentityCache.delete(oldestKey);
	}
	gitIdentityCache.delete(normalizedCwd);
	gitIdentityCache.set(normalizedCwd, {
		expiresAt: now + GIT_IDENTITY_CACHE_TTL_MS,
		identity,
	});
	return identity;
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
		const repositoryIdentity = cachedGitRepositoryIdentity(row.cwd);
		if (repositoryIdentity && knownRepositoryIdentities.has(repositoryIdentity)) {
			identities.set(cwd, repositoryIdentity);
		}
	}
	return identities;
}

export function repositoryIdentityForWorkspace(
	repositoryIdentities: ReadonlyMap<string, string>,
	input: {
		cwd?: string | null;
		metadataJson?: string | null;
		repositoryIdentity?: string | null;
	},
): string | null {
	const recordedIdentity =
		normalizeIdentity(input.repositoryIdentity) ??
		normalizeIdentity(repositoryIdentityFromMetadata(input.metadataJson));
	if (recordedIdentity) return recordedIdentity;
	const cwd = normalizeIdentity(input.cwd);
	return cwd ? (repositoryIdentities.get(cwd) ?? null) : null;
}

export function recordedRepositoryIdentitiesByWorkspace(
	db: Database,
	workspaceIdentities: Iterable<string | null | undefined>,
): Map<string, string> {
	const identities = new Map<string, string>();
	const normalizedWorkspaces = [
		...new Set(
			[...workspaceIdentities]
				.map((identity) => normalizeIdentity(identity))
				.filter((identity): identity is string => identity != null),
		),
	];
	const rowsForWorkspace = db.prepare(
		`SELECT cwd, metadata_json
		 FROM sessions
		 WHERE RTRIM(REPLACE(TRIM(cwd), char(92), '/'), '/') = ?
		 ORDER BY id DESC`,
	);
	for (const workspaceIdentity of normalizedWorkspaces) {
		const rows = rowsForWorkspace.all(workspaceIdentity) as Array<{
			cwd: string;
			metadata_json: string | null;
		}>;
		for (const row of rows) {
			const repositoryIdentity = normalizeIdentity(
				repositoryIdentityFromMetadata(row.metadata_json),
			);
			if (!repositoryIdentity) continue;
			identities.set(workspaceIdentity, repositoryIdentity);
			break;
		}
	}
	return identities;
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
	discoverFilesystem: boolean,
): string | null {
	const recorded = repositoryIdentities.get(identity);
	if (recorded) return recorded;
	if (!discoverFilesystem || !isAbsolute(identity)) return null;
	const discovered = cachedGitRepositoryIdentity(identity);
	return discovered && knownRepositoryIdentities.has(discovered) ? discovered : null;
}

function mappingsGroupedByRepository<T extends ScopeMapping>(
	mappings: T[],
	repositoryIdentities: Map<string, string>,
	discoverFilesystem: boolean,
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
			discoverFilesystem,
		);
		if (!repositoryIdentity || repositoryIdentity === identity) continue;
		const repositoryMappings = grouped.get(repositoryIdentity) ?? [];
		repositoryMappings.push(mapping);
		grouped.set(repositoryIdentity, repositoryMappings);
	}
	return grouped;
}

export function withRepositoryMappingAliasesFromIdentities<T extends ScopeMapping>(
	mappings: T[],
	repositoryIdentities: Map<string, string>,
	options: { discoverFilesystem?: boolean } = {},
): T[] {
	const explicitIdentities = new Set(
		mappings
			.map((mapping) => normalizeIdentity(mapping.workspace_identity))
			.filter((identity): identity is string => identity != null),
	);
	const mappingsByRepository = mappingsGroupedByRepository(
		mappings,
		repositoryIdentities,
		options.discoverFilesystem === true,
	);
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

/**
 * Treat an existing checkout-path mapping as a repository mapping after that
 * checkout gains trusted repository identity. This preserves pre-upgrade Space
 * assignments while making sibling worktrees inherit the same decision.
 */
export function withRepositoryMappingAliases<T extends ScopeMapping>(
	db: Database,
	mappings: T[],
): T[] {
	if (mappings.length === 0) return mappings;
	const repositoryIdentities = repositoryIdentitiesByWorkspace(db);
	return withRepositoryMappingAliasesFromIdentities(mappings, repositoryIdentities, {
		discoverFilesystem: true,
	});
}
