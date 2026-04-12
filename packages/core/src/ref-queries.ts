/**
 * Indexed query functions for finding memories by file path or concept.
 *
 * These use the `memory_file_refs` and `memory_concept_refs` junction tables
 * (populated at write time) to efficiently answer questions like
 * "what decisions affected auth.ts?" and "what do we know about auth?".
 *
 * Uses raw SQL with `db.prepare()` (not Drizzle) since these are JOIN queries
 * with dynamic WHERE clauses — same pattern as search.ts.
 */

import type { Database } from "./db.js";

export interface RefQueryOptions {
	/** Filter by memory kind (e.g. "decision", "bugfix") */
	kind?: string;
	/** Filter file refs by relation type */
	relation?: "read" | "modified";
	/** Max results to return. Default 20. */
	limit?: number;
	/** Only return memories created after this ISO timestamp */
	since?: string;
}

export interface RefQueryResult {
	id: number;
	session_id: number;
	kind: string;
	title: string;
	subtitle: string | null;
	body_text: string;
	narrative: string | null;
	confidence: number;
	tags_text: string;
	created_at: string;
	updated_at: string;
	files_read: string | null;
	files_modified: string | null;
	concepts: string | null;
	metadata_json: string | null;
}

/**
 * Find memories associated with a file path via the `memory_file_refs` index.
 *
 * If `filePath` ends with `/`, it is treated as a directory prefix and matches
 * all files under that directory. Otherwise, it performs an exact match.
 */
export function findByFile(
	db: Database,
	filePath: string,
	options?: RefQueryOptions,
): RefQueryResult[] {
	const limit = options?.limit ?? 20;
	const isDir = filePath.endsWith("/");

	const clauses: string[] = ["mi.active = 1"];
	const params: unknown[] = [];

	if (isDir) {
		clauses.push("mfr.file_path LIKE ? || '%'");
		params.push(filePath);
	} else {
		clauses.push("mfr.file_path = ?");
		params.push(filePath);
	}

	if (options?.relation) {
		clauses.push("mfr.relation = ?");
		params.push(options.relation);
	}

	if (options?.kind) {
		clauses.push("mi.kind = ?");
		params.push(options.kind);
	}

	if (options?.since) {
		clauses.push("mi.created_at > ?");
		params.push(options.since);
	}

	params.push(limit);

	const sql = `
		SELECT DISTINCT mi.id, mi.session_id, mi.kind, mi.title, mi.subtitle,
			mi.body_text, mi.narrative, mi.confidence, mi.tags_text,
			mi.created_at, mi.updated_at, mi.files_read, mi.files_modified,
			mi.concepts, mi.metadata_json
		FROM memory_file_refs mfr
		JOIN memory_items mi ON mi.id = mfr.memory_id
		WHERE ${clauses.join(" AND ")}
		ORDER BY mi.created_at DESC
		LIMIT ?
	`;

	return db.prepare(sql).all(...params) as RefQueryResult[];
}

/**
 * Find memories associated with a concept via the `memory_concept_refs` index.
 *
 * The input concept is normalized to `trim().toLowerCase()` before querying,
 * matching the normalization applied at write time.
 */
export function findByConcept(
	db: Database,
	concept: string,
	options?: RefQueryOptions,
): RefQueryResult[] {
	const limit = options?.limit ?? 20;
	const normalized = concept.trim().toLowerCase();

	const clauses: string[] = ["mcr.concept = ?", "mi.active = 1"];
	const params: unknown[] = [normalized];

	if (options?.kind) {
		clauses.push("mi.kind = ?");
		params.push(options.kind);
	}

	if (options?.since) {
		clauses.push("mi.created_at > ?");
		params.push(options.since);
	}

	params.push(limit);

	const sql = `
		SELECT DISTINCT mi.id, mi.session_id, mi.kind, mi.title, mi.subtitle,
			mi.body_text, mi.narrative, mi.confidence, mi.tags_text,
			mi.created_at, mi.updated_at, mi.files_read, mi.files_modified,
			mi.concepts, mi.metadata_json
		FROM memory_concept_refs mcr
		JOIN memory_items mi ON mi.id = mcr.memory_id
		WHERE ${clauses.join(" AND ")}
		ORDER BY mi.created_at DESC
		LIMIT ?
	`;

	return db.prepare(sql).all(...params) as RefQueryResult[];
}
