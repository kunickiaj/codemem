import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import { ensureScopeBackfillScopes, LEGACY_SHARED_REVIEW_SCOPE_ID } from "./scope-backfill.js";
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
	suggested_scope_id: string | null;
	suggestion_reason: string | null;
	suggestion_signal: WorkspaceIdentitySource | null;
	guardrail_warnings: ProjectScopeGuardrailWarning[];
}

export type ProjectScopeInventoryStatus =
	| "explicitly_mapped"
	| "legacy_review"
	| "local_only"
	| "needs_attention"
	| "suggested"
	| "unmapped";

export interface ProjectScopeInventoryProject extends ProjectScopeCandidate {
	memory_count: number | null;
	session_count: number;
	statuses: ProjectScopeInventoryStatus[];
}

export interface ProjectScopeInventoryOptions {
	identitySource?: string | null;
	limit?: number;
	offset?: number;
	query?: string | null;
	scopeId?: string | null;
	status?: string | null;
}

export interface ProjectScopeInventoryResult {
	projects: ProjectScopeInventoryProject[];
	total: number;
	limit: number;
	offset: number;
	has_more: boolean;
}

interface ProjectScopeSuggestion {
	scopeId: string;
	reason: string;
	signal: WorkspaceIdentitySource;
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

export interface ReassignProjectScopeInventoryProjectResult {
	workspace_identity: string;
	project: string;
	previous_projects: string[];
	moved_session_count: number;
	moved_memory_count: number;
}

interface ProjectScopeCandidateRow {
	id: number;
	started_at: string | null;
	cwd: string | null;
	project: string | null;
	git_remote: string | null;
	git_branch: string | null;
	workspace_id: string | null;
	memory_count?: number | null;
	session_count?: number | null;
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

function tokenSet(value: string | null | undefined): Set<string> {
	const normalized = clean(value)?.toLowerCase() ?? "";
	return new Set(normalized.match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []);
}

function scopeSuggestionTokens(scope: SharingDomainSettingsScope): {
	generic: string[];
	specific: string[];
} {
	const ignored = new Set(["domain", "sharing", "devices", "scope", "team", "org", "local"]);
	const generic = new Set(["client", "dev", "oss", "personal", "work"]);
	const tokens = [...tokenSet(`${scope.scope_id} ${scope.label}`)].filter(
		(token) => !ignored.has(token),
	);
	return {
		generic: tokens.filter((token) => generic.has(token)),
		specific: tokens.filter((token) => !generic.has(token)),
	};
}

function signalTexts(
	project: Pick<ProjectScopeCandidate, "git_remote" | "cwd" | "workspace_identity">,
): Array<{ signal: WorkspaceIdentitySource; text: string }> {
	const signals: Array<{ signal: WorkspaceIdentitySource; text: string }> = [];
	if (project.git_remote) signals.push({ signal: "git_remote", text: project.git_remote });
	if (project.cwd) signals.push({ signal: "cwd", text: project.cwd });
	signals.push({ signal: "workspace_id", text: project.workspace_identity });
	return signals;
}

function suggestProjectScope(
	project: Pick<
		ProjectScopeCandidate,
		"git_remote" | "cwd" | "workspace_identity" | "resolved_scope_id" | "resolution_reason"
	>,
	scopes: SharingDomainSettingsScope[],
): ProjectScopeSuggestion | null {
	if (project.resolution_reason !== "local_default") return null;
	if (project.workspace_identity.startsWith("unmapped:")) return null;
	for (const signal of signalTexts(project)) {
		const signalTokens = tokenSet(signal.text);
		const candidates = scopes
			.filter(
				(scope) =>
					scope.scope_id !== LOCAL_DEFAULT_SCOPE_ID &&
					scope.scope_id !== LEGACY_SHARED_REVIEW_SCOPE_ID &&
					scope.status === "active",
			)
			.flatMap((scope) => {
				const tokens = scopeSuggestionTokens(scope);
				const specificMatches = tokens.specific.filter((token) => signalTokens.has(token));
				const genericMatches = tokens.generic.filter(
					(token) => token === "personal" && signalTokens.has(token) && scope.kind === token,
				);
				if (specificMatches.length === 0 && genericMatches.length === 0) return [];
				return [
					{
						scope,
						matches: [...specificMatches, ...genericMatches],
						score: specificMatches.length * 10 + genericMatches.length,
					},
				];
			})
			.toSorted((left, right) => right.score - left.score);
		const [best, second] = candidates;
		if (!best) continue;
		if (second && second.score === best.score) continue;
		const scopeName = scopeDisplayName(best.scope, best.scope.scope_id);
		const signalName = signal.signal === "git_remote" ? "git remote" : signal.signal;
		return {
			scopeId: best.scope.scope_id,
			reason: `${scopeName} is suggested because the ${signalName} contains ${best.matches.join(
				", ",
			)}. Confirm before mapping; this does not grant peer access.`,
			signal: signal.signal,
		};
	}
	return null;
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
			severity: "info",
			message: `Another workspace is also named ${project.display_project}. Review the git remote or path before assigning a non-local Sharing domain.`,
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

function inventoryStatuses(project: ProjectScopeCandidate): ProjectScopeInventoryStatus[] {
	const statuses = new Set<ProjectScopeInventoryStatus>();
	if (project.resolved_scope_id === LOCAL_DEFAULT_SCOPE_ID) statuses.add("local_only");
	if (project.resolved_scope_id === LEGACY_SHARED_REVIEW_SCOPE_ID) statuses.add("legacy_review");
	if (project.identity_source === "unmapped") statuses.add("unmapped");
	if (project.suggested_scope_id && project.suggested_scope_id !== project.resolved_scope_id) {
		statuses.add("suggested");
	}
	if (project.mapping_id != null) statuses.add("explicitly_mapped");
	if ((project.guardrail_warnings ?? []).some((warning) => warning.severity === "warning")) {
		statuses.add("needs_attention");
	}
	return [...statuses].sort();
}

function projectMatchesInventoryQuery(
	project: ProjectScopeInventoryProject,
	query: string | null | undefined,
): boolean {
	const normalized = clean(query)?.toLowerCase();
	if (!normalized) return true;
	return [
		project.display_project,
		project.project,
		project.cwd,
		project.git_remote,
		project.git_branch,
		project.workspace_identity,
		project.resolved_scope_id,
		project.suggested_scope_id,
	]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.some((value) => value.toLowerCase().includes(normalized));
}

function buildProjectScopeCandidate(
	row: ProjectScopeCandidateRow,
	mappings: ProjectScopeSettingsMapping[],
	scopes: SharingDomainSettingsScope[],
): ProjectScopeCandidate {
	const identity = canonicalWorkspaceIdentity({
		gitRemote: row.git_remote,
		gitBranch: row.git_branch,
		cwd: row.cwd,
		project: row.project,
		workspaceId: row.workspace_id,
	});
	const resolution = resolveProjectScope({
		gitRemote: row.git_remote,
		gitBranch: row.git_branch,
		cwd: row.cwd,
		project: row.project,
		workspaceId: row.workspace_id,
		mappings,
	});
	const baseCandidate = {
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
		suggested_scope_id: null,
		suggestion_reason: null,
		suggestion_signal: null,
		guardrail_warnings: [],
	} satisfies ProjectScopeCandidate;
	const suggestion = suggestProjectScope(baseCandidate, scopes);
	return {
		...baseCandidate,
		suggested_scope_id: suggestion?.scopeId ?? null,
		suggestion_reason: suggestion?.reason ?? null,
		suggestion_signal: suggestion?.signal ?? null,
	};
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
	if (scopeId === LEGACY_SHARED_REVIEW_SCOPE_ID) {
		throw new Error("legacy-shared-review is a review bucket, not an assignable Sharing domain");
	}
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
		? listProjectScopeCandidates(db, { limit: null }).find(
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
	options: { limit?: number | null } = {},
): ProjectScopeCandidate[] {
	ensureScopeBackfillScopes(db);
	const limit = options.limit === null ? null : Math.max(1, Math.min(options.limit ?? 250, 1000));
	const mappings = listProjectScopeSettingsMappings(db);
	const scopes = listSharingDomainSettingsScopes(db);
	const sql = `SELECT
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
			 ORDER BY s.started_at DESC, s.id DESC${limit == null ? "" : "\n\t\t\t LIMIT ?"}`;
	const rows = (
		limit == null ? db.prepare(sql).all() : db.prepare(sql).all(limit)
	) as ProjectScopeCandidateRow[];

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
		candidates.push(buildProjectScopeCandidate(row, mappings, scopes));
	}

	return withCandidateGuardrails(
		candidates.toSorted(
			(left, right) =>
				left.display_project.localeCompare(right.display_project) ||
				left.workspace_identity.localeCompare(right.workspace_identity),
		),
	);
}

export function listProjectScopeInventory(
	db: Database,
	options: ProjectScopeInventoryOptions = {},
): ProjectScopeInventoryResult {
	ensureScopeBackfillScopes(db);
	const limit = Math.max(1, Math.min(options.limit ?? 50, 250));
	const offset = Math.max(0, options.offset ?? 0);
	const mappings = listProjectScopeSettingsMappings(db);
	const scopes = listSharingDomainSettingsScopes(db);
	const rows = db
		.prepare(
			`SELECT
				s.id,
				MAX(s.started_at) AS started_at,
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
				) AS workspace_id,
				COUNT(DISTINCT s.id) AS session_count,
				COUNT(mi_count.id) AS memory_count
			 FROM sessions s
			 LEFT JOIN memory_items mi_count ON mi_count.session_id = s.id
			 WHERE COALESCE(TRIM(s.git_remote), TRIM(s.cwd), TRIM(s.project), '') <> ''
			    OR mi_count.id IS NOT NULL
			 GROUP BY s.id
			 ORDER BY MAX(s.started_at) DESC, s.id DESC`,
		)
		.all() as ProjectScopeCandidateRow[];

	const byIdentity = new Map<string, ProjectScopeInventoryProject>();
	const inventory: ProjectScopeInventoryProject[] = [];
	for (const row of rows) {
		const candidate = buildProjectScopeCandidate(row, mappings, scopes);
		const existing = byIdentity.get(candidate.workspace_identity);
		if (existing) {
			existing.memory_count = (existing.memory_count ?? 0) + Number(row.memory_count ?? 0);
			existing.session_count += Number(row.session_count ?? 1);
			continue;
		}
		const project = {
			...candidate,
			memory_count: Number(row.memory_count ?? 0),
			session_count: Number(row.session_count ?? 1),
			statuses: [],
		};
		byIdentity.set(candidate.workspace_identity, project);
		inventory.push(project);
	}

	for (const mapping of mappings) {
		if (!mapping.workspace_identity || byIdentity.has(mapping.workspace_identity)) continue;
		const candidate: ProjectScopeCandidate = {
			workspace_identity: mapping.workspace_identity,
			identity_source: "workspace_id",
			display_project: mapping.project_pattern || mapping.workspace_identity,
			project: mapping.project_pattern || null,
			cwd: null,
			git_remote: null,
			git_branch: null,
			latest_session_at: null,
			resolved_scope_id: mapping.scope_id,
			resolution_reason: "exact_mapping",
			mapping_id: mapping.id,
			matched_pattern: null,
			suggested_scope_id: null,
			suggestion_reason: null,
			suggestion_signal: null,
			guardrail_warnings: [],
		};
		const project = { ...candidate, memory_count: 0, session_count: 0, statuses: [] };
		byIdentity.set(mapping.workspace_identity, project);
		inventory.push(project);
	}

	const withGuardrails = withCandidateGuardrails(inventory).map((project) => {
		const original = inventory.find(
			(item) => item.workspace_identity === project.workspace_identity,
		);
		return {
			...project,
			memory_count: original?.memory_count ?? null,
			session_count: original?.session_count ?? 0,
			statuses: inventoryStatuses(project),
		};
	});

	const filtered = withGuardrails
		.filter((project) => projectMatchesInventoryQuery(project, options.query))
		.filter((project) => !options.scopeId || project.resolved_scope_id === options.scopeId)
		.filter(
			(project) => !options.identitySource || project.identity_source === options.identitySource,
		)
		.filter(
			(project) => !options.status || project.statuses.some((status) => status === options.status),
		)
		.toSorted(
			(left, right) =>
				(left.latest_session_at == null ? 1 : right.latest_session_at == null ? -1 : 0) ||
				String(right.latest_session_at ?? "").localeCompare(String(left.latest_session_at ?? "")) ||
				left.display_project.localeCompare(right.display_project) ||
				left.workspace_identity.localeCompare(right.workspace_identity),
		);

	return {
		projects: filtered.slice(offset, offset + limit),
		total: filtered.length,
		limit,
		offset,
		has_more: offset + limit < filtered.length,
	};
}

export function reassignProjectScopeInventoryProject(
	db: Database,
	input: { workspaceIdentity: string; project: string },
): ReassignProjectScopeInventoryProjectResult {
	ensureScopeBackfillScopes(db);
	const workspaceIdentity = normalizeWorkspaceIdentity(input.workspaceIdentity);
	if (!workspaceIdentity) throw new Error("workspace_identity must be a non-empty string");
	if (workspaceIdentity.startsWith("unmapped:")) {
		throw new Error("unmapped projects cannot be reassigned until they have a stable identity");
	}
	const project = clean(input.project);
	if (!project) throw new Error("project must be a non-empty string");
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
				) AS workspace_id,
				COUNT(mi_count.id) AS memory_count
			 FROM sessions s
			 LEFT JOIN memory_items mi_count ON mi_count.session_id = s.id
			 WHERE COALESCE(TRIM(s.git_remote), TRIM(s.cwd), TRIM(s.project), '') <> ''
			    OR mi_count.id IS NOT NULL
			 GROUP BY s.id`,
		)
		.all() as ProjectScopeCandidateRow[];
	const matched = rows.filter((row) => {
		const identity = canonicalWorkspaceIdentity({
			gitRemote: row.git_remote,
			gitBranch: row.git_branch,
			cwd: row.cwd,
			project: row.project,
			workspaceId: row.workspace_id,
		});
		return identity.value === workspaceIdentity;
	});
	if (matched.length === 0) throw new Error("project identity not found");
	const previousProjects = [
		...new Set(matched.map((row) => clean(row.project) ?? "").filter(Boolean)),
	].sort();
	const movedMemoryCount = matched.reduce((total, row) => total + Number(row.memory_count ?? 0), 0);
	const update = db.prepare("UPDATE sessions SET project = ? WHERE id = ?");
	db.transaction(() => {
		for (const row of matched) update.run(project, row.id);
	})();
	return {
		moved_memory_count: movedMemoryCount,
		moved_session_count: matched.length,
		previous_projects: previousProjects,
		project,
		workspace_identity: workspaceIdentity,
	};
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
	if (workspaceIdentity?.startsWith("unmapped:")) {
		throw new Error("unmapped projects cannot be assigned to a Sharing domain");
	}
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
