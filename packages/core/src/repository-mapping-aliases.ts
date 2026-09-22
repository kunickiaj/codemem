import { isAbsolute } from "node:path";
import type { Database } from "./db.js";
import { repositoryIdentityFromMetadata, resolveGitRepositoryIdentity } from "./project.js";
import {
	LOCAL_DEFAULT_SCOPE_ID,
	resolveProjectScope,
	type ScopeMapping,
} from "./scope-resolution.js";

const GIT_IDENTITY_CACHE_TTL_MS = 5_000;
const GIT_IDENTITY_CACHE_MAX_ENTRIES = 256;
const gitIdentityCache = new Map<string, { expiresAt: number; identity: string | null }>();
const syntheticRepositoryAliases = new WeakSet<object>();
const recordedWorkspacesByIdentityMap = new WeakMap<object, ReadonlySet<string>>();

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

function recordedRepositoryIdentities(rows: Array<{ cwd: string; repository_identity: string }>): {
	byWorkspace: Map<string, Set<string>>;
	known: Set<string>;
} {
	const byWorkspace = new Map<string, Set<string>>();
	const known = new Set<string>();
	for (const row of rows) {
		const cwd = normalizeIdentity(row.cwd);
		const repositoryIdentity = normalizeIdentity(row.repository_identity);
		if (repositoryIdentity) known.add(repositoryIdentity);
		if (!cwd || !repositoryIdentity) continue;
		const recorded = byWorkspace.get(cwd) ?? new Set<string>();
		recorded.add(repositoryIdentity);
		byWorkspace.set(cwd, recorded);
	}
	return { byWorkspace, known };
}

export function recordedRepositoryIdentityEvidence(db: Database): {
	byWorkspace: Map<string, string>;
	known: Set<string>;
	recordedWorkspaces: Set<string>;
} {
	const rows = db
		.prepare(
			`SELECT DISTINCT cwd,
			        json_extract(metadata_json, '$.codemem_repository_identity') AS repository_identity
			 FROM sessions
			 WHERE cwd IS NOT NULL AND TRIM(cwd) <> ''
			   AND json_valid(metadata_json)
			   AND json_type(metadata_json, '$.codemem_repository_identity') = 'text'`,
		)
		.all() as Array<{ cwd: string; repository_identity: string }>;
	const recorded = recordedRepositoryIdentities(rows);
	const byWorkspace = new Map<string, string>();
	const recordedWorkspaces = new Set(recorded.byWorkspace.keys());
	recordedWorkspacesByIdentityMap.set(byWorkspace, recordedWorkspaces);
	for (const [cwd, identities] of recorded.byWorkspace) {
		if (identities.size !== 1) continue;
		const [repositoryIdentity] = identities;
		if (repositoryIdentity) byWorkspace.set(cwd, repositoryIdentity);
	}
	return {
		byWorkspace,
		known: recorded.known,
		recordedWorkspaces,
	};
}

export function discoverKnownRepositoryIdentity(
	cwd: string,
	knownRepositoryIdentities: ReadonlySet<string>,
): string | null {
	if (!isAbsolute(cwd)) return null;
	const repositoryIdentity = cachedGitRepositoryIdentity(cwd);
	return repositoryIdentity && knownRepositoryIdentities.has(repositoryIdentity)
		? repositoryIdentity
		: null;
}

export function repositoryIdentitiesByWorkspace(db: Database): Map<string, string> {
	const recorded = recordedRepositoryIdentityEvidence(db);
	const identities = recorded.byWorkspace;
	const rows = db
		.prepare(
			`SELECT DISTINCT cwd
			 FROM sessions
			 WHERE cwd IS NOT NULL AND TRIM(cwd) <> ''
			 ORDER BY cwd`,
		)
		.all() as Array<{ cwd: string }>;
	for (const row of rows) {
		const cwd = normalizeIdentity(row.cwd);
		if (!cwd || identities.has(cwd) || recorded.recordedWorkspaces.has(cwd)) continue;
		const repositoryIdentity = discoverKnownRepositoryIdentity(row.cwd, recorded.known);
		if (repositoryIdentity) identities.set(cwd, repositoryIdentity);
	}
	return identities;
}

export function canonicalRepositoryProjectIdentity(
	repositoryIdentities: ReadonlyMap<string, string>,
	value: string,
): string {
	const identity = normalizeIdentity(value);
	if (!identity) return value;
	return repositoryIdentities.get(identity) ?? identity;
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
	return recordedRepositoryIdentityEvidenceByWorkspace(db, workspaceIdentities).byWorkspace;
}

export function recordedRepositoryIdentityEvidenceByWorkspace(
	db: Database,
	workspaceIdentities: Iterable<string | null | undefined>,
): {
	byWorkspace: Map<string, string>;
	recordedWorkspaces: Set<string>;
} {
	const identities = new Map<string, string>();
	const recordedWorkspaces = new Set<string>();
	recordedWorkspacesByIdentityMap.set(identities, recordedWorkspaces);
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
		const recorded = new Set<string>();
		for (const row of rows) {
			const repositoryIdentity = normalizeIdentity(
				repositoryIdentityFromMetadata(row.metadata_json),
			);
			if (!repositoryIdentity) continue;
			recorded.add(repositoryIdentity);
		}
		if (recorded.size > 0) recordedWorkspaces.add(workspaceIdentity);
		if (recorded.size !== 1) continue;
		const [repositoryIdentity] = recorded;
		if (repositoryIdentity) identities.set(workspaceIdentity, repositoryIdentity);
	}
	return { byWorkspace: identities, recordedWorkspaces };
}

export function recordedWorkspacesForRepositoryIdentity(
	db: Database,
	repositoryIdentity: string,
): Map<string, string> {
	const normalizedRepositoryIdentity = normalizeIdentity(repositoryIdentity);
	if (!normalizedRepositoryIdentity) return new Map();
	const rows = db
		.prepare(
			`SELECT DISTINCT cwd
			 FROM sessions
			 WHERE cwd IS NOT NULL AND TRIM(cwd) <> ''
			   AND json_valid(metadata_json)
			   AND json_type(metadata_json, '$.codemem_repository_identity') = 'text'
			   AND RTRIM(REPLACE(TRIM(json_extract(metadata_json, '$.codemem_repository_identity')), char(92), '/'), '/') = ?
			 ORDER BY cwd`,
		)
		.all(normalizedRepositoryIdentity) as Array<{ cwd: string }>;
	const evidence = recordedRepositoryIdentityEvidenceByWorkspace(
		db,
		rows.map((row) => row.cwd),
	);
	return new Map(
		[...evidence.byWorkspace].filter(([, identity]) => identity === normalizedRepositoryIdentity),
	);
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
	repositoryIdentities: ReadonlyMap<string, string>,
	knownRepositoryIdentities: Set<string>,
	discoverFilesystem: boolean,
): string | null {
	const recorded = repositoryIdentities.get(identity);
	if (recorded) return recorded;
	if (recordedWorkspacesByIdentityMap.get(repositoryIdentities)?.has(identity)) return null;
	if (!discoverFilesystem || !isAbsolute(identity)) return null;
	const discovered = cachedGitRepositoryIdentity(identity);
	return discovered && knownRepositoryIdentities.has(discovered) ? discovered : null;
}

function mappingsGroupedByRepository<T extends ScopeMapping>(
	mappings: T[],
	repositoryIdentities: ReadonlyMap<string, string>,
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
	repositoryIdentities: ReadonlyMap<string, string>,
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
		if (mapping) {
			const alias = { ...mapping, workspace_identity: repositoryIdentity };
			syntheticRepositoryAliases.add(alias);
			aliases.set(repositoryIdentity, alias);
		}
	}
	return [...mappings, ...aliases.values()];
}

export function hasConflictingRepositoryMappings(
	mappings: ScopeMapping[],
	repositoryIdentities: ReadonlyMap<string, string>,
	repositoryIdentity: string,
): boolean {
	const effectiveMappings = mappings.filter((mapping) => !syntheticRepositoryAliases.has(mapping));
	const repositoryWorkspaces = new Set(
		[...repositoryIdentities]
			.filter(([, identity]) => identity === repositoryIdentity)
			.map(([workspace]) => workspace),
	);
	const knownRepositoryIdentities = new Set(repositoryIdentities.values());
	knownRepositoryIdentities.add(repositoryIdentity);
	for (const mapping of effectiveMappings) {
		const identity = normalizeIdentity(mapping.workspace_identity);
		if (!identity || identity === repositoryIdentity) continue;
		if (
			mappedRepositoryIdentity(identity, repositoryIdentities, knownRepositoryIdentities, true) ===
			repositoryIdentity
		) {
			repositoryWorkspaces.add(identity);
		}
	}
	const scopeIds = new Set<string>();
	const workspaces = repositoryWorkspaces.size > 0 ? repositoryWorkspaces : [null];
	for (const cwd of workspaces) {
		const resolution = resolveProjectScope({
			repositoryIdentity,
			cwd,
			mappings: effectiveMappings,
		});
		scopeIds.add(resolution.scopeId);
	}
	if (scopeIds.size <= 1) return false;
	const sharedScopes = new Set(
		[...scopeIds].filter((scopeId) => scopeId !== LOCAL_DEFAULT_SCOPE_ID),
	);
	if (sharedScopes.size !== 1 || !scopeIds.has(LOCAL_DEFAULT_SCOPE_ID)) return true;
	const mappingsWithAliases = withRepositoryMappingAliasesFromIdentities(
		effectiveMappings,
		repositoryIdentities,
		{ discoverFilesystem: true },
	);
	const fallback = resolveProjectScope({
		repositoryIdentity,
		mappings: mappingsWithAliases,
		allowRepositoryCwdFallback: false,
	});
	return !fallback.mapping || !sharedScopes.has(fallback.scopeId);
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
