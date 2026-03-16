/**
 * MemoryStore — TypeScript port of codemem/store/_store.py (Phase 1 CRUD).
 *
 * During Phase 1, Python owns DDL/schema. This TS runtime reads and writes data
 * but does NOT create or migrate tables. The assertSchemaReady() call verifies
 * the schema was initialized by Python before any operations.
 *
 * Methods ported: get, remember, forget, recent, recentByKinds, stats,
 * updateMemoryVisibility, close.
 *
 * NOT ported yet: pack, usage tracking, vectors, provenance resolution,
 * memory_owned_by_self check.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { Database } from "./db.js";
import {
	assertSchemaReady,
	connect,
	DEFAULT_DB_PATH,
	fromJson,
	loadSqliteVec,
	tableExists,
	toJson,
} from "./db.js";
import { buildFilterClauses } from "./filters.js";
import { buildMemoryPack } from "./pack.js";
import { explain as explainFn, search as searchFn, timeline as timelineFn } from "./search.js";
import type { MemoryFilters, MemoryItem, MemoryResult } from "./types.js";

// ---------------------------------------------------------------------------
// Memory kind validation (mirrors codemem/memory_kinds.py)
// ---------------------------------------------------------------------------

const ALLOWED_MEMORY_KINDS = new Set([
	"discovery",
	"change",
	"feature",
	"bugfix",
	"refactor",
	"decision",
	"exploration",
]);

/** Normalize and validate a memory kind. Throws on invalid kinds. */
function validateMemoryKind(kind: string): string {
	const normalized = kind.trim().toLowerCase();
	if (!ALLOWED_MEMORY_KINDS.has(normalized)) {
		throw new Error(
			`Invalid memory kind "${kind}". Allowed: ${[...ALLOWED_MEMORY_KINDS].join(", ")}`,
		);
	}
	return normalized;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ISO 8601 timestamp in UTC. */
function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Parse a row's metadata_json string into a plain object.
 * Mutates the row in place and returns it for convenience.
 */
function parseMetadata(row: Record<string, unknown>): Record<string, unknown> {
	row.metadata_json = fromJson(row.metadata_json as string | null | undefined);
	return row;
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
	readonly db: Database;
	readonly dbPath: string;
	readonly deviceId: string;

	constructor(dbPath: string = DEFAULT_DB_PATH) {
		this.dbPath = dbPath;
		this.db = connect(dbPath);
		loadSqliteVec(this.db);
		assertSchemaReady(this.db);

		const envDeviceId = process.env.CODEMEM_DEVICE_ID?.trim();
		this.deviceId = envDeviceId || randomUUID();
	}

	// -----------------------------------------------------------------------
	// get
	// -----------------------------------------------------------------------

	/**
	 * Fetch a single memory item by ID.
	 * Returns null if not found (does not filter by active status).
	 */
	get(memoryId: number): Record<string, unknown> | null {
		const row = this.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(memoryId) as
			| MemoryItem
			| undefined;
		if (!row) return null;
		return parseMetadata({ ...row });
	}

	// -----------------------------------------------------------------------
	// remember
	// -----------------------------------------------------------------------

	/**
	 * Create a new memory item. Returns the new memory ID.
	 *
	 * Validates and normalizes the kind. Sets clock_device_id and
	 * origin_device_id for replication tracing.
	 *
	 * NOT ported yet: full provenance resolution, vector storage,
	 * flush_batch dedup (tracked for follow-up).
	 */
	remember(
		sessionId: number,
		kind: string,
		title: string,
		bodyText: string,
		confidence = 0.5,
		tags?: string[],
		metadata?: Record<string, unknown>,
	): number {
		const validKind = validateMemoryKind(kind);
		const now = nowIso();
		const tagsText = tags ? [...new Set(tags)].sort().join(" ") : "";
		const metaPayload = { ...(metadata ?? {}) };

		metaPayload.clock_device_id ??= this.deviceId;
		const importKey = (metaPayload.import_key as string) || randomUUID();
		metaPayload.import_key = importKey;

		const info = this.db
			.prepare(
				`INSERT INTO memory_items(
					session_id, kind, title, body_text, confidence, tags_text,
					active, created_at, updated_at, metadata_json,
					origin_device_id, deleted_at, rev, import_key
				) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, 1, ?)`,
			)
			.run(
				sessionId,
				validKind,
				title,
				bodyText,
				confidence,
				tagsText,
				now,
				now,
				toJson(metaPayload),
				this.deviceId,
				importKey,
			);

		return Number(info.lastInsertRowid);
	}

	// -----------------------------------------------------------------------
	// forget
	// -----------------------------------------------------------------------

	/**
	 * Soft-delete a memory item (set active = 0, record deleted_at).
	 * Updates metadata_json with clock_device_id for replication tracing.
	 * No-op if the memory doesn't exist.
	 */
	forget(memoryId: number): void {
		const row = this.db
			.prepare("SELECT rev, metadata_json FROM memory_items WHERE id = ?")
			.get(memoryId) as { rev: number; metadata_json: string | null } | undefined;
		if (!row) return;

		const meta = fromJson(row.metadata_json);
		meta.clock_device_id = this.deviceId;

		const now = nowIso();
		const rev = (row.rev ?? 0) + 1;

		this.db
			.prepare(
				`UPDATE memory_items
				 SET active = 0, deleted_at = ?, updated_at = ?, metadata_json = ?, rev = ?
				 WHERE id = ?`,
			)
			.run(now, now, toJson(meta), rev, memoryId);
	}

	// -----------------------------------------------------------------------
	// recent
	// -----------------------------------------------------------------------

	/**
	 * Return recent active memories, newest first.
	 * Supports optional filters via buildFilterClauses.
	 */
	recent(limit = 10, filters?: MemoryFilters | null, offset = 0): Record<string, unknown>[] {
		const baseClauses = ["memory_items.active = 1"];
		const filterResult = buildFilterClauses(filters);
		const allClauses = [...baseClauses, ...filterResult.clauses];
		const where = allClauses.join(" AND ");

		// Note: joinSessions is set by the project filter (not yet ported).
		// Once project filtering lands, it will trigger the sessions JOIN.
		const from = filterResult.joinSessions
			? "memory_items JOIN sessions ON sessions.id = memory_items.session_id"
			: "memory_items";

		const rows = this.db
			.prepare(
				`SELECT memory_items.* FROM ${from}
				 WHERE ${where}
				 ORDER BY created_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...filterResult.params, limit, Math.max(offset, 0)) as Record<string, unknown>[];

		return rows.map((row) => parseMetadata({ ...row }));
	}

	// -----------------------------------------------------------------------
	// recentByKinds
	// -----------------------------------------------------------------------

	/**
	 * Return recent active memories filtered to specific kinds, newest first.
	 */
	recentByKinds(
		kinds: string[],
		limit = 10,
		filters?: MemoryFilters | null,
		offset = 0,
	): Record<string, unknown>[] {
		const kindsList = kinds.filter((k) => k.length > 0);
		if (kindsList.length === 0) return [];

		const kindPlaceholders = kindsList.map(() => "?").join(", ");
		const baseClauses = ["memory_items.active = 1", `memory_items.kind IN (${kindPlaceholders})`];
		const filterResult = buildFilterClauses(filters);
		const allClauses = [...baseClauses, ...filterResult.clauses];
		const where = allClauses.join(" AND ");

		const from = filterResult.joinSessions
			? "memory_items JOIN sessions ON sessions.id = memory_items.session_id"
			: "memory_items";

		const params = [...kindsList, ...filterResult.params, limit, Math.max(offset, 0)];

		const rows = this.db
			.prepare(
				`SELECT memory_items.* FROM ${from}
				 WHERE ${where}
				 ORDER BY created_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...params) as Record<string, unknown>[];

		return rows.map((row) => parseMetadata({ ...row }));
	}

	// -----------------------------------------------------------------------
	// stats
	// -----------------------------------------------------------------------

	/**
	 * Return database statistics matching the Python stats() output shape.
	 */
	stats(): Record<string, unknown> {
		const count = (sql: string): number => {
			const row = this.db.prepare(sql).get() as { c: number } | undefined;
			return row?.c ?? 0;
		};

		const totalMemories = count("SELECT COUNT(*) AS c FROM memory_items");
		const activeMemories = count("SELECT COUNT(*) AS c FROM memory_items WHERE active = 1");
		const sessions = count("SELECT COUNT(*) AS c FROM sessions");
		const artifacts = count("SELECT COUNT(*) AS c FROM artifacts");
		const rawEvents = count("SELECT COUNT(*) AS c FROM raw_events");

		let vectorCount = 0;
		if (tableExists(this.db, "memory_vectors")) {
			vectorCount = count("SELECT COUNT(*) AS c FROM memory_vectors");
		}

		let sizeBytes = 0;
		try {
			sizeBytes = statSync(this.dbPath).size;
		} catch {
			// File may not exist yet or be inaccessible
		}

		return {
			database: {
				path: this.dbPath,
				size_bytes: sizeBytes,
				sessions,
				memory_items: totalMemories,
				active_memory_items: activeMemories,
				artifacts,
				vector_rows: vectorCount,
				raw_events: rawEvents,
			},
		};
	}

	// -----------------------------------------------------------------------
	// updateMemoryVisibility
	// -----------------------------------------------------------------------

	/**
	 * Update the visibility of an active memory item.
	 * Throws if visibility is invalid, memory not found, memory is inactive,
	 * or memory is not owned by this device/actor.
	 */
	updateMemoryVisibility(memoryId: number, visibility: string): Record<string, unknown> {
		const cleaned = visibility.trim();
		if (cleaned !== "private" && cleaned !== "shared") {
			throw new Error("visibility must be private or shared");
		}

		const row = this.db
			.prepare("SELECT * FROM memory_items WHERE id = ? AND active = 1")
			.get(memoryId) as MemoryItem | undefined;
		if (!row) {
			throw new Error("memory not found");
		}

		// Ownership check: only the originating device/actor can change visibility.
		// Matches Python's memory_owned_by_self() — checks origin_device_id.
		// When actor resolution is fully ported, this should also check actor_id.
		if (row.origin_device_id && row.origin_device_id !== this.deviceId) {
			throw new Error("memory not owned by this device");
		}

		const workspaceKind = cleaned === "shared" ? "shared" : "personal";
		const workspaceId =
			cleaned === "shared" && row.workspace_id?.startsWith("shared:")
				? row.workspace_id
				: workspaceKind === "personal"
					? `personal:${this.deviceId}`
					: "shared:default";

		// Update metadata with visibility change + clock stamp
		const meta = fromJson(row.metadata_json);
		meta.visibility = cleaned;
		meta.workspace_kind = workspaceKind;
		meta.workspace_id = workspaceId;
		meta.clock_device_id = this.deviceId;

		const now = nowIso();
		const rev = (row.rev ?? 0) + 1;

		this.db
			.prepare(
				`UPDATE memory_items
				 SET visibility = ?, workspace_kind = ?, workspace_id = ?,
				     updated_at = ?, metadata_json = ?, rev = ?
				 WHERE id = ?`,
			)
			.run(cleaned, workspaceKind, workspaceId, now, toJson(meta), rev, memoryId);

		const updated = this.get(memoryId);
		if (!updated) {
			throw new Error("memory not found after update");
		}
		return updated;
	}

	// -----------------------------------------------------------------------
	// search
	// -----------------------------------------------------------------------

	/**
	 * Full-text search for memories using FTS5.
	 *
	 * Delegates to search.ts to keep the search logic decoupled.
	 * Results are ranked by BM25 score, recency, and kind bonus.
	 */
	search(query: string, limit = 10, filters?: MemoryFilters): MemoryResult[] {
		return searchFn(this, query, limit, filters);
	}

	// -----------------------------------------------------------------------
	// timeline
	// -----------------------------------------------------------------------

	/**
	 * Return a chronological window of memories around an anchor.
	 *
	 * Finds an anchor by memoryId or query, then fetches neighbors
	 * in the same session. Delegates to search.ts.
	 */
	timeline(
		query?: string | null,
		memoryId?: number | null,
		depthBefore = 3,
		depthAfter = 3,
		filters?: MemoryFilters | null,
	): Record<string, unknown>[] {
		return timelineFn(this, query, memoryId, depthBefore, depthAfter, filters);
	}

	// -----------------------------------------------------------------------
	// explain
	// -----------------------------------------------------------------------

	/**
	 * Explain search results with scoring breakdown.
	 *
	 * Returns detailed scoring components for each result, merging
	 * query-based and ID-based lookups. Delegates to search.ts.
	 */
	explain(
		query?: string | null,
		ids?: unknown[] | null,
		limit = 10,
		filters?: MemoryFilters | null,
	): Record<string, unknown> {
		return explainFn(this, query, ids, limit, filters);
	}

	// -----------------------------------------------------------------------
	// buildMemoryPack
	// -----------------------------------------------------------------------

	/**
	 * Build a formatted memory pack from search results.
	 *
	 * Categorizes memories into summary/timeline/observations sections,
	 * with optional token budgeting. Delegates to pack.ts.
	 */
	buildMemoryPack(
		context: string,
		limit?: number,
		tokenBudget?: number | null,
		filters?: MemoryFilters,
	): Record<string, unknown> {
		return buildMemoryPack(this, context, limit, tokenBudget ?? null, filters);
	}

	// -----------------------------------------------------------------------
	// close
	// -----------------------------------------------------------------------

	/** Close the database connection. */
	close(): void {
		this.db.close();
	}
}
