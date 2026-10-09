import { resolve } from "node:path";
import type { Database } from "better-sqlite3";
import { cleanProjectIdentity } from "./project-identity.js";
import { getEffectiveCachedScopeAuthorization } from "./scope-membership-cache.js";
import { matchesWildcard } from "./wildcard-match.js";
import {
	type CanonicalWorkspaceIdentity,
	canonicalWorkspaceIdentity,
	type WorkspaceIdentityInput,
} from "./workspace-identity.js";

export {
	type CanonicalWorkspaceIdentity,
	canonicalWorkspaceIdentity,
	type WorkspaceIdentityInput,
	type WorkspaceIdentitySource,
} from "./workspace-identity.js";

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
 * `scope_id IN (...)` fast path (one bound parameter each). Larger sets use
 * a single JSON array parameter instead of exceeding SQLite's variable limit.
 */
export const MAX_SCOPE_IN_PARAMS = 500;

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
	allowRepositoryCwdFallback?: boolean;
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

function isBasenameOnlyPattern(pattern: string): boolean {
	return !/[\\/:]/.test(pattern);
}

function patternSpecificity(pattern: string): number {
	return pattern.replace(/[*?]/g, "").length;
}

function matchesPattern(identity: string, pattern: string): boolean {
	const normalizedPattern = normalizeSlash(pattern);
	if (!normalizedPattern || isBasenameOnlyPattern(normalizedPattern)) return false;
	if (!/[*?]/.test(normalizedPattern)) return identity === normalizedPattern;
	return matchesWildcard(identity, normalizedPattern, { unicode: false });
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

function exactMappingIdentities(
	input: ResolveProjectScopeInput,
	workspaceIdentity: CanonicalWorkspaceIdentity,
): string[] {
	const identities = [workspaceIdentity.value];
	if (input.allowRepositoryCwdFallback === false) return identities;
	if (
		workspaceIdentity.source !== "git_repository" &&
		workspaceIdentity.source !== "git_remote" &&
		workspaceIdentity.source !== "git_remote_branch"
	) {
		return identities;
	}
	const cwd = cleanProjectIdentity(input.cwd);
	if (cwd) identities.push(normalizeCwd(cwd));
	return identities;
}

function patternMappingIdentities(
	input: ResolveProjectScopeInput,
	workspaceIdentity: CanonicalWorkspaceIdentity,
): string[] {
	const identities = [workspaceIdentity.value];
	if (input.allowRepositoryCwdFallback === false) return identities;
	if (
		workspaceIdentity.source !== "git_repository" &&
		workspaceIdentity.source !== "git_remote" &&
		workspaceIdentity.source !== "git_remote_branch"
	) {
		return identities;
	}
	const cwd = cleanProjectIdentity(input.cwd);
	if (cwd) identities.push(normalizeCwd(cwd));
	return identities;
}

function bestExactMapping(mappings: ScopeMapping[], identities: string[]): MappingCandidate | null {
	for (const identity of identities) {
		const candidate = bestCandidate(
			mappings
				.filter((mapping) => normalizeMappingIdentity(mapping.workspace_identity) === identity)
				.map((mapping) => ({ mapping, matchedPattern: null, specificity: identity.length })),
		);
		if (candidate) return candidate;
	}
	return null;
}

function bestPatternMapping(
	mappings: ScopeMapping[],
	identities: string[],
): MappingCandidate | null {
	return bestCandidate(
		identities.flatMap((identity) =>
			mappings.flatMap((mapping): MappingCandidate[] => {
				if (clean(mapping.workspace_identity)) return [];
				const projectPattern = clean(mapping.project_pattern);
				if (!projectPattern || !matchesPattern(identity, projectPattern)) return [];
				return [
					{
						mapping,
						matchedPattern: normalizeSlash(projectPattern),
						specificity: patternSpecificity(projectPattern),
					},
				];
			}),
		),
	);
}

export function scopeIdsMatchingProjectPatterns(
	mappings: ScopeMapping[],
	workspaceIdentities: Iterable<string>,
): Set<string> {
	const identities = [...workspaceIdentities].map(normalizeSlash);
	const scopeIds = new Set<string>();
	for (const mapping of mappings) {
		if (clean(mapping.workspace_identity)) continue;
		const projectPattern = clean(mapping.project_pattern);
		if (
			!projectPattern ||
			!identities.some((identity) => matchesPattern(identity, projectPattern))
		) {
			continue;
		}
		scopeIds.add(mapping.scope_id);
	}
	return scopeIds;
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
	const exactIdentities = exactMappingIdentities(input, workspaceIdentity);
	const exact = bestExactMapping(mappings, exactIdentities);
	if (exact) {
		return {
			scopeId: exact.mapping.scope_id,
			reason: "exact_mapping",
			workspaceIdentity,
			mapping: exact.mapping,
			matchedPattern: null,
		};
	}

	const pattern = bestPatternMapping(mappings, patternMappingIdentities(input, workspaceIdentity));
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

export interface ScopeVisibilityOptions {
	/** Public key of the runtime's actual signing key, not an enrolled DB row. */
	expectedPublicKey?: string;
	/** Read-only key loader, called once only when coordinator candidates exist. */
	loadExpectedPublicKey?: () => string | undefined;
}

/**
 * Resolve readable scopes once per request. Coordinator membership SQL lists
 * candidates only; retained proof must match the supplied actual signing key.
 * Unknown scopes deny, while local/manual/invite scopes retain existing rules.
 * NULL scopes remain the filter's dedicated local-default branch.
 */
export function resolveVisibleScopeIds(
	db: Database,
	deviceId: string,
	options: ScopeVisibilityOptions = {},
): string[] {
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
			`SELECT sm.scope_id AS scope_id, rs.authority_type
			 FROM scope_memberships sm
			 JOIN replication_scopes rs ON rs.scope_id = sm.scope_id
			 WHERE sm.device_id = ?
			   AND sm.status = 'active'
			   AND rs.status = 'active'
			   AND sm.membership_epoch >= rs.membership_epoch`,
		)
		.all(deviceId) as Array<{ scope_id: string | null; authority_type: string }>;
	const expectedPublicKey =
		options.expectedPublicKey ??
		(memberScopes.some((row) => row.scope_id != null && row.authority_type === "coordinator")
			? options.loadExpectedPublicKey?.()
			: undefined);
	for (const row of memberScopes) {
		if (row.scope_id == null) continue;
		if (row.authority_type !== "coordinator") {
			visible.add(row.scope_id);
			continue;
		}
		if (!expectedPublicKey?.trim()) continue;
		const authorization = getEffectiveCachedScopeAuthorization(db, {
			deviceId,
			scopeId: row.scope_id,
			expectedPublicKey,
		});
		if (!authorization.authorized) continue;
		visible.add(row.scope_id);
	}
	return [...visible];
}
