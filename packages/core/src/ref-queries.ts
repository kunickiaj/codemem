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
import { normalizeConcept } from "./ref-populate.js";

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
	const trimmed = filePath.trim();
	if (!trimmed) return [];

	const limit = options?.limit ?? 20;
	const isDir = trimmed.endsWith("/");

	const refClauses: string[] = [];
	const refParams: unknown[] = [];

	if (isDir) {
		const escaped = trimmed.replace(/%/g, "\\%").replace(/_/g, "\\_");
		refClauses.push("mfr.file_path LIKE ? ESCAPE '\\'");
		refParams.push(`${escaped}%`);
	} else {
		refClauses.push("mfr.file_path = ?");
		refParams.push(trimmed);
	}

	if (options?.relation) {
		refClauses.push("mfr.relation = ?");
		refParams.push(options.relation);
	}

	const outerClauses: string[] = ["mi.active = 1"];
	const outerParams: unknown[] = [];

	if (options?.kind) {
		outerClauses.push("mi.kind = ?");
		outerParams.push(options.kind);
	}

	if (options?.since) {
		outerClauses.push("mi.created_at > ?");
		outerParams.push(options.since);
	}

	const params: unknown[] = [...refParams, ...outerParams, limit];

	const sql = `
		SELECT mi.id, mi.session_id, mi.kind, mi.title, mi.subtitle,
			mi.body_text, mi.narrative, mi.confidence, mi.tags_text,
			mi.created_at, mi.updated_at, mi.files_read, mi.files_modified,
			mi.concepts, mi.metadata_json
		FROM memory_items mi
		WHERE mi.id IN (
			SELECT DISTINCT mfr.memory_id
			FROM memory_file_refs mfr
			WHERE ${refClauses.join(" AND ")}
		)
		AND ${outerClauses.join(" AND ")}
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
	const normalized = normalizeConcept(concept);
	if (!normalized) return [];

	const limit = options?.limit ?? 20;

	const outerClauses: string[] = ["mi.active = 1"];
	const outerParams: unknown[] = [];

	if (options?.kind) {
		outerClauses.push("mi.kind = ?");
		outerParams.push(options.kind);
	}

	if (options?.since) {
		outerClauses.push("mi.created_at > ?");
		outerParams.push(options.since);
	}

	const params: unknown[] = [normalized, ...outerParams, limit];

	const sql = `
		SELECT mi.id, mi.session_id, mi.kind, mi.title, mi.subtitle,
			mi.body_text, mi.narrative, mi.confidence, mi.tags_text,
			mi.created_at, mi.updated_at, mi.files_read, mi.files_modified,
			mi.concepts, mi.metadata_json
		FROM memory_items mi
		WHERE mi.id IN (
			SELECT DISTINCT mcr.memory_id
			FROM memory_concept_refs mcr
			WHERE mcr.concept = ?
		)
		AND ${outerClauses.join(" AND ")}
		ORDER BY mi.created_at DESC
		LIMIT ?
	`;

	return db.prepare(sql).all(...params) as RefQueryResult[];
}
