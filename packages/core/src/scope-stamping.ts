import type { Database } from "./db.js";
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

function loadSessionScopeRow(db: Database, sessionId: number): SessionScopeRow | null {
	const row = db
		.prepare("SELECT cwd, project, git_remote, git_branch FROM sessions WHERE id = ? LIMIT 1")
		.get(sessionId) as SessionScopeRow | undefined;
	return row ?? null;
}

export function resolveSessionScopeId(db: Database, options: ResolveSessionScopeOptions): string {
	const session = loadSessionScopeRow(db, options.sessionId);
	const result = resolveProjectScope({
		gitRemote: session?.git_remote ?? null,
		gitBranch: session?.git_branch ?? null,
		cwd: session?.cwd ?? null,
		project: session?.project ?? null,
		workspaceId: options.workspaceId ?? null,
		explicitScopeId: options.explicitScopeId ?? null,
		localDefaultScopeId: options.localDefaultScopeId ?? LOCAL_DEFAULT_SCOPE_ID,
		mappings: loadProjectScopeMappings(db),
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
				s.git_branch
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

	const result = resolveProjectScope({
		gitRemote: row.git_remote,
		gitBranch: row.git_branch,
		cwd: row.cwd,
		project: row.project,
		workspaceId: row.workspace_id,
		localDefaultScopeId: LOCAL_DEFAULT_SCOPE_ID,
		mappings: loadProjectScopeMappings(db),
	});
	db.prepare(
		`UPDATE memory_items
		 SET scope_id = ?
		 WHERE id = ?
		   AND (scope_id IS NULL OR TRIM(scope_id) = '')`,
	).run(result.scopeId, memoryId);
	return result.scopeId;
}
