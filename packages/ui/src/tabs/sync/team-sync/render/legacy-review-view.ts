import type { CachedLegacySharedReview } from "../../../../lib/state";
import type {
	SyncLegacySharedReviewGroup,
	SyncLegacySharedReviewItem,
	SyncLegacySharedReviewMemorySample,
	SyncLegacySharedReviewTargetScope,
} from "../../components/sync-sharing-review";

type Raw = Record<string, unknown>;

function text(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function memorySample(sample: unknown): SyncLegacySharedReviewMemorySample {
	const raw = sample as Raw;
	const id = Number(raw.id || 0);
	return {
		bodyPreview: text(raw.body_preview),
		createdAt: text(raw.created_at),
		cwd: text(raw.cwd),
		gitRemote: text(raw.git_remote),
		id,
		kind: text(raw.kind),
		ownership: raw.ownership === "peer" ? "peer" : "local",
		project: text(raw.project),
		title: String(raw.title || `Memory ${id}`),
		updatedAt: text(raw.updated_at),
	};
}

function reviewGroup(group: unknown): SyncLegacySharedReviewGroup {
	const raw = group as Raw;
	return {
		displayProject: String(raw.display_project || raw.project || "Unknown project"),
		identitySource: String(raw.identity_source || "unknown"),
		lastUpdatedAt: text(raw.last_updated_at),
		memoryCount: Number(raw.memory_count || 0),
		memorySamples: Array.isArray(raw.memory_samples) ? raw.memory_samples.map(memorySample) : [],
		peerOwnedMemoryCount: Number(raw.peer_owned_memory_count || 0),
		reassignableMemoryCount: Number(raw.reassignable_memory_count || 0),
		suggestedScopeId: text(raw.suggested_scope_id),
		suggestionReason: text(raw.suggestion_reason),
		workspaceIdentity: String(raw.workspace_identity || raw.display_project || "unknown"),
	};
}

function targetScope(scope: unknown): SyncLegacySharedReviewTargetScope {
	const raw = scope as Raw;
	return {
		authorityType: String(raw.authority_type || "unknown"),
		label: String(raw.label || raw.scope_id || "Unknown domain"),
		scopeId: String(raw.scope_id || ""),
	};
}

/**
 * The older shared data review that sync status reports, shaped for the review list.
 * Null when nothing is waiting for review.
 */
export function legacySharedReviewView(
	review: CachedLegacySharedReview | null | undefined,
): SyncLegacySharedReviewItem | null {
	if (!review?.has_data) return null;
	const groups = Array.isArray(review.groups) ? review.groups : [];
	return {
		groups: groups.map(reviewGroup),
		memoryCount: Math.max(0, Number(review.memory_count ?? 0)),
		scopeId: String(review.scope_id || "legacy-shared-review"),
		totalGroupCount: Number(review.total_group_count || groups.length || 0),
		targetScopes: (Array.isArray(review.target_scopes) ? review.target_scopes : [])
			.map(targetScope)
			.filter((scope) => scope.scopeId),
	};
}
