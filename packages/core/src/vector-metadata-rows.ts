import type { Database } from "./db.js";
import { resolveVectorLayout } from "./vector-layout.js";

export type VectorMetadataFilter = { memoryIds?: readonly number[]; model?: string };

export type VectorMetadataRow = {
	rowid: bigint;
	memory_id: bigint | null;
	model: string | null;
	content_hash: string | null;
};

/**
 * Whether vector metadata can be read from the indexed `validated_vector_rows`
 * table instead of scanning vec0.
 *
 * In the v1 layout that table holds exactly one row per vec0 row, with the
 * same rowid, memory_id, model, chunk_index, and content_hash:
 * - The upgrade copies legacy vectors and runs the census that fills the table
 *   from the copy in one transaction (`upgradeWithinTransaction`).
 * - Every later census (`startAudit`) deletes and refills the table from vec0
 *   in one transaction.
 * - The only vec0 insert path (`insertRow`) writes both tables, and the
 *   `memory_vectors` view rejects inserts and updates.
 * - Deletes through the view remove both rows and abort if the indexed row is
 *   missing. `removeRow` deletes both rows directly.
 * - Audits change only `audit_state` and `reason`, which callers never read.
 *
 * Legacy layouts can invalidate the index and write vec0 without it, so they
 * keep reading vec0. A layout that fails validation also keeps the vec0 read,
 * which is what every caller did before.
 *
 * As a cheap check against writes outside these paths (for example a manual
 * delete from memory_vectors_v1), the row counts must also match vec0's rowid
 * table. Both counts read b-tree pages only.
 */
export function hasIndexedVectorMetadata(db: Database): boolean {
	let layout: ReturnType<typeof resolveVectorLayout>;
	try {
		layout = resolveVectorLayout(db);
	} catch {
		return false;
	}
	if (layout.kind !== "v1") return false;
	const count = (table: string) =>
		Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
	return count("validated_vector_rows") === count(layout.rowidsName);
}

/**
 * Walk the distinct models with one index seek each. The only index on
 * `validated_vector_rows` that contains memory_id leads with model, so a
 * memory-only filter must be expanded into (model, memory_id) lookups.
 */
function indexedModels(db: Database): Array<string | null> {
	const models = db
		.prepare(
			`WITH RECURSIVE models(model) AS (
				SELECT (SELECT MIN(model) FROM validated_vector_rows)
				UNION ALL
				SELECT (SELECT MIN(model) FROM validated_vector_rows WHERE model > models.model)
				FROM models WHERE models.model IS NOT NULL
			)
			SELECT model FROM models WHERE model IS NOT NULL`,
		)
		.pluck()
		.all() as string[];
	const hasNullModel = db
		.prepare("SELECT 1 FROM validated_vector_rows WHERE model IS NULL LIMIT 1")
		.get();
	return hasNullModel ? [null, ...models] : models;
}

function* readIndexedRows(
	db: Database,
	{ memoryIds, model }: VectorMetadataFilter,
	marker: string,
): Generator<VectorMetadataRow> {
	const columns = "rowid, memory_id, model, content_hash";
	if (memoryIds === undefined) {
		const where = model === undefined ? "" : "WHERE model = ?";
		const params = model === undefined ? [] : [model];
		const select = db
			.prepare(`SELECT ${columns} FROM validated_vector_rows ${where} /* ${marker} indexed */`)
			.safeIntegers();
		yield* select.iterate(...params) as Iterable<VectorMetadataRow>;
		return;
	}
	const ids = JSON.stringify(memoryIds);
	// Resolve the model list before iterating: the connection cannot run another
	// statement while an iterator is open.
	const models = model === undefined ? indexedModels(db) : [model];
	const select = db
		.prepare(
			`SELECT ${columns} FROM validated_vector_rows
			 WHERE model IS ? AND memory_id IN (SELECT value FROM json_each(?)) /* ${marker} indexed */`,
		)
		.safeIntegers();
	for (const value of models) yield* select.iterate(value, ids) as Iterable<VectorMetadataRow>;
}

function* readVec0Rows(
	db: Database,
	{ memoryIds, model }: VectorMetadataFilter,
	marker: string,
): Generator<VectorMetadataRow> {
	// Restrict copied rows to this batch; vec0 may still scan memory IDs.
	// A JSON ID list uses one binding even when callers exceed SQLite's bind limit.
	const conditions =
		memoryIds === undefined ? [] : ["memory_id IN (SELECT value FROM json_each(?))"];
	const params: Array<string> = memoryIds === undefined ? [] : [JSON.stringify(memoryIds)];
	if (model !== undefined) {
		conditions.push("model = ?");
		params.push(model);
	}
	const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
	const select = db
		.prepare(
			`SELECT rowid, memory_id, model, content_hash FROM memory_vectors
		 ${where} /* ${marker} */`,
		)
		.safeIntegers();
	yield* select.iterate(...params) as Iterable<VectorMetadataRow>;
}

/**
 * Stream rowid, memory_id, model, and content_hash for vector rows matching
 * the filter, as bigint IDs. Uses the indexed table when the layout keeps it
 * complete and vec0 otherwise. `marker` names the caller in the SQL comment.
 */
export function readVectorMetadataRows(
	db: Database,
	filter: VectorMetadataFilter,
	marker: string,
): Iterable<VectorMetadataRow> {
	if (filter.memoryIds?.length === 0) return [];
	if (hasIndexedVectorMetadata(db)) return readIndexedRows(db, filter, marker);
	return readVec0Rows(db, filter, marker);
}
