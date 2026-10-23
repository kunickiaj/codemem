import SqliteDatabase from "better-sqlite3";
import type { Database } from "./db.js";

type VectorMetadataSnapshotOptions = { memoryIds?: readonly number[]; model?: string };

function copyVectorMetadata(
	db: Database,
	metadata: Database,
	{ memoryIds, model }: VectorMetadataSnapshotOptions,
): void {
	if (memoryIds?.length === 0) return;
	// Restrict copied rows to this batch; vec0 may still scan memory IDs.
	// A JSON ID list uses one binding even when callers exceed SQLite's bind limit.
	const conditions =
		memoryIds === undefined ? [] : ["memory_id IN (SELECT value FROM json_each(?))"];
	const params = memoryIds === undefined ? [] : [JSON.stringify(memoryIds)];
	if (model !== undefined) {
		conditions.push("model = ?");
		params.push(model);
	}
	const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
	const rows = db
		.prepare(
			`SELECT rowid, memory_id, model, content_hash FROM memory_vectors
		 ${where} /* vector-metadata-snapshot */`,
		)
		.safeIntegers();
	const insert = metadata.prepare(
		"INSERT INTO vector_metadata(rowid, memory_id, model, content_hash) VALUES (?, ?, ?, ?)",
	);
	metadata.transaction(() => {
		for (const row of rows.iterate(...params) as Iterable<{
			rowid: bigint;
			memory_id: bigint | null;
			model: string | null;
			content_hash: string | null;
		}>) {
			if (
				!Number.isSafeInteger(Number(row.rowid)) ||
				(row.memory_id !== null && !Number.isSafeInteger(Number(row.memory_id)))
			) {
				throw new RangeError("Vector metadata IDs exceed the exact numeric range");
			}
			insert.run(row.rowid, row.memory_id, row.model, row.content_hash);
		}
	})();
}

/**
 * Stream vec0 metadata once into an indexed, disposable SQLite database.
 *
 * A separate temporary database avoids changing the source connection's
 * temp_store (which would destroy callers' TEMP tables). Its pager can spill
 * to disk, unlike a TEMP table on our temp_store=MEMORY source connection.
 * Every invocation owns its connection, including nested operations.
 *
 * Callers own its lifetime and must close it in finally. Retaining an idle
 * catalog across cleanup yields holds no source transaction or statement open.
 * A write recheck must build it inside the source's immediate transaction.
 */
export function createVectorMetadataSnapshot(
	db: Database,
	options: VectorMetadataSnapshotOptions = {},
): Database {
	const metadata = new SqliteDatabase("");
	try {
		metadata.pragma("temp_store = FILE");
		metadata.pragma("cache_size = -1024");
		metadata.exec(`CREATE TABLE vector_metadata (
			rowid INTEGER PRIMARY KEY,
			memory_id INTEGER,
			model TEXT,
			content_hash TEXT
		)`);
		copyVectorMetadata(db, metadata, options);
		metadata.exec(
			"CREATE INDEX vector_metadata_memory_model_hash ON vector_metadata(memory_id, model, content_hash)",
		);
		return metadata;
	} catch (error) {
		metadata.close();
		throw error;
	}
}

export function withVectorMetadataSnapshot<T>(
	db: Database,
	visit: (metadata: Database) => T,
	options: VectorMetadataSnapshotOptions = {},
): T {
	const metadata = createVectorMetadataSnapshot(db, options);
	try {
		return visit(metadata);
	} finally {
		metadata.close();
	}
}
