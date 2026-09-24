import type { Database } from "./db.js";
import { repositoryIdentitiesFromIndexedEvidence } from "./repository-discovery-cache.js";
import {
	discoverKnownRepositoryIdentity,
	hasConflictingRepositoryMappings,
	normalizeRepositoryWorkspaceIdentity,
	recordedRepositoryIdentityEvidenceByWorkspace,
	repositoryIdentitiesByWorkspace,
	repositoryIdentityForWorkspace,
	withRepositoryMappingAliasesFromIdentities,
} from "./repository-mapping-aliases.js";
import {
	LOCAL_DEFAULT_SCOPE_ID,
	resolveProjectScope,
	type ScopeMapping,
} from "./scope-resolution.js";

interface SessionScopeRow {
	cwd: string | null;
	project: string | null;
	git_remote: string | null;
	git_branch: string | null;
	metadata_json: string | null;
}

interface MemoryScopeRow extends SessionScopeRow {
	id: number;
	session_id: number;
	workspace_id: string | null;
	scope_id: string | null;
}

export interface ResolveSessionScopeOptions {
	sessionId: number;
	workspaceId?: string | null;
	explicitScopeId?: string | null;
	localDefaultScopeId?: string;
}

interface RepositoryScopeContext {
	allowRepositoryCwdFallback: boolean;
	mappings: ScopeMapping[];
	repositoryIdentity: string | null;
}

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function loadProjectScopeMappings(db: Database): ScopeMapping[] {
	return db
		.prepare(
			`SELECT id, workspace_identity, project_pattern, scope_id, priority, source, updated_at
			 FROM project_scope_mappings
			 WHERE scope_id IS NOT NULL AND TRIM(scope_id) != ''
			 ORDER BY priority DESC, id ASC`,
		)
		.all() as ScopeMapping[];
}

function hasRepositoryConflict(
	mappings: ScopeMapping[],
	repositoryIdentities: ReadonlyMap<string, string>,
	repositoryIdentity: string | null,
): boolean {
	return Boolean(
		repositoryIdentity &&
			hasConflictingRepositoryMappings(mappings, repositoryIdentities, repositoryIdentity),
	);
}

function emptyRepositoryScopeContext(
	row: SessionScopeRow | null,
	mappings: ScopeMapping[],
): RepositoryScopeContext {
	return {
		allowRepositoryCwdFallback: true,
		mappings,
		repositoryIdentity: repositoryIdentityForWorkspace(new Map(), {
			cwd: row?.cwd,
			gitRemote: row?.git_remote ?? null,
			metadataJson: row?.metadata_json,
		}),
	};
}

function addDiscoveredRepositoryWorkspaces(
	db: Database,
	repositoryIdentities: Map<string, string>,
	repositoryIdentity: string,
	mappedWorkspaces: Array<string | null | undefined>,
): void {
	const discoveredWorkspaces = repositoryIdentitiesByWorkspace(db, {
		knownRepositoryIdentities: [repositoryIdentity, ...mappedWorkspaces],
	});
	for (const [workspace, identity] of discoveredWorkspaces) {
		if (identity === repositoryIdentity) repositoryIdentities.set(workspace, identity);
	}
}

function scopeRepositoryEvidence(
	db: Database,
	row: SessionScopeRow | null,
	mappedWorkspaces: Array<string | null | undefined>,
	mappingIdentitySeeds: Array<string | null | undefined>,
) {
	const indexed =
		mappedWorkspaces.length < 900
			? repositoryIdentitiesFromIndexedEvidence(db, mappingIdentitySeeds)
			: null;
	const legacy = () => ({
		evidence: recordedRepositoryIdentityEvidenceByWorkspace(db, [row?.cwd, ...mappedWorkspaces], {
			freshWorkspaces: [row?.cwd],
		}),
		indexed: false,
	});
	if (!indexed) return legacy();
	const requested = [row?.cwd, ...mappedWorkspaces];
	let fresh: ReturnType<typeof recordedRepositoryIdentityEvidenceByWorkspace>;
	try {
		fresh = recordedRepositoryIdentityEvidenceByWorkspace(db, requested, {
			freshWorkspaces: [row?.cwd],
			knownRepositoryIdentities: indexed.known,
			restrictToRequestedWorkspaces: true,
		});
	} catch {
		// Unavailable indexes or query limits must not narrow the policy check.
		return legacy();
	}
	for (const workspace of requested) {
		const cwd = normalizeRepositoryWorkspaceIdentity(workspace);
		if (!cwd) continue;
		indexed.identities.delete(cwd);
		const identity = fresh.byWorkspace.get(cwd);
		if (identity) indexed.identities.set(cwd, identity);
	}
	return {
		evidence: { byWorkspace: indexed.identities, recordedWorkspaces: fresh.recordedWorkspaces },
		indexed: true,
	};
}

function discoverCurrentWorkspace(
	cwd: string | null,
	repositoryIdentities: Map<string, string>,
	recordedWorkspaces: ReadonlySet<string>,
	mappingIdentitySeeds: Array<string | null | undefined>,
): void {
	if (!cwd || recordedWorkspaces.has(cwd)) return;
	const known = new Set(
		[
			...repositoryIdentities.values(),
			...mappingIdentitySeeds.map((identity) => normalizeRepositoryWorkspaceIdentity(identity)),
		].filter((identity): identity is string => identity != null),
	);
	const identity = discoverKnownRepositoryIdentity(cwd, known);
	if (identity) repositoryIdentities.set(cwd, identity);
}

function repositoryScopeContext(
	db: Database,
	row: SessionScopeRow | null,
	mappings: ScopeMapping[],
): RepositoryScopeContext {
	if (mappings.length === 0) return emptyRepositoryScopeContext(row, mappings);
	const mappedWorkspaces = mappings.map((mapping) => mapping.workspace_identity);
	const mappingIdentitySeeds = mappings.flatMap((mapping) => [
		mapping.workspace_identity,
		mapping.project_pattern,
	]);
	const { evidence, indexed } = scopeRepositoryEvidence(
		db,
		row,
		mappedWorkspaces,
		mappingIdentitySeeds,
	);
	const repositoryIdentities = evidence.byWorkspace;
	const cwd = normalizeRepositoryWorkspaceIdentity(row?.cwd);
	const ambiguousCwd = Boolean(
		cwd && evidence.recordedWorkspaces.has(cwd) && !repositoryIdentities.has(cwd),
	);
	discoverCurrentWorkspace(
		cwd,
		repositoryIdentities,
		evidence.recordedWorkspaces,
		mappingIdentitySeeds,
	);
	const repositoryIdentity = repositoryIdentityForWorkspace(repositoryIdentities, {
		cwd: row?.cwd,
		gitRemote: row?.git_remote ?? null,
		metadataJson: row?.metadata_json,
	});
	if (repositoryIdentity && !indexed) {
		addDiscoveredRepositoryWorkspaces(
			db,
			repositoryIdentities,
			repositoryIdentity,
			mappingIdentitySeeds,
		);
	}
	const repositoryConflict = hasRepositoryConflict(
		mappings,
		repositoryIdentities,
		repositoryIdentity,
	);
	const unresolvedAmbiguousCwd = ambiguousCwd && !repositoryIdentity;
	let effectiveMappings = mappings;
	if (repositoryConflict || unresolvedAmbiguousCwd) {
		effectiveMappings = [];
	} else if (!ambiguousCwd) {
		effectiveMappings = withRepositoryMappingAliasesFromIdentities(mappings, repositoryIdentities, {
			discoverFilesystem: true,
		});
	}
	return {
		allowRepositoryCwdFallback: !ambiguousCwd && !repositoryConflict,
		mappings: effectiveMappings,
		repositoryIdentity,
	};
}

function loadSessionScopeRow(db: Database, sessionId: number): SessionScopeRow | null {
	const row = db
		.prepare(
			"SELECT cwd, project, git_remote, git_branch, metadata_json FROM sessions WHERE id = ? LIMIT 1",
		)
		.get(sessionId) as SessionScopeRow | undefined;
	return row ?? null;
}

export function resolveSessionScopeId(db: Database, options: ResolveSessionScopeOptions): string {
	const explicitScopeId = clean(options.explicitScopeId);
	if (explicitScopeId) return explicitScopeId;
	const session = loadSessionScopeRow(db, options.sessionId);
	const context = repositoryScopeContext(db, session, loadProjectScopeMappings(db));
	const result = resolveProjectScope({
		allowRepositoryCwdFallback: context.allowRepositoryCwdFallback,
		gitRemote: session?.git_remote ?? null,
		gitBranch: session?.git_branch ?? null,
		repositoryIdentity: context.repositoryIdentity,
		cwd: session?.cwd ?? null,
		project: session?.project ?? null,
		workspaceId: options.workspaceId ?? null,
		localDefaultScopeId: options.localDefaultScopeId ?? LOCAL_DEFAULT_SCOPE_ID,
		mappings: context.mappings,
	});
	return result.scopeId;
}

function loadMemoryScopeRow(db: Database, memoryId: number): MemoryScopeRow | null {
	const row = db
		.prepare(
			`SELECT
				mi.id,
				mi.session_id,
				mi.workspace_id,
				mi.scope_id,
				s.cwd,
				s.project,
				s.git_remote,
				s.git_branch,
				s.metadata_json
			 FROM memory_items mi
			 LEFT JOIN sessions s ON s.id = mi.session_id
			 WHERE mi.id = ?
			 LIMIT 1`,
		)
		.get(memoryId) as MemoryScopeRow | undefined;
	return row ?? null;
}

export function ensureMemoryScopeId(db: Database, memoryId: number): string | null {
	const row = loadMemoryScopeRow(db, memoryId);
	if (!row) return null;
	const existingScopeId = clean(row.scope_id);
	if (existingScopeId) return existingScopeId;
	const context = repositoryScopeContext(db, row, loadProjectScopeMappings(db));
	const result = resolveProjectScope({
		allowRepositoryCwdFallback: context.allowRepositoryCwdFallback,
		gitRemote: row.git_remote,
		gitBranch: row.git_branch,
		repositoryIdentity: context.repositoryIdentity,
		cwd: row.cwd,
		project: row.project,
		workspaceId: row.workspace_id,
		localDefaultScopeId: LOCAL_DEFAULT_SCOPE_ID,
		mappings: context.mappings,
	});
	db.prepare(
		`UPDATE memory_items
		 SET scope_id = ?
		 WHERE id = ?
		   AND (scope_id IS NULL OR TRIM(scope_id) = '')`,
	).run(result.scopeId, memoryId);
	return result.scopeId;
}
