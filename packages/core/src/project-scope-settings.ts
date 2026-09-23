import { createHash } from "node:crypto";
import { type Database, fromJson, toJson } from "./db.js";
import { hasLocalInventoryIdentity } from "./local-project-inventory.js";
import { repositoryIdentityFromMetadata } from "./project.js";
import { cleanProjectIdentity } from "./project-identity.js";
import {
	hasConflictingRepositoryMappings,
	hasRecordedRepositoryWorkspace,
	normalizeRepositoryWorkspaceIdentity,
	recordedWorkspacesForRepositoryIdentity,
	repositoryIdentitiesByWorkspace,
	repositoryIdentityForWorkspace,
	withRepositoryMappingAliases,
} from "./repository-mapping-aliases.js";
import { ensureScopeBackfillScopes, LEGACY_SHARED_REVIEW_SCOPE_ID } from "./scope-backfill.js";
import {
	canonicalWorkspaceIdentity,
	LOCAL_DEFAULT_SCOPE_ID,
	resolveProjectScope,
	type ScopeMapping,
	type ScopeResolutionReason,
	scopeIdsMatchingProjectPatterns,
	type WorkspaceIdentitySource,
} from "./scope-resolution.js";
import { SYNC_BOOTSTRAP_CWD_PREFIX } from "./sync-bootstrap-constants.js";
import { recordAccessCleanupOp, recordReplicationOp } from "./sync-replication.js";

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
	| "conflicting_repository_mappings"
	| "broad_org_domain_pattern"
	| "home_directory_org_domain_pattern"
	| "conflicting_repository_mappings"
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
	repository_identity?: string | null;
	latest_session_at: string | null;
	resolved_scope_id: string;
	resolution_reason: ScopeResolutionReason;
	mapping_id: number | null;
	matched_pattern: string | null;
	suggested_scope_id: string | null;
	suggestion_reason: string | null;
	suggestion_signal: WorkspaceIdentitySource | null;
	guardrail_warnings: ProjectScopeGuardrailWarning[];
	read_only: boolean;
	read_only_reason: "peer_received" | null;
	origin_devices?: Array<{ device_id: string }>;
}

export type ProjectScopeInventoryStatus =
	| "explicitly_mapped"
	| "legacy_review"
	| "local_only"
	| "needs_attention"
	| "received"
	| "suggested"
	| "unmapped";

export interface ProjectScopeInventoryProject extends ProjectScopeCandidate {
	memory_count: number | null;
	origin_devices: Array<{ device_id: string }>;
	session_count: number;
	statuses: ProjectScopeInventoryStatus[];
	worktrees: ProjectScopeInventoryWorktree[];
}

export interface ProjectScopeInventoryWorktree {
	cwd: string;
	latest_session_at: string | null;
	memory_count: number;
	session_count: number;
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
	deviceId?: string | null;
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

const PEER_RECEIVED_WORKSPACE_IDENTITY_PREFIX = "peer-received:";

export interface ReassignProjectScopeInventoryProjectResult {
	workspace_identity: string;
	project: string;
	previous_projects: string[];
	moved_session_count: number;
	moved_memory_count: number;
}

interface ProjectScopeCandidateRow {
	id: number;
	inventory_source?: "local" | "peer_received" | null;
	started_at: string | null;
	cwd: string | null;
	project: string | null;
	git_remote: string | null;
	git_branch: string | null;
	metadata_json?: string | null;
	repository_identity?: string | null;
	workspace_id: string | null;
	origin_devices?: Array<{ device_id: string }>;
	memory_count?: number | null;
	session_count?: number | null;
}

type ProjectScopeCandidateWithOrigins = ProjectScopeCandidate & {
	origin_devices: Array<{ device_id: string }>;
};

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function originDevicesForCandidate(row: ProjectScopeCandidateRow): Array<{ device_id: string }> {
	if (row.inventory_source !== "peer_received") return [];
	return [...new Set((row.origin_devices ?? []).map((device) => device.device_id))]
		.toSorted((left, right) => left.localeCompare(right))
		.map((deviceId) => ({ device_id: deviceId }));
}

function explicitRepositoryIdentityForRow(row: ProjectScopeCandidateRow): string | null {
	return normalizeRepositoryWorkspaceIdentity(
		cleanProjectIdentity(row.repository_identity) ??
			repositoryIdentityFromMetadata(row.metadata_json),
	);
}

function repositoryIdentityForRow(row: ProjectScopeCandidateRow): string | null {
	return (
		explicitRepositoryIdentityForRow(row) ??
		normalizeRepositoryWorkspaceIdentity(cleanProjectIdentity(row.git_remote))
	);
}

function workspaceIdentityForRow(row: ProjectScopeCandidateRow) {
	return canonicalWorkspaceIdentity({
		gitRemote: row.git_remote,
		gitBranch: row.git_branch,
		repositoryIdentity: explicitRepositoryIdentityForRow(row),
		cwd: row.cwd,
		project: row.project,
		workspaceId: row.workspace_id,
	});
}

function identifyRepositoryRow(
	row: ProjectScopeCandidateRow,
	repositoryIdentityByCwd: Map<string, string>,
): ProjectScopeCandidateRow {
	const discoveredRepositoryIdentity = explicitRepositoryIdentityForRow(row);
	const cwd = normalizeRepositoryWorkspaceIdentity(row.cwd);
	const explicitRemote = cleanProjectIdentity(row.git_remote);
	const ambiguousWorkspace = Boolean(
		cwd &&
			hasRecordedRepositoryWorkspace(repositoryIdentityByCwd, cwd) &&
			!repositoryIdentityByCwd.has(cwd),
	);
	if (discoveredRepositoryIdentity && cwd && !ambiguousWorkspace) {
		repositoryIdentityByCwd.set(cwd, discoveredRepositoryIdentity);
	}
	return {
		...row,
		repository_identity:
			discoveredRepositoryIdentity ??
			(!explicitRemote && cwd && !ambiguousWorkspace
				? (repositoryIdentityByCwd.get(cwd) ?? null)
				: null),
	};
}

function repositoryIdentitiesByCwd(
	db: Database,
	_rows: ProjectScopeCandidateRow[],
): Map<string, string> {
	return repositoryIdentitiesByWorkspace(db);
}

function mergeWorktree(project: ProjectScopeInventoryProject, row: ProjectScopeCandidateRow): void {
	const cwd = cleanProjectIdentity(row.cwd);
	if (!cwd) return;
	const memoryCount = Number(row.memory_count ?? 0);
	const sessionCount = Number(row.session_count ?? 1);
	const existing = project.worktrees.find((member) => member.cwd === cwd);
	if (existing) {
		existing.memory_count += memoryCount;
		existing.session_count += sessionCount;
		return;
	}
	project.worktrees.push({
		cwd,
		latest_session_at: row.started_at,
		memory_count: memoryCount,
		session_count: sessionCount,
	});
}

function worktreesForRow(row: ProjectScopeCandidateRow): ProjectScopeInventoryWorktree[] {
	const cwd = cleanProjectIdentity(row.cwd);
	if (!cwd) return [];
	return [
		{
			cwd,
			latest_session_at: row.started_at,
			memory_count: Number(row.memory_count ?? 0),
			session_count: Number(row.session_count ?? 1),
		},
	];
}

function inventoryMergeKey(
	row: ProjectScopeCandidateRow,
	candidate: ProjectScopeCandidate,
): string {
	return `${row.inventory_source === "peer_received" ? "peer_received" : "local"}:${candidate.workspace_identity}`;
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
	if (project.read_only) return warnings;
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

function withCandidateGuardrails<T extends ProjectScopeCandidate>(candidates: T[]): T[] {
	const collisions = candidateCollisionMap(candidates);
	return candidates.map((candidate) => ({
		...candidate,
		guardrail_warnings: dedupeGuardrailWarnings([
			...candidate.guardrail_warnings,
			...projectScopeCandidateGuardrailWarnings(candidate, collisions),
		]),
	}));
}

function markConflictingRepositoryScopes(project: ProjectScopeInventoryProject): void {
	project.resolved_scope_id = LOCAL_DEFAULT_SCOPE_ID;
	project.resolution_reason = "local_default";
	project.mapping_id = null;
	project.matched_pattern = null;
	project.suggested_scope_id = null;
	project.suggestion_reason = null;
	project.suggestion_signal = null;
	if (
		project.guardrail_warnings.some((warning) => warning.code === "conflicting_repository_mappings")
	) {
		return;
	}
	project.guardrail_warnings.push(
		withGuardrailConfirmationToken({
			code: "conflicting_repository_mappings",
			severity: "warning",
			message:
				"Linked checkouts map this repository to different Sharing domains. Resolve the conflicting mappings before sharing this Project.",
			requires_confirmation: true,
			workspace_identity: project.workspace_identity,
		}),
	);
}

function mergeInventoryProject(
	existing: ProjectScopeInventoryProject,
	candidate: ProjectScopeCandidate,
	row: ProjectScopeCandidateRow,
	readOnly: boolean,
): void {
	if (!readOnly && existing.resolved_scope_id !== candidate.resolved_scope_id) {
		markConflictingRepositoryScopes(existing);
	}
	existing.memory_count = (existing.memory_count ?? 0) + Number(row.memory_count ?? 0);
	existing.session_count += Number(row.session_count ?? 1);
	mergeWorktree(existing, row);
	if (readOnly) return;
	existing.read_only = false;
	existing.read_only_reason = null;
}

function inventoryStatuses(project: ProjectScopeCandidate): ProjectScopeInventoryStatus[] {
	const statuses = new Set<ProjectScopeInventoryStatus>();
	if (project.read_only) return ["received"];
	if (!project.read_only && project.resolved_scope_id === LOCAL_DEFAULT_SCOPE_ID) {
		statuses.add("local_only");
	}
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
		...project.worktrees.map((worktree) => worktree.cwd),
	]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.some((value) => value.toLowerCase().includes(normalized));
}

function repositoryConflictWarnings(
	conflicting: boolean,
	workspaceIdentity: string,
): ProjectScopeGuardrailWarning[] {
	if (!conflicting) return [];
	return [
		{
			code: "conflicting_repository_mappings",
			severity: "warning",
			message:
				"Repository worktrees resolve to conflicting Sharing domains. Memories stay Local only until the mappings agree.",
			requires_confirmation: true,
			workspace_identity: workspaceIdentity,
		},
	];
}

function buildProjectScopeCandidate(
	row: ProjectScopeCandidateRow,
	mappings: ProjectScopeSettingsMapping[],
	scopes: SharingDomainSettingsScope[],
	options: {
		ambiguousRepositoryWorkspace?: boolean;
		conflictingRepositoryMappings?: boolean;
	} = {},
): ProjectScopeCandidateWithOrigins {
	const project = cleanProjectIdentity(row.project);
	const cwd = cleanProjectIdentity(row.cwd);
	const gitRemote = cleanProjectIdentity(row.git_remote);
	const gitBranch = cleanProjectIdentity(row.git_branch);
	const repositoryIdentity = repositoryIdentityForRow(row);
	const identity = workspaceIdentityForRow(row);
	const conflicting = options.conflictingRepositoryMappings === true;
	const ambiguousWorkspace = options.ambiguousRepositoryWorkspace === true;
	const resolution = resolveProjectScope({
		allowRepositoryCwdFallback: !ambiguousWorkspace && !conflicting,
		gitRemote: row.git_remote,
		gitBranch: row.git_branch,
		repositoryIdentity,
		cwd: row.cwd,
		project: row.project,
		workspaceId: row.workspace_id,
		mappings: conflicting ? [] : mappings,
	});
	const baseCandidate = {
		workspace_identity: identity.value,
		identity_source: identity.source,
		display_project: identity.displayProject ?? project ?? cwd ?? identity.value,
		project,
		cwd,
		git_remote: gitRemote,
		git_branch: gitBranch,
		repository_identity: repositoryIdentity,
		latest_session_at: row.started_at,
		resolved_scope_id: resolution.scopeId,
		resolution_reason: resolution.reason,
		mapping_id: resolution.mapping?.id ?? null,
		matched_pattern: resolution.matchedPattern,
		read_only: false,
		read_only_reason: null,
		origin_devices: originDevicesForCandidate(row),
		suggested_scope_id: null,
		suggestion_reason: null,
		suggestion_signal: null,
		guardrail_warnings: repositoryConflictWarnings(conflicting, identity.value),
	} satisfies ProjectScopeCandidateWithOrigins;
	if (conflicting) return baseCandidate;
	const suggestion = suggestProjectScope(baseCandidate, scopes);
	return {
		...baseCandidate,
		suggested_scope_id: suggestion?.scopeId ?? null,
		suggestion_reason: suggestion?.reason ?? null,
		suggestion_signal: suggestion?.signal ?? null,
	};
}

function buildConflictAwareCandidate(
	row: ProjectScopeCandidateRow,
	mappings: ProjectScopeSettingsMapping[],
	scopes: SharingDomainSettingsScope[],
	repositoryIdentities: ReadonlyMap<string, string>,
	conflictsByRepository?: Map<string, boolean>,
): ProjectScopeCandidateWithOrigins {
	const repositoryIdentity = repositoryIdentityForRow(row);
	const cwd = normalizeRepositoryWorkspaceIdentity(row.cwd);
	const ambiguousWorkspace = Boolean(
		cwd &&
			hasRecordedRepositoryWorkspace(repositoryIdentities, cwd) &&
			!repositoryIdentities.has(cwd),
	);
	let conflicting = false;
	if (repositoryIdentity) {
		if (conflictsByRepository?.has(repositoryIdentity)) {
			conflicting = conflictsByRepository.get(repositoryIdentity) ?? false;
		} else {
			conflicting = hasConflictingRepositoryMappings(
				mappings,
				repositoryIdentities,
				repositoryIdentity,
			);
			conflictsByRepository?.set(repositoryIdentity, conflicting);
		}
	}
	const unresolvedAmbiguousWorkspace = ambiguousWorkspace && !repositoryIdentity;
	return buildProjectScopeCandidate(row, unresolvedAmbiguousWorkspace ? [] : mappings, scopes, {
		ambiguousRepositoryWorkspace: ambiguousWorkspace,
		conflictingRepositoryMappings: conflicting,
	});
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
	return listProjectScopeSettingsMappingsForScopes(db, listSharingDomainSettingsScopes(db));
}

function listProjectScopeSettingsMappingsForScopes(
	db: Database,
	scopes: SharingDomainSettingsScope[],
): ProjectScopeSettingsMapping[] {
	const scopesById = scopeLookup(scopes);
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
	deviceId: string | null;
	existing: ProjectScopeSettingsMapping | null;
	workspaceIdentity: string | null;
	projectPattern: string | null;
	scopeId: string;
	priority: number;
	source: string;
}

function projectScopeMappingById(
	db: Database,
	mappings: ProjectScopeSettingsMapping[] | undefined,
	id: number | null,
): ProjectScopeSettingsMapping | null {
	if (!id || !Number.isInteger(id)) return null;
	if (mappings) return mappings.find((mapping) => mapping.id === id) ?? null;
	return getProjectScopeSettingsMappingById(db, id);
}

function projectScopeMappingByWorkspace(
	db: Database,
	mappings: ProjectScopeSettingsMapping[] | undefined,
	workspaceIdentity: string | null,
): ProjectScopeSettingsMapping | null {
	if (!workspaceIdentity) return null;
	if (!mappings) return getProjectScopeSettingsMappingByWorkspaceIdentity(db, workspaceIdentity);
	return (
		mappings.find(
			(mapping) =>
				normalizeRepositoryWorkspaceIdentity(mapping.workspace_identity) === workspaceIdentity,
		) ?? null
	);
}

function resolveProjectScopeMappingDraft(
	db: Database,
	input: UpsertProjectScopeMappingInput,
	mappings?: ProjectScopeSettingsMapping[],
): ProjectScopeMappingDraft {
	const id = input.id == null ? null : Number(input.id);
	if (id != null && (!Number.isSafeInteger(id) || id <= 0)) {
		throw new Error("id must be a positive integer");
	}
	const byId = projectScopeMappingById(db, mappings, id);
	const workspaceIdentity =
		normalizeWorkspaceIdentity(input.workspace_identity) ?? byId?.workspace_identity ?? null;
	const byWorkspace = projectScopeMappingByWorkspace(db, mappings, workspaceIdentity);
	const existing = byId ?? byWorkspace;
	const projectPattern =
		clean(input.project_pattern) ?? existing?.project_pattern ?? workspaceIdentity;
	const priority = input.priority == null ? (existing?.priority ?? 0) : Number(input.priority);
	return {
		deviceId: clean(input.deviceId),
		existing,
		workspaceIdentity,
		projectPattern,
		scopeId: clean(input.scope_id) ?? "",
		priority,
		source: clean(input.source) ?? "user",
	};
}

interface SourceOwnedMemoryScopeRow {
	id: number;
	import_key: string | null;
	rev: number | null;
	scope_id: string | null;
	metadata_json: string | null;
	session_metadata_json: string | null;
	workspace_id: string | null;
	cwd: string | null;
	git_branch: string | null;
	git_remote: string | null;
	project: string | null;
}

function resolveSourceOwnedMemoryScope(
	row: SourceOwnedMemoryScopeRow,
	mappings: ProjectScopeSettingsMapping[],
	repositoryIdentities: ReadonlyMap<string, string>,
	conflictsByRepository: Map<string, boolean>,
) {
	const repositoryIdentity = repositoryIdentityForWorkspace(repositoryIdentities, {
		cwd: row.cwd,
		gitRemote: row.git_remote,
		metadataJson: row.session_metadata_json,
	});
	const cwd = normalizeRepositoryWorkspaceIdentity(row.cwd);
	const ambiguousWorkspace = Boolean(
		cwd &&
			hasRecordedRepositoryWorkspace(repositoryIdentities, cwd) &&
			!repositoryIdentities.has(cwd),
	);
	let conflicting = false;
	if (repositoryIdentity) {
		const cached = conflictsByRepository.get(repositoryIdentity);
		if (cached == null) {
			conflicting = hasConflictingRepositoryMappings(
				mappings,
				repositoryIdentities,
				repositoryIdentity,
			);
			conflictsByRepository.set(repositoryIdentity, conflicting);
		} else {
			conflicting = cached;
		}
	}
	const unresolvedAmbiguousWorkspace = ambiguousWorkspace && !repositoryIdentity;
	return resolveProjectScope({
		allowRepositoryCwdFallback: !ambiguousWorkspace && !conflicting,
		gitBranch: row.git_branch,
		gitRemote: row.git_remote,
		repositoryIdentity,
		cwd: row.cwd,
		project: row.project,
		workspaceId: row.workspace_id,
		mappings: conflicting || unresolvedAmbiguousWorkspace ? [] : mappings,
	});
}

function sourceOwnedMemoryRowsForScopePropagation(
	db: Database,
	deviceId: string,
): SourceOwnedMemoryScopeRow[] {
	return db
		.prepare(
			`SELECT
				mi.id,
				mi.import_key,
				mi.rev,
				mi.scope_id,
				mi.metadata_json,
				mi.workspace_id,
				s.metadata_json AS session_metadata_json,
				s.cwd,
				s.git_branch,
				s.git_remote,
				s.project
			 FROM memory_items mi
			 JOIN sessions s ON s.id = mi.session_id
			 WHERE mi.active = 1
			   AND (mi.origin_device_id IS NULL OR TRIM(mi.origin_device_id) = '' OR mi.origin_device_id = ?)
			   AND (s.cwd IS NULL OR substr(s.cwd, 1, length(?)) <> ?)`,
		)
		.all(
			deviceId,
			SYNC_BOOTSTRAP_CWD_PREFIX,
			SYNC_BOOTSTRAP_CWD_PREFIX,
		) as SourceOwnedMemoryScopeRow[];
}

function recordSourceOwnedMemoryScopeMove(
	db: Database,
	row: SourceOwnedMemoryScopeRow,
	input: {
		deviceId: string;
		mappingId: number;
		newScopeId: string;
		now: string;
		oldScopeId: string;
	},
): void {
	const oldRev = Number(row.rev ?? 0);
	const tombstoneRev = oldRev + 1;
	const upsertRev = oldRev + 2;
	const metadata = fromJson(row.metadata_json);
	metadata.clock_device_id = input.deviceId;
	metadata.last_project_scope_mapping = {
		mapping_id: input.mappingId,
		old_scope_id: input.oldScopeId,
		new_scope_id: input.newScopeId,
		updated_at: input.now,
	};
	db.prepare(
		`UPDATE memory_items SET scope_id = ?, updated_at = ?, metadata_json = ?, rev = ? WHERE id = ?`,
	).run(input.newScopeId, input.now, toJson(metadata), upsertRev, row.id);
	for (const [opType, scopeId, clockRev] of [
		["delete", input.oldScopeId, tombstoneRev],
		["upsert", input.newScopeId, upsertRev],
	] as const) {
		recordReplicationOp(db, {
			memoryId: row.id,
			opType,
			deviceId: input.deviceId,
			scopeId,
			clockRev,
			clockUpdatedAt: input.now,
			clockDeviceId: input.deviceId,
			createdAt: input.now,
		});
	}
	if (!row.import_key) return;
	recordAccessCleanupOp(db, {
		importKey: row.import_key,
		deviceId: input.deviceId,
		cleanupScopeId: input.oldScopeId,
		clockRev: tombstoneRev,
		clockUpdatedAt: input.now,
		clockDeviceId: input.deviceId,
		createdAt: input.now,
		reason: "project_scope_reassignment",
	});
}

function mappingChangeAffectsSourceOwnedMemory(
	mappingId: number,
	repositoryIdentity: string | null,
	previousResolution: ReturnType<typeof resolveProjectScope>,
	resolution: ReturnType<typeof resolveProjectScope>,
	previousConflicts: ReadonlyMap<string, boolean>,
	conflicts: ReadonlyMap<string, boolean>,
): boolean {
	if (repositoryIdentity) {
		if (previousConflicts.get(repositoryIdentity) || conflicts.get(repositoryIdentity)) return true;
	}
	return previousResolution.mapping?.id === mappingId || resolution.mapping?.id === mappingId;
}

function propagateProjectScopeMappingToSourceOwnedMemories(
	db: Database,
	mapping: ProjectScopeSettingsMapping,
	deviceId: string | null,
	previousMappings?: ProjectScopeSettingsMapping[],
): number {
	if (!deviceId) return 0;
	const mappings = withRepositoryMappingAliases(db, listProjectScopeSettingsMappings(db));
	const oldMappings = previousMappings
		? withRepositoryMappingAliases(db, previousMappings)
		: mappings;
	const now = new Date().toISOString();
	const repositoryIdentities = repositoryIdentitiesByWorkspace(db);
	const oldConflictsByRepository = new Map<string, boolean>();
	const conflictsByRepository = new Map<string, boolean>();
	let moved = 0;
	for (const row of sourceOwnedMemoryRowsForScopePropagation(db, deviceId)) {
		const previousResolution = resolveSourceOwnedMemoryScope(
			row,
			oldMappings,
			repositoryIdentities,
			oldConflictsByRepository,
		);
		const resolution = resolveSourceOwnedMemoryScope(
			row,
			mappings,
			repositoryIdentities,
			conflictsByRepository,
		);
		const repositoryIdentity = repositoryIdentityForWorkspace(repositoryIdentities, {
			cwd: row.cwd,
			gitRemote: row.git_remote,
			metadataJson: row.session_metadata_json,
		});
		if (
			!mappingChangeAffectsSourceOwnedMemory(
				mapping.id,
				repositoryIdentity,
				previousResolution,
				resolution,
				oldConflictsByRepository,
				conflictsByRepository,
			)
		) {
			continue;
		}
		const oldScopeId = clean(row.scope_id) ?? LOCAL_DEFAULT_SCOPE_ID;
		const newScopeId = resolution.scopeId;
		if (oldScopeId === newScopeId) continue;
		recordSourceOwnedMemoryScopeMove(db, row, {
			deviceId,
			mappingId: mapping.id,
			newScopeId,
			now,
			oldScopeId,
		});
		moved += 1;
	}
	return moved;
}

function applyProjectScopeDraft(
	mappings: ProjectScopeSettingsMapping[],
	draft: ProjectScopeMappingDraft,
	syntheticId: number,
): ProjectScopeSettingsMapping[] {
	if (!draft.projectPattern || !draft.scopeId) return mappings;
	const now = new Date().toISOString();
	const requested: ProjectScopeSettingsMapping = {
		id: draft.existing?.id ?? syntheticId,
		workspace_identity: draft.workspaceIdentity,
		project_pattern: draft.projectPattern,
		scope_id: draft.scopeId,
		priority: draft.priority,
		source: draft.source,
		created_at: draft.existing?.created_at ?? now,
		updated_at: now,
		guardrail_warnings: [],
	};
	const requestedWorkspace = normalizeRepositoryWorkspaceIdentity(draft.workspaceIdentity);
	const replaced = mappings.some(
		(mapping) =>
			(draft.existing && mapping.id === draft.existing.id) ||
			(requestedWorkspace != null &&
				normalizeRepositoryWorkspaceIdentity(mapping.workspace_identity) === requestedWorkspace),
	);
	if (!replaced) return [...mappings, requested];
	return mappings.map((mapping) => {
		if (draft.existing && mapping.id === draft.existing.id) return requested;
		if (
			requestedWorkspace != null &&
			normalizeRepositoryWorkspaceIdentity(mapping.workspace_identity) === requestedWorkspace
		) {
			return requested;
		}
		return mapping;
	});
}

function resolveProjectScopeMappingDrafts(
	db: Database,
	scopes: SharingDomainSettingsScope[],
	inputs: UpsertProjectScopeMappingInput[],
): { drafts: ProjectScopeMappingDraft[]; mappings: ProjectScopeSettingsMapping[] } {
	let mappings = listProjectScopeSettingsMappingsForScopes(db, scopes);
	const drafts: ProjectScopeMappingDraft[] = [];
	let nextSyntheticId = Math.max(0, ...mappings.map((mapping) => mapping.id)) + 1;
	for (const input of inputs) {
		const draft = resolveProjectScopeMappingDraft(db, input, mappings);
		drafts.push(draft);
		mappings = applyProjectScopeDraft(mappings, draft, nextSyntheticId);
		if (!draft.existing) nextSyntheticId += 1;
	}
	return { drafts, mappings };
}

function candidateMatchesProjectScopeDraft(
	db: Database,
	candidate: ProjectScopeCandidate,
	draft: ProjectScopeMappingDraft,
	requested: ProjectScopeSettingsMapping,
	repositoryIdentities: ReadonlyMap<string, string>,
	workspacesByRepository: Map<string, ReadonlySet<string>>,
): boolean {
	const normalizedWorkspace = normalizeRepositoryWorkspaceIdentity(draft.workspaceIdentity);
	if (normalizedWorkspace) {
		const candidateWorkspace = normalizeRepositoryWorkspaceIdentity(candidate.workspace_identity);
		if (candidateWorkspace === normalizedWorkspace) return true;
		const repositoryIdentity = repositoryIdentities.get(normalizedWorkspace);
		return repositoryIdentity != null && candidate.repository_identity === repositoryIdentity;
	}
	const identities = new Set(
		[
			candidate.workspace_identity,
			candidate.cwd,
			candidate.git_remote,
			candidate.repository_identity,
		].filter((identity): identity is string => identity != null),
	);
	if (candidate.repository_identity) {
		let repositoryWorkspaces = workspacesByRepository.get(candidate.repository_identity);
		if (!repositoryWorkspaces) {
			repositoryWorkspaces = new Set(
				recordedWorkspacesForRepositoryIdentity(db, candidate.repository_identity).keys(),
			);
			workspacesByRepository.set(candidate.repository_identity, repositoryWorkspaces);
		}
		for (const workspace of repositoryWorkspaces) {
			identities.add(workspace);
		}
	}
	return scopeIdsMatchingProjectPatterns([requested], identities).size > 0;
}

function candidatesForProjectScopeDraft(
	db: Database,
	draft: ProjectScopeMappingDraft,
	scopes: SharingDomainSettingsScope[],
	mappings: ProjectScopeSettingsMapping[],
): ProjectScopeCandidate[] {
	if (!draft.projectPattern || !draft.scopeId) return [];
	const requested = applyProjectScopeDraft([], draft, -1)[0];
	if (!requested) return [];
	const effectiveMappings = withRepositoryMappingAliases(db, mappings);
	const repositoryIdentities = repositoryIdentitiesByWorkspace(db);
	const workspacesByRepository = new Map<string, ReadonlySet<string>>();
	const candidates = withCandidateGuardrails(
		collectProjectScopeCandidates(db, {
			candidateCeiling: null,
			excludePeerReceived: false,
			mappings: effectiveMappings,
			scopes,
		}),
	);
	return candidates.filter((candidate) =>
		candidateMatchesProjectScopeDraft(
			db,
			candidate,
			draft,
			requested,
			repositoryIdentities,
			workspacesByRepository,
		),
	);
}

function analyzeProjectScopeMappingDraftGuardrails(
	db: Database,
	draft: ProjectScopeMappingDraft,
	scopes: SharingDomainSettingsScope[],
	mappings: ProjectScopeSettingsMapping[],
): ProjectScopeMappingChangeGuardrailAnalysis {
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
	const requestedScope = scopesById.get(draft.scopeId);
	for (const candidate of candidatesForProjectScopeDraft(db, draft, scopes, mappings)) {
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
			message: `Changing this project from ${oldScope} to ${newScope} updates future sync authorization. Online compatible peers should converge after syncing, but offline devices, backups, copied databases, malicious peers, or old versions may retain old copies.`,
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

export function analyzeProjectScopeMappingChangesGuardrails(
	db: Database,
	inputs: UpsertProjectScopeMappingInput[],
): ProjectScopeMappingChangeGuardrailAnalysis[] {
	ensureScopeBackfillScopes(db);
	const scopes = listSharingDomainSettingsScopes(db);
	const { drafts, mappings } = resolveProjectScopeMappingDrafts(db, scopes, inputs);
	return drafts.map((draft) =>
		analyzeProjectScopeMappingDraftGuardrails(db, draft, scopes, mappings),
	);
}

export function analyzeProjectScopeMappingChangeGuardrails(
	db: Database,
	input: UpsertProjectScopeMappingInput,
): ProjectScopeMappingChangeGuardrailAnalysis {
	const analysis = analyzeProjectScopeMappingChangesGuardrails(db, [input])[0];
	if (!analysis) throw new Error("project_scope_mapping_analysis_missing");
	return analysis;
}

/**
 * How many distinct candidates the scan must observe before it may stop.
 *
 * When a scan budget exists it is the only ceiling: `maxScannedRows + 1`.
 * Seeing that many distinct identities proves overflow, so walking further is
 * pure waste; seeing fewer means the whole roster fits and the result limit is
 * applied afterwards. Using the result limit here would either disable the
 * guard (limit <= budget) or defeat its bounded failure path (limit > budget).
 * Without a budget, the result limit bounds the walk; without either, unbounded.
 */
function candidateWalkCeiling(limit: number | null, maxScannedRows: number | null): number | null {
	if (maxScannedRows != null) return maxScannedRows + 1;
	return limit;
}

function candidatePageQueries(db: Database, excludePeerReceived: boolean) {
	const pageSize = 500;
	const filter = `(
		COALESCE(TRIM(s.git_remote), TRIM(s.cwd), TRIM(s.project), '') <> ''
		OR EXISTS (SELECT 1 FROM memory_items candidate WHERE candidate.session_id = s.id)
	)${
		excludePeerReceived
			? ` AND (s.cwd IS NULL OR substr(s.cwd, 1, length(?)) <> ?)
				AND COALESCE(s.tool_version, '') <> 'sync_replication'`
			: ""
	}`;
	const columns = `s.id, s.started_at, s.cwd, s.project, s.git_remote, s.git_branch,
		s.metadata_json, (SELECT mi.workspace_id FROM memory_items mi
		WHERE mi.session_id = s.id AND mi.workspace_id IS NOT NULL
		AND TRIM(mi.workspace_id) <> '' ORDER BY mi.id DESC LIMIT 1) AS workspace_id`;
	return {
		filterParameters: excludePeerReceived
			? [SYNC_BOOTSTRAP_CWD_PREFIX, SYNC_BOOTSTRAP_CWD_PREFIX]
			: [],
		pageSize,
		selectFirstPage: db.prepare(`SELECT ${columns} FROM sessions s WHERE ${filter}
			ORDER BY s.started_at DESC, s.id DESC LIMIT ?`),
		selectNextPage: db.prepare(`SELECT * FROM (
			SELECT ${columns} FROM sessions s WHERE s.started_at = ? AND s.id < ? AND ${filter}
			ORDER BY s.id DESC LIMIT ?
		) UNION ALL SELECT * FROM (
			SELECT ${columns} FROM sessions s WHERE s.started_at < ? AND ${filter}
			ORDER BY s.started_at DESC, s.id DESC LIMIT ?
		) ORDER BY started_at DESC, id DESC LIMIT ?`),
	};
}

function collectProjectScopeCandidates(
	db: Database,
	input: {
		candidateCeiling: number | null;
		excludePeerReceived: boolean;
		mappings: ProjectScopeSettingsMapping[];
		scopes: SharingDomainSettingsScope[];
	},
): ProjectScopeCandidate[] {
	const queries = candidatePageQueries(db, input.excludePeerReceived);
	const seen = new Set<string>();
	const repositories = repositoryIdentitiesByWorkspace(db);
	const conflictsByRepository = new Map<string, boolean>();
	const candidates: ProjectScopeCandidate[] = [];
	let cursor: { startedAt: string; id: number } | null = null;
	const ceilingReached = () =>
		input.candidateCeiling != null && candidates.length >= input.candidateCeiling;
	pages: while (!ceilingReached()) {
		const rows = (
			cursor
				? queries.selectNextPage.all(
						cursor.startedAt,
						cursor.id,
						...queries.filterParameters,
						queries.pageSize,
						cursor.startedAt,
						...queries.filterParameters,
						queries.pageSize,
						queries.pageSize,
					)
				: queries.selectFirstPage.all(...queries.filterParameters, queries.pageSize)
		) as ProjectScopeCandidateRow[];
		if (rows.length === 0) break;
		for (const row of rows) {
			const identifiedRow = identifyRepositoryRow(row, repositories);
			const candidate = buildConflictAwareCandidate(
				identifiedRow,
				input.mappings,
				input.scopes,
				repositories,
				conflictsByRepository,
			);
			if (seen.has(candidate.workspace_identity)) continue;
			seen.add(candidate.workspace_identity);
			candidates.push(candidate);
			if (ceilingReached()) break pages;
		}
		if (rows.length < queries.pageSize) break;
		const last = rows.at(-1);
		if (!last || last.started_at == null) break;
		cursor = { startedAt: last.started_at, id: last.id };
	}
	return candidates;
}

export function listProjectScopeCandidates(
	db: Database,
	options: {
		limit?: number | null;
		maxScannedRows?: number;
		maxMetadataRows?: number;
		excludePeerReceived?: boolean;
	} = {},
): ProjectScopeCandidate[] {
	ensureScopeBackfillScopes(db);
	const limit = options.limit === null ? null : Math.max(1, Math.min(options.limit ?? 250, 1000));
	const maxScannedRows =
		options.maxScannedRows == null ? null : Math.max(1, Math.floor(options.maxScannedRows));
	const maxMetadataRows =
		options.maxMetadataRows == null ? null : Math.max(1, Math.floor(options.maxMetadataRows));
	if (
		maxMetadataRows != null &&
		(db.prepare("SELECT 1 FROM project_scope_mappings LIMIT 1 OFFSET ?").get(maxMetadataRows) ||
			db
				.prepare("SELECT 1 FROM replication_scopes WHERE status = 'active' LIMIT 1 OFFSET ?")
				.get(maxMetadataRows))
	) {
		throw new Error("project_scope_candidate_metadata_too_large");
	}
	// maxScannedRows bounds DISTINCT candidates, not raw session rows. A large
	// history on few Projects must not trip it, so the session stream is walked
	// in keyset pages and deduplicated as it goes. Stopping once cap+1 distinct
	// identities are seen makes the overflow signal truthful: it fires only when
	// the roster genuinely exceeds the budget, never because the window was cut
	// short by volume. The walk ceiling is the LARGER of the result limit and
	// cap+1: the overflow check must always be able to see cap+1 distinct
	// identities, even when the caller only wants a handful back. The result
	// limit is applied after the overflow check, never before it.
	const candidateCeiling = candidateWalkCeiling(limit, maxScannedRows);
	const scopes = listSharingDomainSettingsScopes(db);
	const mappings = withRepositoryMappingAliases(
		db,
		listProjectScopeSettingsMappingsForScopes(db, scopes),
	);
	const candidates = collectProjectScopeCandidates(db, {
		candidateCeiling,
		excludePeerReceived: options.excludePeerReceived === true,
		mappings,
		scopes,
	});
	if (maxScannedRows != null && candidates.length > maxScannedRows) {
		throw new Error("project_scope_candidate_scan_too_large");
	}

	const sorted = withCandidateGuardrails(
		candidates.toSorted(
			(left, right) =>
				left.display_project.localeCompare(right.display_project) ||
				left.workspace_identity.localeCompare(right.workspace_identity),
		),
	);
	return limit == null ? sorted : sorted.slice(0, limit);
}

// Bootstrap sessions use a placeholder cwd to satisfy the memory_items FK. They
// represent inbound memories and must not surface as local projects. Match the
// prefix with substr because SQLite LIKE treats its underscores as wildcards.
function listLocalProjectScopeInventoryRows(db: Database): ProjectScopeCandidateRow[] {
	return db
		.prepare(
			`SELECT
				s.id,
				'local' AS inventory_source,
				MAX(s.started_at) AS started_at,
				s.cwd,
				s.project,
				s.git_remote,
				s.git_branch,
				s.metadata_json,
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
			 LEFT JOIN memory_items mi_count ON mi_count.session_id = s.id AND mi_count.active = 1
				AND NOT (
					COALESCE(s.tool_version, '') = 'sync_replication'
					AND COALESCE(TRIM(mi_count.project), '') <> ''
				)
			 WHERE (
			           COALESCE(TRIM(s.git_remote), TRIM(s.cwd), TRIM(s.project), '') <> ''
			        OR mi_count.id IS NOT NULL
			       )
			   AND (s.cwd IS NULL OR substr(s.cwd, 1, length(?)) <> ?)
			   AND NOT (
			         COALESCE(s.tool_version, '') = 'sync_replication'
			     AND (
			           COALESCE(TRIM(s.project), '') <> ''
			        OR NOT EXISTS (
			             SELECT 1 FROM memory_items mp
			             WHERE mp.session_id = s.id AND mp.active = 1
			               AND COALESCE(TRIM(mp.project), '') = ''
			           )
			         )
			       )
			 GROUP BY s.id
			 ORDER BY MAX(s.started_at) DESC, s.id DESC`,
		)
		.all(SYNC_BOOTSTRAP_CWD_PREFIX, SYNC_BOOTSTRAP_CWD_PREFIX) as ProjectScopeCandidateRow[];
}

function listPeerReceivedProjectAggregateRows(db: Database): ProjectScopeCandidateRow[] {
	// Peer-received rows cover both bootstrap snapshot sessions (marked by the
	// bootstrap cwd prefix) and sessions minted by incremental replication
	// (tool_version 'sync_replication', no cwd). Both hold peer-owned content
	// the local device receives but does not manage. Memories in a managed
	// Project scope key on that scope — it is the sender's canonical Project
	// identity and stays stable across multiple authoring devices — while
	// legacy rows without a managed scope fall back to origin device + name.
	// MAX(project) makes the displayed name deterministic when scope members
	// briefly disagree (renames converge as replication upserts rewrite the
	// project on existing rows).
	return db
		.prepare(
			`SELECT
				MIN(s.id) AS id,
				'peer_received' AS inventory_source,
				MAX(COALESCE(mi.updated_at, s.started_at)) AS started_at,
				NULL AS cwd,
				MAX(TRIM(mi.project)) AS project,
				NULL AS git_remote,
				NULL AS git_branch,
				NULL AS metadata_json,
				'peer-received:' || CASE
					WHEN mi.scope_id LIKE 'managed-project:%' THEN 'scope:' || mi.scope_id
					ELSE COALESCE(NULLIF(TRIM(mi.origin_device_id), ''), 'unknown') || ':project:' || TRIM(mi.project)
				END AS workspace_id,
				0 AS session_count,
				COUNT(mi.id) AS memory_count
			 FROM memory_items mi
			 JOIN sessions s ON s.id = mi.session_id
			 WHERE mi.active = 1
			   AND mi.project IS NOT NULL
			   AND TRIM(mi.project) <> ''
			   AND (
			         (s.cwd IS NOT NULL AND substr(s.cwd, 1, length(?)) = ?)
			      OR (s.cwd IS NULL AND s.tool_version = 'sync_replication')
			       )
			 GROUP BY CASE
				WHEN mi.scope_id LIKE 'managed-project:%' THEN 'scope:' || mi.scope_id
				ELSE COALESCE(NULLIF(TRIM(mi.origin_device_id), ''), 'unknown') || ':project:' || TRIM(mi.project)
			 END
			 ORDER BY MAX(COALESCE(mi.updated_at, s.started_at)) DESC, TRIM(mi.project) ASC`,
		)
		.all(SYNC_BOOTSTRAP_CWD_PREFIX, SYNC_BOOTSTRAP_CWD_PREFIX) as ProjectScopeCandidateRow[];
}

interface PeerReceivedOriginDeviceRow {
	workspace_id: string;
	device_id: string;
}

function listPeerReceivedOriginDeviceRows(db: Database): PeerReceivedOriginDeviceRow[] {
	return db
		.prepare(
			`WITH received AS (
				SELECT memory_items.*,
				COALESCE(NULLIF(TRIM(origin_device_id), ''),
					CASE WHEN json_valid(metadata_json) THEN NULLIF(TRIM(json_extract(metadata_json, '$.origin_device_id')), '') END) AS effective_origin
				FROM memory_items
			) SELECT DISTINCT
				'peer-received:' || CASE
					WHEN mi.scope_id LIKE 'managed-project:%' THEN 'scope:' || mi.scope_id
					ELSE COALESCE(NULLIF(TRIM(mi.origin_device_id), ''), 'unknown') || ':project:' || TRIM(mi.project)
				END AS workspace_id,
				mi.effective_origin AS device_id
			 FROM received mi
			 JOIN sessions s ON s.id = mi.session_id
			 WHERE mi.active = 1
			   AND mi.project IS NOT NULL
			   AND TRIM(mi.project) <> ''
			   AND COALESCE(mi.effective_origin, '') NOT IN ('', 'unknown')
			   AND (
			         (s.cwd IS NOT NULL AND substr(s.cwd, 1, length(?)) = ?)
			      OR (s.cwd IS NULL AND s.tool_version = 'sync_replication')
			       )
			 ORDER BY workspace_id, device_id`,
		)
		.all(SYNC_BOOTSTRAP_CWD_PREFIX, SYNC_BOOTSTRAP_CWD_PREFIX) as PeerReceivedOriginDeviceRow[];
}

function listPeerReceivedProjectScopeInventoryRows(db: Database): ProjectScopeCandidateRow[] {
	const originsByWorkspace = new Map<string, Array<{ device_id: string }>>();
	for (const origin of listPeerReceivedOriginDeviceRows(db)) {
		const origins = originsByWorkspace.get(origin.workspace_id) ?? [];
		origins.push({ device_id: origin.device_id });
		originsByWorkspace.set(origin.workspace_id, origins);
	}
	return listPeerReceivedProjectAggregateRows(db).map((row) => ({
		...row,
		origin_devices: originsByWorkspace.get(row.workspace_id ?? "") ?? [],
	}));
}

interface BuiltProjectScopeInventory {
	byIdentity: Map<string, ProjectScopeInventoryProject>;
	inventory: ProjectScopeInventoryProject[];
}

function mappingOnlyProject(mapping: ProjectScopeSettingsMapping): ProjectScopeInventoryProject {
	return {
		workspace_identity: mapping.workspace_identity ?? "",
		identity_source: "workspace_id",
		display_project: mapping.project_pattern || mapping.workspace_identity || "",
		project: mapping.project_pattern || null,
		cwd: null,
		git_remote: null,
		git_branch: null,
		repository_identity: null,
		latest_session_at: null,
		resolved_scope_id: mapping.scope_id,
		resolution_reason: "exact_mapping",
		mapping_id: mapping.id,
		matched_pattern: null,
		read_only: false,
		read_only_reason: null,
		origin_devices: [],
		suggested_scope_id: null,
		suggestion_reason: null,
		suggestion_signal: null,
		guardrail_warnings: [],
		memory_count: 0,
		session_count: 0,
		statuses: [],
		worktrees: [],
	};
}

function appendMappingOnlyProjects(
	db: Database,
	mappings: ProjectScopeSettingsMapping[],
	byIdentity: Map<string, ProjectScopeInventoryProject>,
	inventory: ProjectScopeInventoryProject[],
): void {
	const repositoryIdentityByWorkspace = repositoryIdentitiesByWorkspace(db);
	for (const mapping of mappings) {
		if (!mapping.workspace_identity) continue;
		const normalized = normalizeWorkspaceIdentity(mapping.workspace_identity) ?? "";
		const repositoryIdentity = repositoryIdentityByWorkspace.get(normalized);
		if (
			byIdentity.has(`local:${mapping.workspace_identity}`) ||
			(repositoryIdentity != null && byIdentity.has(`local:${repositoryIdentity}`))
		) {
			continue;
		}
		const project = mappingOnlyProject(mapping);
		byIdentity.set(`local:${mapping.workspace_identity}`, project);
		inventory.push(project);
	}
}

function buildProjectScopeInventory(
	db: Database,
	rows: ProjectScopeCandidateRow[],
	mappings: ProjectScopeSettingsMapping[],
	scopes: SharingDomainSettingsScope[],
): BuiltProjectScopeInventory {
	const byIdentity = new Map<string, ProjectScopeInventoryProject>();
	const inventory: ProjectScopeInventoryProject[] = [];
	const repositoryIdentityByCwd = repositoryIdentitiesByCwd(db, rows);
	const conflictsByRepository = new Map<string, boolean>();
	for (const row of rows) {
		const identifiedRow = identifyRepositoryRow(row, repositoryIdentityByCwd);
		const readOnly = row.inventory_source === "peer_received";
		const candidate = {
			...buildConflictAwareCandidate(
				identifiedRow,
				mappings,
				scopes,
				repositoryIdentityByCwd,
				conflictsByRepository,
			),
			read_only: readOnly,
			read_only_reason: readOnly ? "peer_received" : null,
			...(readOnly
				? {
						mapping_id: null,
						matched_pattern: null,
						resolution_reason: "local_default" as const,
						resolved_scope_id: LOCAL_DEFAULT_SCOPE_ID,
						suggested_scope_id: null,
						suggestion_reason: null,
						suggestion_signal: null,
					}
				: {}),
		} satisfies ProjectScopeCandidate;
		const key = inventoryMergeKey(identifiedRow, candidate);
		const existing = byIdentity.get(key);
		if (existing) {
			mergeInventoryProject(existing, candidate, row, readOnly);
			continue;
		}
		const project = {
			...candidate,
			memory_count: Number(row.memory_count ?? 0),
			session_count: Number(row.session_count ?? 1),
			statuses: [],
			worktrees: worktreesForRow(row),
		};
		byIdentity.set(key, project);
		inventory.push(project);
	}
	return { byIdentity, inventory };
}

export function listProjectScopeInventory(
	db: Database,
	options: ProjectScopeInventoryOptions = {},
): ProjectScopeInventoryResult {
	ensureScopeBackfillScopes(db);
	const limit = Math.max(1, Math.min(options.limit ?? 50, 250));
	const offset = Math.max(0, options.offset ?? 0);
	const mappings = withRepositoryMappingAliases(db, listProjectScopeSettingsMappings(db));
	const scopes = listSharingDomainSettingsScopes(db);
	const rows = listLocalProjectScopeInventoryRows(db);
	const bootstrapRows = listPeerReceivedProjectScopeInventoryRows(db);
	const { byIdentity, inventory } = buildProjectScopeInventory(
		db,
		[...rows, ...bootstrapRows],
		mappings,
		scopes,
	);

	appendMappingOnlyProjects(db, mappings, byIdentity, inventory);

	const withGuardrails = withCandidateGuardrails(inventory).map((project, index) => {
		const original = inventory[index];
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

function projectRowsForScopeReassignment(db: Database): ProjectScopeCandidateRow[] {
	return db
		.prepare(
			`SELECT s.id, s.started_at, s.cwd, s.project, s.git_remote, s.git_branch,
				s.metadata_json,
				(
					SELECT mi.workspace_id FROM memory_items mi
					WHERE mi.session_id = s.id
					  AND mi.workspace_id IS NOT NULL
					  AND TRIM(mi.workspace_id) <> ''
					ORDER BY mi.id DESC LIMIT 1
				) AS workspace_id,
				COUNT(mi_count.id) AS memory_count
			 FROM sessions s
			 LEFT JOIN memory_items mi_count ON mi_count.session_id = s.id
			 WHERE COALESCE(TRIM(s.git_remote), TRIM(s.cwd), TRIM(s.project), '') <> ''
			    OR mi_count.id IS NOT NULL
			 GROUP BY s.id`,
		)
		.all() as ProjectScopeCandidateRow[];
}

function sourceOwnedMemoriesForSessions(
	db: Database,
	sessionIds: number[],
	deviceId: string,
): Array<{ id: number; project: string | null; session_id: number }> {
	const placeholders = sessionIds.map(() => "?").join(", ");
	return db
		.prepare(
			`SELECT id, session_id, project FROM memory_items
			 WHERE session_id IN (${placeholders})
			   AND active = 1
			   AND (origin_device_id IS NULL OR TRIM(origin_device_id) = '' OR origin_device_id = ?)`,
		)
		.all(...sessionIds, deviceId) as Array<{
		id: number;
		project: string | null;
		session_id: number;
	}>;
}

function validatedReassignmentInput(input: {
	deviceId: string;
	workspaceIdentity: string;
	project: string;
}): { deviceId: string; workspaceIdentity: string; project: string } {
	const deviceId = clean(input.deviceId);
	if (!deviceId) throw new Error("device_id must be a non-empty string");
	const workspaceIdentity = normalizeWorkspaceIdentity(input.workspaceIdentity);
	if (!workspaceIdentity) throw new Error("workspace_identity must be a non-empty string");
	if (workspaceIdentity.startsWith("unmapped:")) {
		throw new Error("unmapped projects cannot be reassigned until they have a stable identity");
	}
	const project = clean(input.project);
	if (!project) throw new Error("project must be a non-empty string");
	return { deviceId, workspaceIdentity, project };
}

export function reassignProjectScopeInventoryProject(
	db: Database,
	input: { deviceId: string; workspaceIdentity: string; project: string },
): ReassignProjectScopeInventoryProjectResult {
	ensureScopeBackfillScopes(db);
	const { deviceId, workspaceIdentity, project } = validatedReassignmentInput(input);
	const rows = projectRowsForScopeReassignment(db);
	const repositoryIdentityByCwd = repositoryIdentitiesByCwd(db, rows);
	const matched = rows
		.map((row) => identifyRepositoryRow(row, repositoryIdentityByCwd))
		.filter((row) => {
			const identity = workspaceIdentityForRow(row);
			return identity.value === workspaceIdentity;
		});
	if (matched.length === 0) throw new Error("project identity not found");
	const now = new Date().toISOString();
	const sessionIds = matched.map((row) => row.id);
	const sourceOwnedMemories = sourceOwnedMemoriesForSessions(db, sessionIds, deviceId);
	const sourceOwnedSessionIds = new Set(sourceOwnedMemories.map((memory) => memory.session_id));
	const matchedSourceRows = matched.filter(
		(row) => sourceOwnedSessionIds.has(row.id) || Number(row.memory_count ?? 0) === 0,
	);
	if (matchedSourceRows.length === 0) {
		throw new Error("project identity has no source-owned memories on this device");
	}
	const previousProjects = [
		...new Set(matchedSourceRows.map((row) => clean(row.project) ?? "").filter(Boolean)),
	].sort();
	const changedMemories = sourceOwnedMemories.filter(
		(memory) => (clean(memory.project) ?? "") !== project,
	);
	const movedMemoryCount = changedMemories.length;
	const update = db.prepare("UPDATE sessions SET project = ? WHERE id = ?");
	db.transaction(() => {
		for (const row of matchedSourceRows) update.run(project, row.id);
		if (changedMemories.length > 0) {
			const memoryIds = changedMemories.map((memory) => Number(memory.id));
			db.prepare(
				`UPDATE memory_items
				 SET project = ?, updated_at = ?, rev = COALESCE(rev, 0) + 1
				 WHERE id IN (${memoryIds.map(() => "?").join(", ")})`,
			).run(project, now, ...memoryIds);
			for (const memoryId of memoryIds) {
				recordReplicationOp(db, {
					memoryId,
					opType: "upsert",
					deviceId,
					clockDeviceId: deviceId,
					clockUpdatedAt: now,
					createdAt: now,
				});
			}
		}
	})();
	return {
		moved_memory_count: movedMemoryCount,
		moved_session_count: matchedSourceRows.length,
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
	if (
		workspaceIdentity?.startsWith(PEER_RECEIVED_WORKSPACE_IDENTITY_PREFIX) &&
		!hasLocalInventoryIdentity(db, workspaceIdentity)
	) {
		throw new Error("peer-received projects cannot be assigned on this device");
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
	const previousMappings = listProjectScopeSettingsMappings(db);
	if (existing) {
		db.prepare(
			`UPDATE project_scope_mappings
			 SET workspace_identity = ?, project_pattern = ?, scope_id = ?, priority = ?, source = ?, updated_at = ?
			 WHERE id = ?`,
		).run(workspaceIdentity, projectPattern, scopeId, priority, source, now, existing.id);
		const saved = getProjectScopeSettingsMappingById(db, existing.id);
		if (!saved) throw new Error("project_scope_mapping update returned no row");
		propagateProjectScopeMappingToSourceOwnedMemories(db, saved, draft.deviceId, previousMappings);
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
	propagateProjectScopeMappingToSourceOwnedMemories(db, saved, draft.deviceId, previousMappings);
	return saved;
}

export function deleteProjectScopeSettingsMapping(db: Database, id: number): boolean {
	if (!Number.isInteger(id) || id <= 0) throw new Error("id must be a positive integer");
	const result = db.prepare("DELETE FROM project_scope_mappings WHERE id = ?").run(id);
	return Number(result.changes ?? 0) > 0;
}
