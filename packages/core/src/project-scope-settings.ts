import { createHash } from "node:crypto";
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
	guardrail_warnings: ProjectScopeGuardrailWarning[];
}

export type ProjectScopeGuardrailCode =
	| "unknown_project_local_only"
	| "basename_collision_review"
	| "broad_org_domain_pattern"
	| "home_directory_org_domain_pattern"
	| "scope_reassignment_old_copies";

export type ProjectScopeGuardrailSeverity = "info" | "warning";

export interface ProjectScopeGuardrailWarning {
	code: ProjectScopeGuardrailCode;
	severity: ProjectScopeGuardrailSeverity;
	message: string;
	requires_confirmation: boolean;
	scope_id?: string | null;
	previous_scope_id?: string | null;
	mapping_id?: number | null;
	workspace_identity?: string | null;
	project_pattern?: string | null;
	related_workspace_identities?: string[];
	related_projects?: string[];
	confirmation_token?: string;
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
	guardrail_warnings: ProjectScopeGuardrailWarning[];
}

export interface UpsertProjectScopeMappingInput {
	id?: number | null;
	workspace_identity?: string | null;
	project_pattern?: string | null;
	scope_id: string;
	priority?: number | null;
	source?: string | null;
}

export interface ProjectScopeMappingChangeGuardrailAnalysis {
	existing_mapping: ProjectScopeSettingsMapping | null;
	requested_scope_id: string;
	requested_workspace_identity: string | null;
	requested_project_pattern: string | null;
	warnings: ProjectScopeGuardrailWarning[];
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

function normalizeWorkspaceIdentity(value: string | null | undefined): string | null {
	const cleaned = clean(value);
	if (!cleaned) return null;
	const normalized = cleaned.replaceAll("\\", "/").replace(/\/+$/, "");
	return normalized || cleaned;
}

function scopeDisplayName(scope: SharingDomainSettingsScope | undefined, scopeId: string): string {
	return scope?.label || scopeId;
}

function scopeLookup(
	scopes: SharingDomainSettingsScope[],
): Map<string, SharingDomainSettingsScope> {
	return new Map(scopes.map((scope) => [scope.scope_id, scope]));
}

function isOrgLikeScope(scope: SharingDomainSettingsScope | undefined): boolean {
	if (!scope || scope.scope_id === LOCAL_DEFAULT_SCOPE_ID) return false;
	if (scope.authority_type !== "local") return true;
	return scope.kind === "team" || scope.kind === "org" || scope.kind === "client";
}

function hasWildcard(value: string): boolean {
	return /[*?]/.test(value);
}

function prefixBeforeWildcard(value: string): string {
	const index = value.search(/[*?]/);
	return (index >= 0 ? value.slice(0, index) : value).replace(/\/+$/, "");
}

function isHomeDirectoryRootPattern(pattern: string): boolean {
	const prefix = prefixBeforeWildcard(pattern.replaceAll("\\", "/"));
	return (
		prefix === "~" ||
		/^\/Users\/[^/]+$/i.test(prefix) ||
		/^\/home\/[^/]+$/i.test(prefix) ||
		/^\/var\/home\/[^/]+$/i.test(prefix) ||
		/^[A-Z]:\/Users\/[^/]+$/i.test(prefix)
	);
}

function guardrailConfirmationToken(warning: ProjectScopeGuardrailWarning): string {
	const payload = JSON.stringify({
		code: warning.code,
		mapping_id: warning.mapping_id ?? null,
		project_pattern: warning.project_pattern ?? null,
		previous_scope_id: warning.previous_scope_id ?? null,
		related_workspace_identities: warning.related_workspace_identities?.toSorted() ?? [],
		scope_id: warning.scope_id ?? null,
		workspace_identity: warning.workspace_identity ?? null,
	});
	return `psg_${createHash("sha256").update(payload).digest("hex").slice(0, 32)}`;
}

function withGuardrailConfirmationToken(
	warning: ProjectScopeGuardrailWarning,
): ProjectScopeGuardrailWarning {
	if (!warning.requires_confirmation) return warning;
	return { ...warning, confirmation_token: guardrailConfirmationToken(warning) };
}

function projectScopeMappingGuardrailWarnings(
	mapping: Pick<
		ProjectScopeSettingsMapping,
		"id" | "workspace_identity" | "project_pattern" | "scope_id"
	>,
	scopesById: Map<string, SharingDomainSettingsScope>,
): ProjectScopeGuardrailWarning[] {
	if (mapping.workspace_identity) return [];
	const pattern = normalizeWorkspaceIdentity(mapping.project_pattern) ?? mapping.project_pattern;
	const scope = scopesById.get(mapping.scope_id);
	if (!isOrgLikeScope(scope)) return [];
	const scopeName = scopeDisplayName(scope, mapping.scope_id);
	const warnings: ProjectScopeGuardrailWarning[] = [];
	if (hasWildcard(pattern)) {
		warnings.push({
			code: "broad_org_domain_pattern",
			severity: "warning",
			message: `Wildcard project pattern ${pattern} can catch multiple projects. Review before attaching it to ${scopeName}.`,
			requires_confirmation: true,
			scope_id: mapping.scope_id,
			mapping_id: mapping.id ?? null,
			project_pattern: mapping.project_pattern,
		});
	}
	if (isHomeDirectoryRootPattern(pattern)) {
		warnings.push({
			code: "home_directory_org_domain_pattern",
			severity: "warning",
			message: `Home-directory project pattern ${pattern} can mix personal and work projects. Review before attaching it to ${scopeName}.`,
			requires_confirmation: true,
			scope_id: mapping.scope_id,
			mapping_id: mapping.id ?? null,
			project_pattern: mapping.project_pattern,
		});
	}
	return warnings.map(withGuardrailConfirmationToken);
}

function projectNameKey(project: ProjectScopeCandidate): string {
	return (
		clean(project.project) ??
		clean(project.display_project) ??
		project.workspace_identity
	).toLowerCase();
}

function candidateCollisionMap(
	candidates: ProjectScopeCandidate[],
): Map<string, ProjectScopeCandidate[]> {
	const groups = new Map<string, ProjectScopeCandidate[]>();
	for (const candidate of candidates) {
		const key = projectNameKey(candidate);
		groups.set(key, [...(groups.get(key) ?? []), candidate]);
	}
	return groups;
}

function projectScopeCandidateGuardrailWarnings(
	project: ProjectScopeCandidate,
	collisions: Map<string, ProjectScopeCandidate[]>,
): ProjectScopeGuardrailWarning[] {
	const warnings: ProjectScopeGuardrailWarning[] = [];
	if (project.resolution_reason === "local_default") {
		warnings.push({
			code: "unknown_project_local_only",
			severity: "info",
			message:
				"No Sharing domain mapping matches this project, so future memories stay Local only until you assign one.",
			requires_confirmation: false,
			workspace_identity: project.workspace_identity,
			scope_id: LOCAL_DEFAULT_SCOPE_ID,
		});
	}
	const related = (collisions.get(projectNameKey(project)) ?? []).filter(
		(candidate) => candidate.workspace_identity !== project.workspace_identity,
	);
	if (related.length > 0) {
		warnings.push({
			code: "basename_collision_review",
			severity: "warning",
			message: `Another project is also named ${project.display_project}. Review the git remote or path before assigning a non-local Sharing domain.`,
			requires_confirmation: true,
			workspace_identity: project.workspace_identity,
			related_workspace_identities: related.map((candidate) => candidate.workspace_identity),
			related_projects: related.map((candidate) => candidate.display_project),
		});
	}
	return warnings.map(withGuardrailConfirmationToken);
}

function withCandidateGuardrails(candidates: ProjectScopeCandidate[]): ProjectScopeCandidate[] {
	const collisions = candidateCollisionMap(candidates);
	return candidates.map((candidate) => ({
		...candidate,
		guardrail_warnings: projectScopeCandidateGuardrailWarnings(candidate, collisions),
	}));
}

function dedupeGuardrailWarnings(
	warnings: ProjectScopeGuardrailWarning[],
): ProjectScopeGuardrailWarning[] {
	const seen = new Set<string>();
	return warnings
		.filter((warning) => {
			const key = [
				warning.code,
				warning.scope_id ?? "",
				warning.workspace_identity ?? "",
				warning.project_pattern ?? "",
				warning.related_workspace_identities?.join("|") ?? "",
			].join("\0");
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map(withGuardrailConfirmationToken);
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
		workspace_identity: normalizeWorkspaceIdentity(
			row.workspace_identity as string | null | undefined,
		),
		project_pattern: String(row.project_pattern ?? ""),
		scope_id: String(row.scope_id ?? ""),
		priority: Number(row.priority ?? 0),
		source: String(row.source ?? "user"),
		created_at: String(row.created_at ?? ""),
		updated_at: String(row.updated_at ?? ""),
		guardrail_warnings: [],
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
	ensureScopeBackfillScopes(db);
	const scopesById = scopeLookup(listSharingDomainSettingsScopes(db));
	return db
		.prepare(
			`SELECT id, workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 FROM project_scope_mappings
			 ORDER BY priority DESC, updated_at DESC, id DESC`,
		)
		.all()
		.map((row) => {
			const mapping = rowToMapping(row as Record<string, unknown>);
			return {
				...mapping,
				guardrail_warnings: projectScopeMappingGuardrailWarnings(mapping, scopesById),
			};
		});
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

interface ProjectScopeMappingDraft {
	existing: ProjectScopeSettingsMapping | null;
	workspaceIdentity: string | null;
	projectPattern: string | null;
	scopeId: string;
	priority: number;
	source: string;
}

function resolveProjectScopeMappingDraft(
	db: Database,
	input: UpsertProjectScopeMappingInput,
): ProjectScopeMappingDraft {
	const id = input.id == null ? null : Number(input.id);
	const byId = id && Number.isInteger(id) ? getProjectScopeSettingsMappingById(db, id) : null;
	const workspaceIdentity =
		normalizeWorkspaceIdentity(input.workspace_identity) ?? byId?.workspace_identity ?? null;
	const byWorkspace = workspaceIdentity
		? getProjectScopeSettingsMappingByWorkspaceIdentity(db, workspaceIdentity)
		: null;
	const existing = byId ?? byWorkspace;
	const projectPattern =
		clean(input.project_pattern) ?? existing?.project_pattern ?? workspaceIdentity;
	const priority = input.priority == null ? (existing?.priority ?? 0) : Number(input.priority);
	return {
		existing,
		workspaceIdentity,
		projectPattern,
		scopeId: clean(input.scope_id) ?? "",
		priority,
		source: clean(input.source) ?? "user",
	};
}

export function analyzeProjectScopeMappingChangeGuardrails(
	db: Database,
	input: UpsertProjectScopeMappingInput,
): ProjectScopeMappingChangeGuardrailAnalysis {
	ensureScopeBackfillScopes(db);
	const draft = resolveProjectScopeMappingDraft(db, input);
	const scopes = listSharingDomainSettingsScopes(db);
	const scopesById = scopeLookup(scopes);
	const warnings: ProjectScopeGuardrailWarning[] = [];
	if (draft.projectPattern && draft.scopeId) {
		warnings.push(
			...projectScopeMappingGuardrailWarnings(
				{
					id: draft.existing?.id ?? 0,
					workspace_identity: draft.workspaceIdentity,
					project_pattern: draft.projectPattern,
					scope_id: draft.scopeId,
				},
				scopesById,
			),
		);
	}
	const candidate = draft.workspaceIdentity
		? listProjectScopeCandidates(db).find(
				(project) => project.workspace_identity === draft.workspaceIdentity,
			)
		: null;
	const requestedScope = scopesById.get(draft.scopeId);
	if (candidate) {
		warnings.push(
			...candidate.guardrail_warnings.filter(
				(warning) => warning.code !== "basename_collision_review" || isOrgLikeScope(requestedScope),
			),
		);
	}
	if (draft.scopeId && draft.existing && draft.existing.scope_id !== draft.scopeId) {
		const oldScope = scopeDisplayName(
			scopesById.get(draft.existing.scope_id),
			draft.existing.scope_id,
		);
		const newScope = scopeDisplayName(scopesById.get(draft.scopeId), draft.scopeId);
		warnings.push({
			code: "scope_reassignment_old_copies",
			severity: "warning",
			message: `Changing this project from ${oldScope} to ${newScope} does not recall data already copied under the old Sharing domain. Previous recipients may retain it.`,
			requires_confirmation: true,
			scope_id: draft.scopeId,
			previous_scope_id: draft.existing.scope_id,
			mapping_id: draft.existing.id,
			workspace_identity: draft.workspaceIdentity,
			project_pattern: draft.projectPattern,
		});
	}
	return {
		existing_mapping: draft.existing,
		requested_scope_id: draft.scopeId,
		requested_workspace_identity: draft.workspaceIdentity,
		requested_project_pattern: draft.projectPattern,
		warnings: dedupeGuardrailWarnings(warnings),
	};
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
			guardrail_warnings: [],
		});
	}

	return withCandidateGuardrails(
		candidates.toSorted(
			(left, right) =>
				left.display_project.localeCompare(right.display_project) ||
				left.workspace_identity.localeCompare(right.workspace_identity),
		),
	);
}

export function upsertProjectScopeSettingsMapping(
	db: Database,
	input: UpsertProjectScopeMappingInput,
): ProjectScopeSettingsMapping {
	ensureScopeBackfillScopes(db);
	const draft = resolveProjectScopeMappingDraft(db, input);
	const scopeId = draft.scopeId;
	if (!scopeId) throw new Error("scope_id must be a non-empty string");
	assertActiveScope(db, scopeId);

	const { existing, workspaceIdentity } = draft;
	const projectPattern = draft.projectPattern;
	if (!projectPattern) throw new Error("project_pattern or workspace_identity is required");
	assertCanonicalPattern(workspaceIdentity, projectPattern);

	const priority = draft.priority;
	if (!Number.isFinite(priority) || !Number.isInteger(priority)) {
		throw new Error("priority must be an integer");
	}

	const source = draft.source;
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
