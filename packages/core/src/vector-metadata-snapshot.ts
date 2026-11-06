import SqliteDatabase from "better-sqlite3";
import type { Database } from "./db.js";
import { readVectorMetadataRows, type VectorMetadataFilter } from "./vector-metadata-rows.js";

type VectorMetadataSnapshotOptions = VectorMetadataFilter;

function copyVectorMetadata(
	db: Database,
	metadata: Database,
	options: VectorMetadataSnapshotOptions,
): void {
	if (options.memoryIds?.length === 0) return;
	const insert = metadata.prepare(
		"INSERT INTO vector_metadata(rowid, memory_id, model, content_hash) VALUES (?, ?, ?, ?)",
	);
	metadata.transaction(() => {
		for (const row of readVectorMetadataRows(db, options, "vector-metadata-snapshot")) {
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
 * Stream vector metadata once into an indexed, disposable SQLite database.
 * v1 layouts read the indexed mirror table; legacy layouts scan vec0.
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
