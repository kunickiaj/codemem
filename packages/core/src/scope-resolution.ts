import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Database } from "better-sqlite3";

export const LOCAL_DEFAULT_SCOPE_ID = "local-default";

/**
 * Scope id used by the conservative migration backfill for legacy shared
 * memories that cannot yet be assigned to a concrete team/org scope. Single
 * source of truth: filters.ts and scope-backfill.ts re-import this so the
 * read-visibility predicate and the backfill agree on one literal.
 */
export const LEGACY_SHARED_REVIEW_SCOPE_ID = "legacy-shared-review";

/**
 * Upper bound on how many scope ids we will inline into the index-eligible
 * `scope_id IN (...)` fast path (one bound parameter each). Kept well under
 * SQLite's compiled `SQLITE_MAX_VARIABLE_NUMBER` so a device with an
 * unrealistically large visible set falls back to the fixed-param EXISTS
 * predicate instead of throwing "too many SQL variables" at prepare time.
 */
export const MAX_SCOPE_IN_PARAMS = 500;

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

/**
 * Resolve, once per request, the full set of scope_ids that `deviceId` may read.
 *
 * This is the index-eligible equivalent of the per-row EXISTS predicate in
 * `addScopeVisibilityFilter`'s fallback branch (filters.ts): instead of
 * evaluating the replication_scopes / scope_memberships subqueries for every
 * candidate row, we compute the visible set up front and let the SQL filter use
 * a plain `scope_id IN (...)`. The membership predicate (active membership with
 * `membership_epoch >= scope.membership_epoch`) is preserved exactly.
 *
 * Lives in this leaf module (it imports nothing from filters/search/store/
 * vectors) so all three OwnershipFilterContext builders can share it without an
 * import cycle.
 *
 * NULL scope_ids are skipped here — a NULL scope_id is handled by the filter's
 * dedicated `IS NULL` branch, not by membership in this set.
 */
export function resolveVisibleScopeIds(db: Database, deviceId: string): string[] {
	const visible = new Set<string>(["", LOCAL_DEFAULT_SCOPE_ID, LEGACY_SHARED_REVIEW_SCOPE_ID]);
	const localScopes = db
		.prepare(
			`SELECT scope_id
			 FROM replication_scopes
			 WHERE status = 'active' AND authority_type = 'local'`,
		)
		.all() as Array<{ scope_id: string | null }>;
	for (const row of localScopes) {
		if (row.scope_id != null) visible.add(row.scope_id);
	}
	const memberScopes = db
		.prepare(
			`SELECT sm.scope_id AS scope_id
			 FROM scope_memberships sm
			 JOIN replication_scopes rs ON rs.scope_id = sm.scope_id
			 WHERE sm.device_id = ?
			   AND sm.status = 'active'
			   AND rs.status = 'active'
			   AND sm.membership_epoch >= rs.membership_epoch`,
		)
		.all(deviceId) as Array<{ scope_id: string | null }>;
	for (const row of memberScopes) {
		if (row.scope_id != null) visible.add(row.scope_id);
	}
	return [...visible];
}
