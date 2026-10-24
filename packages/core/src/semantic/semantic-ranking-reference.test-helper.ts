/** Test-only full-corpus audit and token harness around the shipping ranking engine. */
import type { Database } from "../db.js";
import {
	inspectBytes,
	type RankingRequest as ProductionRankingRequest,
	type RankingResult,
	rankPrevalidatedSnapshot,
	readModelJob,
	requireModel,
	resolveCatalogModels,
	type VectorRowInput,
	validateRankingRequest,
	vectorBytes,
} from "./semantic-ranking.js";

declare const corpusTokenBrand: unique symbol;
export interface CorpusToken {
	readonly [corpusTokenBrand]: true;
}
export interface RankingRequest extends ProductionRankingRequest {
	token: CorpusToken;
}
export interface CorpusAudit {
	token: CorpusToken;
	scanned: number;
	accepted: number;
	rejected: readonly { rowid: number; reason: NonNullable<ReturnType<typeof inspectBytes>> }[];
}
interface Version {
	data: number;
	changes: number;
	schema: number;
}
interface Trust {
	db: Database;
	version: Version;
	acceptedIds: string | null;
	models: Array<string | null>;
	knownModels: ReadonlySet<string>;
}
const trusts = new WeakMap<CorpusToken, Trust>();

function readVersion(db: Database): Version {
	const { changes } = db.prepare("SELECT total_changes() AS changes").get() as { changes: number };
	return {
		data: Number(db.pragma("data_version", { simple: true })),
		changes,
		schema: Number(db.pragma("schema_version", { simple: true })),
	};
}

function assertVersion(db: Database, version: Version): void {
	const current = readVersion(db);
	if (
		current.data !== version.data ||
		current.changes !== version.changes ||
		current.schema !== version.schema
	) {
		throw new Error("stale_corpus_token_reaudit_required");
	}
}

function readSnapshot<T>(db: Database, read: () => T): T {
	if (db.inTransaction) throw new Error("prototype_requires_own_snapshot");
	return db.transaction(() => {
		// Pin the main database snapshot BEFORE reading data_version, not vice versa.
		db.prepare("SELECT rootpage FROM main.sqlite_schema LIMIT 1").get();
		return read();
	})();
}

/** Connection-bound proof tokens deliberately invalidate even after unrelated writes. */
export function auditCorpus(
	db: Database,
	options: { knownModels: readonly string[] },
): CorpusAudit {
	const knownModels = new Set(options.knownModels);
	for (const model of knownModels) requireModel(model);
	return readSnapshot(db, () => {
		const version = readVersion(db);
		const rejected: CorpusAudit["rejected"][number][] = [];
		const acceptedIds: number[] = [];
		const models = new Set<string | null>();
		const rows = db.prepare("SELECT rowid, embedding, model FROM memory_vectors ORDER BY rowid");
		for (const entry of rows.iterate()) {
			const row = entry as { rowid: number; embedding: Buffer; model: string | null };
			models.add(row.model);
			const reason =
				typeof row.model === "string" && knownModels.has(row.model)
					? inspectBytes(row.embedding)
					: "model";
			if (reason) {
				rejected.push({ rowid: row.rowid, reason });
				continue;
			}
			acceptedIds.push(row.rowid);
		}
		assertVersion(db, version);
		const token = Object.freeze({}) as CorpusToken;
		trusts.set(token, {
			db,
			version,
			acceptedIds: rejected.length === 0 ? null : JSON.stringify(acceptedIds),
			models: [...models],
			knownModels,
		});
		return {
			token,
			scanned: acceptedIds.length + rejected.length,
			accepted: acceptedIds.length,
			rejected,
		};
	});
}

/** Validate the entire fixture batch before starting writes. */
export function writeFixtureBatch(
	db: Database,
	batch: {
		expectedModel: string;
		model: string;
		expectedCount: number;
		rows: readonly VectorRowInput[];
	},
): void {
	requireModel(batch.model);
	if (batch.model !== batch.expectedModel) throw new TypeError("vector_model_mismatch");
	if (!Number.isSafeInteger(batch.expectedCount) || batch.expectedCount !== batch.rows.length) {
		throw new TypeError("vector_count_mismatch");
	}
	const prepared = batch.rows.map((row) => {
		if (
			!Number.isSafeInteger(row.memoryId) ||
			row.memoryId <= 0 ||
			!Number.isSafeInteger(row.chunkIndex) ||
			row.chunkIndex < 0 ||
			typeof row.contentHash !== "string" ||
			!row.contentHash
		) {
			throw new TypeError("invalid_vector_metadata");
		}
		return { ...row, bytes: vectorBytes(row.vector) };
	});
	db.transaction(() => {
		const insert = db.prepare(`INSERT INTO memory_vectors
			(embedding, memory_id, chunk_index, content_hash, model) VALUES (?, ?, ?, ?, ?)`);
		for (const row of prepared) {
			insert.run(
				row.bytes,
				BigInt(row.memoryId),
				BigInt(row.chunkIndex),
				row.contentHash,
				batch.model,
			);
		}
	})();
}

function resolveModels(
	db: Database,
	currentModel: string,
	catalog: Array<string | null>,
): string[] {
	return resolveCatalogModels(currentModel, catalog, readModelJob(db));
}

function rankSnapshot(db: Database, request: RankingRequest, trust: Trust): RankingResult {
	assertVersion(db, trust.version);
	const models = resolveModels(db, request.query.model, trust.models);
	const result = rankPrevalidatedSnapshot(db, request, { models, acceptedIds: trust.acceptedIds });
	assertVersion(db, trust.version);
	return result;
}

/** All ranking and authorization assertions exercise rankPrevalidatedSnapshot itself. */
export function rankExact(db: Database, request: RankingRequest): RankingResult {
	const trust = trusts.get(request.token);
	if (!trust || trust.db !== db) throw new TypeError("invalid_corpus_token");
	validateRankingRequest(request);
	if (!trust.knownModels.has(request.query.model)) throw new TypeError("unknown_query_model");
	vectorBytes(request.query.vectors[0] as Float32Array);
	return readSnapshot(db, () => rankSnapshot(db, request, trust));
}
