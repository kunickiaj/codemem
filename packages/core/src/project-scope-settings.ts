import type { Database } from "./db.js";
import { ensureScopeBackfillScopes } from "./scope-backfill.js";
import {
	canonicalWorkspaceIdentity,
	LOCAL_DEFAULT_SCOPE_ID,
	resolveProjectScope,
	type ScopeMapping,
	type ScopeResolutionReason,
	type WorkspaceIdentitySource,
} from "./scope-resolution.js";

export interface SharingDomainSettingsScope {
	scope_id: string;
	label: string;
	kind: string;
	authority_type: string;
	coordinator_id: string | null;
	group_id: string | null;
	membership_epoch: number;
	status: string;
	updated_at: string;
}

export interface ProjectScopeSettingsMapping extends ScopeMapping {
	id: number;
	workspace_identity: string | null;
	project_pattern: string;
	scope_id: string;
	priority: number;
	source: string;
	created_at: string;
	updated_at: string;
}

export interface ProjectScopeCandidate {
	workspace_identity: string;
	identity_source: WorkspaceIdentitySource;
	display_project: string;
	project: string | null;
	cwd: string | null;
	git_remote: string | null;
	git_branch: string | null;
	latest_session_at: string | null;
	resolved_scope_id: string;
	resolution_reason: ScopeResolutionReason;
	mapping_id: number | null;
	matched_pattern: string | null;
}

export interface UpsertProjectScopeMappingInput {
	id?: number | null;
	workspace_identity?: string | null;
	project_pattern?: string | null;
	scope_id: string;
	priority?: number | null;
	source?: string | null;
}

interface ProjectScopeCandidateRow {
	id: number;
	started_at: string | null;
	cwd: string | null;
	project: string | null;
	git_remote: string | null;
	git_branch: string | null;
	workspace_id: string | null;
}

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function assertCanonicalPattern(workspaceIdentity: string | null, projectPattern: string): void {
	if (workspaceIdentity) return;
	if (/[\\/:]/.test(projectPattern)) return;
	if (/[*?]/.test(projectPattern) && /[\\/:]/.test(projectPattern.replace(/[*?]/g, ""))) return;
	throw new Error("project_pattern must use a canonical path, remote, or workspace pattern");
}

function rowToScope(row: Record<string, unknown>): SharingDomainSettingsScope {
	return {
		scope_id: String(row.scope_id ?? ""),
		label: String(row.label ?? ""),
		kind: String(row.kind ?? "user"),
		authority_type: String(row.authority_type ?? "local"),
		coordinator_id: clean(row.coordinator_id as string | null | undefined),
		group_id: clean(row.group_id as string | null | undefined),
		membership_epoch: Number(row.membership_epoch ?? 0),
		status: String(row.status ?? "active"),
		updated_at: String(row.updated_at ?? ""),
	};
}

function rowToMapping(row: Record<string, unknown>): ProjectScopeSettingsMapping {
	return {
		id: Number(row.id ?? 0),
		workspace_identity: clean(row.workspace_identity as string | null | undefined),
		project_pattern: String(row.project_pattern ?? ""),
		scope_id: String(row.scope_id ?? ""),
		priority: Number(row.priority ?? 0),
		source: String(row.source ?? "user"),
		created_at: String(row.created_at ?? ""),
		updated_at: String(row.updated_at ?? ""),
	};
}

export function listSharingDomainSettingsScopes(db: Database): SharingDomainSettingsScope[] {
	ensureScopeBackfillScopes(db);
	return db
		.prepare(
			`SELECT scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, updated_at
			 FROM replication_scopes
			 WHERE status = 'active'
			 ORDER BY CASE WHEN scope_id = ? THEN 0 ELSE 1 END, label COLLATE NOCASE, scope_id`,
		)
		.all(LOCAL_DEFAULT_SCOPE_ID)
		.map((row) => rowToScope(row as Record<string, unknown>));
}

export function listProjectScopeSettingsMappings(db: Database): ProjectScopeSettingsMapping[] {
	return db
		.prepare(
			`SELECT id, workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 FROM project_scope_mappings
			 ORDER BY priority DESC, updated_at DESC, id DESC`,
		)
		.all()
		.map((row) => rowToMapping(row as Record<string, unknown>));
}

function getProjectScopeSettingsMappingById(
	db: Database,
	id: number,
): ProjectScopeSettingsMapping | null {
	const row = db
		.prepare(
			`SELECT id, workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 FROM project_scope_mappings
			 WHERE id = ?
			 LIMIT 1`,
		)
		.get(id) as Record<string, unknown> | undefined;
	return row ? rowToMapping(row) : null;
}

function getProjectScopeSettingsMappingByWorkspaceIdentity(
	db: Database,
	workspaceIdentity: string,
): ProjectScopeSettingsMapping | null {
	const row = db
		.prepare(
			`SELECT id, workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 FROM project_scope_mappings
			 WHERE workspace_identity = ?
			 ORDER BY priority DESC, updated_at DESC, id DESC
			 LIMIT 1`,
		)
		.get(workspaceIdentity) as Record<string, unknown> | undefined;
	return row ? rowToMapping(row) : null;
}

function assertActiveScope(db: Database, scopeId: string): void {
	const row = db
		.prepare("SELECT 1 FROM replication_scopes WHERE scope_id = ? AND status = 'active' LIMIT 1")
		.get(scopeId);
	if (!row) throw new Error(`scope_id ${scopeId} is not an active Sharing domain`);
}

export function listProjectScopeCandidates(
	db: Database,
	options: { limit?: number } = {},
): ProjectScopeCandidate[] {
	ensureScopeBackfillScopes(db);
	const limit = Math.max(1, Math.min(options.limit ?? 250, 1000));
	const mappings = listProjectScopeSettingsMappings(db);
	const rows = db
		.prepare(
			`SELECT
				s.id,
				s.started_at,
				s.cwd,
				s.project,
				s.git_remote,
				s.git_branch,
				(
					SELECT mi.workspace_id
					FROM memory_items mi
					WHERE mi.session_id = s.id
					  AND mi.workspace_id IS NOT NULL
					  AND TRIM(mi.workspace_id) <> ''
					ORDER BY mi.id DESC
					LIMIT 1
				) AS workspace_id
			 FROM sessions s
			 WHERE COALESCE(TRIM(s.git_remote), TRIM(s.cwd), TRIM(s.project), '') <> ''
			    OR EXISTS (SELECT 1 FROM memory_items mi_candidate WHERE mi_candidate.session_id = s.id)
			 ORDER BY s.started_at DESC, s.id DESC
			 LIMIT ?`,
		)
		.all(limit) as ProjectScopeCandidateRow[];

	const seen = new Set<string>();
	const candidates: ProjectScopeCandidate[] = [];
	for (const row of rows) {
		const identity = canonicalWorkspaceIdentity({
			gitRemote: row.git_remote,
			gitBranch: row.git_branch,
			cwd: row.cwd,
			project: row.project,
			workspaceId: row.workspace_id,
		});
		if (seen.has(identity.value)) continue;
		seen.add(identity.value);
		const resolution = resolveProjectScope({
			gitRemote: row.git_remote,
			gitBranch: row.git_branch,
			cwd: row.cwd,
			project: row.project,
			workspaceId: row.workspace_id,
			mappings,
		});
		candidates.push({
			workspace_identity: identity.value,
			identity_source: identity.source,
			display_project:
				identity.displayProject ?? clean(row.project) ?? clean(row.cwd) ?? identity.value,
			project: clean(row.project),
			cwd: clean(row.cwd),
			git_remote: clean(row.git_remote),
			git_branch: clean(row.git_branch),
			latest_session_at: row.started_at,
			resolved_scope_id: resolution.scopeId,
			resolution_reason: resolution.reason,
			mapping_id: resolution.mapping?.id ?? null,
			matched_pattern: resolution.matchedPattern,
		});
	}

	return candidates.toSorted(
		(left, right) =>
			left.display_project.localeCompare(right.display_project) ||
			left.workspace_identity.localeCompare(right.workspace_identity),
	);
}

export function upsertProjectScopeSettingsMapping(
	db: Database,
	input: UpsertProjectScopeMappingInput,
): ProjectScopeSettingsMapping {
	ensureScopeBackfillScopes(db);
	const scopeId = clean(input.scope_id);
	if (!scopeId) throw new Error("scope_id must be a non-empty string");
	assertActiveScope(db, scopeId);

	const id = input.id == null ? null : Number(input.id);
	const byId = id && Number.isInteger(id) ? getProjectScopeSettingsMappingById(db, id) : null;
	const workspaceIdentity = clean(input.workspace_identity) ?? byId?.workspace_identity ?? null;
	const byWorkspace = workspaceIdentity
		? getProjectScopeSettingsMappingByWorkspaceIdentity(db, workspaceIdentity)
		: null;
	const existing = byId ?? byWorkspace;
	const projectPattern =
		clean(input.project_pattern) ?? existing?.project_pattern ?? workspaceIdentity;
	if (!projectPattern) throw new Error("project_pattern or workspace_identity is required");
	assertCanonicalPattern(workspaceIdentity, projectPattern);

	const priority = input.priority == null ? (existing?.priority ?? 0) : Number(input.priority);
	if (!Number.isFinite(priority) || !Number.isInteger(priority)) {
		throw new Error("priority must be an integer");
	}

	const source = clean(input.source) ?? "user";
	const now = new Date().toISOString();
	if (existing) {
		db.prepare(
			`UPDATE project_scope_mappings
			 SET workspace_identity = ?, project_pattern = ?, scope_id = ?, priority = ?, source = ?, updated_at = ?
			 WHERE id = ?`,
		).run(workspaceIdentity, projectPattern, scopeId, priority, source, now, existing.id);
		const saved = getProjectScopeSettingsMappingById(db, existing.id);
		if (!saved) throw new Error("project_scope_mapping update returned no row");
		return saved;
	}

	const result = db
		.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(workspaceIdentity, projectPattern, scopeId, priority, source, now, now);
	const saved = getProjectScopeSettingsMappingById(db, Number(result.lastInsertRowid));
	if (!saved) throw new Error("project_scope_mapping insert returned no row");
	return saved;
}

export function deleteProjectScopeSettingsMapping(db: Database, id: number): boolean {
	if (!Number.isInteger(id) || id <= 0) throw new Error("id must be a positive integer");
	const result = db.prepare("DELETE FROM project_scope_mappings WHERE id = ?").run(id);
	return Number(result.changes ?? 0) > 0;
}
