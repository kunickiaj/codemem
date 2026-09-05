/**
 * Vector store operations for semantic search.
 *
 * Ports codemem/store/vectors.py — backfill and on-insert vector writes
 * against the sqlite-vec `memory_vectors` virtual table.
 *
 * All functions accept a raw better-sqlite3 Database so they work outside
 * the MemoryStore class.  Embedding is async; callers await then write
 * synchronously (matches the runtime-topology decision: main thread owns DB).
 */

import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { isEmbeddingDisabled, tableExists } from "./db.js";
import {
	assertEmbeddingClientIdentity,
	chunkText,
	DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL,
	type EmbeddingClient,
	embedTexts,
	getEmbeddingClient,
	getEmbeddingRuntimeStatus,
	hashText,
	resolveEmbeddingClientVectorIdentityLabel,
	resolveEmbeddingModel,
	serializeFloat32,
	tryResolveEmbeddingRevision,
	tryResolveEmbeddingVectorIdentityLabel,
} from "./embeddings.js";
import { buildFilterClausesWithContext, type OwnershipFilterContext } from "./filters.js";
import {
	completeMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
} from "./maintenance-jobs.js";
import { projectClause } from "./project.js";
import type { ReplicationVectorWork } from "./sync-replication.js";
import type { MemoryFilters } from "./types.js";

const VECTOR_MODEL_MIGRATION_JOB = "vector_model_migration";
// Keep resolved-client identity separate from migration progress: direct or
// partial backfills must not claim that a model cutover completed.
const VECTOR_MODEL_IDENTITY_JOB = "vector_model_identity";
const LEGACY_DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
const BACKFILL_MEMORY_PAGE_SIZE = 50;
const BACKFILL_INFERENCE_BATCH_SIZE = 32;
const BACKFILL_CANDIDATE_TABLE_PREFIX = "codemem_backfill_vector_candidates";

type VectorModelCount = { model: string; rows: number };

type MemoryTextRow = {
	id: number;
	title: string | null;
	body_text: string | null;
	created_at?: string;
};
type PendingChunk = { text: string; chunkIndex: number; contentHash: string };
type PendingMemory = {
	memoryId: number;
	chunks: PendingChunk[];
	vectors: Float32Array[];
};

type BackfillMemoryRow = MemoryTextRow & { snapshot_seq: number };

function createBackfillCandidateSnapshot(
	db: Database,
	joinClause: string,
	where: string,
	params: unknown[],
	rowLimit: number,
): string {
	// randomUUID is hex plus hyphens; stripping hyphens keeps this interpolated identifier safe.
	const tableName = `${BACKFILL_CANDIDATE_TABLE_PREFIX}_${randomUUID().replaceAll("-", "")}`;
	db.exec(`
		CREATE TEMP TABLE ${tableName} (
			seq INTEGER PRIMARY KEY,
			memory_id INTEGER NOT NULL
		)
	`);
	const hasFiniteLimit = Number.isFinite(rowLimit);
	const limitClause = hasFiniteLimit ? "LIMIT ?" : "";
	const snapshotParams = hasFiniteLimit ? [...params, rowLimit] : params;
	try {
		db.prepare(
			`INSERT INTO ${tableName}(memory_id)
			 SELECT memory_items.id
			 FROM memory_items ${joinClause}
			 WHERE ${where}
			 ORDER BY memory_items.created_at ASC, memory_items.id ASC
			 ${limitClause}`,
		).run(...snapshotParams);
	} catch (error) {
		db.exec(`DROP TABLE IF EXISTS ${tableName}`);
		throw error;
	}
	return tableName;
}

function deleteBackfillCandidateSnapshot(db: Database, tableName: string): void {
	db.exec(`DROP TABLE IF EXISTS ${tableName}`);
}

// Deliberately omits `enforceScopeVisibility` so semantic callers can never
// disable the local read boundary — scopeVisibleFilterContext() always forces
// it on below. Field list otherwise mirrors OwnershipFilterContext.
export type SemanticSearchScopeContext = Omit<OwnershipFilterContext, "enforceScopeVisibility">;

function scopeVisibleFilterContext(context: SemanticSearchScopeContext): OwnershipFilterContext {
	return {
		actorId: context?.actorId ?? "",
		deviceId: context?.deviceId ?? "",
		claimedDeviceIds: context?.claimedDeviceIds ?? [],
		legacyActorIds: context?.legacyActorIds ?? [],
		enforceScopeVisibility: true,
		// Forward the pre-resolved visible scope set so the KNN candidate filter
		// gets the index-eligible `scope_id IN (...)` fast path. Callers reach
		// semanticSearch via ownershipFilterContext(store) (search.ts / store.ts),
		// which already resolves this set; when absent the filter falls back to the
		// equivalent EXISTS predicate. This function has no db handle of its own.
		visibleScopeIds: context?.visibleScopeIds,
	};
}

function clampSemanticLimit(limit: number): number {
	if (limit === Number.POSITIVE_INFINITY) return 200;
	if (!Number.isFinite(limit)) return 1;
	return Math.min(Math.max(1, Math.trunc(limit)), 200);
}

function listVectorModelCounts(db: Database): VectorModelCount[] {
	if (!tableExists(db, "memory_vectors")) {
		return [];
	}
	try {
		return db
			.prepare(
				"SELECT model, COUNT(*) AS rows FROM memory_vectors GROUP BY model ORDER BY rows DESC, model ASC",
			)
			.all() as VectorModelCount[];
	} catch {
		return [];
	}
}

function hasVectorRows(db: Database): boolean {
	if (!tableExists(db, "memory_vectors")) return false;
	try {
		return db.prepare("SELECT 1 FROM memory_vectors LIMIT 1").get() != null;
	} catch {
		return false;
	}
}

function tryResolveConfiguredVectorIdentityLabel(db: Database): string | null {
	for (const jobKind of [VECTOR_MODEL_IDENTITY_JOB, VECTOR_MODEL_MIGRATION_JOB]) {
		const metadata = (getMaintenanceJob(db, jobKind)?.metadata ?? {}) as Record<string, unknown>;
		const targetModel = tryResolveEmbeddingVectorIdentityLabel({
			targetModel: metadata.target_model,
			requestedModel: metadata.requested_model,
			requestedRevision: metadata.requested_revision,
		});
		if (targetModel) return targetModel;
	}
	return null;
}

function persistBackfillVectorIdentity(
	db: Database,
	client: EmbeddingClient,
	targetModel: string,
): void {
	if (!client.identity) {
		throw new TypeError("Embedding runtime identity is required to persist backfill metadata");
	}
	const metadata = {
		target_model: targetModel,
		requested_model: client.model,
		requested_revision: client.identity.requestedRevision ?? client.identity.revision,
	};
	startMaintenanceJob(db, {
		kind: VECTOR_MODEL_IDENTITY_JOB,
		title: "Embedding vector identity",
		message: "Recorded the canonical embedding identity used by vector backfill",
		progressTotal: 1,
		metadata,
	});
	completeMaintenanceJob(db, VECTOR_MODEL_IDENTITY_JOB, {
		progressCurrent: 1,
		progressTotal: 1,
		metadata,
	});
}

export function resolveSemanticSearchModel(db: Database, currentModel?: string): string | null {
	if (currentModel === undefined) {
		currentModel = tryResolveConfiguredVectorIdentityLabel(db) ?? undefined;
		if (currentModel === undefined) return null;
	}
	const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
	const metadata = job?.metadata ?? {};
	const sourceModel = typeof metadata.source_model === "string" ? metadata.source_model : null;
	const targetModel = typeof metadata.target_model === "string" ? metadata.target_model : null;
	const reconciliationTargetCoverageComplete =
		metadata.reconciliation_target_coverage_complete === true;
	const rows = listVectorModelCounts(db);
	if (rows.length === 0) return null;
	const hasCurrentModel = rows.some((row) => row.model === currentModel);
	const hasCompatibleLegacyModel =
		currentModel === DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL &&
		rows.some((row) => row.model === LEGACY_DEFAULT_EMBEDDING_MODEL);
	if (
		(job?.status === "running" || job?.status === "pending") &&
		reconciliationTargetCoverageComplete &&
		targetModel === currentModel
	) {
		return hasCurrentModel ? currentModel : null;
	}
	if (
		(job?.status === "running" || job?.status === "pending" || job?.status === "failed") &&
		sourceModel &&
		sourceModel !== currentModel
	) {
		const compatibleLegacyRebuild =
			sourceModel === LEGACY_DEFAULT_EMBEDDING_MODEL &&
			targetModel === DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL &&
			currentModel === DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;
		if (!compatibleLegacyRebuild) return null;
		if (rows.some((row) => row.model === sourceModel)) return sourceModel;
		if (hasCurrentModel) return currentModel;
		return null;
	}
	if (job?.status === "completed" && targetModel === currentModel) {
		return hasCurrentModel ? currentModel : null;
	}
	if (hasCompatibleLegacyModel) return LEGACY_DEFAULT_EMBEDDING_MODEL;
	if (hasCurrentModel && rows.every((row) => row.model === currentModel)) return currentModel;
	return null;
}

/**
 * Resolve every vector-model label that should be read together for the current
 * identity. During the compatible legacy-default rebuild this returns both the
 * legacy label and the revision-aware target so consumers see memories written
 * under either identity. Returns a single-element list otherwise, or `[]` when
 * no semantic corpus is currently serviceable.
 */
export function resolveSemanticSearchModels(db: Database, resolvedModel?: string): string[] {
	const currentModel = resolvedModel ?? tryResolveConfiguredVectorIdentityLabel(db);
	if (currentModel == null) return [];
	const primaryModel = resolveSemanticSearchModel(db, currentModel);
	if (!primaryModel) return [];
	if (
		primaryModel === LEGACY_DEFAULT_EMBEDDING_MODEL &&
		currentModel === DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL &&
		listVectorModelCounts(db).some((row) => row.model === currentModel)
	) {
		return [primaryModel, currentModel];
	}
	return [primaryModel];
}

function chunkHashes(text: string): string[] {
	return chunkText(text).map((chunk) => hashText(chunk));
}

function memoryText(title: string | null, bodyText: string | null): string {
	return `${title ?? ""}\n${bodyText ?? ""}`.trim();
}

export function memoryHasCompleteVectorCoverage(
	db: Database,
	memory: MemoryTextRow,
	model: string,
): boolean {
	const expectedHashes = chunkHashes(memoryText(memory.title, memory.body_text));
	if (expectedHashes.length === 0) return true;
	const existingRows = db
		.prepare("SELECT content_hash FROM memory_vectors WHERE memory_id = ? AND model = ?")
		.all(memory.id, model) as Array<{ content_hash: string | null }>;
	return expectedHashesExist(expectedHashes, existingRows);
}

function expectedHashesExist(
	expectedHashes: string[],
	existingRows: Array<{ content_hash: string | null }>,
): boolean {
	const existingHashes = new Set(
		existingRows.map((row) => row.content_hash).filter((hash): hash is string => hash != null),
	);
	return expectedHashSetContains(expectedHashes, existingHashes);
}

function expectedHashSetContains(expectedHashes: string[], existingHashes: Set<string>): boolean {
	return expectedHashes.every((hash) => existingHashes.has(hash));
}

export function countIncompleteActiveMemoryVectorCoverage(db: Database, model: string): number {
	const batchSize = 250;
	let afterId = 0;
	let incomplete = 0;
	const selectMemories = db.prepare(
		`SELECT id, title, body_text FROM memory_items
		 WHERE active = 1
		   AND TRIM(COALESCE(title, '') || COALESCE(body_text, '')) != ''
		   AND id > ?
		 ORDER BY id ASC
		 LIMIT ?`,
	);
	while (true) {
		const memories = selectMemories.all(afterId, batchSize) as MemoryTextRow[];
		if (memories.length === 0) break;
		const placeholders = memories.map(() => "?").join(", ");
		const vectorRows = db
			.prepare(
				`/* vector-coverage-validation */
				 SELECT memory_id, content_hash FROM memory_vectors
				 WHERE model = ? AND memory_id IN (${placeholders})`,
			)
			.all(model, ...memories.map((memory) => memory.id)) as Array<{
			memory_id: number;
			content_hash: string | null;
		}>;
		const hashesByMemory = new Map<number, Set<string>>();
		for (const row of vectorRows) {
			if (row.content_hash == null) continue;
			const hashes = hashesByMemory.get(row.memory_id) ?? new Set<string>();
			hashes.add(row.content_hash);
			hashesByMemory.set(row.memory_id, hashes);
		}
		for (const memory of memories) {
			const expected = chunkHashes(memoryText(memory.title, memory.body_text));
			// A memory that chunks to nothing (e.g. whitespace-only content that
			// SQLite's one-arg TRIM does not strip) has no expected hashes and is
			// vacuously covered, matching memoryHasCompleteVectorCoverage.
			if (expected.length === 0) continue;
			const existing = hashesByMemory.get(memory.id);
			if (!existing || !expectedHashSetContains(expected, existing)) incomplete++;
		}
		afterId = memories.at(-1)?.id ?? afterId;
	}
	return incomplete;
}

/**
 * Delete target-model vector rows whose content_hash is not part of their
 * memory's current chunk set. Coverage is a subset check, so a memory can be
 * "covered" while still retaining obsolete target rows — e.g. an interrupted
 * migration, or a title/body edit (like `codemem db scan-secrets` redaction)
 * without vector maintenance. Because semanticSearch ranks by MIN(distance)
 * across a memory's rows, those stale rows would keep pre-edit or redacted
 * content influencing recall after cutover. Incomplete memories are left
 * untouched so their current rows can still be repaired safely. Returns the
 * number of rows removed.
 */
export function pruneObsoleteTargetModelVectors(
	db: Database,
	model: string,
	options: { signal?: AbortSignal } = {},
): number {
	const batchSize = 250;
	let afterRowId = 0;
	let deleted = 0;
	const selectBatch = db.prepare(
		`SELECT mv.rowid AS rowid, mv.memory_id AS memory_id, mv.content_hash AS content_hash,
		        mi.title AS title, mi.body_text AS body_text, mi.active AS active
		 FROM memory_vectors mv
		 LEFT JOIN memory_items mi ON mi.id = mv.memory_id
		 WHERE mv.model = ? AND mv.rowid > ?
		 ORDER BY mv.rowid ASC
		 LIMIT ?`,
	);
	const deleteStmt = db.prepare("DELETE FROM memory_vectors WHERE rowid = ?");
	const processBatch = db.transaction((cursor: number) => {
		const rows = selectBatch.all(model, cursor, batchSize) as Array<{
			rowid: number;
			memory_id: number;
			content_hash: string | null;
			title: string | null;
			body_text: string | null;
			active: number | null;
		}>;
		const expectedByMemory = new Map<number, Set<string>>();
		const coverageByMemory = new Map<number, boolean>();
		const obsoleteRowIds: number[] = [];
		for (const row of rows) {
			if (row.active == null || row.active === 0) {
				obsoleteRowIds.push(row.rowid);
				continue;
			}
			let hasCompleteCoverage = coverageByMemory.get(row.memory_id);
			if (hasCompleteCoverage === undefined) {
				hasCompleteCoverage = memoryHasCompleteVectorCoverage(
					db,
					{ id: row.memory_id, title: row.title, body_text: row.body_text },
					model,
				);
				coverageByMemory.set(row.memory_id, hasCompleteCoverage);
			}
			if (!hasCompleteCoverage) continue;
			let expected = expectedByMemory.get(row.memory_id);
			if (!expected) {
				expected = new Set(chunkHashes(memoryText(row.title, row.body_text)));
				expectedByMemory.set(row.memory_id, expected);
			}
			if (row.content_hash == null || !expected.has(row.content_hash)) {
				obsoleteRowIds.push(row.rowid);
			}
		}
		let deletedInBatch = 0;
		for (const id of obsoleteRowIds) deletedInBatch += deleteStmt.run(id).changes;
		return {
			deleted: deletedInBatch,
			nextCursor: rows.at(-1)?.rowid ?? cursor,
			exhausted: rows.length === 0,
		};
	}).immediate;
	while (!options.signal?.aborted) {
		const batch = processBatch(afterRowId);
		deleted += batch.deleted;
		if (batch.exhausted) break;
		afterRowId = batch.nextCursor;
	}
	return deleted;
}

function toSqlStringLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function toVecF32Literal(vector: Float32Array): string {
	return `vec_f32(${toSqlStringLiteral(JSON.stringify(Array.from(vector)))})`;
}

function toSqlIntegerLiteral(value: number): string {
	if (!Number.isFinite(value)) {
		throw new TypeError(`Expected finite integer, received ${String(value)}`);
	}
	if (!Number.isInteger(value)) {
		throw new TypeError(`Expected integer, received ${String(value)}`);
	}
	return String(value);
}

function insertMemoryVector(
	db: Database,
	vector: Float32Array,
	memoryId: number,
	chunkIndex: number,
	contentHash: string,
	model: string,
): void {
	db.exec(`
		INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
		VALUES (
			${toVecF32Literal(vector)},
			${toSqlIntegerLiteral(memoryId)},
			${toSqlIntegerLiteral(chunkIndex)},
			${toSqlStringLiteral(contentHash)},
			${toSqlStringLiteral(model)}
		)
	`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillVectorsResult {
	checked: number;
	embedded: number;
	inserted: number;
	skipped: number;
}

export interface BackfillVectorsOptions {
	limit?: number | null;
	since?: string | null;
	project?: string | null;
	activeOnly?: boolean;
	dryRun?: boolean;
	memoryIds?: number[] | null;
	/**
	 * When provided, backfill stops between inference batches. The in-flight
	 * batch finishes, and any memory with only partial output remains unwritten.
	 * Used by the viewer serve shutdown sequence to bound SIGTERM latency.
	 */
	signal?: AbortSignal;
	/** Use an already-resolved client so vectors and their persisted label cannot diverge. */
	client?: EmbeddingClient;
}

export interface ReplicationVectorMaintenanceResult {
	deleted: number;
	inserted: number;
	errors: string[];
}

export type SemanticIndexState = "healthy" | "pending" | "failed" | "degraded";

export interface SemanticIndexDiagnostics {
	state: SemanticIndexState;
	summary: string;
	mode: "semantic" | "keyword_only";
	current_model: string;
	semantic_search_model: string | null;
	embeddable_memory_count: number;
	indexed_memory_count: number;
	pending_memory_count: number;
	maintenance_job: {
		status: "pending" | "running" | "failed" | "completed" | "cancelled";
		message: string | null;
		error: string | null;
		progress_current: number;
		progress_total: number | null;
	} | null;
}

export interface SemanticIndexDiagnosticsOptions {
	/**
	 * Default true — runs a single indexed COUNT(DISTINCT) join. The slow
	 * alternative does a vec0 probe per memory row, which blocks the event
	 * loop; only set to false from non-request-path tooling that needs
	 * per-chunk coverage precision.
	 */
	fastCounts?: boolean;
}

function traceSemanticDiag<T>(label: string, fn: () => T): T {
	if (process.env.CODEMEM_TRACE_SEMANTIC_DIAGNOSTICS !== "1") return fn();
	const startedAt = Date.now();
	console.warn(`[codemem semantic] ${label} start`);
	try {
		return fn();
	} finally {
		console.warn(`[codemem semantic] ${label} ${Date.now() - startedAt}ms`);
	}
}

function countEmbeddableActiveMemories(db: Database): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS c
			 FROM memory_items
			 WHERE active = 1
			   AND TRIM(COALESCE(title, '') || COALESCE(body_text, '')) != ''`,
		)
		.get() as { c?: number } | undefined;
	return Number(row?.c ?? 0);
}

/**
 * `memory_vectors` is a sqlite-vec virtual table. Querying it requires the
 * `vec0` module to be loaded into the active connection — a different
 * concern from the table merely existing in the schema. On platforms where
 * sqlite-vec failed to load (e.g. Linux ARM64 without the matching
 * platform package), the table can persist from a previous run while the
 * module is gone, so a JOIN crashes with `SQLITE_ERROR: no such module:
 * vec0`. Diagnostic counters must treat that case as "0 indexed", same as
 * the explicit `CODEMEM_EMBEDDING_DISABLED` path, instead of throwing.
 */
function isVecModuleMissingError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message ?? "";
	return /no such module:\s*vec0/i.test(message);
}

function countIndexedActiveMemories(db: Database, model: string): number {
	if (isEmbeddingDisabled() || !tableExists(db, "memory_vectors")) return 0;
	let rows: MemoryTextRow[];
	try {
		rows = db
			.prepare(
				`SELECT id, title, body_text
				 FROM memory_items
				 WHERE active = 1
				   AND TRIM(COALESCE(title, '') || COALESCE(body_text, '')) != ''
				 ORDER BY id ASC`,
			)
			.all() as MemoryTextRow[];
	} catch (error) {
		if (isVecModuleMissingError(error)) return 0;
		throw error;
	}
	try {
		return rows.filter((row) => memoryHasCompleteVectorCoverage(db, row, model)).length;
	} catch (error) {
		if (isVecModuleMissingError(error)) return 0;
		throw error;
	}
}

function countIndexedActiveMemoriesFast(db: Database, model: string): number {
	if (isEmbeddingDisabled() || !tableExists(db, "memory_vectors")) return 0;
	try {
		const row = db
			.prepare(
				`SELECT COUNT(DISTINCT mi.id) AS c
				 FROM memory_items mi
				 JOIN memory_vectors mv ON mv.memory_id = mi.id
				 WHERE mi.active = 1
				   AND mv.model = ?
				   AND TRIM(COALESCE(mi.title, '') || COALESCE(mi.body_text, '')) != ''`,
			)
			.get(model) as { c?: number } | undefined;
		return Number(row?.c ?? 0);
	} catch (error) {
		if (isVecModuleMissingError(error)) return 0;
		throw error;
	}
}

function resolvePendingMemoryCount(
	fallbackPendingCount: number,
	job: ReturnType<typeof getMaintenanceJob>,
): number {
	if (!(job?.status === "pending" || job?.status === "running" || job?.status === "failed")) {
		return fallbackPendingCount;
	}
	const metadata = job?.metadata ?? {};
	const total = Number(metadata.embeddable_total ?? job?.progress.total ?? Number.NaN);
	const processed = Number(metadata.processed_embeddable ?? job?.progress.current ?? Number.NaN);
	if (Number.isFinite(total) && Number.isFinite(processed)) {
		return Math.max(total - processed, 0);
	}
	return fallbackPendingCount;
}

function summarizeSemanticIndexState(
	state: SemanticIndexState,
	counts: { embeddable: number; indexed: number; pending: number },
	job: ReturnType<typeof getMaintenanceJob>,
	runtimeUnavailable: boolean,
): string {
	if (state === "failed") {
		return job?.error ?? job?.message ?? "Semantic-index catch-up failed";
	}
	if (state === "degraded") {
		if (isEmbeddingDisabled()) {
			return "Embeddings are disabled; sync data is available in keyword-only mode";
		}
		if (runtimeUnavailable) {
			return "The embedding runtime is unavailable; sync data is available in keyword-only mode";
		}
		return "Semantic-index coverage is unavailable; sync data is effectively running in keyword-only mode";
	}
	if (state === "pending") {
		return job?.message ?? `${counts.pending} memory(s) still need semantic indexing`;
	}
	if (counts.embeddable === 0) {
		return "No embeddable memories need semantic indexing";
	}
	return `Semantic index is current for ${counts.indexed} embeddable mem${counts.indexed === 1 ? "ory" : "ories"}`;
}

function resolveSemanticIndexState(options: {
	embeddingRevisionMissing: boolean;
	identityLabelUnresolved: boolean;
	jobStatus: NonNullable<ReturnType<typeof getMaintenanceJob>>["status"] | undefined;
	activeCatchUp: boolean;
	degraded: boolean;
	pendingMemoryCount: number;
}): SemanticIndexState {
	if (options.embeddingRevisionMissing) return "degraded";
	if (options.jobStatus === "failed") return "failed";
	if (options.identityLabelUnresolved) return "pending";
	if (options.activeCatchUp) return "pending";
	if (options.degraded) return "degraded";
	if (options.pendingMemoryCount > 0) return "pending";
	return "healthy";
}

function resolveSemanticRuntime(db: Database): {
	embeddingModel: string;
	embeddingRevision: string | null;
	currentModel: string;
	semanticSearchModel: string | null;
	embeddingsDisabled: boolean;
	runtimeUnavailable: boolean;
	embeddingRevisionMissing: boolean;
	identityLabelUnresolved: boolean;
} {
	const embeddingModel = traceSemanticDiag("resolveEmbeddingModel", () => resolveEmbeddingModel());
	const embeddingRevision = traceSemanticDiag("tryResolveEmbeddingRevision", () =>
		tryResolveEmbeddingRevision(embeddingModel),
	);
	const resolvedCurrentModel = traceSemanticDiag("tryResolveConfiguredVectorIdentityLabel", () =>
		tryResolveConfiguredVectorIdentityLabel(db),
	);
	const embeddingRevisionMissing = embeddingRevision == null;
	const identityLabelUnresolved = !embeddingRevisionMissing && resolvedCurrentModel == null;
	const currentModel =
		resolvedCurrentModel ??
		(embeddingRevision == null
			? `${embeddingModel} (missing CODEMEM_EMBEDDING_REVISION)`
			: `${embeddingModel}@${embeddingRevision} (revision unresolved)`);
	const semanticSearchModel =
		embeddingRevisionMissing || identityLabelUnresolved
			? null
			: traceSemanticDiag("resolveSemanticSearchModel", () =>
					resolveSemanticSearchModel(db, currentModel),
				);
	const embeddingsDisabled = traceSemanticDiag("isEmbeddingDisabled", () => isEmbeddingDisabled());
	const runtimeUnavailable = getEmbeddingRuntimeStatus().state === "unavailable";
	return {
		embeddingModel,
		embeddingRevision,
		currentModel,
		semanticSearchModel,
		embeddingsDisabled,
		runtimeUnavailable,
		embeddingRevisionMissing,
		identityLabelUnresolved,
	};
}

function collectSemanticIndexCounts(
	db: Database,
	currentModel: string,
	fastCounts: boolean,
): { embeddableMemoryCount: number; indexedMemoryCount: number } {
	const embeddableMemoryCount = traceSemanticDiag("countEmbeddableActiveMemories", () =>
		countEmbeddableActiveMemories(db),
	);
	const indexedMemoryCount = traceSemanticDiag(
		fastCounts ? "countIndexedActiveMemoriesFast" : "countIndexedActiveMemories",
		() =>
			fastCounts
				? countIndexedActiveMemoriesFast(db, currentModel)
				: countIndexedActiveMemories(db, currentModel),
	);
	return { embeddableMemoryCount, indexedMemoryCount };
}

export function getSemanticIndexDiagnostics(
	db: Database,
	options: SemanticIndexDiagnosticsOptions = {},
): SemanticIndexDiagnostics {
	const fastCounts = options.fastCounts !== false;
	const {
		embeddingModel,
		embeddingRevision,
		currentModel,
		semanticSearchModel,
		embeddingsDisabled,
		runtimeUnavailable,
		embeddingRevisionMissing,
		identityLabelUnresolved,
	} = resolveSemanticRuntime(db);
	let embeddableMemoryCount: number;
	let indexedMemoryCount: number;
	if (embeddingRevisionMissing || identityLabelUnresolved) {
		embeddableMemoryCount = traceSemanticDiag("countEmbeddableActiveMemories", () =>
			countEmbeddableActiveMemories(db),
		);
		indexedMemoryCount = 0;
	} else {
		({ embeddableMemoryCount, indexedMemoryCount } = collectSemanticIndexCounts(
			db,
			currentModel,
			fastCounts,
		));
	}
	const fallbackPendingCount = Math.max(embeddableMemoryCount - indexedMemoryCount, 0);
	const job = traceSemanticDiag("getMaintenanceJob", () =>
		getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB),
	);
	const pendingMemoryCount = resolvePendingMemoryCount(fallbackPendingCount, job);
	const degraded =
		embeddingRevisionMissing ||
		(embeddableMemoryCount > 0 &&
			(embeddingsDisabled || runtimeUnavailable || semanticSearchModel == null));
	const activeCatchUp = job?.status === "pending" || job?.status === "running";
	const state = resolveSemanticIndexState({
		embeddingRevisionMissing,
		identityLabelUnresolved,
		jobStatus: job?.status,
		activeCatchUp,
		degraded,
		pendingMemoryCount,
	});
	let summary: string;
	if (embeddingRevisionMissing) {
		summary = `Semantic search is unavailable because ${embeddingModel} has no CODEMEM_EMBEDDING_REVISION; keyword search remains available`;
	} else if (identityLabelUnresolved) {
		summary = `Semantic indexing is pending until ${embeddingModel}@${embeddingRevision} resolves to a canonical commit`;
	} else {
		summary = summarizeSemanticIndexState(
			state,
			{
				embeddable: embeddableMemoryCount,
				indexed: indexedMemoryCount,
				pending: pendingMemoryCount,
			},
			job,
			runtimeUnavailable,
		);
	}

	return {
		state,
		summary,
		mode:
			embeddingsDisabled || runtimeUnavailable || !semanticSearchModel
				? "keyword_only"
				: "semantic",
		current_model: currentModel,
		semantic_search_model: semanticSearchModel,
		embeddable_memory_count: embeddableMemoryCount,
		indexed_memory_count: indexedMemoryCount,
		pending_memory_count: pendingMemoryCount,
		maintenance_job: job
			? {
					status: job.status,
					message: job.message,
					error: job.error,
					progress_current: job.progress.current,
					progress_total: job.progress.total,
				}
			: null,
	};
}

function uniqueMemoryIds(memoryIds: number[]): number[] {
	return [...new Set(memoryIds.filter((memoryId) => Number.isInteger(memoryId) && memoryId > 0))];
}

function deleteVectorsForMemoryIds(db: Database, memoryIds: number[]): number {
	if (!tableExists(db, "memory_vectors") || memoryIds.length === 0) return 0;
	const placeholders = memoryIds.map(() => "?").join(", ");
	const result = db
		.prepare(`DELETE FROM memory_vectors WHERE memory_id IN (${placeholders})`)
		.run(...memoryIds);
	return result.changes;
}

/**
 * Prune stale target rows only after the memory's current target hashes are
 * complete. For the revision-aware default identity, also remove that memory's
 * compatible legacy rows so covered memories no longer rank on pre-edit content.
 */
export function pruneStaleCurrentModelVectors(
	db: Database,
	memoryIds: number[],
	model: string,
): number {
	const ids = uniqueMemoryIds(memoryIds);
	if (ids.length === 0) return 0;
	const batchSize = 250;
	const compatibleLegacyModel =
		model === DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL ? LEGACY_DEFAULT_EMBEDDING_MODEL : null;
	const selectTargetRows = db.prepare(
		"SELECT rowid, content_hash FROM memory_vectors WHERE memory_id = ? AND model = ?",
	);
	const deleteTargetRow = db.prepare("DELETE FROM memory_vectors WHERE rowid = ?");
	const deleteLegacyRows = db.prepare(
		"DELETE FROM memory_vectors WHERE memory_id = ? AND model = ?",
	);
	let deleted = 0;

	for (let offset = 0; offset < ids.length; offset += batchSize) {
		const batchIds = ids.slice(offset, offset + batchSize);
		const placeholders = batchIds.map(() => "?").join(", ");
		const pruneCoveredMemories = db.transaction(() => {
			const rows = db
				.prepare(
					`SELECT id, title, body_text FROM memory_items
					 WHERE id IN (${placeholders}) ORDER BY id ASC`,
				)
				.all(...batchIds) as MemoryTextRow[];
			let deletedInBatch = 0;
			for (const row of rows) {
				const expectedHashes = chunkHashes(memoryText(row.title, row.body_text));
				const targetRows = selectTargetRows.all(row.id, model) as Array<{
					rowid: number;
					content_hash: string | null;
				}>;
				if (!expectedHashesExist(expectedHashes, targetRows)) continue;
				const expectedHashSet = new Set(expectedHashes);
				for (const targetRow of targetRows) {
					if (targetRow.content_hash != null && expectedHashSet.has(targetRow.content_hash)) {
						continue;
					}
					deletedInBatch += deleteTargetRow.run(targetRow.rowid).changes;
				}
				if (compatibleLegacyModel) {
					deletedInBatch += deleteLegacyRows.run(row.id, compatibleLegacyModel).changes;
				}
			}
			return deletedInBatch;
		});
		deleted += pruneCoveredMemories.immediate();
	}

	return deleted;
}

/**
 * Fallback-only sync maintenance path used when durable incremental queueing
 * fails after inbound replication has already been applied. New sync code
 * should prefer queueVectorBackfillForIncrementalSync so work survives restart.
 */
export async function bestEffortMaintainVectorsForSyncFallback(
	db: Database,
	work: ReplicationVectorWork,
): Promise<ReplicationVectorMaintenanceResult> {
	const result: ReplicationVectorMaintenanceResult = { deleted: 0, inserted: 0, errors: [] };
	const deleteMemoryIds = uniqueMemoryIds(work.deleteMemoryIds);
	const upsertMemoryIds = uniqueMemoryIds(work.upsertMemoryIds);

	if (!tableExists(db, "memory_vectors")) {
		return result;
	}

	try {
		result.deleted += deleteVectorsForMemoryIds(db, deleteMemoryIds);
	} catch (error) {
		result.errors.push(
			`delete vectors failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (upsertMemoryIds.length === 0) return result;

	try {
		const client = await getEmbeddingClient();
		const backfill = await backfillVectors(db, {
			memoryIds: upsertMemoryIds,
			client: client ?? undefined,
		});
		result.inserted = backfill.inserted;
		if (backfill.checked > 0 && client) {
			result.deleted += pruneStaleCurrentModelVectors(
				db,
				upsertMemoryIds,
				resolveEmbeddingClientVectorIdentityLabel(client),
			);
		}
	} catch (error) {
		result.errors.push(
			`backfill vectors failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return result;
}

// ---------------------------------------------------------------------------
// storeVectors — called inline when a memory is created/remembered
// ---------------------------------------------------------------------------

/**
 * Embed and store vectors for a single memory item.
 * No-op when embeddings are disabled or the client is unavailable.
 */
export async function storeVectors(
	db: Database,
	memoryId: number,
	title: string,
	bodyText: string,
): Promise<void> {
	const client = await getEmbeddingClient();
	if (!client) return;

	const text = `${title}\n${bodyText}`.trim();
	const chunks = chunkText(text);
	if (chunks.length === 0) return;

	const embeddings = await embedTexts(chunks, client);
	if (embeddings.length === 0) return;

	const model = resolveEmbeddingClientVectorIdentityLabel(client);
	const insertVectors = db.transaction(
		(entries: Array<{ vector: Float32Array; chunkIndex: number; contentHash: string }>) => {
			for (const entry of entries) {
				insertMemoryVector(db, entry.vector, memoryId, entry.chunkIndex, entry.contentHash, model);
			}
		},
	);
	const entries: Array<{ vector: Float32Array; chunkIndex: number; contentHash: string }> = [];

	for (let i = 0; i < chunks.length && i < embeddings.length; i++) {
		const vector = embeddings[i];
		const chunk = chunks[i];
		if (!vector || vector.length === 0) continue;
		if (!chunk) continue;
		entries.push({ vector, chunkIndex: i, contentHash: hashText(chunk) });
	}
	if (entries.length > 0) insertVectors(entries);
}

// ---------------------------------------------------------------------------
// backfillVectors — CLI batch backfill
// ---------------------------------------------------------------------------

/**
 * Backfill vectors for memories that don't have them yet.
 * Matches Python's `backfill_vectors()` in store/vectors.py.
 */
export async function backfillVectors(
	db: Database,
	opts: BackfillVectorsOptions = {},
): Promise<BackfillVectorsResult> {
	if (opts.client) assertEmbeddingClientIdentity(opts.client);
	const client = opts.client ?? (await getEmbeddingClient());
	if (!client) return { checked: 0, embedded: 0, inserted: 0, skipped: 0 };

	const { limit, since, project, activeOnly = true, dryRun = false, memoryIds, signal } = opts;

	const params: unknown[] = [];
	const whereClauses: string[] = [];

	if (activeOnly) whereClauses.push("memory_items.active = 1");
	if (since) {
		whereClauses.push("memory_items.created_at >= ?");
		params.push(since);
	}
	if (project) {
		const pc = projectClause(project);
		if (pc.clause) {
			whereClauses.push(pc.clause);
			params.push(...pc.params);
		}
	}
	if (memoryIds && memoryIds.length > 0) {
		const placeholders = memoryIds.map(() => "?").join(",");
		whereClauses.push(`memory_items.id IN (${placeholders})`);
		params.push(...memoryIds);
	}

	const where = whereClauses.length > 0 ? whereClauses.join(" AND ") : "1=1";
	const joinSessions = project != null;
	const joinClause = joinSessions ? "JOIN sessions ON sessions.id = memory_items.session_id" : "";
	const model = resolveEmbeddingClientVectorIdentityLabel(client);
	let checked = 0;
	let embedded = 0;
	let inserted = 0;
	let skipped = 0;
	const rowLimit = limit != null && limit > 0 ? limit : Infinity;
	const candidateTable = createBackfillCandidateSnapshot(db, joinClause, where, params, rowLimit);

	try {
		const selectPage = db.prepare(
			`SELECT candidates.seq AS snapshot_seq,
			        memory_items.id, memory_items.title, memory_items.body_text
			 FROM ${candidateTable} AS candidates
			 JOIN memory_items ON memory_items.id = candidates.memory_id
			 WHERE candidates.seq > ?
			 ORDER BY candidates.seq ASC
			 LIMIT ?`,
		);
		let cursorSeq = 0;
		while (!signal?.aborted) {
			const rows = selectPage.all(cursorSeq, BACKFILL_MEMORY_PAGE_SIZE) as BackfillMemoryRow[];
			if (rows.length === 0) break;
			const lastRow = rows.at(-1) as BackfillMemoryRow;
			// This cursor lives only for this invocation. An aborted caller starts a fresh pass.
			cursorSeq = lastRow.snapshot_seq;

			const placeholders = rows.map(() => "?").join(", ");
			const existingRows = db
				.prepare(
					`SELECT memory_id, content_hash FROM memory_vectors
					 WHERE model = ? AND memory_id IN (${placeholders})`,
				)
				.all(model, ...rows.map((row) => row.id)) as Array<{
				memory_id: number;
				content_hash: string | null;
			}>;
			const existingHashesByMemory = new Map<number, Set<string>>();
			for (const existing of existingRows) {
				if (existing.content_hash == null) continue;
				const hashes = existingHashesByMemory.get(existing.memory_id) ?? new Set<string>();
				hashes.add(existing.content_hash);
				existingHashesByMemory.set(existing.memory_id, hashes);
			}

			let batch: Array<{ memory: PendingMemory; chunk: PendingChunk }> = [];
			const flushBatch = async (): Promise<void> => {
				if (batch.length === 0) return;
				const currentBatch = batch;
				batch = [];
				const embeddings = await embedTexts(
					currentBatch.map(({ chunk }) => chunk.text),
					client,
				);
				if (embeddings.length !== currentBatch.length) {
					throw new TypeError(
						`Embedding client returned ${embeddings.length} vectors for ${currentBatch.length} texts`,
					);
				}
				for (const vector of embeddings) {
					if (vector.length !== client.dimensions) {
						throw new TypeError(
							`Embedding client returned vector dimension ${vector.length}, expected ${client.dimensions}`,
						);
					}
					for (const value of vector) {
						if (!Number.isFinite(value)) {
							throw new TypeError("Embedding client returned a non-finite vector value");
						}
					}
				}
				embedded += embeddings.length;
				const completed = new Set<PendingMemory>();
				for (const [index, { memory }] of currentBatch.entries()) {
					const vector = embeddings[index];
					if (!vector) throw new TypeError("Embedding client omitted a validated vector");
					memory.vectors.push(vector);
					if (memory.vectors.length === memory.chunks.length) completed.add(memory);
				}
				for (const memory of completed) {
					const entries = memory.chunks.map((chunk, index) => ({
						...chunk,
						vector: memory.vectors[index] as Float32Array,
					}));
					if (!dryRun) {
						// The page-wide existing-hash snapshot can go stale between that
						// query and this insert when a concurrent writer (e.g. a vector
						// migration worker running alongside `codemem embed`) vectors the
						// same memory. memory_vectors is a vec0 table with no uniqueness
						// constraint, so re-read this memory's current hashes inside an
						// immediate transaction and skip any that now exist, preventing
						// permanent duplicate rows.
						const insertVectors = db.transaction(() => {
							// Only skip hashes a concurrent writer already persisted for this
							// memory (observed since the page-wide snapshot). Do not dedup
							// within this batch: distinct chunk_index rows may legitimately
							// share content, matching the pre-existing insert semantics.
							const persistedHashes = new Set(
								(
									db
										.prepare(
											"SELECT content_hash FROM memory_vectors WHERE memory_id = ? AND model = ?",
										)
										.all(memory.memoryId, model) as Array<{ content_hash: string | null }>
								)
									.map((existing) => existing.content_hash)
									.filter((hash): hash is string => hash != null),
							);
							let insertedInTx = 0;
							for (const entry of entries) {
								if (persistedHashes.has(entry.contentHash)) continue;
								insertMemoryVector(
									db,
									entry.vector,
									memory.memoryId,
									entry.chunkIndex,
									entry.contentHash,
									model,
								);
								insertedInTx++;
							}
							return insertedInTx;
						});
						inserted += insertVectors.immediate();
					} else {
						inserted += entries.length;
					}
					memory.vectors.length = 0;
					memory.chunks.length = 0;
				}
			};

			for (const row of rows) {
				if (signal?.aborted) return { checked, embedded, inserted, skipped };
				checked++;
				const chunks = chunkText(memoryText(row.title, row.body_text));
				const existingHashes = existingHashesByMemory.get(row.id) ?? new Set<string>();
				const pendingChunks: PendingChunk[] = [];
				for (const [chunkIndex, text] of chunks.entries()) {
					const contentHash = hashText(text);
					if (existingHashes.has(contentHash)) {
						skipped++;
						continue;
					}
					pendingChunks.push({ text, chunkIndex, contentHash });
				}
				if (pendingChunks.length === 0) continue;
				const memory: PendingMemory = { memoryId: row.id, chunks: pendingChunks, vectors: [] };
				for (const chunk of pendingChunks) {
					batch.push({ memory, chunk });
					if (batch.length < BACKFILL_INFERENCE_BATCH_SIZE) continue;
					await flushBatch();
					if (!signal?.aborted) continue;
					// `embedded` includes valid inference discarded for an incomplete memory;
					// `inserted` counts only memories completed by this batch (also for dry-run).
					return { checked, embedded, inserted, skipped };
				}
			}
			await flushBatch();
			if (signal?.aborted) return { checked, embedded, inserted, skipped };
		}
	} finally {
		deleteBackfillCandidateSnapshot(db, candidateTable);
	}

	if (!dryRun && (inserted > 0 || skipped > 0)) {
		persistBackfillVectorIdentity(db, client, model);
	}
	return { checked, embedded, inserted, skipped };
}

// ---------------------------------------------------------------------------
// semanticSearch — vector KNN query
// ---------------------------------------------------------------------------

export interface SemanticSearchResult {
	id: number;
	kind: string;
	title: string;
	body_text: string;
	confidence: number;
	tags_text: string;
	metadata_json: string | null;
	created_at: string;
	updated_at: string;
	session_id: number;
	score: number;
	distance: number;
	/** Structured narrative from observation (carried through from memory_items.*). */
	narrative: string | null;
	/** JSON-encoded string array of extracted facts. */
	facts: string | null;
}

/**
 * Search for memories by vector similarity using exact sqlite-vec distance.
 * Returns an empty array when embeddings are disabled or unavailable.
 *
 * Matches Python's `_semantic_search()` in store/search.py.
 */
export async function semanticSearch(
	db: Database,
	query: string,
	limit: number,
	filters: MemoryFilters | null,
	context: SemanticSearchScopeContext,
): Promise<SemanticSearchResult[]> {
	if (query.trim().length < 3) return [];
	if (!hasVectorRows(db)) return [];
	const client = await getEmbeddingClient();
	if (!client) return [];
	const searchModels = resolveSemanticSearchModels(
		db,
		resolveEmbeddingClientVectorIdentityLabel(client),
	);
	if (searchModels.length === 0) return [];
	if (!context?.deviceId?.trim()) {
		throw new Error("semantic_search_scope_context_required");
	}

	const embeddings = await embedTexts([query], client);
	if (embeddings.length === 0) return [];

	const firstEmbedding = embeddings[0];
	if (!firstEmbedding) return [];
	const queryEmbedding = serializeFloat32(firstEmbedding);
	const effectiveLimit = clampSemanticLimit(limit);
	const whereClauses: string[] = ["memory_items.active = 1"];
	const filterResult = buildFilterClausesWithContext(filters, scopeVisibleFilterContext(context));
	whereClauses.push(...filterResult.clauses);

	const where = whereClauses.join(" AND ");
	const modelPlaceholders = searchModels.map(() => "?").join(", ");
	const joinClause = filterResult.joinSessions
		? "JOIN sessions ON sessions.id = memory_items.session_id"
		: "";

	// Scope predicates must apply before vector ranking. sqlite-vec's MATCH/k
	// query ranks inside the virtual table before joined memory_items filters can
	// reliably constrain the candidate set, so use an exact distance scan over the
	// already-authorized memory rows instead of widening post-KNN candidates.
	const sql = `
		WITH scoped_vectors AS (
			SELECT
				memory_vectors.memory_id,
				MIN(vec_distance_l2(memory_vectors.embedding, ?)) AS distance
			FROM memory_vectors
			JOIN memory_items ON memory_items.id = memory_vectors.memory_id
			${joinClause}
			WHERE memory_vectors.model IN (${modelPlaceholders})
			  AND ${where}
			GROUP BY memory_vectors.memory_id
			ORDER BY distance ASC
			LIMIT ?
		)
		SELECT memory_items.*, scoped_vectors.distance
		FROM scoped_vectors
		JOIN memory_items ON memory_items.id = scoped_vectors.memory_id
		ORDER BY scoped_vectors.distance ASC
	`;

	const statement = db.prepare(sql);
	const rows = statement.all(
		queryEmbedding,
		...searchModels,
		...filterResult.params,
		effectiveLimit,
	) as Array<Record<string, unknown>>;

	return rows
		.map((row) => ({
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
		}))
		.slice(0, effectiveLimit);
}
