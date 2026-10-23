/** Persisted vector writer contract and readiness-gated semantic ranking. */
import type { Database } from "../db.js";
import {
	type RankingRequest,
	type RankingResult,
	rankPrevalidatedSnapshot,
	resolveCatalogModels,
} from "./semantic-ranking.js";
import {
	type CandidateVersion,
	isSearchableVectorCatalog,
	readCandidateVersions,
	readCatalog,
	readSearchableModelLabels,
	snapshot,
} from "./validated-vector-index-state.js";

export { auditBatch, startAudit } from "./validated-vector-index-audit.js";
export {
	deleteValidatedVectors,
	type ValidatedBatch,
	writeValidatedBatch,
} from "./validated-vector-index-mutations.js";
export {
	type AuditProgress,
	type CandidateVersion,
	initializeValidatedIndex,
	invalidateValidatedIndex,
	isSearchableVectorCatalog,
	readCandidateVersions,
	readCatalog,
	readSearchableModelLabels,
	type VectorCatalog,
} from "./validated-vector-index-state.js";

export interface IndexedRanking extends RankingResult {
	generationId: string;
	revision: number;
	models: string[];
	candidateVersions: CandidateVersion[];
}

/** Reuses a caller-owned read transaction; no DDL, audit, BLOB hashes or model-catalog vec0 scan. */
export function rankValidatedIndex(db: Database, request: RankingRequest): IndexedRanking | null {
	return snapshot(db, () => {
		const catalog = readCatalog(db);
		if (!isSearchableVectorCatalog(db, catalog)) return null;
		const models = resolveCatalogModels(
			request.query.model,
			readSearchableModelLabels(db, catalog),
			catalog.migration,
		);
		if (!models.length) return null;
		const ranked = rankPrevalidatedSnapshot(db, request, {
			models,
			acceptedIds: null,
			indexedRows: true,
		});
		const candidateVersions = readCandidateVersions(db, {
			memoryIds: ranked.results.map((row) => row.id),
			models,
		});
		return {
			...ranked,
			generationId: catalog.generationId,
			revision: catalog.revision,
			models,
			candidateVersions,
		};
	});
}
