import type { Database } from "better-sqlite3";
import { readVectorCorpusFence, type VectorCorpusFence } from "./vector-corpus-epoch.js";
import { createVectorMetadataSnapshot } from "./vector-metadata-snapshot.js";
import {
	countIncompleteActiveMemoryVectorCoverage,
	pruneObsoleteTargetVectorsFromCatalog,
} from "./vectors.js";

type MutationFence = VectorCorpusFence & { dataVersion: number; totalChanges: number };

function readFence(db: Database, phase: string): MutationFence {
	return {
		...readVectorCorpusFence(db),
		dataVersion: Number(db.pragma("data_version", { simple: true })),
		totalChanges: Number(
			db.prepare(`/* vector-cutover-${phase} */ SELECT total_changes()`).pluck().get(),
		),
	};
}

type MetadataRow = {
	rowid: number;
	memory_id: number | null;
	model: string | null;
	content_hash: string | null;
};

function hasExactNumericIds(row: MetadataRow): boolean {
	return (
		Number.isSafeInteger(row.rowid) &&
		(row.memory_id === null || Number.isSafeInteger(row.memory_id))
	);
}

function compareCatalog(
	db: Database,
	metadata: Database,
	model: string,
	expectedCount: number,
): string | null {
	const deadline = performance.now() + 2000;
	const find = metadata.prepare(
		"SELECT memory_id, model, content_hash FROM vector_metadata WHERE rowid = ?",
	);
	const current = db
		.prepare(
			"SELECT rowid, memory_id, model, content_hash FROM memory_vectors /* vector-cutover-exact-metadata */",
		)
		.safeIntegers();
	let count = 0;
	for (const raw of current.iterate() as Iterable<
		Omit<MetadataRow, "rowid" | "memory_id"> & { rowid: bigint; memory_id: bigint | null }
	>) {
		if (performance.now() > deadline)
			return "Target metadata comparison exceeded 2 seconds; retrying";
		// Read every row so a native step cannot spend the whole budget skipping
		// a long run of non-target rows before control returns to JavaScript.
		if (raw.model !== model) continue;
		const row: MetadataRow = {
			...raw,
			rowid: Number(raw.rowid),
			memory_id: raw.memory_id === null ? null : Number(raw.memory_id),
		};
		if (!hasExactNumericIds(row))
			return "Target metadata IDs exceed the exact numeric range; retrying";
		const saved = find.get(row.rowid) as MetadataRow | undefined;
		if (
			!saved ||
			saved.memory_id !== row.memory_id ||
			saved.model !== row.model ||
			saved.content_hash !== row.content_hash
		)
			return "Target vector metadata changed during validation; retrying";
		count++;
	}
	if (performance.now() > deadline)
		return "Target metadata comparison exceeded 2 seconds; retrying";
	// Unique rowids + exact membership + cardinality proves equality in both directions.
	if (count !== expectedCount) return "Target vector metadata changed during validation; retrying";
	return null;
}

/**
 * Keep the catalog alive through finalization; it is NOT a source TEMP table.
 * Blob/chunk_index-only writes cannot change hash coverage and are intentionally ignored.
 */
export type VectorCutoverValidation = {
	deleted: number;
	uncovered: number;
	close: () => void;
	retryReason: () => string | null;
	corpusRetryReason: () => string | null;
	metadataRetryReason: () => string | null;
	noteOwnWrites: () => void;
};

export function prepareVectorCutoverValidation(
	db: Database,
	model: string,
	options: { signal?: AbortSignal; phase?: "cleanup-" } = {},
): VectorCutoverValidation {
	const phase = options.phase ?? "";
	const before = readFence(db, `${phase}prune-start`);
	const metadata = createVectorMetadataSnapshot(db, { model });
	try {
		const deleted = pruneObsoleteTargetVectorsFromCatalog(db, model, metadata, options);
		let afterPrune = readFence(db, `${phase}prune-end`);
		const uncovered = countIncompleteActiveMemoryVectorCoverage(db, model, { metadata });
		const expectedCount = Number(
			metadata.prepare("SELECT COUNT(*) FROM vector_metadata").pluck().get(),
		);
		const corpusRetryReason = (): string | null => {
			if (options.signal?.aborted) return "Cutover paused during shutdown; retrying";
			const current = readFence(db, "validation");
			if (current.schemaVersion !== before.schemaVersion)
				return "Database schema changed during validation; retrying";
			if (before.epoch !== null) {
				if (current.epoch !== before.epoch)
					return `Memory changes arrived during ${phase}cutover validation; retrying`;
			} else if (
				before.dataVersion !== afterPrune.dataVersion ||
				current.dataVersion !== afterPrune.dataVersion ||
				current.totalChanges !== afterPrune.totalChanges
			) {
				return `Memory changes arrived during ${phase}cutover validation; retrying`;
			}
			return null;
		};
		const metadataRetryReason = () => compareCatalog(db, metadata, model, expectedCount);
		return {
			deleted,
			uncovered,
			close: () => metadata.close(),
			// Must be called under BEGIN IMMEDIATE. Body hashing already happened above.
			retryReason: () => corpusRetryReason() ?? metadataRetryReason(),
			corpusRetryReason,
			metadataRetryReason,
			// Only immediately after our synchronous delete/job writes, before yielding.
			// Keep the original data_version: other connections still invalidate fallback.
			noteOwnWrites: () => {
				afterPrune = {
					...afterPrune,
					totalChanges: Number(db.prepare("SELECT total_changes()").pluck().get()),
				};
			},
		};
	} catch (error) {
		metadata.close();
		throw error;
	}
}
