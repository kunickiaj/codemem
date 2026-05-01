import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const LOCAL_DEFAULT_SCOPE_ID = "local-default";

export type WorkspaceIdentitySource =
	| "git_remote"
	| "git_remote_branch"
	| "cwd"
	| "workspace_id"
	| "unmapped";

export interface WorkspaceIdentityInput {
	gitRemote?: string | null;
	gitBranch?: string | null;
	cwd?: string | null;
	workspaceId?: string | null;
	project?: string | null;
	branchScoped?: boolean;
}

export interface CanonicalWorkspaceIdentity {
	value: string;
	source: WorkspaceIdentitySource;
	displayProject: string | null;
}

export interface ScopeMapping {
	id?: number | null;
	workspace_identity?: string | null;
	project_pattern: string;
	scope_id: string;
	priority?: number | null;
	updated_at?: string | null;
	source?: string | null;
}

export type ScopeResolutionReason =
	| "explicit_override"
	| "exact_mapping"
	| "pattern_mapping"
	| "local_default";

export interface ScopeResolution {
	scopeId: string;
	reason: ScopeResolutionReason;
	workspaceIdentity: CanonicalWorkspaceIdentity;
	mapping: ScopeMapping | null;
	matchedPattern: string | null;
}

export interface ResolveProjectScopeInput extends WorkspaceIdentityInput {
	explicitScopeId?: string | null;
	mappings?: ScopeMapping[];
	localDefaultScopeId?: string;
}

interface MappingCandidate {
	mapping: ScopeMapping;
	specificity: number;
	matchedPattern: string | null;
}

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function normalizeSlash(value: string): string {
	const normalized = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
	return normalized || value.trim();
}

function normalizeCwd(cwd: string): string {
	// Callers should pass an already-realpathed session cwd when symlink
	// resolution matters; this pure helper only normalizes path syntax.
	return normalizeSlash(resolve(cwd));
}

function normalizeMappingIdentity(value: string | null | undefined): string | null {
	const cleaned = clean(value);
	return cleaned ? normalizeSlash(cleaned) : null;
}

function unmappedIdentity(input: WorkspaceIdentityInput): string {
	const seed = [input.cwd, input.project, input.workspaceId]
		.map((value) => clean(value))
		.find((value): value is string => value != null);
	const digest = createHash("sha256")
		.update(seed ?? "unknown", "utf8")
		.digest("hex");
	return `unmapped:${digest}`;
}

export function canonicalWorkspaceIdentity(
	input: WorkspaceIdentityInput,
): CanonicalWorkspaceIdentity {
	const gitRemote = clean(input.gitRemote);
	const gitBranch = clean(input.gitBranch);
	const cwd = clean(input.cwd);
	const workspaceId = clean(input.workspaceId);
	const project = clean(input.project);

	if (gitRemote) {
		const normalizedRemote = normalizeSlash(gitRemote);
		if (input.branchScoped && gitBranch) {
			return {
				value: `${normalizedRemote}:${gitBranch}`,
				source: "git_remote_branch",
				displayProject: project,
			};
		}
		return { value: normalizedRemote, source: "git_remote", displayProject: project };
	}

	if (cwd) {
		return { value: normalizeCwd(cwd), source: "cwd", displayProject: project };
	}

	if (workspaceId) {
		return { value: normalizeSlash(workspaceId), source: "workspace_id", displayProject: project };
	}

	return { value: unmappedIdentity(input), source: "unmapped", displayProject: project };
}

function isBasenameOnlyPattern(pattern: string): boolean {
	return !/[\\/:]/.test(pattern);
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}

function patternSpecificity(pattern: string): number {
	return pattern.replace(/[*?]/g, "").length;
}

function matchesPattern(identity: string, pattern: string): boolean {
	const normalizedPattern = normalizeSlash(pattern);
	if (!normalizedPattern || isBasenameOnlyPattern(normalizedPattern)) return false;
	if (!/[*?]/.test(normalizedPattern)) return identity === normalizedPattern;
	const regex = new RegExp(
		`^${escapeRegex(normalizedPattern).replaceAll("\\*", ".*").replaceAll("\\?", ".")}$`,
	);
	return regex.test(identity);
}

function candidatePriority(candidate: MappingCandidate): number {
	return candidate.mapping.priority ?? 0;
}

function candidateUpdatedAt(candidate: MappingCandidate): number {
	const updatedAt = clean(candidate.mapping.updated_at);
	if (!updatedAt) return 0;
	const time = Date.parse(updatedAt);
	return Number.isFinite(time) ? time : 0;
}

function compareCandidates(a: MappingCandidate, b: MappingCandidate): number {
	return (
		candidatePriority(b) - candidatePriority(a) ||
		b.specificity - a.specificity ||
		candidateUpdatedAt(b) - candidateUpdatedAt(a) ||
		(b.mapping.id ?? 0) - (a.mapping.id ?? 0) ||
		a.mapping.scope_id.localeCompare(b.mapping.scope_id)
	);
}

function bestCandidate(candidates: MappingCandidate[]): MappingCandidate | null {
	return candidates.toSorted(compareCandidates)[0] ?? null;
}

export function resolveProjectScope(input: ResolveProjectScopeInput): ScopeResolution {
	const workspaceIdentity = canonicalWorkspaceIdentity(input);
	const explicitScopeId = clean(input.explicitScopeId);
	if (explicitScopeId) {
		return {
			scopeId: explicitScopeId,
			reason: "explicit_override",
			workspaceIdentity,
			mapping: null,
			matchedPattern: null,
		};
	}
	if (workspaceIdentity.source === "unmapped") {
		return {
			scopeId: input.localDefaultScopeId ?? LOCAL_DEFAULT_SCOPE_ID,
			reason: "local_default",
			workspaceIdentity,
			mapping: null,
			matchedPattern: null,
		};
	}

	const mappings = input.mappings ?? [];
	const exact = bestCandidate(
		mappings
			.filter(
				(mapping) =>
					normalizeMappingIdentity(mapping.workspace_identity) === workspaceIdentity.value,
			)
			.map((mapping) => ({
				mapping,
				matchedPattern: null,
				specificity: workspaceIdentity.value.length,
			})),
	);
	if (exact) {
		return {
			scopeId: exact.mapping.scope_id,
			reason: "exact_mapping",
			workspaceIdentity,
			mapping: exact.mapping,
			matchedPattern: null,
		};
	}

	const pattern = bestCandidate(
		mappings.flatMap((mapping): MappingCandidate[] => {
			if (clean(mapping.workspace_identity)) return [];
			const projectPattern = clean(mapping.project_pattern);
			if (!projectPattern || !matchesPattern(workspaceIdentity.value, projectPattern)) return [];
			return [
				{
					mapping,
					matchedPattern: normalizeSlash(projectPattern),
					specificity: patternSpecificity(projectPattern),
				},
			];
		}),
	);
	if (pattern) {
		return {
			scopeId: pattern.mapping.scope_id,
			reason: "pattern_mapping",
			workspaceIdentity,
			mapping: pattern.mapping,
			matchedPattern: pattern.matchedPattern,
		};
	}

	return {
		scopeId: input.localDefaultScopeId ?? LOCAL_DEFAULT_SCOPE_ID,
		reason: "local_default",
		workspaceIdentity,
		mapping: null,
		matchedPattern: null,
	};
}
