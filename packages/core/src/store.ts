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
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import {
	assertSchemaReady,
	backupOnFirstAccess,
	connect,
	DEFAULT_DB_PATH,
	fromJson,
	loadSqliteVec,
	resolveDbPath,
	tableExists,
	toJson,
	toJsonNullable,
} from "./db.js";
import { buildFilterClauses } from "./filters.js";
import { readCodememConfigFile } from "./observer-config.js";
import { buildMemoryPack, buildMemoryPackAsync } from "./pack.js";
import * as schema from "./schema.js";
import {
	type ExplainOptions,
	explain as explainFn,
	search as searchFn,
	timeline as timelineFn,
} from "./search.js";
import { recordReplicationOp } from "./sync-replication.js";
import type {
	ExplainResponse,
	MemoryFilters,
	MemoryItem,
	MemoryItemResponse,
	MemoryResult,
	PackResponse,
	StoreStats,
	TimelineItemResponse,
} from "./types.js";

// Memory kind validation (mirrors codemem/memory_kinds.py)

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

// Helpers

/** ISO 8601 timestamp in UTC. */
function nowIso(): string {
	return new Date().toISOString();
}

/** Trim a string value, returning null for empty/non-string. Matches Python's _clean_optional_str. */
function cleanStr(value: unknown): string | null {
	if (value == null || typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseJsonList(value: unknown): string[] {
	if (typeof value !== "string" || !value.trim()) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed
					.filter((item): item is string => typeof item === "string")
					.map((item) => item.trim())
					.filter(Boolean)
			: [];
	} catch {
		return [];
	}
}

function projectBasename(value: string | null | undefined): string {
	const raw = cleanStr(value);
	if (!raw) return "";
	const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts[parts.length - 1] ?? raw;
}

const LEGACY_SYNC_ACTOR_DISPLAY_NAME = "Legacy synced peer";
const LEGACY_SHARED_WORKSPACE_ID = "shared:legacy";

/**
 * Parse a row's metadata_json string into a plain object.
 * Returns a new MemoryItemResponse with metadata_json as a parsed object.
 */
function parseMetadata(row: MemoryItem): MemoryItemResponse {
	const { metadata_json, ...rest } = row;
	return { ...rest, metadata_json: fromJson(metadata_json) };
}

// MemoryStore

export class MemoryStore {
	readonly db: Database;
	readonly dbPath: string;
	readonly deviceId: string;
	readonly actorId: string;
	readonly actorDisplayName: string;

	/** Lazy Drizzle ORM wrapper — shares the same better-sqlite3 connection. */
	private _drizzle: ReturnType<typeof drizzle> | null = null;
	private get d() {
		if (!this._drizzle) this._drizzle = drizzle(this.db, { schema });
		return this._drizzle;
	}

	constructor(dbPath: string = DEFAULT_DB_PATH) {
		this.dbPath = resolveDbPath(dbPath);
		backupOnFirstAccess(this.dbPath);
		this.db = connect(this.dbPath);
		try {
			loadSqliteVec(this.db);
			assertSchemaReady(this.db);
		} catch (err) {
			this.db.close();
			throw err;
		}

		// Resolve device ID: env var → sync_device table → stable "local" fallback.
		// Python uses exactly this order and fallback.
		const envDeviceId = process.env.CODEMEM_DEVICE_ID?.trim();
		if (envDeviceId) {
			this.deviceId = envDeviceId;
		} else {
			// Guard: sync_device may not exist in older/minimal schemas
			let dbDeviceId: string | undefined;
			try {
				const row = this.d
					.select({ device_id: schema.syncDevice.device_id })
					.from(schema.syncDevice)
					.limit(1)
					.get();
				dbDeviceId = row?.device_id;
			} catch {
				// Table doesn't exist — fall through to stable default
			}
			this.deviceId = dbDeviceId ?? "local";
		}

		// Resolve actor identity — matches Python load_config() precedence:
		// config file, then env override, then local fallbacks.
		const config = readCodememConfigFile();
		const configActorId = Object.hasOwn(process.env, "CODEMEM_ACTOR_ID")
			? cleanStr(process.env.CODEMEM_ACTOR_ID)
			: (cleanStr(config.actor_id) ?? null);
		this.actorId = configActorId || `local:${this.deviceId}`;

		const configDisplayName = Object.hasOwn(process.env, "CODEMEM_ACTOR_DISPLAY_NAME")
			? cleanStr(process.env.CODEMEM_ACTOR_DISPLAY_NAME)
			: (cleanStr(config.actor_display_name) ?? null);
		this.actorDisplayName =
			configDisplayName || process.env.USER?.trim() || process.env.USERNAME?.trim() || this.actorId;
	}

	// get

	/**
	 * Fetch a single memory item by ID.
	 * Returns null if not found (does not filter by active status).
	 */
	get(memoryId: number): MemoryItemResponse | null {
		const row = this.d
			.select()
			.from(schema.memoryItems)
			.where(eq(schema.memoryItems.id, memoryId))
			.get() as MemoryItem | undefined;
		if (!row) return null;
		return parseMetadata(row);
	}

	// startSession / endSession

	/**
	 * Create a new session row. Returns the session ID.
	 * Matches Python's store.start_session().
	 */
	startSession(opts: {
		cwd?: string;
		project?: string | null;
		gitRemote?: string | null;
		gitBranch?: string | null;
		user?: string;
		toolVersion?: string;
		metadata?: Record<string, unknown>;
	}): number {
		const now = nowIso();
		const rows = this.d
			.insert(schema.sessions)
			.values({
				started_at: now,
				cwd: opts.cwd ?? process.cwd(),
				project: opts.project ?? null,
				git_remote: opts.gitRemote ?? null,
				git_branch: opts.gitBranch ?? null,
				user: opts.user ?? process.env.USER ?? "unknown",
				tool_version: opts.toolVersion ?? "manual",
				metadata_json: toJson(opts.metadata ?? {}),
			})
			.returning({ id: schema.sessions.id })
			.all();
		const id = rows[0]?.id;
		if (id == null) throw new Error("session insert returned no id");
		return id;
	}

	/**
	 * End a session by recording ended_at.
	 * FIX: merges incoming metadata with existing instead of replacing.
	 * No-op if session doesn't exist.
	 */
	endSession(sessionId: number, metadata?: Record<string, unknown>): void {
		const now = nowIso();
		if (metadata) {
			// Read existing metadata and merge — prevents clobbering earlier fields
			const existing = this.d
				.select({ metadata_json: schema.sessions.metadata_json })
				.from(schema.sessions)
				.where(eq(schema.sessions.id, sessionId))
				.get();
			const merged = { ...fromJson(existing?.metadata_json), ...metadata };
			this.d
				.update(schema.sessions)
				.set({ ended_at: now, metadata_json: toJson(merged) })
				.where(eq(schema.sessions.id, sessionId))
				.run();
		} else {
			this.d
				.update(schema.sessions)
				.set({ ended_at: now })
				.where(eq(schema.sessions.id, sessionId))
				.run();
		}
	}

	// remember

	/**
	 * Create a new memory item. Returns the new memory ID.
	 *
	 * Validates and normalizes the kind. Resolves provenance fields (actor_id,
	 * visibility, workspace_id, trust_state) matching Python's
	 * _resolve_memory_provenance logic.
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

		// Extract dedicated columns from metadata before they get buried in metadata_json
		const subtitle = typeof metaPayload.subtitle === "string" ? metaPayload.subtitle : null;
		const narrative = typeof metaPayload.narrative === "string" ? metaPayload.narrative : null;
		const facts = Array.isArray(metaPayload.facts) ? metaPayload.facts : null;
		const concepts = Array.isArray(metaPayload.concepts) ? metaPayload.concepts : null;
		const filesRead = Array.isArray(metaPayload.files_read) ? metaPayload.files_read : null;
		const filesModified = Array.isArray(metaPayload.files_modified)
			? metaPayload.files_modified
			: null;
		const promptNumber =
			typeof metaPayload.prompt_number === "number" ? metaPayload.prompt_number : null;
		const userPromptId =
			typeof metaPayload.user_prompt_id === "number" ? metaPayload.user_prompt_id : null;

		// Resolve provenance fields
		const provenance = this.resolveProvenance(metaPayload);

		const rows = this.d
			.insert(schema.memoryItems)
			.values({
				session_id: sessionId,
				kind: validKind,
				title,
				subtitle,
				body_text: bodyText,
				confidence,
				tags_text: tagsText,
				active: 1,
				created_at: now,
				updated_at: now,
				metadata_json: toJson(metaPayload),
				actor_id: provenance.actor_id,
				actor_display_name: provenance.actor_display_name,
				visibility: provenance.visibility,
				workspace_id: provenance.workspace_id,
				workspace_kind: provenance.workspace_kind,
				origin_device_id: provenance.origin_device_id,
				origin_source: provenance.origin_source,
				trust_state: provenance.trust_state,
				narrative,
				facts: toJsonNullable(facts),
				concepts: toJsonNullable(concepts),
				files_read: toJsonNullable(filesRead),
				files_modified: toJsonNullable(filesModified),
				prompt_number: promptNumber,
				user_prompt_id: userPromptId,
				deleted_at: null,
				rev: 1,
				import_key: importKey,
			})
			.returning({ id: schema.memoryItems.id })
			.all();

		const memoryId = rows[0]?.id;
		if (memoryId == null) throw new Error("memory insert returned no id");

		// Record replication op for sync propagation
		try {
			recordReplicationOp(this.db, { memoryId, opType: "upsert", deviceId: this.deviceId });
		} catch {
			// Non-fatal — don't block memory creation
		}

		return memoryId;
	}

	// provenance resolution

	/**
	 * Resolve provenance fields for a new memory, matching Python's
	 * _resolve_memory_provenance. Uses metadata overrides when present,
	 * falls back to store-level defaults.
	 */
	private resolveProvenance(metadata: Record<string, unknown>): {
		actor_id: string | null;
		actor_display_name: string | null;
		visibility: string;
		workspace_id: string;
		workspace_kind: string;
		origin_device_id: string;
		origin_source: string | null;
		trust_state: string;
	} {
		const clean = (v: unknown): string | null => {
			if (v == null) return null;
			const s = String(v).trim();
			return s.length > 0 ? s : null;
		};

		const actorId = clean(metadata.actor_id) ?? this.actorId;
		const actorDisplayName = clean(metadata.actor_display_name) ?? this.actorDisplayName;

		const explicitWorkspaceKind = clean(metadata.workspace_kind);
		const explicitWorkspaceId = clean(metadata.workspace_id);

		// Visibility defaults to "shared" (matches Python behavior)
		let visibility = clean(metadata.visibility);
		if (!visibility || (visibility !== "private" && visibility !== "shared")) {
			if (explicitWorkspaceKind === "shared" || explicitWorkspaceId?.startsWith("shared:")) {
				visibility = "shared";
			} else {
				visibility = "shared";
			}
		}

		// Workspace kind derives from visibility
		let workspaceKind = explicitWorkspaceKind ?? "shared";
		if (workspaceKind !== "personal" && workspaceKind !== "shared") {
			workspaceKind = visibility === "shared" ? "shared" : "personal";
		} else if (visibility === "shared") {
			workspaceKind = "shared";
		} else if (visibility === "private") {
			workspaceKind = "personal";
		}

		// Workspace ID with fallback — matches Python's _default_workspace_id
		const workspaceId =
			explicitWorkspaceId ??
			(workspaceKind === "personal" ? `personal:${actorId}` : "shared:default");

		const originDeviceId = clean(metadata.origin_device_id) ?? this.deviceId;
		const originSource = clean(metadata.origin_source) ?? clean(metadata.source) ?? null;
		const trustState = clean(metadata.trust_state) ?? "trusted";

		return {
			actor_id: actorId,
			actor_display_name: actorDisplayName,
			visibility,
			workspace_id: workspaceId,
			workspace_kind: workspaceKind,
			origin_device_id: originDeviceId,
			origin_source: originSource,
			trust_state: trustState,
		};
	}

	// ownership check

	/**
	 * Check if a memory item is owned by this actor/device.
	 * Port of Python's memory_owned_by_self().
	 *
	 * Python checks:
	 * 1. actor_id == self.actor_id → owned
	 * 2. origin_device_id in claimed_same_actor_peers → owned
	 * 3. actor_id in legacy sync actor ids → owned
	 *
	 * Simplified: check actor_id first, then origin_device_id.
	 * Peer claim/legacy checks deferred until sync parity is needed.
	 */
	memoryOwnedBySelf(item: MemoryItem | MemoryResult | Record<string, unknown>): boolean {
		const rec = item as Record<string, unknown>;
		// Check top-level columns first (MemoryItem / DB row),
		// then metadata dict (MemoryResult from search populates provenance there).
		const meta = (rec.metadata ?? {}) as Record<string, unknown>;

		const actorId = cleanStr(rec.actor_id) ?? cleanStr(meta.actor_id);
		if (actorId === this.actorId) return true;

		const deviceId = cleanStr(rec.origin_device_id) ?? cleanStr(meta.origin_device_id);
		if (deviceId === this.deviceId) return true;

		return false;
	}

	// forget

	/**
	 * Soft-delete a memory item (set active = 0, record deleted_at).
	 * Updates metadata_json with clock_device_id for replication tracing.
	 * No-op if the memory doesn't exist.
	 */
	forget(memoryId: number): void {
		this.db
			.transaction(() => {
				const row = this.d
					.select({
						rev: schema.memoryItems.rev,
						metadata_json: schema.memoryItems.metadata_json,
					})
					.from(schema.memoryItems)
					.where(eq(schema.memoryItems.id, memoryId))
					.get();
				if (!row) return;

				const meta = fromJson(row.metadata_json);
				meta.clock_device_id = this.deviceId;

				const now = nowIso();
				const rev = (row.rev ?? 0) + 1;

				this.d
					.update(schema.memoryItems)
					.set({
						active: 0,
						deleted_at: now,
						updated_at: now,
						metadata_json: toJson(meta),
						rev,
					})
					.where(eq(schema.memoryItems.id, memoryId))
					.run();

				try {
					recordReplicationOp(this.db, { memoryId, opType: "delete", deviceId: this.deviceId });
				} catch {
					// Non-fatal
				}
			})
			.immediate();
	}

	// recent

	/**
	 * Return recent active memories, newest first.
	 * Supports optional filters via buildFilterClauses.
	 */
	recent(limit = 10, filters?: MemoryFilters | null, offset = 0): MemoryItemResponse[] {
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
			.all(...filterResult.params, limit, Math.max(offset, 0)) as MemoryItem[];

		return rows.map((row) => parseMetadata(row));
	}

	// recentByKinds

	/**
	 * Return recent active memories filtered to specific kinds, newest first.
	 */
	recentByKinds(
		kinds: string[],
		limit = 10,
		filters?: MemoryFilters | null,
		offset = 0,
	): MemoryItemResponse[] {
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
			.all(...params) as MemoryItem[];

		return rows.map((row) => parseMetadata(row));
	}

	// stats

	/**
	 * Return database statistics matching the Python stats() output shape.
	 */
	stats(): StoreStats {
		// biome-ignore lint/suspicious/noExplicitAny: Drizzle table union type is unwieldy
		const countRows = (tbl: any) =>
			this.d.select({ c: sql<number>`COUNT(*)` }).from(tbl).get()?.c ?? 0;

		const totalMemories = countRows(schema.memoryItems);
		const activeMemories =
			this.d
				.select({ c: sql<number>`COUNT(*)` })
				.from(schema.memoryItems)
				.where(eq(schema.memoryItems.active, 1))
				.get()?.c ?? 0;
		const sessions = countRows(schema.sessions);
		const artifacts = countRows(schema.artifacts);
		const rawEvents = countRows(schema.rawEvents);

		let vectorCount = 0;
		if (tableExists(this.db, "memory_vectors")) {
			const row = this.db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get() as
				| { c: number }
				| undefined;
			vectorCount = row?.c ?? 0;
		}
		const vectorCoverage = activeMemories > 0 ? Math.min(1, vectorCount / activeMemories) : 0;

		const tagsFilled =
			this.d
				.select({ c: sql<number>`COUNT(*)` })
				.from(schema.memoryItems)
				.where(and(eq(schema.memoryItems.active, 1), sql`TRIM(tags_text) != ''`))
				.get()?.c ?? 0;
		const tagsCoverage = activeMemories > 0 ? Math.min(1, tagsFilled / activeMemories) : 0;

		let sizeBytes = 0;
		try {
			sizeBytes = statSync(this.dbPath).size;
		} catch {
			// File may not exist yet or be inaccessible
		}

		// Usage stats
		const usageRows = this.d
			.select({
				event: schema.usageEvents.event,
				count: sql<number>`COUNT(*)`,
				tokens_read: sql<number | null>`SUM(tokens_read)`,
				tokens_written: sql<number | null>`SUM(tokens_written)`,
				tokens_saved: sql<number | null>`SUM(COALESCE(tokens_saved, 0))`,
			})
			.from(schema.usageEvents)
			.groupBy(schema.usageEvents.event)
			.orderBy(desc(sql`COUNT(*)`))
			.all();

		const usageEvents = usageRows.map((r) => ({
			event: r.event,
			count: r.count,
			tokens_read: r.tokens_read ?? 0,
			tokens_written: r.tokens_written ?? 0,
			tokens_saved: r.tokens_saved ?? 0,
		}));

		const totalEvents = usageEvents.reduce((s, e) => s + e.count, 0);
		const totalTokensRead = usageEvents.reduce((s, e) => s + e.tokens_read, 0);
		const totalTokensWritten = usageEvents.reduce((s, e) => s + e.tokens_written, 0);
		const totalTokensSaved = usageEvents.reduce((s, e) => s + e.tokens_saved, 0);

		return {
			identity: {
				device_id: this.deviceId,
				actor_id: this.actorId,
				actor_display_name: this.actorDisplayName,
			},
			database: {
				path: this.dbPath,
				size_bytes: sizeBytes,
				sessions,
				memory_items: totalMemories,
				active_memory_items: activeMemories,
				artifacts,
				vector_rows: vectorCount,
				vector_coverage: vectorCoverage,
				tags_filled: tagsFilled,
				tags_coverage: tagsCoverage,
				raw_events: rawEvents,
			},
			usage: {
				events: usageEvents,
				totals: {
					events: totalEvents,
					tokens_read: totalTokensRead,
					tokens_written: totalTokensWritten,
					tokens_saved: totalTokensSaved,
				},
			},
		};
	}

	// updateMemoryVisibility

	/**
	 * Update the visibility of an active memory item.
	 * Throws if visibility is invalid, memory not found, memory is inactive,
	 * or memory is not owned by this device/actor.
	 */
	updateMemoryVisibility(memoryId: number, visibility: string): MemoryItemResponse {
		const cleaned = visibility.trim();
		if (cleaned !== "private" && cleaned !== "shared") {
			throw new Error("visibility must be private or shared");
		}

		return this.db
			.transaction(() => {
				const row = this.d
					.select()
					.from(schema.memoryItems)
					.where(and(eq(schema.memoryItems.id, memoryId), eq(schema.memoryItems.active, 1)))
					.get() as MemoryItem | undefined;
				if (!row) {
					throw new Error("memory not found");
				}

				if (!this.memoryOwnedBySelf(row)) {
					throw new Error("memory not owned by this device");
				}

				const rowActorId = cleanStr(row.actor_id) ?? this.actorId;
				const workspaceKind = cleaned === "shared" ? "shared" : "personal";
				const workspaceId =
					cleaned === "shared" && row.workspace_id?.startsWith("shared:")
						? row.workspace_id
						: workspaceKind === "personal"
							? `personal:${rowActorId}`
							: "shared:default";

				const meta = fromJson(row.metadata_json);
				meta.visibility = cleaned;
				meta.workspace_kind = workspaceKind;
				meta.workspace_id = workspaceId;
				meta.clock_device_id = this.deviceId;

				const now = nowIso();
				const rev = (row.rev ?? 0) + 1;

				this.d
					.update(schema.memoryItems)
					.set({
						visibility: cleaned,
						workspace_kind: workspaceKind,
						workspace_id: workspaceId,
						updated_at: now,
						metadata_json: toJson(meta),
						rev,
					})
					.where(eq(schema.memoryItems.id, memoryId))
					.run();

				try {
					recordReplicationOp(this.db, {
						memoryId,
						opType: "upsert",
						deviceId: this.deviceId,
					});
				} catch {
					// Non-fatal
				}

				const updated = this.get(memoryId);
				if (!updated) {
					throw new Error("memory not found after update");
				}
				return updated;
			})
			.immediate();
	}

	// search

	/**
	 * Full-text search for memories using FTS5.
	 *
	 * Delegates to search.ts to keep the search logic decoupled.
	 * Results are ranked by BM25 score, recency, and kind bonus.
	 */
	search(query: string, limit = 10, filters?: MemoryFilters): MemoryResult[] {
		return searchFn(this, query, limit, filters);
	}

	// timeline

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
	): TimelineItemResponse[] {
		return timelineFn(this, query, memoryId, depthBefore, depthAfter, filters);
	}

	// explain

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
		options?: ExplainOptions,
	): ExplainResponse {
		return explainFn(this, query, ids, limit, filters, options);
	}

	// buildMemoryPack

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
	): PackResponse {
		return buildMemoryPack(this, context, limit, tokenBudget ?? null, filters);
	}

	/**
	 * Build a memory pack with semantic candidate merging.
	 *
	 * Async version that runs vector KNN search via sqlite-vec and merges
	 * semantic candidates with FTS results.  Falls back to FTS-only when
	 * embeddings are disabled or unavailable.
	 */
	async buildMemoryPackAsync(
		context: string,
		limit?: number,
		tokenBudget?: number | null,
		filters?: MemoryFilters,
	): Promise<PackResponse> {
		return buildMemoryPackAsync(this, context, limit, tokenBudget ?? null, filters);
	}

	// Raw event helpers

	/**
	 * Normalize source/streamId to match Python's _normalize_stream_identity().
	 * Trims whitespace, lowercases source, defaults to "opencode".
	 */
	private normalizeStreamIdentity(source: string, streamId: string): [string, string] {
		const s = source.trim().toLowerCase() || "opencode";
		const sid = streamId.trim();
		if (!sid) throw new Error("stream_id is required");
		return [s, sid];
	}

	// Raw event query methods (ports from codemem/store/raw_events.py)

	/**
	 * Find sessions that have unflushed events and have been idle long enough.
	 * Port of raw_event_sessions_pending_idle_flush().
	 */
	rawEventSessionsPendingIdleFlush(
		idleBeforeTsWallMs: number,
		limit = 25,
	): { source: string; streamId: string }[] {
		const rows = this.db
			.prepare(
				`WITH max_events AS (
            SELECT source, stream_id, MAX(event_seq) AS max_seq
            FROM raw_events
            GROUP BY source, stream_id
        )
        SELECT s.source, s.stream_id
        FROM raw_event_sessions s
        JOIN max_events e ON e.source = s.source AND e.stream_id = s.stream_id
        WHERE s.last_seen_ts_wall_ms IS NOT NULL
          AND s.last_seen_ts_wall_ms <= ?
          AND e.max_seq > s.last_flushed_event_seq
        ORDER BY s.last_seen_ts_wall_ms ASC
        LIMIT ?`,
			)
			.all(idleBeforeTsWallMs, limit) as { source: string | null; stream_id: string | null }[];

		return rows
			.filter((row) => row.stream_id)
			.map((row) => ({
				source: String(row.source ?? "opencode"),
				streamId: String(row.stream_id ?? ""),
			}));
	}

	/**
	 * Find sessions that have pending/failed flush batches with unflushed events.
	 * Port of raw_event_sessions_with_pending_queue().
	 */
	rawEventSessionsWithPendingQueue(limit = 25): { source: string; streamId: string }[] {
		const rows = this.db
			.prepare(
				`WITH pending_batches AS (
            SELECT b.source, b.stream_id, MIN(b.updated_at) AS oldest_pending_update
            FROM raw_event_flush_batches b
            WHERE b.status IN ('pending', 'failed', 'started', 'error')
            GROUP BY b.source, b.stream_id
        ),
        max_events AS (
            SELECT source, stream_id, MAX(event_seq) AS max_seq
            FROM raw_events
            GROUP BY source, stream_id
        )
        SELECT b.source, b.stream_id
        FROM pending_batches b
        JOIN max_events e ON e.source = b.source AND e.stream_id = b.stream_id
        LEFT JOIN raw_event_sessions s ON s.source = b.source AND s.stream_id = b.stream_id
        WHERE e.max_seq > COALESCE(s.last_flushed_event_seq, -1)
        ORDER BY b.oldest_pending_update ASC
        LIMIT ?`,
			)
			.all(limit) as { source: string | null; stream_id: string | null }[];

		return rows
			.filter((row) => row.stream_id)
			.map((row) => ({
				source: String(row.source ?? "opencode"),
				streamId: String(row.stream_id ?? ""),
			}));
	}

	/**
	 * Delete raw events older than max_age_ms. Returns count of deleted raw_events rows.
	 * Port of purge_raw_events() + purge_raw_events_before().
	 */
	purgeRawEvents(maxAgeMs: number): number {
		if (maxAgeMs <= 0) return 0;
		const nowMs = Date.now();
		const cutoffTsWallMs = nowMs - maxAgeMs;
		const cutoffIso = new Date(cutoffTsWallMs).toISOString();

		return this.db.transaction(() => {
			this.d
				.delete(schema.rawEventIngestSamples)
				.where(sql`${schema.rawEventIngestSamples.created_at} < ${cutoffIso}`)
				.run();
			// Use raw SQL for DELETE to access result.changes
			const result = this.db
				.prepare("DELETE FROM raw_events WHERE ts_wall_ms IS NOT NULL AND ts_wall_ms < ?")
				.run(cutoffTsWallMs);
			return result.changes;
		})();
	}

	/**
	 * Mark stuck flush batches (started/running/pending/claimed) as failed.
	 * Port of mark_stuck_raw_event_batches_as_error().
	 */
	markStuckRawEventBatchesAsError(olderThanIso: string, limit = 100): number {
		const now = new Date().toISOString();
		const result = this.db
			.prepare(
				`WITH candidates AS (
            SELECT id
            FROM raw_event_flush_batches
            WHERE status IN ('started', 'running', ?, ?) AND updated_at < ?
            ORDER BY updated_at
            LIMIT ?
        )
        UPDATE raw_event_flush_batches
        SET status = ?,
            updated_at = ?,
            error_message = 'Flush retry timed out.',
            error_type = 'RawEventBatchStuck',
            observer_provider = NULL,
            observer_model = NULL,
            observer_runtime = NULL
        WHERE id IN (SELECT id FROM candidates)`,
			)
			.run(
				"pending", // RAW_EVENT_QUEUE_PENDING
				"claimed", // RAW_EVENT_QUEUE_CLAIMED
				olderThanIso,
				limit,
				"failed", // RAW_EVENT_QUEUE_FAILED
				now,
			);

		return result.changes;
	}

	// Raw event per-session methods (ports for flush pipeline)

	/**
	 * Get session metadata (cwd, project, started_at, etc.) for a raw event stream.
	 * Port of raw_event_session_meta().
	 */
	rawEventSessionMeta(opencodeSessionId: string, source = "opencode"): Record<string, unknown> {
		const [s, sid] = this.normalizeStreamIdentity(source, opencodeSessionId);
		const row = this.d
			.select({
				cwd: schema.rawEventSessions.cwd,
				project: schema.rawEventSessions.project,
				started_at: schema.rawEventSessions.started_at,
				last_seen_ts_wall_ms: schema.rawEventSessions.last_seen_ts_wall_ms,
				last_flushed_event_seq: schema.rawEventSessions.last_flushed_event_seq,
			})
			.from(schema.rawEventSessions)
			.where(and(eq(schema.rawEventSessions.source, s), eq(schema.rawEventSessions.stream_id, sid)))
			.get();
		if (!row) return {};
		return {
			cwd: row.cwd,
			project: row.project,
			started_at: row.started_at,
			last_seen_ts_wall_ms: row.last_seen_ts_wall_ms,
			last_flushed_event_seq: row.last_flushed_event_seq,
		};
	}

	/**
	 * Get the last flushed event_seq for a session. Returns -1 if no state.
	 * Port of raw_event_flush_state().
	 */
	rawEventFlushState(opencodeSessionId: string, source = "opencode"): number {
		const [s, sid] = this.normalizeStreamIdentity(source, opencodeSessionId);
		const row = this.d
			.select({ last_flushed_event_seq: schema.rawEventSessions.last_flushed_event_seq })
			.from(schema.rawEventSessions)
			.where(and(eq(schema.rawEventSessions.source, s), eq(schema.rawEventSessions.stream_id, sid)))
			.get();
		if (!row) return -1;
		return Number(row.last_flushed_event_seq);
	}

	/**
	 * Get raw events after a given event_seq, ordered by event_seq ASC.
	 * Returns enriched event objects with type, timestamps, event_seq, event_id.
	 * Port of raw_events_since_by_seq().
	 */
	rawEventsSinceBySeq(
		opencodeSessionId: string,
		source = "opencode",
		afterEventSeq = -1,
		limit?: number | null,
	): Record<string, unknown>[] {
		const [s, sid] = this.normalizeStreamIdentity(source, opencodeSessionId);
		const limitClause = limit != null && limit > 0 ? "LIMIT ?" : "";
		const params: unknown[] = [s, sid, afterEventSeq];
		if (limit != null && limit > 0) params.push(limit);

		const rows = this.db
			.prepare(
				`SELECT event_seq, event_type, ts_wall_ms, ts_mono_ms, payload_json, event_id
				 FROM raw_events
				 WHERE source = ? AND stream_id = ? AND event_seq > ?
				 ORDER BY event_seq ASC
				 ${limitClause}`,
			)
			.all(...params) as {
			event_seq: number;
			event_type: string;
			ts_wall_ms: number | null;
			ts_mono_ms: number | null;
			payload_json: string | null;
			event_id: string | null;
		}[];

		return rows.map((row) => {
			const payload = fromJson(row.payload_json) as Record<string, unknown>;
			// Use || (not ??) to match Python's `or` semantics — empty string falls through
			payload.type = payload.type || row.event_type;
			payload.timestamp_wall_ms = row.ts_wall_ms;
			payload.timestamp_mono_ms = row.ts_mono_ms;
			payload.event_seq = row.event_seq;
			payload.event_id = row.event_id;
			return payload;
		});
	}

	/**
	 * Get or create a flush batch record. Returns [batchId, status].
	 * Port of get_or_create_raw_event_flush_batch().
	 */
	getOrCreateRawEventFlushBatch(
		opencodeSessionId: string,
		source: string,
		startEventSeq: number,
		endEventSeq: number,
		extractorVersion: string,
	): { batchId: number; status: string } {
		const [s, sid] = this.normalizeStreamIdentity(source, opencodeSessionId);
		const now = new Date().toISOString();

		// Atomic UPSERT to avoid SELECT+INSERT races. We intentionally do NOT
		// heartbeat claimed/running batches: their updated_at stays unchanged so
		// stuck-batch recovery can still age them out.
		const row = this.db
			.prepare(
				`INSERT INTO raw_event_flush_batches(
					source, stream_id, opencode_session_id,
					start_event_seq, end_event_seq, extractor_version,
					status, created_at, updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
				ON CONFLICT(source, stream_id, start_event_seq, end_event_seq, extractor_version)
				DO UPDATE SET
					updated_at = CASE
						WHEN raw_event_flush_batches.status IN ('claimed', 'running')
						THEN raw_event_flush_batches.updated_at
						ELSE excluded.updated_at
					END
				RETURNING id, status`,
			)
			.get(s, sid, sid, startEventSeq, endEventSeq, extractorVersion, now, now) as
			| { id: number; status: string }
			| undefined;

		if (!row) throw new Error("Failed to create flush batch");
		// Canonicalize legacy DB statuses to match Python's _RAW_EVENT_QUEUE_DB_TO_CANONICAL
		const rawStatus = String(row.status);
		const canonicalStatus =
			rawStatus === "started"
				? "pending"
				: rawStatus === "running"
					? "claimed"
					: rawStatus === "error"
						? "failed"
						: rawStatus;
		return { batchId: Number(row.id), status: canonicalStatus };
	}

	/**
	 * Attempt to claim a flush batch for processing.
	 * Returns true if successfully claimed, false if already claimed/completed.
	 * Port of claim_raw_event_flush_batch().
	 */
	claimRawEventFlushBatch(batchId: number): boolean {
		const now = new Date().toISOString();
		const row = this.db
			.prepare(
				`UPDATE raw_event_flush_batches
				 SET status = 'claimed', updated_at = ?, attempt_count = attempt_count + 1
				 WHERE id = ? AND status IN ('pending', 'failed', 'started', 'error')
				 RETURNING id`,
			)
			.get(now, batchId) as { id: number } | undefined;
		return row != null;
	}

	/**
	 * Update the status of a flush batch.
	 * Port of update_raw_event_flush_batch_status().
	 */
	updateRawEventFlushBatchStatus(batchId: number, status: string): void {
		const now = new Date().toISOString();
		if (status === "failed") {
			// Preserve existing error details when marking as failed
			this.d
				.update(schema.rawEventFlushBatches)
				.set({ status, updated_at: now })
				.where(eq(schema.rawEventFlushBatches.id, batchId))
				.run();
		} else {
			// Clear error details for non-failure statuses
			this.d
				.update(schema.rawEventFlushBatches)
				.set({
					status,
					updated_at: now,
					error_message: null,
					error_type: null,
					observer_provider: null,
					observer_model: null,
					observer_runtime: null,
				})
				.where(eq(schema.rawEventFlushBatches.id, batchId))
				.run();
		}
	}

	/**
	 * Record a flush batch failure with error details.
	 * Port of record_raw_event_flush_batch_failure().
	 */
	recordRawEventFlushBatchFailure(
		batchId: number,
		opts: {
			message: string;
			errorType: string;
			observerProvider?: string | null;
			observerModel?: string | null;
			observerRuntime?: string | null;
		},
	): void {
		const now = new Date().toISOString();
		this.d
			.update(schema.rawEventFlushBatches)
			.set({
				status: "failed",
				updated_at: now,
				error_message: opts.message,
				error_type: opts.errorType,
				observer_provider: opts.observerProvider ?? null,
				observer_model: opts.observerModel ?? null,
				observer_runtime: opts.observerRuntime ?? null,
			})
			.where(eq(schema.rawEventFlushBatches.id, batchId))
			.run();
	}

	/**
	 * Update the last flushed event_seq for a session.
	 * Port of update_raw_event_flush_state().
	 */
	updateRawEventFlushState(
		opencodeSessionId: string,
		lastFlushed: number,
		source = "opencode",
	): void {
		const [s, sid] = this.normalizeStreamIdentity(source, opencodeSessionId);
		const now = new Date().toISOString();
		this.d
			.insert(schema.rawEventSessions)
			.values({
				opencode_session_id: sid,
				source: s,
				stream_id: sid,
				last_flushed_event_seq: lastFlushed,
				updated_at: now,
			})
			.onConflictDoUpdate({
				target: [schema.rawEventSessions.source, schema.rawEventSessions.stream_id],
				set: {
					opencode_session_id: sql`excluded.opencode_session_id`,
					last_flushed_event_seq: sql`excluded.last_flushed_event_seq`,
					updated_at: sql`excluded.updated_at`,
				},
			})
			.run();
	}

	// Raw event ingestion methods (ports for POST /api/raw-events)

	/**
	 * Update ingest stats counters (sample + running totals).
	 * Port of _update_raw_event_ingest_stats().
	 */
	private updateRawEventIngestStats(
		inserted: number,
		skippedInvalid: number,
		skippedDuplicate: number,
		skippedConflict: number,
	): void {
		const now = nowIso();
		const skippedEvents = skippedInvalid + skippedDuplicate + skippedConflict;
		this.d
			.insert(schema.rawEventIngestSamples)
			.values({
				created_at: now,
				inserted_events: inserted,
				skipped_invalid: skippedInvalid,
				skipped_duplicate: skippedDuplicate,
				skipped_conflict: skippedConflict,
			})
			.run();
		this.d
			.insert(schema.rawEventIngestStats)
			.values({
				id: 1,
				inserted_events: inserted,
				skipped_events: skippedEvents,
				skipped_invalid: skippedInvalid,
				skipped_duplicate: skippedDuplicate,
				skipped_conflict: skippedConflict,
				updated_at: now,
			})
			.onConflictDoUpdate({
				target: schema.rawEventIngestStats.id,
				set: {
					inserted_events: sql`${schema.rawEventIngestStats.inserted_events} + excluded.inserted_events`,
					skipped_events: sql`${schema.rawEventIngestStats.skipped_events} + excluded.skipped_events`,
					skipped_invalid: sql`${schema.rawEventIngestStats.skipped_invalid} + excluded.skipped_invalid`,
					skipped_duplicate: sql`${schema.rawEventIngestStats.skipped_duplicate} + excluded.skipped_duplicate`,
					skipped_conflict: sql`${schema.rawEventIngestStats.skipped_conflict} + excluded.skipped_conflict`,
					updated_at: sql`excluded.updated_at`,
				},
			})
			.run();
	}

	/**
	 * Record a single raw event. Returns true if inserted, false if duplicate.
	 * Port of record_raw_event().
	 */
	recordRawEvent(opts: {
		opencodeSessionId: string;
		source?: string;
		eventId: string;
		eventType: string;
		payload: Record<string, unknown>;
		tsWallMs?: number | null;
		tsMonoMs?: number | null;
	}): boolean {
		if (!opts.opencodeSessionId.trim()) throw new Error("opencode_session_id is required");
		if (!opts.eventId.trim()) throw new Error("event_id is required");
		if (!opts.eventType.trim()) throw new Error("event_type is required");

		const [source, streamId] = this.normalizeStreamIdentity(
			opts.source ?? "opencode",
			opts.opencodeSessionId,
		);

		return this.db.transaction(() => {
			const now = nowIso();

			// Check for duplicate
			const existing = this.d
				.select({ one: sql<number>`1` })
				.from(schema.rawEvents)
				.where(
					and(
						eq(schema.rawEvents.source, source),
						eq(schema.rawEvents.stream_id, streamId),
						eq(schema.rawEvents.event_id, opts.eventId),
					),
				)
				.get();
			if (existing != null) {
				this.updateRawEventIngestStats(0, 0, 1, 0);
				return false;
			}

			// Ensure session row exists
			const sessionRow = this.d
				.select({ one: sql<number>`1` })
				.from(schema.rawEventSessions)
				.where(
					and(
						eq(schema.rawEventSessions.source, source),
						eq(schema.rawEventSessions.stream_id, streamId),
					),
				)
				.get();
			if (sessionRow == null) {
				this.d
					.insert(schema.rawEventSessions)
					.values({
						opencode_session_id: streamId,
						source,
						stream_id: streamId,
						updated_at: now,
					})
					.run();
			}

			// Allocate event_seq
			const seqRow = this.d
				.update(schema.rawEventSessions)
				.set({
					last_received_event_seq: sql`${schema.rawEventSessions.last_received_event_seq} + 1`,
					updated_at: now,
				})
				.where(
					and(
						eq(schema.rawEventSessions.source, source),
						eq(schema.rawEventSessions.stream_id, streamId),
					),
				)
				.returning({
					last_received_event_seq: schema.rawEventSessions.last_received_event_seq,
				})
				.get();
			if (!seqRow) throw new Error("Failed to allocate raw event seq");
			const eventSeq = Number(seqRow.last_received_event_seq);

			this.d
				.insert(schema.rawEvents)
				.values({
					source,
					stream_id: streamId,
					opencode_session_id: streamId,
					event_id: opts.eventId,
					event_seq: eventSeq,
					event_type: opts.eventType,
					ts_wall_ms: opts.tsWallMs ?? null,
					ts_mono_ms: opts.tsMonoMs ?? null,
					payload_json: toJson(opts.payload),
					created_at: now,
				})
				.run();
			this.updateRawEventIngestStats(1, 0, 0, 0);
			return true;
		})();
	}

	/**
	 * Record a batch of raw events for a single session. Returns { inserted, skipped }.
	 * Port of record_raw_events_batch().
	 */
	recordRawEventsBatch(
		opencodeSessionId: string,
		events: Record<string, unknown>[],
	): { inserted: number; skipped: number } {
		if (!opencodeSessionId.trim()) throw new Error("opencode_session_id is required");
		const [source, streamId] = this.normalizeStreamIdentity("opencode", opencodeSessionId);

		return this.db.transaction(() => {
			const now = nowIso();

			// Ensure session row exists
			const sessionRow = this.d
				.select({ one: sql<number>`1` })
				.from(schema.rawEventSessions)
				.where(
					and(
						eq(schema.rawEventSessions.source, source),
						eq(schema.rawEventSessions.stream_id, streamId),
					),
				)
				.get();
			if (sessionRow == null) {
				this.d
					.insert(schema.rawEventSessions)
					.values({
						opencode_session_id: streamId,
						source,
						stream_id: streamId,
						updated_at: now,
					})
					.run();
			}

			// Normalize and validate events
			let skippedInvalid = 0;
			let skippedDuplicate = 0;
			let skippedConflict = 0;

			interface NormalizedEvent {
				eventId: string;
				eventType: string;
				payload: Record<string, unknown>;
				tsWallMs: unknown;
				tsMonoMs: unknown;
			}
			const normalized: NormalizedEvent[] = [];
			const seenIds = new Set<string>();

			for (const event of events) {
				const eventId = String(event.event_id ?? "");
				const eventType = String(event.event_type ?? "");
				let payload = event.payload;
				if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
					payload = {};
				}
				const tsWallMs = event.ts_wall_ms;
				const tsMonoMs = event.ts_mono_ms;

				if (!eventId || !eventType) {
					skippedInvalid++;
					continue;
				}
				if (seenIds.has(eventId)) {
					skippedDuplicate++;
					continue;
				}
				seenIds.add(eventId);
				normalized.push({
					eventId,
					eventType,
					payload: payload as Record<string, unknown>,
					tsWallMs,
					tsMonoMs,
				});
			}

			if (normalized.length === 0) {
				this.updateRawEventIngestStats(0, skippedInvalid, skippedDuplicate, skippedConflict);
				return { inserted: 0, skipped: skippedInvalid + skippedDuplicate + skippedConflict };
			}

			// Check for existing event_ids in chunks
			const existingIds = new Set<string>();
			const chunkSize = 500;
			for (let i = 0; i < normalized.length; i += chunkSize) {
				const chunk = normalized.slice(i, i + chunkSize);
				const chunkEventIds = chunk.map((e) => e.eventId);
				const rows = this.d
					.select({ event_id: schema.rawEvents.event_id })
					.from(schema.rawEvents)
					.where(
						and(
							eq(schema.rawEvents.source, source),
							eq(schema.rawEvents.stream_id, streamId),
							inArray(schema.rawEvents.event_id, chunkEventIds),
						),
					)
					.all();
				for (const row of rows) {
					if (row.event_id) existingIds.add(row.event_id);
				}
			}

			const newEvents = normalized.filter((e) => !existingIds.has(e.eventId));
			skippedDuplicate += normalized.length - newEvents.length;

			if (newEvents.length === 0) {
				this.updateRawEventIngestStats(0, skippedInvalid, skippedDuplicate, skippedConflict);
				return { inserted: 0, skipped: skippedInvalid + skippedDuplicate + skippedConflict };
			}

			// Allocate seq range
			const seqRow = this.d
				.update(schema.rawEventSessions)
				.set({
					last_received_event_seq: sql`${schema.rawEventSessions.last_received_event_seq} + ${newEvents.length}`,
					updated_at: now,
				})
				.where(
					and(
						eq(schema.rawEventSessions.source, source),
						eq(schema.rawEventSessions.stream_id, streamId),
					),
				)
				.returning({
					last_received_event_seq: schema.rawEventSessions.last_received_event_seq,
				})
				.get();
			if (!seqRow) throw new Error("Failed to allocate raw event seq");
			const endSeq = Number(seqRow.last_received_event_seq);
			const startSeq = endSeq - newEvents.length + 1;

			let inserted = 0;
			const insertStmt = this.db.prepare(
				`INSERT INTO raw_events(
					source, stream_id, opencode_session_id, event_id, event_seq,
					event_type, ts_wall_ms, ts_mono_ms, payload_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);

			for (let offset = 0; offset < newEvents.length; offset++) {
				const event = newEvents[offset]!;
				try {
					insertStmt.run(
						source,
						streamId,
						streamId,
						event.eventId,
						startSeq + offset,
						event.eventType,
						event.tsWallMs ?? null,
						event.tsMonoMs ?? null,
						toJson(event.payload),
						now,
					);
					inserted++;
				} catch (err: unknown) {
					// SQLite UNIQUE constraint → skip conflict
					if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
						skippedConflict++;
					} else {
						throw err;
					}
				}
			}

			this.updateRawEventIngestStats(inserted, skippedInvalid, skippedDuplicate, skippedConflict);
			return { inserted, skipped: skippedInvalid + skippedDuplicate + skippedConflict };
		})();
	}

	/**
	 * UPSERT session metadata (cwd, project, started_at, last_seen_ts_wall_ms).
	 * Port of update_raw_event_session_meta().
	 */
	updateRawEventSessionMeta(opts: {
		opencodeSessionId: string;
		source?: string;
		cwd?: string | null;
		project?: string | null;
		startedAt?: string | null;
		lastSeenTsWallMs?: number | null;
	}): void {
		const [source, streamId] = this.normalizeStreamIdentity(
			opts.source ?? "opencode",
			opts.opencodeSessionId,
		);
		const now = nowIso();
		const t = schema.rawEventSessions;
		this.d
			.insert(t)
			.values({
				opencode_session_id: streamId,
				source,
				stream_id: streamId,
				cwd: opts.cwd ?? null,
				project: opts.project ?? null,
				started_at: opts.startedAt ?? null,
				last_seen_ts_wall_ms: opts.lastSeenTsWallMs ?? null,
				updated_at: now,
			})
			.onConflictDoUpdate({
				target: [t.source, t.stream_id],
				set: {
					opencode_session_id: sql`excluded.opencode_session_id`,
					cwd: sql`COALESCE(excluded.cwd, ${t.cwd})`,
					project: sql`COALESCE(excluded.project, ${t.project})`,
					started_at: sql`COALESCE(excluded.started_at, ${t.started_at})`,
					last_seen_ts_wall_ms: sql`CASE
						WHEN excluded.last_seen_ts_wall_ms IS NULL THEN ${t.last_seen_ts_wall_ms}
						WHEN ${t.last_seen_ts_wall_ms} IS NULL THEN excluded.last_seen_ts_wall_ms
						WHEN excluded.last_seen_ts_wall_ms > ${t.last_seen_ts_wall_ms} THEN excluded.last_seen_ts_wall_ms
						ELSE ${t.last_seen_ts_wall_ms}
					END`,
					updated_at: sql`excluded.updated_at`,
				},
			})
			.run();
	}

	/**
	 * Get totals of pending (unflushed) raw events.
	 * Port of raw_event_backlog_totals().
	 */
	rawEventBacklogTotals(): { pending: number; sessions: number } {
		const row = this.d.get<{ sessions: number | null; pending: number | null }>(sql`
			WITH max_events AS (
				SELECT source, stream_id, MAX(event_seq) AS max_seq
				FROM raw_events
				GROUP BY source, stream_id
			)
			SELECT
				COUNT(1) AS sessions,
				SUM(e.max_seq - s.last_flushed_event_seq) AS pending
			FROM raw_event_sessions s
			JOIN max_events e ON e.source = s.source AND e.stream_id = s.stream_id
			WHERE e.max_seq > s.last_flushed_event_seq
		`);
		if (!row) return { sessions: 0, pending: 0 };
		return {
			sessions: Number(row.sessions ?? 0),
			pending: Number(row.pending ?? 0),
		};
	}

	/**
	 * Get the latest failed flush batch, or null if none.
	 * Port of latest_raw_event_flush_failure().
	 */
	latestRawEventFlushFailure(source?: string | null): Record<string, unknown> | null {
		let query = `SELECT
			id, source, stream_id, opencode_session_id,
			start_event_seq, end_event_seq, extractor_version,
			status, updated_at, attempt_count,
			error_message, error_type,
			observer_provider, observer_model, observer_runtime
		FROM raw_event_flush_batches
		WHERE status IN ('error', 'failed')`;
		const params: unknown[] = [];
		if (source != null) {
			query += " AND source = ?";
			params.push(source.trim().toLowerCase() || "opencode");
		}
		query += " ORDER BY updated_at DESC LIMIT 1";
		const row = this.db.prepare(query).get(...params) as Record<string, unknown> | undefined;
		if (!row) return null;
		return { ...row, status: "error" };
	}

	getSyncDaemonState(): Record<string, unknown> | null {
		const row = this.db
			.prepare(
				"SELECT last_error, last_traceback, last_error_at, last_ok_at FROM sync_daemon_state WHERE id = 1",
			)
			.get() as Record<string, unknown> | undefined;
		return row ? { ...row } : null;
	}

	sameActorPeerIds(): string[] {
		const rows = this.db
			.prepare(
				"SELECT peer_device_id FROM sync_peers WHERE claimed_local_actor = 1 OR actor_id = ? ORDER BY peer_device_id",
			)
			.all(this.actorId) as Array<Record<string, unknown>>;
		return rows.map((row) => String(row.peer_device_id ?? "").trim()).filter(Boolean);
	}

	claimedSameActorLegacyActorIds(): string[] {
		return this.sameActorPeerIds().map((peerId) => `legacy-sync:${peerId}`);
	}

	claimableLegacyDeviceIds(): Record<string, unknown>[] {
		const rows = this.db
			.prepare(
				`SELECT origin_device_id, COUNT(*) AS memory_count, MAX(created_at) AS last_seen_at
				 FROM memory_items
				 WHERE origin_device_id IS NOT NULL
				   AND origin_device_id != ''
				   AND origin_device_id != 'unknown'
				   AND ((actor_id IS NULL OR TRIM(actor_id) = '' OR actor_id LIKE 'legacy-sync:%')
				     AND (actor_id IS NULL OR TRIM(actor_id) = '' OR actor_id LIKE 'legacy-sync:%' OR actor_display_name = ? OR workspace_id = ? OR trust_state = 'legacy_unknown'))
				   AND origin_device_id != ?
				   AND origin_device_id NOT IN (SELECT peer_device_id FROM sync_peers WHERE peer_device_id IS NOT NULL)
				 GROUP BY origin_device_id
				 ORDER BY last_seen_at DESC, origin_device_id ASC`,
			)
			.all(LEGACY_SYNC_ACTOR_DISPLAY_NAME, LEGACY_SHARED_WORKSPACE_ID, this.deviceId) as Array<
			Record<string, unknown>
		>;
		return rows
			.filter((row) => cleanStr(row.origin_device_id))
			.map((row) => ({
				origin_device_id: String(row.origin_device_id),
				memory_count: Number(row.memory_count ?? 0),
				last_seen_at: row.last_seen_at ?? null,
			}));
	}

	private effectiveSyncProjectFilters(peerDeviceId?: string | null): {
		include: string[];
		exclude: string[];
	} {
		const config = readCodememConfigFile();
		let include = parseJsonList(JSON.stringify(config.sync_projects_include ?? []));
		let exclude = parseJsonList(JSON.stringify(config.sync_projects_exclude ?? []));
		if (peerDeviceId) {
			const row = this.db
				.prepare(
					"SELECT projects_include_json, projects_exclude_json FROM sync_peers WHERE peer_device_id = ?",
				)
				.get(peerDeviceId) as Record<string, unknown> | undefined;
			if (row) {
				if (row.projects_include_json != null) include = parseJsonList(row.projects_include_json);
				if (row.projects_exclude_json != null) exclude = parseJsonList(row.projects_exclude_json);
			}
		}
		return { include, exclude };
	}

	private syncProjectAllowed(project: string | null, peerDeviceId?: string | null): boolean {
		const { include, exclude } = this.effectiveSyncProjectFilters(peerDeviceId);
		const name = cleanStr(project);
		const basename = projectBasename(name);
		if (include.length > 0 && !include.some((item) => item === name || item === basename))
			return false;
		if (exclude.some((item) => item === name || item === basename)) return false;
		return true;
	}

	sharingReviewSummary(project?: string | null): Record<string, unknown>[] {
		const selectedProject = cleanStr(project);
		const claimedPeers = this.sameActorPeerIds();
		const legacyActorIds = this.claimedSameActorLegacyActorIds();
		const ownershipClauses = ["memory_items.actor_id = ?"];
		const params: unknown[] = [this.actorId];
		if (claimedPeers.length > 0) {
			ownershipClauses.push(
				`memory_items.origin_device_id IN (${claimedPeers.map(() => "?").join(", ")})`,
			);
			params.push(...claimedPeers);
		}
		if (legacyActorIds.length > 0) {
			ownershipClauses.push(
				`memory_items.actor_id IN (${legacyActorIds.map(() => "?").join(", ")})`,
			);
			params.push(...legacyActorIds);
		}
		const rows = this.db
			.prepare(
				`SELECT sync_peers.peer_device_id, sync_peers.name, sync_peers.actor_id,
				        actors.display_name AS actor_display_name,
				        sessions.project AS project, memory_items.visibility AS visibility,
				        COUNT(*) AS total
				 FROM sync_peers
				 LEFT JOIN actors ON actors.actor_id = sync_peers.actor_id
				 JOIN memory_items ON memory_items.active = 1
				 JOIN sessions ON sessions.id = memory_items.session_id
				 WHERE sync_peers.actor_id IS NOT NULL
				   AND TRIM(sync_peers.actor_id) != ''
				   AND sync_peers.actor_id != ?
				   AND (${ownershipClauses.join(" OR ")})
				 GROUP BY sync_peers.peer_device_id, sync_peers.name, sync_peers.actor_id, sessions.project, memory_items.visibility
				 ORDER BY sync_peers.name, sync_peers.peer_device_id`,
			)
			.all(this.actorId, ...params) as Array<Record<string, unknown>>;
		const byPeer = new Map<string, Record<string, unknown>>();
		for (const row of rows) {
			const peerDeviceId = String(row.peer_device_id ?? "").trim();
			const actorId = String(row.actor_id ?? "").trim();
			if (!peerDeviceId || !actorId || actorId === this.actorId) continue;
			const projectName = cleanStr(row.project);
			if (selectedProject) {
				const selectedBase = projectBasename(selectedProject);
				const projectBase = projectBasename(projectName);
				if (projectName !== selectedProject && projectBase !== selectedBase) continue;
			}
			if (!this.syncProjectAllowed(projectName, peerDeviceId)) continue;
			const current = byPeer.get(peerDeviceId) ?? {
				peer_device_id: peerDeviceId,
				peer_name: cleanStr(row.name) ?? peerDeviceId,
				actor_id: actorId,
				actor_display_name: cleanStr(row.actor_display_name) ?? actorId,
				project: selectedProject,
				scope_label: selectedProject ?? "All allowed projects",
				shareable_count: 0,
				private_count: 0,
			};
			const total = Number(row.total ?? 0);
			if (String(row.visibility ?? "") === "private") {
				current.private_count = Number(current.private_count ?? 0) + total;
			} else {
				current.shareable_count = Number(current.shareable_count ?? 0) + total;
			}
			byPeer.set(peerDeviceId, current);
		}
		const results = [...byPeer.values()].map((item) => ({
			...item,
			total_count: Number(item.shareable_count ?? 0) + Number(item.private_count ?? 0),
		}));
		return results.sort(
			(a: Record<string, unknown>, b: Record<string, unknown>) =>
				String(a.peer_name ?? "").localeCompare(String(b.peer_name ?? "")) ||
				String(a.peer_device_id ?? "").localeCompare(String(b.peer_device_id ?? "")),
		);
	}

	// close

	/** Close the database connection. */
	close(): void {
		this.db.close();
	}
}
