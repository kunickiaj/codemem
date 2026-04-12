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

import type { Database } from "./db.js";
import { isEmbeddingDisabled, tableExists } from "./db.js";
import {
	chunkText,
	embedTexts,
	getEmbeddingClient,
	hashText,
	resolveEmbeddingModel,
	serializeFloat32,
} from "./embeddings.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { projectClause } from "./project.js";
import type { ReplicationVectorWork } from "./sync-replication.js";

const VECTOR_MODEL_MIGRATION_JOB = "vector_model_migration";

type VectorModelCount = { model: string; rows: number };

type MemoryTextRow = { id: number; title: string | null; body_text: string | null };

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

export function resolveSemanticSearchModel(
	db: Database,
	currentModel = resolveEmbeddingModel(),
): string | null {
	const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
	const metadata = job?.metadata ?? {};
	const sourceModel = typeof metadata.source_model === "string" ? metadata.source_model : null;
	if (
		(job?.status === "running" || job?.status === "pending" || job?.status === "failed") &&
		sourceModel &&
		sourceModel !== currentModel
	) {
		return null;
	}
	const rows = listVectorModelCounts(db);
	if (rows.length === 0) return null;
	if (rows.some((row) => row.model === currentModel)) return currentModel;
	return null;
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
	const existingHashes = new Set(
		existingRows.map((row) => row.content_hash).filter((hash): hash is string => hash != null),
	);
	return expectedHashes.every((hash) => existingHashes.has(hash));
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

function countIndexedActiveMemories(db: Database, model: string): number {
	if (!tableExists(db, "memory_vectors")) return 0;
	const rows = db
		.prepare(
			`SELECT id, title, body_text
			 FROM memory_items
			 WHERE active = 1
			   AND TRIM(COALESCE(title, '') || COALESCE(body_text, '')) != ''
			 ORDER BY id ASC`,
		)
		.all() as MemoryTextRow[];
	return rows.filter((row) => memoryHasCompleteVectorCoverage(db, row, model)).length;
}

function countIndexedActiveMemoriesFast(db: Database, model: string): number {
	if (!tableExists(db, "memory_vectors")) return 0;
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
): string {
	if (state === "failed") {
		return job?.error ?? job?.message ?? "Semantic-index catch-up failed";
	}
	if (state === "degraded") {
		if (isEmbeddingDisabled()) {
			return "Embeddings are disabled; sync data is available in keyword-only mode";
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

export function getSemanticIndexDiagnostics(
	db: Database,
	options: SemanticIndexDiagnosticsOptions = {},
): SemanticIndexDiagnostics {
	const currentModel = traceSemanticDiag("resolveEmbeddingModel", () => resolveEmbeddingModel());
	const semanticSearchModel = traceSemanticDiag("resolveSemanticSearchModel", () =>
		resolveSemanticSearchModel(db, currentModel),
	);
	const embeddingsDisabled = traceSemanticDiag("isEmbeddingDisabled", () => isEmbeddingDisabled());
	const embeddableMemoryCount = traceSemanticDiag("countEmbeddableActiveMemories", () =>
		countEmbeddableActiveMemories(db),
	);
	const indexedMemoryCount = traceSemanticDiag(
		options.fastCounts ? "countIndexedActiveMemoriesFast" : "countIndexedActiveMemories",
		() =>
			options.fastCounts
				? countIndexedActiveMemoriesFast(db, currentModel)
				: countIndexedActiveMemories(db, currentModel),
	);
	const fallbackPendingCount = Math.max(embeddableMemoryCount - indexedMemoryCount, 0);
	const job = traceSemanticDiag("getMaintenanceJob", () =>
		getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB),
	);
	const pendingMemoryCount = resolvePendingMemoryCount(fallbackPendingCount, job);
	const degraded = embeddableMemoryCount > 0 && (embeddingsDisabled || semanticSearchModel == null);
	const activeCatchUp = job?.status === "pending" || job?.status === "running";
	const state: SemanticIndexState =
		job?.status === "failed"
			? "failed"
			: activeCatchUp
				? "pending"
				: degraded
					? "degraded"
					: pendingMemoryCount > 0
						? "pending"
						: "healthy";

	return {
		state,
		summary: summarizeSemanticIndexState(
			state,
			{
				embeddable: embeddableMemoryCount,
				indexed: indexedMemoryCount,
				pending: pendingMemoryCount,
			},
			job,
		),
		mode: embeddingsDisabled || !semanticSearchModel ? "keyword_only" : "semantic",
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

export function pruneStaleCurrentModelVectors(
	db: Database,
	memoryIds: number[],
	model: string,
): number {
	if (memoryIds.length === 0) return 0;
	const placeholders = memoryIds.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT id, title, body_text FROM memory_items WHERE id IN (${placeholders}) ORDER BY id ASC`,
		)
		.all(...memoryIds) as MemoryTextRow[];
	let deleted = 0;

	for (const row of rows) {
		const expectedHashes = chunkHashes(memoryText(row.title, row.body_text));
		if (expectedHashes.length === 0) {
			deleted += db
				.prepare("DELETE FROM memory_vectors WHERE memory_id = ? AND model = ?")
				.run(row.id, model).changes;
			continue;
		}
		const hashPlaceholders = expectedHashes.map(() => "?").join(", ");
		deleted += db
			.prepare(
				`DELETE FROM memory_vectors
				 WHERE memory_id = ?
				   AND model = ?
				   AND content_hash NOT IN (${hashPlaceholders})`,
			)
			.run(row.id, model, ...expectedHashes).changes;
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
		const backfill = await backfillVectors(db, { memoryIds: upsertMemoryIds });
		result.inserted = backfill.inserted;
		if (backfill.checked > 0) {
			result.deleted += pruneStaleCurrentModelVectors(db, upsertMemoryIds, resolveEmbeddingModel());
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

	const embeddings = await embedTexts(chunks);
	if (embeddings.length === 0) return;

	const model = client.model;
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
	const client = await getEmbeddingClient();
	if (!client) return { checked: 0, embedded: 0, inserted: 0, skipped: 0 };

	const { limit, since, project, activeOnly = true, dryRun = false, memoryIds } = opts;

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
	const limitClause = limit != null && limit > 0 ? "LIMIT ?" : "";
	if (limit != null && limit > 0) params.push(limit);

	const rows = db
		.prepare(
			`SELECT memory_items.id, memory_items.title, memory_items.body_text
			 FROM memory_items ${joinClause}
			 WHERE ${where}
			 ORDER BY memory_items.created_at ASC ${limitClause}`,
		)
		.all(...params) as Array<{ id: number; title: string | null; body_text: string | null }>;

	const model = client.model;
	let checked = 0;
	let embedded = 0;
	let inserted = 0;
	let skipped = 0;

	for (const row of rows) {
		checked++;
		const text = memoryText(row.title, row.body_text);
		const chunks = chunkText(text);
		if (chunks.length === 0) continue;

		// Check existing hashes
		const existingRows = db
			.prepare("SELECT content_hash FROM memory_vectors WHERE memory_id = ? AND model = ?")
			.all(row.id, model) as Array<{ content_hash: string | null }>;
		const existingHashes = new Set(
			existingRows.map((r) => r.content_hash).filter((h): h is string => h != null),
		);

		const pendingChunks: string[] = [];
		const pendingHashes: string[] = [];
		const pendingChunkIndexes: number[] = [];
		for (const [chunkIndex, chunk] of chunks.entries()) {
			const h = hashText(chunk);
			if (existingHashes.has(h)) {
				skipped++;
				continue;
			}
			pendingChunks.push(chunk);
			pendingHashes.push(h);
			pendingChunkIndexes.push(chunkIndex);
		}

		if (pendingChunks.length === 0) continue;

		const embeddings = await embedTexts(pendingChunks);
		if (embeddings.length === 0) continue;
		embedded += embeddings.length;

		if (dryRun) {
			inserted += embeddings.length;
			continue;
		}

		const insertVectors = db.transaction(
			(entries: Array<{ vector: Float32Array; chunkIndex: number; contentHash: string }>) => {
				for (const entry of entries) {
					insertMemoryVector(db, entry.vector, row.id, entry.chunkIndex, entry.contentHash, model);
				}
			},
		);
		const entries: Array<{ vector: Float32Array; chunkIndex: number; contentHash: string }> = [];
		for (let i = 0; i < embeddings.length; i++) {
			const vector = embeddings[i];
			const contentHash = pendingHashes[i];
			const chunkIndex = pendingChunkIndexes[i];
			if (!vector || vector.length === 0) continue;
			if (!contentHash) continue;
			if (chunkIndex == null) continue;
			entries.push({ vector, chunkIndex, contentHash });
		}
		if (entries.length > 0) {
			insertVectors(entries);
			inserted += entries.length;
		}
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
 * Search for memories by vector similarity (KNN via sqlite-vec MATCH).
 * Returns an empty array when embeddings are disabled or unavailable.
 *
 * Matches Python's `_semantic_search()` in store/search.py.
 */
export async function semanticSearch(
	db: Database,
	query: string,
	limit = 10,
	filters?: { project?: string | null } | null,
): Promise<SemanticSearchResult[]> {
	if (query.trim().length < 3) return [];
	const searchModel = resolveSemanticSearchModel(db, resolveEmbeddingModel());
	if (!searchModel) return [];

	const embeddings = await embedTexts([query]);
	if (embeddings.length === 0) return [];

	const firstEmbedding = embeddings[0];
	if (!firstEmbedding) return [];
	const queryEmbedding = serializeFloat32(firstEmbedding);
	const params: unknown[] = [queryEmbedding, limit, searchModel];
	const whereClauses: string[] = ["memory_items.active = 1"];
	let joinSessions = false;

	if (filters?.project) {
		const pc = projectClause(filters.project);
		if (pc.clause) {
			whereClauses.push(pc.clause);
			params.push(...pc.params);
			joinSessions = true;
		}
	}

	const where = whereClauses.join(" AND ");
	const joinClause = joinSessions ? "JOIN sessions ON sessions.id = memory_items.session_id" : "";

	const sql = `
		SELECT memory_items.*, memory_vectors.distance
		FROM memory_vectors
		JOIN memory_items ON memory_items.id = memory_vectors.memory_id
		${joinClause}
		WHERE memory_vectors.embedding MATCH ?
		  AND k = ?
		  AND memory_vectors.model = ?
		  AND ${where}
		ORDER BY memory_vectors.distance ASC
	`;

	const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

	return rows.map((row) => ({
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
	}));
}
