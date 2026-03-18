/**
 * Vector store operations for semantic search.
 *
 * Ports codemem/store/vectors.py — backfill and on-insert vector writes
 * against the sqlite-vec `memory_vectors` virtual table.
 *
 * All functions accept a raw better-sqlite3 Database so they work outside
 * the MemoryStore class.  Embedding is async; callers await then write
 * synchronously (matches the runtime-topology decision: main thread owns DB).
 */

import type { Database } from "./db.js";
import {
	chunkText,
	embedTexts,
	getEmbeddingClient,
	hashText,
	serializeFloat32,
} from "./embeddings.js";
import { projectClause } from "./project.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillVectorsResult {
	checked: number;
	embedded: number;
	inserted: number;
	skipped: number;
}

export interface BackfillVectorsOptions {
	limit?: number | null;
	since?: string | null;
	project?: string | null;
	activeOnly?: boolean;
	dryRun?: boolean;
	memoryIds?: number[] | null;
}

// ---------------------------------------------------------------------------
// storeVectors — called inline when a memory is created/remembered
// ---------------------------------------------------------------------------

/**
 * Embed and store vectors for a single memory item.
 * No-op when embeddings are disabled or the client is unavailable.
 */
export async function storeVectors(
	db: Database,
	memoryId: number,
	title: string,
	bodyText: string,
): Promise<void> {
	const client = await getEmbeddingClient();
	if (!client) return;

	const text = `${title}\n${bodyText}`.trim();
	const chunks = chunkText(text);
	if (chunks.length === 0) return;

	const embeddings = await embedTexts(chunks);
	if (embeddings.length === 0) return;

	const model = client.model;
	const stmt = db.prepare(
		"INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model) VALUES (?, ?, ?, ?, ?)",
	);

	for (let i = 0; i < chunks.length && i < embeddings.length; i++) {
		const vector = embeddings[i];
		if (!vector || vector.length === 0) continue;
		stmt.run(serializeFloat32(vector), memoryId, i, hashText(chunks[i]!), model);
	}
}

// ---------------------------------------------------------------------------
// backfillVectors — CLI batch backfill
// ---------------------------------------------------------------------------

/**
 * Backfill vectors for memories that don't have them yet.
 * Matches Python's `backfill_vectors()` in store/vectors.py.
 */
export async function backfillVectors(
	db: Database,
	opts: BackfillVectorsOptions = {},
): Promise<BackfillVectorsResult> {
	const client = await getEmbeddingClient();
	if (!client) return { checked: 0, embedded: 0, inserted: 0, skipped: 0 };

	const { limit, since, project, activeOnly = true, dryRun = false, memoryIds } = opts;

	const params: unknown[] = [];
	const whereClauses: string[] = [];

	if (activeOnly) whereClauses.push("memory_items.active = 1");
	if (since) {
		whereClauses.push("memory_items.created_at >= ?");
		params.push(since);
	}
	if (project) {
		const pc = projectClause(project);
		if (pc.clause) {
			whereClauses.push(pc.clause);
			params.push(...pc.params);
		}
	}
	if (memoryIds && memoryIds.length > 0) {
		const placeholders = memoryIds.map(() => "?").join(",");
		whereClauses.push(`memory_items.id IN (${placeholders})`);
		params.push(...memoryIds);
	}

	const where = whereClauses.length > 0 ? whereClauses.join(" AND ") : "1=1";
	const joinSessions = project != null;
	const joinClause = joinSessions ? "JOIN sessions ON sessions.id = memory_items.session_id" : "";
	const limitClause = limit != null && limit > 0 ? "LIMIT ?" : "";
	if (limit != null && limit > 0) params.push(limit);

	const rows = db
		.prepare(
			`SELECT memory_items.id, memory_items.title, memory_items.body_text
			 FROM memory_items ${joinClause}
			 WHERE ${where}
			 ORDER BY memory_items.created_at ASC ${limitClause}`,
		)
		.all(...params) as Array<{ id: number; title: string | null; body_text: string | null }>;

	const model = client.model;
	let checked = 0;
	let embedded = 0;
	let inserted = 0;
	let skipped = 0;

	for (const row of rows) {
		checked++;
		const text = `${row.title ?? ""}\n${row.body_text ?? ""}`.trim();
		const chunks = chunkText(text);
		if (chunks.length === 0) continue;

		// Check existing hashes
		const existingRows = db
			.prepare("SELECT content_hash FROM memory_vectors WHERE memory_id = ? AND model = ?")
			.all(row.id, model) as Array<{ content_hash: string | null }>;
		const existingHashes = new Set(
			existingRows.map((r) => r.content_hash).filter((h): h is string => h != null),
		);

		const pendingChunks: string[] = [];
		const pendingHashes: string[] = [];
		for (const chunk of chunks) {
			const h = hashText(chunk);
			if (existingHashes.has(h)) {
				skipped++;
				continue;
			}
			pendingChunks.push(chunk);
			pendingHashes.push(h);
		}

		if (pendingChunks.length === 0) continue;

		const embeddings = await embedTexts(pendingChunks);
		if (embeddings.length === 0) continue;
		embedded += embeddings.length;

		if (dryRun) {
			inserted += embeddings.length;
			continue;
		}

		const stmt = db.prepare(
			"INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model) VALUES (?, ?, ?, ?, ?)",
		);
		for (let i = 0; i < embeddings.length; i++) {
			const vector = embeddings[i];
			if (!vector || vector.length === 0) continue;
			stmt.run(serializeFloat32(vector), row.id, i, pendingHashes[i], model);
			inserted++;
		}
	}

	return { checked, embedded, inserted, skipped };
}

// ---------------------------------------------------------------------------
// semanticSearch — vector KNN query
// ---------------------------------------------------------------------------

export interface SemanticSearchResult {
	id: number;
	kind: string;
	title: string;
	body_text: string;
	confidence: number;
	tags_text: string;
	metadata_json: string | null;
	created_at: string;
	updated_at: string;
	session_id: number;
	score: number;
	distance: number;
}

/**
 * Search for memories by vector similarity (KNN via sqlite-vec MATCH).
 * Returns an empty array when embeddings are disabled or unavailable.
 *
 * Matches Python's `_semantic_search()` in store/search.py.
 */
export async function semanticSearch(
	db: Database,
	query: string,
	limit = 10,
	filters?: { project?: string | null } | null,
): Promise<SemanticSearchResult[]> {
	if (query.trim().length < 3) return [];

	const embeddings = await embedTexts([query]);
	if (embeddings.length === 0) return [];

	const firstEmbedding = embeddings[0];
	if (!firstEmbedding) return [];
	const queryEmbedding = serializeFloat32(firstEmbedding);
	const params: unknown[] = [queryEmbedding, limit];
	const whereClauses: string[] = ["memory_items.active = 1"];
	let joinSessions = false;

	if (filters?.project) {
		const pc = projectClause(filters.project);
		if (pc.clause) {
			whereClauses.push(pc.clause);
			params.push(...pc.params);
			joinSessions = true;
		}
	}

	const where = whereClauses.join(" AND ");
	const joinClause = joinSessions ? "JOIN sessions ON sessions.id = memory_items.session_id" : "";

	const sql = `
		SELECT memory_items.*, memory_vectors.distance
		FROM memory_vectors
		JOIN memory_items ON memory_items.id = memory_vectors.memory_id
		${joinClause}
		WHERE memory_vectors.embedding MATCH ?
		  AND k = ?
		  AND ${where}
		ORDER BY memory_vectors.distance ASC
	`;

	const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

	return rows.map((row) => ({
		id: Number(row.id),
		kind: String(row.kind ?? "observation"),
		title: String(row.title ?? ""),
		body_text: String(row.body_text ?? ""),
		confidence: Number(row.confidence ?? 0),
		tags_text: String(row.tags_text ?? ""),
		metadata_json: row.metadata_json == null ? null : String(row.metadata_json),
		created_at: String(row.created_at ?? ""),
		updated_at: String(row.updated_at ?? ""),
		session_id: Number(row.session_id),
		score: 1.0 / (1.0 + Number(row.distance ?? 0)),
		distance: Number(row.distance ?? 0),
	}));
}
