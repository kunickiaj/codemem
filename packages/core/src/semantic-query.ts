/** Internal query stages shared by inline and worker semantic ranking, not a package API. */
import { DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL } from "./embeddings.js";
import { buildFilterBranchesWithContext, type OwnershipFilterContext } from "./filters.js";
import type { MaintenanceJobSnapshot } from "./maintenance-jobs.js";
import { summaryContinuityFilter } from "./summary-memory.js";
import type { MemoryFilters } from "./types.js";
import type { SemanticSearchResult, SemanticSearchScopeContext } from "./vectors.js";

function scopeVisibleFilterContext(context: SemanticSearchScopeContext): OwnershipFilterContext {
	return {
		actorId: context?.actorId ?? "",
		deviceId: context?.deviceId ?? "",
		claimedDeviceIds: context?.claimedDeviceIds ?? [],
		legacyActorIds: context?.legacyActorIds ?? [],
		enforceScopeVisibility: true,
		visibleScopeIds: context?.visibleScopeIds,
		scopeVisibilityDb: context?.scopeVisibilityDb,
		expectedPublicKey: context?.expectedPublicKey,
		loadExpectedPublicKey: context?.loadExpectedPublicKey,
	};
}

export function buildAuthorizedSemanticMemoryIdsQuery(
	filters: MemoryFilters | null,
	context: SemanticSearchScopeContext,
	summarySessionId: number | null | undefined,
): { sql: string; params: unknown[] } {
	const branches = buildFilterBranchesWithContext(filters, scopeVisibleFilterContext(context));
	const continuity = summaryContinuityFilter(summarySessionId);
	const queries = branches.map((branch) => {
		const join = branch.joinSessions
			? "JOIN sessions ON sessions.id = memory_items.session_id"
			: "";
		const clauses = ["memory_items.active = 1", ...branch.clauses, ...continuity.clauses];
		return `SELECT memory_items.id FROM memory_items ${join}
			WHERE ${clauses.join(" AND ")}`;
	});
	return {
		sql: queries.join(" UNION ALL "),
		params: branches.flatMap((branch) => [...branch.params, ...continuity.params]),
	};
}

export function semanticResult(row: Record<string, unknown>): SemanticSearchResult {
	return {
		id: Number(row.id),
		kind: String(row.kind ?? "observation"),
		title: String(row.title ?? ""),
		body_text: String(row.body_text ?? ""),
		confidence: Number(row.confidence ?? 0),
		tags_text: String(row.tags_text ?? ""),
		metadata_json: row.metadata_json == null ? null : String(row.metadata_json),
		created_at: String(row.created_at ?? ""),
		updated_at: String(row.updated_at ?? ""),
		session_id: Number(row.session_id),
		score: 1.0 / (1.0 + Number(row.distance ?? 0)),
		distance: Number(row.distance ?? 0),
		narrative: row.narrative == null ? null : String(row.narrative),
		facts: row.facts == null ? null : String(row.facts),
	};
}

const LEGACY_MODEL = "Xenova/bge-small-en-v1.5";

function resolveLegacyRebuild(options: {
	currentModel: string;
	sourceModel: string;
	targetModel: string | null;
	models: readonly (string | null)[];
}): string | null {
	if (
		options.sourceModel !== LEGACY_MODEL ||
		options.targetModel !== DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL ||
		options.currentModel !== DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL
	)
		return null;
	if (options.models.includes(options.sourceModel)) return options.sourceModel;
	if (options.models.includes(options.currentModel)) return options.currentModel;
	return null;
}

function catalogDefault(currentModel: string, models: readonly (string | null)[]): string | null {
	if (currentModel === DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL && models.includes(LEGACY_MODEL)) {
		return LEGACY_MODEL;
	}
	if (models.includes(currentModel) && models.every((model) => model === currentModel)) {
		return currentModel;
	}
	return null;
}

function metadataModel(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function resolveSemanticSearchModelFromCatalog(
	currentModel: string,
	job: Pick<MaintenanceJobSnapshot, "status" | "metadata"> | null,
	models: readonly (string | null)[],
): string | null {
	const metadata = job?.metadata ?? {};
	const sourceModel = metadataModel(metadata.source_model);
	const targetModel = metadataModel(metadata.target_model);
	const reconciliationTargetCoverageComplete =
		metadata.reconciliation_target_coverage_complete === true;
	if (models.length === 0) return null;
	const hasCurrentModel = models.includes(currentModel);
	if (
		["running", "pending"].includes(job?.status ?? "") &&
		reconciliationTargetCoverageComplete &&
		targetModel === currentModel
	) {
		return hasCurrentModel ? currentModel : null;
	}
	if (
		["running", "pending", "failed"].includes(job?.status ?? "") &&
		sourceModel &&
		sourceModel !== currentModel
	) {
		return resolveLegacyRebuild({ currentModel, sourceModel, targetModel, models });
	}
	if (job?.status === "completed" && targetModel === currentModel) {
		return hasCurrentModel ? currentModel : null;
	}
	return catalogDefault(currentModel, models);
}
