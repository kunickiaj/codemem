/** Exact semantic ranking inside a caller-owned, validated read snapshot. */
import { type Database, tableExists } from "../db.js";
import { DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL } from "../embeddings.js";
import type { MaintenanceJobSnapshot, MaintenanceJobStatus } from "../maintenance-jobs.js";
import {
	buildAuthorizedSemanticMemoryIdsQuery,
	resolveSemanticSearchModelFromCatalog,
	semanticResult,
} from "../semantic-query.js";
import type { MemoryFilters } from "../types.js";
import { resolveVectorLayout } from "../vector-layout.js";
import type { SemanticSearchResult, SemanticSearchScopeContext } from "../vectors.js";

export interface PreparedQuery {
	model: string;
	vectors: readonly Float32Array[];
}
export interface VectorRowInput {
	memoryId: number;
	chunkIndex: number;
	contentHash: string;
	vector: Float32Array;
}
type Rejection = "shape" | "nonfinite" | "norm" | "model";
export interface RankingRequest {
	query: PreparedQuery;
	limit: number;
	filters: MemoryFilters | null;
	context: SemanticSearchScopeContext;
	summarySessionId?: number | null;
}
interface Probe {
	model: string;
	k: number;
	returned: number;
	exhausted: boolean;
	tailDistance: number | null;
}
export interface RankingResult {
	results: SemanticSearchResult[];
	strategy: "native" | "scalar";
	probes: readonly Probe[];
	fallbackCount: number;
}
interface CandidateScope {
	sql: string;
	params: unknown[];
	acceptedSql: string;
	acceptedParams: string[];
	rowidSource: "memory_vectors" | "validated_vector_rows";
	vectorTable: "memory_vectors" | "memory_vectors_v1";
}
interface Neighbor {
	id: number;
	distance: number;
}

export function requireModel(model: string): void {
	if (typeof model !== "string" || !model.trim()) throw new TypeError("vector_model_required");
}

function vectorRejection(vector: Float32Array): Rejection | null {
	if (!(vector instanceof Float32Array) || vector.length !== 384) return "shape";
	let normSquared = 0;
	for (const component of vector) {
		if (!Number.isFinite(component)) return "nonfinite";
		normSquared += component * component;
	}
	// Normalized embeddings have norm ~1. Norm <=2 allows rounding headroom without
	// renormalization. For two accepted vectors L2 <=4, squared L2 <=16: float32-safe.
	if (normSquared > 4) return "norm";
	return null;
}

export function vectorBytes(vector: Float32Array): Buffer {
	const rejection = vectorRejection(vector);
	if (rejection) throw new TypeError(`invalid_vector_${rejection}`);
	const bytes = Buffer.alloc(384 * 4);
	vector.forEach((component, index) => {
		bytes.writeFloatLE(component, index * 4);
	});
	return bytes;
}

export function inspectBytes(bytes: Buffer): Rejection | null {
	if (!Buffer.isBuffer(bytes) || bytes.length !== 384 * 4) return "shape";
	const vector = new Float32Array(384);
	for (let index = 0; index < vector.length; index++) vector[index] = bytes.readFloatLE(index * 4);
	return vectorRejection(vector);
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

export function resolveCatalogModels(
	currentModel: string,
	catalog: Array<string | null>,
	job: Pick<MaintenanceJobSnapshot, "status" | "metadata"> | null,
): string[] {
	const primary = resolveSemanticSearchModelFromCatalog(currentModel, job, catalog);
	if (!primary) return [];
	if (
		primary === "Xenova/bge-small-en-v1.5" &&
		currentModel === DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL &&
		catalog.includes(currentModel)
	) {
		return [primary, currentModel];
	}
	return [primary];
}

function candidateScope(
	db: Database,
	request: RankingRequest,
	options: { acceptedIds: string | null; indexedRows?: boolean },
): CandidateScope {
	const authorized = buildAuthorizedSemanticMemoryIdsQuery(
		request.filters,
		{ ...request.context, visibleScopeIds: undefined, scopeVisibilityDb: db },
		request.summarySessionId,
	);
	const rowidSource = options.indexedRows ? "validated_vector_rows" : "memory_vectors";
	const layout = resolveVectorLayout(db);
	if (layout.kind === "absent") throw new Error("vector_table_required");
	const vectorTable = layout.physicalName;
	const validitySql = options.indexedRows ? "AND audit_state='valid'" : "";
	if (options.acceptedIds === null) {
		return {
			...authorized,
			acceptedSql: validitySql,
			acceptedParams: [],
			rowidSource,
			vectorTable,
		};
	}
	return {
		...authorized,
		acceptedSql: `${validitySql} AND rowid IN (SELECT value FROM json_each(?))`,
		acceptedParams: [options.acceptedIds],
		rowidSource,
		vectorTable,
	};
}

function nativeProbe(
	db: Database,
	options: { model: string; scope: CandidateScope; query: Buffer; k: number },
) {
	const { scope } = options;
	// Both constraints belong to vec0's MATCH query, not a joined postfilter.
	const rows = db
		.prepare(`WITH authorized_ids AS MATERIALIZED (${scope.sql})
		SELECT memory_id AS id, distance FROM ${scope.vectorTable}
		WHERE embedding MATCH ? AND k = ? AND model = ?
		AND rowid IN (
			SELECT rowid FROM ${scope.rowidSource}
			WHERE model = ? AND memory_id IN (SELECT id FROM authorized_ids)
			${scope.acceptedSql}
		) ORDER BY distance`)
		.all(
			...scope.params,
			options.query,
			options.k,
			options.model,
			options.model,
			...scope.acceptedParams,
		) as Neighbor[];
	for (const row of rows) {
		if (!Number.isSafeInteger(row.id) || !Number.isFinite(row.distance)) {
			throw new Error("invalid_native_neighbor");
		}
	}
	const probe: Probe = {
		model: options.model,
		k: options.k,
		returned: rows.length,
		// Exactly k returned may also exhaust a model, but proving that would
		// require counting every eligible row. Treat it as unknown instead.
		exhausted: rows.length < options.k,
		tailDistance: rows.at(-1)?.distance ?? null,
	};
	return { neighbors: rows, probe };
}

function mergeNeighbors(neighbors: Neighbor[]): Neighbor[] {
	const best = new Map<number, number>();
	for (const { id, distance } of neighbors) {
		best.set(id, Math.min(best.get(id) ?? Number.POSITIVE_INFINITY, distance));
	}
	return [...best]
		.map(([id, distance]) => ({ id, distance }))
		.sort((a, b) => a.distance - b.distance || a.id - b.id);
}

function scalarRank(
	db: Database,
	options: { scope: CandidateScope; models: string[]; query: Buffer; limit: number },
): Neighbor[] {
	const { scope } = options;
	return db
		.prepare(`WITH authorized_ids AS MATERIALIZED (${scope.sql})
		SELECT memory_id AS id, MIN(vec_distance_l2(embedding, ?)) AS distance
		FROM ${scope.vectorTable} WHERE rowid IN (
			SELECT rowid FROM ${scope.rowidSource}
			WHERE memory_id IN (SELECT id FROM authorized_ids)
			AND model IN (SELECT value FROM json_each(?)) ${scope.acceptedSql}
		)
		GROUP BY memory_id ORDER BY distance, memory_id LIMIT ?`)
		.all(
			...scope.params,
			options.query,
			JSON.stringify(options.models),
			...scope.acceptedParams,
			options.limit,
		) as Neighbor[];
}

function loadPayloads(db: Database, ranked: Neighbor[]): SemanticSearchResult[] {
	const rows = db
		.prepare("SELECT * FROM memory_items WHERE id IN (SELECT value FROM json_each(?))")
		.all(JSON.stringify(ranked.map(({ id }) => id))) as Record<string, unknown>[];
	const byId = new Map(rows.map((row) => [Number(row.id), row]));
	const results: SemanticSearchResult[] = [];
	for (const { id, distance } of ranked) {
		const row = byId.get(id);
		if (!row) continue;
		results.push(semanticResult({ ...row, distance }));
	}
	return results;
}

/** Internal engine; caller supplies validation evidence and owns the read snapshot. */
export function rankPrevalidatedSnapshot(
	db: Database,
	request: RankingRequest,
	options: { models: string[]; acceptedIds: string | null; indexedRows?: boolean },
): RankingResult {
	if (!db.inTransaction) throw new Error("ranking_snapshot_required");
	validateRankingRequest(request);
	const query = vectorBytes(request.query.vectors[0] as Float32Array);
	const scope = candidateScope(db, request, options);
	const { models } = options;
	const k = Math.min(4096, Math.max(request.limit + 1, 4 * request.limit));
	const outputs = models.map((model) =>
		nativeProbe(db, {
			model,
			scope,
			query,
			k,
		}),
	);
	const probes = outputs.map((output) => output.probe);
	const merged = mergeNeighbors(outputs.flatMap((output) => output.neighbors));
	const nth = merged[request.limit - 1]?.distance;
	const certified =
		nth !== undefined &&
		probes.every(
			(probe) => probe.exhausted || (probe.tailDistance !== null && probe.tailDistance > nth),
		);
	const ranked = certified
		? merged.slice(0, request.limit)
		: scalarRank(db, { scope, models, query, limit: request.limit });
	const results = loadPayloads(db, ranked);
	return {
		results,
		strategy: certified ? "native" : "scalar",
		probes,
		fallbackCount: certified ? 0 : 1,
	};
}

export function validateRankingRequest(request: RankingRequest): void {
	if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200) {
		throw new RangeError("semantic_limit_must_be_1_to_200");
	}
	requireModel(request.query.model);
	if (request.query.vectors.length !== 1) throw new TypeError("query_vector_count_mismatch");
	if (!request.context?.deviceId?.trim()) throw new Error("semantic_search_scope_context_required");
}
