/**
 * Shared helpers for populating the `memory_file_refs` and
 * `memory_concept_refs` junction tables from the denormalized JSON arrays
 * stored on `memory_items` rows.
 *
 * Used at write time in `MemoryStore.remember()`, during replication apply,
 * and by the ref-backfill maintenance job.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

/**
 * Normalize a concept string for storage/lookup: trim whitespace and
 * lowercase. Shared across write, backfill, and query paths so the
 * normalization rule lives in exactly one place.
 */
export function normalizeConcept(concept: string): string {
	return concept.trim().toLowerCase();
}

/**
 * Delete all existing ref rows for a memory. Used before re-populating on
 * updates where the files/concepts may have changed.
 */
export function clearMemoryRefs(db: SqliteDatabase, memoryId: number): void {
	db.prepare("DELETE FROM memory_file_refs WHERE memory_id = ?").run(memoryId);
	db.prepare("DELETE FROM memory_concept_refs WHERE memory_id = ?").run(memoryId);
}

/**
 * Populate `memory_file_refs` and `memory_concept_refs` junction-table rows
 * for a single memory item. Uses `INSERT OR IGNORE` so calling this on an
 * already-populated memory is a safe no-op.
 *
 * Callers are responsible for running this inside a transaction when
 * atomicity with the parent insert/update is required.
 */
export function populateMemoryRefs(
	db: SqliteDatabase,
	memoryId: number,
	filesRead: string[] | null,
	filesModified: string[] | null,
	concepts: string[] | null,
): void {
	const insertFileRef = db.prepare(
		"INSERT OR IGNORE INTO memory_file_refs (memory_id, file_path, relation) VALUES (?, ?, ?)",
	);
	if (filesRead) {
		for (const path of filesRead) {
			if (path) insertFileRef.run(memoryId, path, "read");
		}
	}
	if (filesModified) {
		for (const path of filesModified) {
			if (path) insertFileRef.run(memoryId, path, "modified");
		}
	}
	const insertConceptRef = db.prepare(
		"INSERT OR IGNORE INTO memory_concept_refs (memory_id, concept) VALUES (?, ?)",
	);
	if (concepts) {
		for (const concept of concepts) {
			const normalized = normalizeConcept(concept ?? "");
			if (normalized) insertConceptRef.run(memoryId, normalized);
		}
	}
}
