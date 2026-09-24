import { isAbsolute } from "node:path";
import type { Database } from "./db.js";
import { repositoryIdentityFromMetadata, resolveGitRepositoryIdentity } from "./project.js";
import { cleanProjectIdentity } from "./project-identity.js";
import {
	LOCAL_DEFAULT_SCOPE_ID,
	resolveProjectScope,
	type ScopeMapping,
} from "./scope-resolution.js";

const GIT_IDENTITY_CACHE_TTL_MS = 5_000;
const GIT_IDENTITY_CACHE_MAX_ENTRIES = 256;
const gitIdentityCache = new Map<string, { expiresAt: number; identity: string }>();
const syntheticRepositoryAliases = new WeakSet<object>();
const recordedWorkspacesByIdentityMap = new WeakMap<object, ReadonlySet<string>>();

export function normalizeRepositoryWorkspaceIdentity(
	value: string | null | undefined,
): string | null {
	const cleaned = value?.trim();
	if (!cleaned) return null;
	return cleaned.replaceAll("\\", "/").replace(/\/+$/u, "") || cleaned;
}

const normalizeIdentity = normalizeRepositoryWorkspaceIdentity;

export function hasRecordedRepositoryWorkspace(
	repositoryIdentities: ReadonlyMap<string, string>,
	workspace: string | null | undefined,
): boolean {
	const normalized = normalizeIdentity(workspace);
	return Boolean(
		normalized && recordedWorkspacesByIdentityMap.get(repositoryIdentities)?.has(normalized),
	);
}

function cachedGitRepositoryIdentity(cwd: string): string | null {
	const normalizedCwd = normalizeIdentity(cwd);
	if (!normalizedCwd) return null;
	const now = Date.now();
	const cached = gitIdentityCache.get(normalizedCwd);
	if (cached && cached.expiresAt > now) return cached.identity;
	if (cached) gitIdentityCache.delete(normalizedCwd);
	const identity = normalizeIdentity(resolveGitRepositoryIdentity(cwd)?.identity);
	if (!identity) return null;
	if (gitIdentityCache.size >= GIT_IDENTITY_CACHE_MAX_ENTRIES) {
		const oldestKey = gitIdentityCache.keys().next().value;
		if (oldestKey) gitIdentityCache.delete(oldestKey);
	}
	gitIdentityCache.set(normalizedCwd, {
		expiresAt: now + GIT_IDENTITY_CACHE_TTL_MS,
		identity,
	});
	return identity;
}

function gitRepositoryIdentity(cwd: string, bypassCache: boolean): string | null {
	if (!bypassCache) return cachedGitRepositoryIdentity(cwd);
	const normalizedCwd = normalizeIdentity(cwd);
	if (!normalizedCwd) return null;
	gitIdentityCache.delete(normalizedCwd);
	return normalizeIdentity(resolveGitRepositoryIdentity(cwd)?.identity);
}

function recordedRepositoryIdentity(row: {
	git_remote?: string | null;
	metadata_json?: string | null;
	repository_identity?: string | null;
}): string | null {
	return normalizeIdentity(
		cleanProjectIdentity(row.repository_identity) ??
			cleanProjectIdentity(repositoryIdentityFromMetadata(row.metadata_json)) ??
			cleanProjectIdentity(row.git_remote),
	);
}

function recordedRepositoryEvidence(row: {
	cwd: string;
	git_remote?: string | null;
	metadata_json?: string | null;
	repository_identity?: string | null;
}): { cwd: string; fromMetadata: boolean; repositoryIdentity: string } | null {
	const cwd = normalizeIdentity(row.cwd);
	if (!cwd) return null;
	const metadataIdentity = normalizeIdentity(
		cleanProjectIdentity(row.repository_identity) ??
			cleanProjectIdentity(repositoryIdentityFromMetadata(row.metadata_json)),
	);
	const repositoryIdentity =
		metadataIdentity ?? normalizeIdentity(cleanProjectIdentity(row.git_remote));
	if (!repositoryIdentity) return null;
	return { cwd, fromMetadata: metadataIdentity != null, repositoryIdentity };
}

function addRecordedRepositoryIdentity(
	identities: Map<string, Set<string>>,
	cwd: string,
	repositoryIdentity: string,
): void {
	const recorded = identities.get(cwd) ?? new Set<string>();
	recorded.add(repositoryIdentity);
	identities.set(cwd, recorded);
}

function recordedRepositoryIdentities(
	rows: Array<{
		cwd: string;
		git_remote?: string | null;
		metadata_json?: string | null;
		repository_identity?: string | null;
	}>,
): {
	byWorkspace: Map<string, Set<string>>;
	known: Set<string>;
} {
	const metadataByWorkspace = new Map<string, Set<string>>();
	const remoteByWorkspace = new Map<string, Set<string>>();
	const known = new Set<string>();
	for (const row of rows) {
		const evidence = recordedRepositoryEvidence(row);
		if (!evidence) continue;
		addRecordedRepositoryIdentity(
			evidence.fromMetadata ? metadataByWorkspace : remoteByWorkspace,
			evidence.cwd,
			evidence.repositoryIdentity,
		);
	}
	const byWorkspace = new Map<string, Set<string>>();
	for (const cwd of new Set([...metadataByWorkspace.keys(), ...remoteByWorkspace.keys()])) {
		const recorded = new Set([
			...(metadataByWorkspace.get(cwd) ?? []),
			...(remoteByWorkspace.get(cwd) ?? []),
		]);
		if (recorded.size === 0) continue;
		byWorkspace.set(cwd, recorded);
		for (const repositoryIdentity of recorded) known.add(repositoryIdentity);
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
			`SELECT DISTINCT cwd, git_remote, metadata_json
			 FROM sessions
			 WHERE cwd IS NOT NULL AND TRIM(cwd) <> ''
			   AND ((json_valid(metadata_json)
			         AND json_type(metadata_json, '$.codemem_repository_identity') = 'text')
			        OR (git_remote IS NOT NULL AND TRIM(git_remote) <> ''))`,
		)
		.all() as Array<{ cwd: string; git_remote: string | null; metadata_json: string | null }>;
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

export function repositoryIdentitiesByWorkspace(
	db: Database,
	options: { knownRepositoryIdentities?: Iterable<string | null | undefined> } = {},
): Map<string, string> {
	const recorded = recordedRepositoryIdentityEvidence(db);
	const identities = recorded.byWorkspace;
	const known = new Set(recorded.known);
	for (const identity of options.knownRepositoryIdentities ?? []) {
		const normalized = normalizeIdentity(cleanProjectIdentity(identity));
		if (normalized) known.add(normalized);
	}
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
		const repositoryIdentity = discoverKnownRepositoryIdentity(row.cwd, known);
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
		gitRemote: string | null;
		metadataJson?: string | null;
		repositoryIdentity?: string | null;
	},
): string | null {
	const recorded =
		normalizeIdentity(cleanProjectIdentity(input.repositoryIdentity)) ??
		normalizeIdentity(cleanProjectIdentity(repositoryIdentityFromMetadata(input.metadataJson)));
	if (recorded) return recorded;
	const gitRemote = normalizeIdentity(cleanProjectIdentity(input.gitRemote));
	if (gitRemote) return gitRemote;
	const cwd = normalizeIdentity(input.cwd);
	return cwd ? (repositoryIdentities.get(cwd) ?? null) : null;
}

export function recordedRepositoryIdentitiesByWorkspace(
	db: Database,
	workspaceIdentities: Iterable<string | null | undefined>,
	options: { freshWorkspaces?: Iterable<string | null | undefined> } = {},
): Map<string, string> {
	return recordedRepositoryIdentityEvidenceByWorkspace(db, workspaceIdentities, options)
		.byWorkspace;
}

function collectRecordedRepositoryEvidence(
	rows: Array<{ cwd: string; git_remote: string | null; metadata_json: string | null }>,
	requested: ReadonlySet<string>,
): { known: Set<string>; recordedByWorkspace: Map<string, Set<string>> } {
	const recorded = recordedRepositoryIdentities(rows);
	return {
		known: recorded.known,
		recordedByWorkspace: new Map(
			[...recorded.byWorkspace].filter(([workspace]) => requested.has(workspace)),
		),
	};
}

function addUnambiguousRecordedEvidence(
	identities: Map<string, string>,
	recordedWorkspaces: Set<string>,
	recordedByWorkspace: ReadonlyMap<string, ReadonlySet<string>>,
): void {
	for (const [workspaceIdentity, recorded] of recordedByWorkspace) {
		recordedWorkspaces.add(workspaceIdentity);
		if (recorded.size !== 1) continue;
		const [repositoryIdentity] = recorded;
		if (repositoryIdentity) identities.set(workspaceIdentity, repositoryIdentity);
	}
}

function addDiscoveredRepositoryEvidence(
	identities: Map<string, string>,
	recordedWorkspaces: ReadonlySet<string>,
	workspaceIdentities: string[],
	knownRepositoryIdentities: ReadonlySet<string>,
	freshWorkspaces: ReadonlySet<string>,
): void {
	for (const workspaceIdentity of workspaceIdentities) {
		if (recordedWorkspaces.has(workspaceIdentity) || !isAbsolute(workspaceIdentity)) continue;
		const discovered = gitRepositoryIdentity(
			workspaceIdentity,
			freshWorkspaces.has(workspaceIdentity),
		);
		if (discovered && knownRepositoryIdentities.has(discovered)) {
			identities.set(workspaceIdentity, discovered);
		}
	}
}

export function recordedRepositoryIdentityEvidenceByWorkspace(
	db: Database,
	workspaceIdentities: Iterable<string | null | undefined>,
	options: { freshWorkspaces?: Iterable<string | null | undefined> } = {},
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
	const freshWorkspaces = new Set(
		[...(options.freshWorkspaces ?? [])]
			.map((identity) => normalizeIdentity(identity))
			.filter((identity): identity is string => identity != null),
	);
	const requested = new Set(normalizedWorkspaces);
	const rows = db
		.prepare(
			`SELECT cwd, git_remote, metadata_json FROM sessions
			 WHERE cwd IS NOT NULL AND TRIM(cwd) <> '' ORDER BY id DESC`,
		)
		.all() as Array<{ cwd: string; git_remote: string | null; metadata_json: string | null }>;
	const evidence = collectRecordedRepositoryEvidence(rows, requested);
	addUnambiguousRecordedEvidence(identities, recordedWorkspaces, evidence.recordedByWorkspace);
	addDiscoveredRepositoryEvidence(
		identities,
		recordedWorkspaces,
		normalizedWorkspaces,
		evidence.known,
		freshWorkspaces,
	);
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
			`SELECT DISTINCT cwd, git_remote, metadata_json
			 FROM sessions
			 WHERE cwd IS NOT NULL AND TRIM(cwd) <> ''
			   AND (RTRIM(REPLACE(TRIM(git_remote), char(92), '/'), '/') = ?
			        OR (json_valid(metadata_json)
			            AND json_type(metadata_json, '$.codemem_repository_identity') = 'text'
			            AND RTRIM(REPLACE(TRIM(json_extract(metadata_json, '$.codemem_repository_identity')), char(92), '/'), '/') = ?))
			 ORDER BY cwd`,
		)
		.all(normalizedRepositoryIdentity, normalizedRepositoryIdentity) as Array<{
		cwd: string;
		git_remote: string | null;
		metadata_json: string | null;
	}>;
	const matchingRows = rows.filter(
		(row) => recordedRepositoryIdentity(row) === normalizedRepositoryIdentity,
	);
	const evidence = recordedRepositoryIdentityEvidenceByWorkspace(
		db,
		matchingRows.map((row) => row.cwd),
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
	if (mappings.length === 0) return mappings;
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

function repositoryWorkspacesForMappings(
	mappings: ScopeMapping[],
	repositoryIdentities: ReadonlyMap<string, string>,
	repositoryIdentity: string,
): Set<string> {
	const workspaces = new Set(
		[...repositoryIdentities]
			.filter(([, identity]) => identity === repositoryIdentity)
			.map(([workspace]) => workspace),
	);
	const knownRepositoryIdentities = new Set(repositoryIdentities.values());
	knownRepositoryIdentities.add(repositoryIdentity);
	for (const mapping of mappings) {
		const identity = normalizeIdentity(mapping.workspace_identity);
		if (!identity || identity === repositoryIdentity) continue;
		if (
			mappedRepositoryIdentity(identity, repositoryIdentities, knownRepositoryIdentities, true) ===
			repositoryIdentity
		) {
			workspaces.add(identity);
		}
	}
	return workspaces;
}

function repositoryScopeResolutions(
	mappings: ScopeMapping[],
	repositoryIdentity: string,
	workspaces: ReadonlySet<string>,
): { explicitLocalWinner: boolean; scopeIds: Set<string>; mappedScopeIds: Set<string> } {
	const scopeIds = new Set<string>();
	const mappedScopeIds = new Set<string>();
	let explicitLocalWinner = false;
	const candidateWorkspaces = workspaces.size > 0 ? workspaces : [null];
	for (const cwd of candidateWorkspaces) {
		const resolution = resolveProjectScope({ repositoryIdentity, cwd, mappings });
		scopeIds.add(resolution.scopeId);
		if (resolution.mapping) mappedScopeIds.add(resolution.scopeId);
		if (resolution.scopeId === LOCAL_DEFAULT_SCOPE_ID && resolution.mapping) {
			explicitLocalWinner = true;
		}
	}
	return { explicitLocalWinner, scopeIds, mappedScopeIds };
}

export function mappedScopeIdsForRepository(
	mappings: ScopeMapping[],
	repositoryIdentities: ReadonlyMap<string, string>,
	repositoryIdentity: string,
): Set<string> {
	const normalized = normalizeIdentity(repositoryIdentity);
	if (!normalized) return new Set();
	const effectiveMappings = mappings.filter((mapping) => !syntheticRepositoryAliases.has(mapping));
	const workspaces = repositoryWorkspacesForMappings(
		effectiveMappings,
		repositoryIdentities,
		normalized,
	);
	return repositoryScopeResolutions(effectiveMappings, normalized, workspaces).mappedScopeIds;
}

export function hasConflictingRepositoryMappings(
	mappings: ScopeMapping[],
	repositoryIdentities: ReadonlyMap<string, string>,
	repositoryIdentity: string,
): boolean {
	const normalizedRepositoryIdentity = normalizeIdentity(repositoryIdentity);
	if (!normalizedRepositoryIdentity) return false;
	const effectiveMappings = mappings.filter((mapping) => !syntheticRepositoryAliases.has(mapping));
	const repositoryWorkspaces = repositoryWorkspacesForMappings(
		effectiveMappings,
		repositoryIdentities,
		normalizedRepositoryIdentity,
	);
	const { explicitLocalWinner, scopeIds } = repositoryScopeResolutions(
		effectiveMappings,
		normalizedRepositoryIdentity,
		repositoryWorkspaces,
	);
	if (scopeIds.size <= 1) return false;
	if (explicitLocalWinner) return true;
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
		repositoryIdentity: normalizedRepositoryIdentity,
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
