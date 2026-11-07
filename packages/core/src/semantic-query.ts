/** Internal query stages shared by inline and worker semantic ranking, not a package API. */

import { type Database, tableExists } from "./db.js";
import { chunkText, DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL, hashText } from "./embeddings.js";
import { buildFilterBranchesWithContext, type OwnershipFilterContext } from "./filters.js";
import type { MaintenanceJobSnapshot, MaintenanceJobStatus } from "./maintenance-jobs.js";
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
	memoryIds?: readonly number[],
): { sql: string; params: unknown[] } {
	const branches = buildFilterBranchesWithContext(filters, scopeVisibleFilterContext(context));
	const continuity = summaryContinuityFilter(summarySessionId);
	const queries = branches.map((branch) => {
		const join = branch.joinSessions
			? "JOIN sessions ON sessions.id = memory_items.session_id"
			: "";
		const source =
			memoryIds === undefined
				? "memory_items"
				: "json_each(?) AS requested_ids CROSS JOIN memory_items ON memory_items.id = requested_ids.value";
		const clauses = ["memory_items.active = 1", ...branch.clauses, ...continuity.clauses];
		return `SELECT memory_items.id FROM ${source} ${join}
			WHERE ${clauses.join(" AND ")}`;
	});
	return {
		sql: queries.join(" UNION ALL "),
		params: branches.flatMap((branch) => [
			...(memoryIds === undefined ? [] : [JSON.stringify(memoryIds)]),
			...branch.params,
			...continuity.params,
		]),
	};
}

function readModelMetadata(json: string | null): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(json ?? "null");
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	} catch {
		return null;
	}
	return null;
}

/** Read only: search must never initialize maintenance schema. */
export function readModelJob(
	db: Database,
): Pick<MaintenanceJobSnapshot, "status" | "metadata"> | null {
	if (!tableExists(db, "maintenance_jobs")) return null;
	const row = db
		.prepare("SELECT status, metadata_json FROM maintenance_jobs WHERE kind = ?")
		.get("vector_model_migration") as
		| { status: MaintenanceJobStatus; metadata_json: string | null }
		| undefined;
	if (!row) return null;
	return { status: row.status, metadata: readModelMetadata(row.metadata_json) };
}

/** Build before distance evaluation, in the same snapshot as authorization and ranking. */
export function pendingVectorFreshness(
	db: Database,
	filters: MemoryFilters | null,
	context: SemanticSearchScopeContext,
	summarySessionId: number | null | undefined,
	columnPrefix = "",
): { sql: string; params: string[] } {
	const job = readModelJob(db);
	if (!job) return { sql: "", params: [] };
	const pending = job.metadata?.pending_upsert_memory_ids;
	const deletes = job.metadata?.pending_delete_memory_ids;
	if (
		!job.metadata ||
		(pending !== undefined && !validPendingIds(pending)) ||
		(deletes !== undefined && !validPendingIds(deletes))
	) {
		return { sql: "AND 0", params: [] };
	}
	if (pending === undefined || pending.length === 0) return { sql: "", params: [] };
	const authorized = buildAuthorizedSemanticMemoryIdsQuery(
		filters,
		context,
		summarySessionId,
		pending,
	);
	const memories = db
		.prepare(`SELECT id, title, body_text FROM memory_items
		WHERE id IN (${authorized.sql})`)
		.all(...authorized.params) as Array<{
		id: number;
		title: string | null;
		body_text: string | null;
	}>;
	const chunkKeys: string[] = [];
	for (const memory of memories) {
		const text = `${memory.title ?? ""}\n${memory.body_text ?? ""}`.trim();
		chunkText(text).forEach((chunk, index) => {
			chunkKeys.push(`${memory.id}:${index}:${hashText(chunk)}`);
		});
	}
	// Writers number chunks from zero. Matching the position also rejects an old
	// chunk whose text survives elsewhere in the current memory. The uncorrelated
	// IN list builds an index once instead of looking up a JSON path for every row.
	return {
		sql: `AND (${columnPrefix}memory_id NOT IN (SELECT value FROM json_each(?))
			OR (${columnPrefix}memory_id || ':' || ${columnPrefix}chunk_index || ':' || ${columnPrefix}content_hash)
			IN (SELECT value FROM json_each(?)))`,
		params: [JSON.stringify(pending), JSON.stringify(chunkKeys)],
	};
}

function validPendingIds(value: unknown): value is number[] {
	return Array.isArray(value) && value.every((id) => Number.isSafeInteger(id) && id > 0);
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
