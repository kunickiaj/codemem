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
import { and, desc, eq, gt, inArray, isNotNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import {
	assertSchemaReady,
	connect,
	DEFAULT_DB_PATH,
	ensureAdditiveSchemaCompatibility,
	ensurePlannerStats,
	fromJson,
	isEmbeddingDisabled,
	loadSqliteVec,
	resolveDbPath,
	tableExists,
	toJson,
	toJsonNullable,
} from "./db.js";
import { buildFilterClauses } from "./filters.js";
import { buildMemoryDedupKey, normalizeMemoryDedupTitle } from "./memory-dedup.js";
import { readCodememConfigFile } from "./observer-config.js";
import {
	buildMemoryPack,
	buildMemoryPackAsync,
	buildMemoryPackTrace,
	buildMemoryPackTraceAsync,
} from "./pack.js";
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
	PackRenderOptions,
	PackResponse,
	PackTrace,
	StoreStats,
	TimelineItemResponse,
} from "./types.js";
import { storeVectors } from "./vectors.js";

// Memory kind validation (mirrors codemem/memory_kinds.py)

const ALLOWED_MEMORY_KINDS = new Set([
	"discovery",
	"change",
	"feature",
	"bugfix",
	"refactor",
	"decision",
	"exploration",
	"session_summary",
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

function countQuestionPlaceholders(clause: string): number {
	return (clause.match(/\?/g) ?? []).length;
}

function sqlFromParameterizedClause(clause: string, params: unknown[]): SQL {
	const parts = clause.split("?");
	let acc: SQL = sql.raw(parts[0] ?? "");
	for (let i = 1; i < parts.length; i++) {
		acc = sql`${acc}${params[i - 1]}${sql.raw(parts[i] ?? "")}`;
	}
	return acc;
}

function buildWhereSql(clauses: string[], params: unknown[]): SQL {
	const sqlClauses: SQL[] = [];
	let cursor = 0;
	for (const clause of clauses) {
		const count = countQuestionPlaceholders(clause);
		const clauseParams = params.slice(cursor, cursor + count);
		sqlClauses.push(sqlFromParameterizedClause(clause, clauseParams));
		cursor += count;
	}
	if (cursor !== params.length) {
		throw new Error("filter parameter mismatch while building SQL clauses");
	}
	if (sqlClauses.length === 1) return sqlClauses[0] ?? sql`1=1`;
	const combined = and(...sqlClauses);
	if (!combined) throw new Error("failed to combine filter SQL clauses");
	return combined;
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
const DEFAULT_CROSS_SESSION_DEDUP_WINDOW_MS = 3_600_000;
const CROSS_SESSION_DEDUP_WINDOW_ENV = "CODEMEM_MEMORY_CROSS_SESSION_DEDUP_WINDOW_MS";
const MAX_CROSS_SESSION_DEDUP_WINDOW_MS = 8_640_000_000_000_000;

function getMemoryDedupMatchText(title: string): string | null {
	const normalized = normalizeMemoryDedupTitle(title);
	const fallback = title.toLowerCase().replace(/\s+/g, " ").trim();
	return normalized || fallback || null;
}
function resolveCrossSessionDedupWindowMs(): number {
	const raw = process.env[CROSS_SESSION_DEDUP_WINDOW_ENV]?.trim();
	if (!raw) return DEFAULT_CROSS_SESSION_DEDUP_WINDOW_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CROSS_SESSION_DEDUP_WINDOW_MS;
	return Math.min(Math.floor(parsed), MAX_CROSS_SESSION_DEDUP_WINDOW_MS);
}

function isSameSessionDedupConstraintError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	return (
		message.includes("idx_memory_items_same_session_dedup_unique") ||
		(message.includes("unique constraint failed") && message.includes("memory_items.session_id"))
	);
}

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
	readonly crossSessionDedupWindowMs: number;
	private readonly pendingVectorWrites = new Set<Promise<void>>();

	/** Lazy Drizzle ORM wrapper — shares the same better-sqlite3 connection. */
	private _drizzle: ReturnType<typeof drizzle> | null = null;
	private get d() {
		if (!this._drizzle) this._drizzle = drizzle(this.db, { schema });
		return this._drizzle;
	}

	constructor(dbPath: string = DEFAULT_DB_PATH) {
		this.dbPath = resolveDbPath(dbPath);
		this.db = connect(this.dbPath);
		try {
			loadSqliteVec(this.db);
			assertSchemaReady(this.db);
			ensureAdditiveSchemaCompatibility(this.db);
			ensurePlannerStats(this.db);
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
		this.crossSessionDedupWindowMs = resolveCrossSessionDedupWindowMs();
	}

	private findExistingDuplicateMemory(
		sessionId: number,
		kind: string,
		title: string,
		dedupKey: string | null,
		provenance: {
			visibility: string;
			workspace_id: string;
		},
		now: string,
	): number | null {
		if (!dedupKey) return null;
		const matchTitle = getMemoryDedupMatchText(title);
		if (!matchTitle) return null;

		const sameSessionRows = this.db
			.prepare(
				`SELECT id, title
				 FROM memory_items
				 WHERE active = 1
				   AND session_id = ?
				   AND kind = ?
				   AND visibility = ?
				   AND workspace_id = ?
				   AND (dedup_key = ? OR dedup_key IS NULL)
				 ORDER BY created_at DESC, id DESC`,
			)
			.all(sessionId, kind, provenance.visibility, provenance.workspace_id, dedupKey) as Array<{
			id: number;
			title: string;
		}>;
		for (const row of sameSessionRows) {
			if (getMemoryDedupMatchText(row.title) === matchTitle) return row.id;
		}

		// Cross-session matching is intentionally best-effort. We want to avoid
		// obvious duplicate bursts from adjacent sessions, but we do not enforce
		// a global uniqueness constraint because the time-window heuristic is not
		// strong enough to be a durable identity rule.
		if (this.crossSessionDedupWindowMs <= 0) return null;

		const since = new Date(Date.parse(now) - this.crossSessionDedupWindowMs).toISOString();
		const crossSessionRows = this.db
			.prepare(
				`SELECT id, title
				 FROM memory_items
				 WHERE active = 1
				   AND session_id != ?
				   AND kind = ?
				   AND visibility = ?
				   AND workspace_id = ?
				   AND created_at >= ?
				   AND (dedup_key = ? OR dedup_key IS NULL)
				 ORDER BY confidence DESC, created_at DESC, id DESC`,
			)
			.all(
				sessionId,
				kind,
				provenance.visibility,
				provenance.workspace_id,
				since,
				dedupKey,
			) as Array<{
			id: number;
			title: string;
		}>;
		for (const row of crossSessionRows) {
			if (getMemoryDedupMatchText(row.title) === matchTitle) return row.id;
		}
		return null;
	}

	/**
	 * Throw if sync is in a blocking phase and the memory has shared visibility.
	 * Private memories are always safe to write regardless of sync state.
	 *
	 * Uses the store's existing Drizzle instance to avoid re-instantiation on
	 * every mutation. The underlying query is a PK lookup on a 0-or-1-row table,
	 * so the cost is negligible.
	 */
	private assertSharedMutationAllowed(visibility: string | null | undefined): void {
		if (!visibility || visibility === "private") return;
		const row = this.d
			.select({ phase: schema.syncDaemonState.phase })
			.from(schema.syncDaemonState)
			.where(eq(schema.syncDaemonState.id, 1))
			.get();
		if (row?.phase === "needs_attention") {
			throw new Error("sync_rebootstrap_in_progress");
		}
	}

	private enqueueVectorWrite(memoryId: number, title: string, bodyText: string): void {
		if (this.db.inTransaction) return;
		let op: Promise<void> | null = null;
		op = storeVectors(this.db, memoryId, title, bodyText)
			.catch(() => {
				// Non-fatal — keep memory writes resilient when embeddings are unavailable
			})
			.finally(() => {
				if (op) this.pendingVectorWrites.delete(op);
			});
		this.pendingVectorWrites.add(op);
	}

	async flushPendingVectorWrites(): Promise<void> {
		if (this.pendingVectorWrites.size === 0) return;
		await Promise.allSettled([...this.pendingVectorWrites]);
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

	getOrCreateSessionForOpencodeSession(opts: {
		opencodeSessionId: string;
		source?: string;
		cwd?: string;
		project?: string | null;
		metadata?: Record<string, unknown>;
		startedAt?: string | null;
		toolVersion?: string;
		user?: string;
	}): number {
		const [source, streamId] = this.normalizeStreamIdentity(
			opts.source ?? "opencode",
			opts.opencodeSessionId,
		);
		const existing = this.d
			.select({ session_id: schema.opencodeSessions.session_id })
			.from(schema.opencodeSessions)
			.where(
				and(
					eq(schema.opencodeSessions.source, source),
					eq(schema.opencodeSessions.stream_id, streamId),
				),
			)
			.get();
		if (existing?.session_id != null) {
			return Number(existing.session_id);
		}

		const startedAt = opts.startedAt ?? nowIso();
		const sessionRows = this.d
			.insert(schema.sessions)
			.values({
				started_at: startedAt,
				cwd: opts.cwd ?? process.cwd(),
				project: opts.project ?? null,
				git_remote: null,
				git_branch: null,
				user: opts.user ?? process.env.USER ?? "unknown",
				tool_version: opts.toolVersion ?? "raw_events",
				metadata_json: toJson(opts.metadata ?? {}),
			})
			.returning({ id: schema.sessions.id })
			.all();
		const sessionId = sessionRows[0]?.id;
		if (sessionId == null) throw new Error("session insert returned no id");

		this.d
			.insert(schema.opencodeSessions)
			.values({
				opencode_session_id: streamId,
				source,
				stream_id: streamId,
				session_id: sessionId,
				created_at: nowIso(),
			})
			.onConflictDoUpdate({
				target: [schema.opencodeSessions.source, schema.opencodeSessions.stream_id],
				set: {
					opencode_session_id: sql`excluded.opencode_session_id`,
					session_id: sql`excluded.session_id`,
				},
			})
			.run();

		return Number(sessionId);
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
		const dedupKey = buildMemoryDedupKey(title);

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

		const existingId = this.findExistingDuplicateMemory(
			sessionId,
			validKind,
			title,
			dedupKey,
			provenance,
			now,
		);
		if (existingId != null) return existingId;

		// Block shared-memory writes while sync requires attention.
		this.assertSharedMutationAllowed(provenance.visibility);

		let insertedRows: Array<{ id: number }>;
		try {
			insertedRows = this.d
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
					dedup_key: dedupKey,
					import_key: importKey,
				})
				.returning({ id: schema.memoryItems.id })
				.all();
		} catch (error) {
			if (!isSameSessionDedupConstraintError(error)) throw error;
			const existingSameSessionId = this.findExistingDuplicateMemory(
				sessionId,
				validKind,
				title,
				dedupKey,
				provenance,
				now,
			);
			if (existingSameSessionId != null) return existingSameSessionId;
			throw error;
		}

		const memoryId = insertedRows[0]?.id;
		if (memoryId == null) throw new Error("memory insert returned no id");

		// Record replication op for sync propagation
		try {
			recordReplicationOp(this.db, { memoryId, opType: "upsert", deviceId: this.deviceId });
		} catch {
			// Non-fatal — don't block memory creation
		}

		this.enqueueVectorWrite(memoryId, title, bodyText);

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

		const claimedPeers = new Set(this.sameActorPeerIds());
		if (deviceId && claimedPeers.has(deviceId)) return true;

		const legacyActorIds = new Set(this.claimedSameActorLegacyActorIds());
		if (actorId && legacyActorIds.has(actorId)) return true;

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
						visibility: schema.memoryItems.visibility,
					})
					.from(schema.memoryItems)
					.where(eq(schema.memoryItems.id, memoryId))
					.get();
				if (!row) return;

				// Block shared-memory deletes while sync requires attention.
				this.assertSharedMutationAllowed(row.visibility);

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
		const whereSql = buildWhereSql(allClauses, filterResult.params);

		// Note: joinSessions is set by the project filter (not yet ported).
		// Once project filtering lands, it will trigger the sessions JOIN.
		const fromSql = filterResult.joinSessions
			? sql.raw("memory_items JOIN sessions ON sessions.id = memory_items.session_id")
			: sql.raw("memory_items");

		const rows = this.d.all<MemoryItem>(
			sql`SELECT memory_items.* FROM ${fromSql}
				WHERE ${whereSql}
				ORDER BY created_at DESC
				LIMIT ${limit} OFFSET ${Math.max(offset, 0)}`,
		);

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
		const params = [...kindsList, ...filterResult.params];
		const whereSql = buildWhereSql(allClauses, params);

		const fromSql = filterResult.joinSessions
			? sql.raw("memory_items JOIN sessions ON sessions.id = memory_items.session_id")
			: sql.raw("memory_items");

		const rows = this.d.all<MemoryItem>(
			sql`SELECT memory_items.* FROM ${fromSql}
				WHERE ${whereSql}
				ORDER BY created_at DESC
				LIMIT ${limit} OFFSET ${Math.max(offset, 0)}`,
		);

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
		if (!isEmbeddingDisabled() && tableExists(this.db, "memory_vectors")) {
			try {
				const row = this.d.get<{ c: number | null }>(sql`SELECT COUNT(*) AS c FROM memory_vectors`);
				vectorCount = row?.c ?? 0;
			} catch {
				vectorCount = 0;
			}
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

		// Block promoting to shared while sync requires attention.
		this.assertSharedMutationAllowed(cleaned);

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

	buildMemoryPackTrace(
		context: string,
		limit?: number,
		tokenBudget?: number | null,
		filters?: MemoryFilters,
	): PackTrace {
		return buildMemoryPackTrace(this, context, limit, tokenBudget ?? null, filters);
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
		renderOptions?: PackRenderOptions,
	): Promise<PackResponse> {
		return buildMemoryPackAsync(this, context, limit, tokenBudget ?? null, filters, renderOptions);
	}

	async buildMemoryPackTraceAsync(
		context: string,
		limit?: number,
		tokenBudget?: number | null,
		filters?: MemoryFilters,
		renderOptions?: PackRenderOptions,
	): Promise<PackTrace> {
		return buildMemoryPackTraceAsync(
			this,
			context,
			limit,
			tokenBudget ?? null,
			filters,
			renderOptions,
		);
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
		const maxEvents = this.d
			.select({
				source: schema.rawEvents.source,
				stream_id: schema.rawEvents.stream_id,
				max_seq: sql<number>`MAX(${schema.rawEvents.event_seq})`.as("max_seq"),
			})
			.from(schema.rawEvents)
			.groupBy(schema.rawEvents.source, schema.rawEvents.stream_id)
			.as("max_events");

		const rows = this.d
			.select({
				source: schema.rawEventSessions.source,
				stream_id: schema.rawEventSessions.stream_id,
			})
			.from(schema.rawEventSessions)
			.innerJoin(
				maxEvents,
				and(
					eq(maxEvents.source, schema.rawEventSessions.source),
					eq(maxEvents.stream_id, schema.rawEventSessions.stream_id),
				),
			)
			.where(
				and(
					isNotNull(schema.rawEventSessions.last_seen_ts_wall_ms),
					lte(schema.rawEventSessions.last_seen_ts_wall_ms, idleBeforeTsWallMs),
					gt(maxEvents.max_seq, schema.rawEventSessions.last_flushed_event_seq),
				),
			)
			.orderBy(schema.rawEventSessions.last_seen_ts_wall_ms)
			.limit(limit)
			.all();

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
		const pendingBatches = this.d
			.select({
				source: schema.rawEventFlushBatches.source,
				stream_id: schema.rawEventFlushBatches.stream_id,
				oldest_pending_update: sql<string>`MIN(${schema.rawEventFlushBatches.updated_at})`.as(
					"oldest_pending_update",
				),
			})
			.from(schema.rawEventFlushBatches)
			.where(inArray(schema.rawEventFlushBatches.status, ["pending", "failed", "started", "error"]))
			.groupBy(schema.rawEventFlushBatches.source, schema.rawEventFlushBatches.stream_id)
			.as("pending_batches");

		const maxEvents = this.d
			.select({
				source: schema.rawEvents.source,
				stream_id: schema.rawEvents.stream_id,
				max_seq: sql<number>`MAX(${schema.rawEvents.event_seq})`.as("max_seq"),
			})
			.from(schema.rawEvents)
			.groupBy(schema.rawEvents.source, schema.rawEvents.stream_id)
			.as("max_events");

		const rows = this.d
			.select({ source: pendingBatches.source, stream_id: pendingBatches.stream_id })
			.from(pendingBatches)
			.innerJoin(
				maxEvents,
				and(
					eq(maxEvents.source, pendingBatches.source),
					eq(maxEvents.stream_id, pendingBatches.stream_id),
				),
			)
			.leftJoin(
				schema.rawEventSessions,
				and(
					eq(schema.rawEventSessions.source, pendingBatches.source),
					eq(schema.rawEventSessions.stream_id, pendingBatches.stream_id),
				),
			)
			.where(
				gt(maxEvents.max_seq, sql`COALESCE(${schema.rawEventSessions.last_flushed_event_seq}, -1)`),
			)
			.orderBy(sql`${pendingBatches.oldest_pending_update}`)
			.limit(limit)
			.all();

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
			const result = this.d
				.delete(schema.rawEvents)
				.where(
					and(
						isNotNull(schema.rawEvents.ts_wall_ms),
						lt(schema.rawEvents.ts_wall_ms, cutoffTsWallMs),
					),
				)
				.run();
			return Number(result.changes ?? 0);
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
            observer_runtime = NULL,
            observer_auth_source = NULL,
            observer_auth_type = NULL,
            observer_error_code = NULL,
            observer_error_message = NULL
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
		const baseQuery = this.d
			.select({
				event_seq: schema.rawEvents.event_seq,
				event_type: schema.rawEvents.event_type,
				ts_wall_ms: schema.rawEvents.ts_wall_ms,
				ts_mono_ms: schema.rawEvents.ts_mono_ms,
				payload_json: schema.rawEvents.payload_json,
				event_id: schema.rawEvents.event_id,
			})
			.from(schema.rawEvents)
			.where(
				and(
					eq(schema.rawEvents.source, s),
					eq(schema.rawEvents.stream_id, sid),
					gt(schema.rawEvents.event_seq, afterEventSeq),
				),
			)
			.orderBy(schema.rawEvents.event_seq);

		const rows = limit != null && limit > 0 ? baseQuery.limit(limit).all() : baseQuery.all();

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
	): { batchId: number; status: string; attemptCount: number } {
		const [s, sid] = this.normalizeStreamIdentity(source, opencodeSessionId);
		const now = new Date().toISOString();

		// Atomic UPSERT to avoid SELECT+INSERT races. We intentionally do NOT
		// heartbeat claimed/running batches: their updated_at stays unchanged so
		// stuck-batch recovery can still age them out.
		const t = schema.rawEventFlushBatches;
		const row = this.d
			.insert(t)
			.values({
				source: s,
				stream_id: sid,
				opencode_session_id: sid,
				start_event_seq: startEventSeq,
				end_event_seq: endEventSeq,
				extractor_version: extractorVersion,
				status: "pending",
				created_at: now,
				updated_at: now,
			})
			.onConflictDoUpdate({
				target: [t.source, t.stream_id, t.start_event_seq, t.end_event_seq, t.extractor_version],
				set: {
					updated_at: sql`CASE
						WHEN ${t.status} IN ('claimed', 'running')
						THEN ${t.updated_at}
						ELSE excluded.updated_at
					END`,
				},
			})
			.returning({ id: t.id, status: t.status, attempt_count: t.attempt_count })
			.get();

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
		return {
			batchId: Number(row.id),
			status: canonicalStatus,
			attemptCount: Number(row.attempt_count ?? 0),
		};
	}

	/**
	 * Attempt to claim a flush batch for processing.
	 * Returns true if successfully claimed, false if already claimed/completed.
	 * Port of claim_raw_event_flush_batch().
	 */
	claimRawEventFlushBatch(batchId: number): boolean {
		const now = new Date().toISOString();
		const row = this.d
			.update(schema.rawEventFlushBatches)
			.set({
				status: "claimed",
				updated_at: now,
				attempt_count: sql`${schema.rawEventFlushBatches.attempt_count} + 1`,
			})
			.where(
				and(
					eq(schema.rawEventFlushBatches.id, batchId),
					inArray(schema.rawEventFlushBatches.status, ["pending", "failed", "started", "error"]),
				),
			)
			.returning({ id: schema.rawEventFlushBatches.id })
			.get();
		return row != null;
	}

	/**
	 * Update the status of a flush batch.
	 * Port of update_raw_event_flush_batch_status().
	 */
	updateRawEventFlushBatchStatus(batchId: number, status: string): void {
		const now = new Date().toISOString();
		if (status === "failed" || status === "gave_up") {
			// Preserve existing error details when marking as failed/gave_up
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
					observer_auth_source: null,
					observer_auth_type: null,
					observer_error_code: null,
					observer_error_message: null,
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
			observerAuthSource?: string | null;
			observerAuthType?: string | null;
			observerErrorCode?: string | null;
			observerErrorMessage?: string | null;
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
				observer_auth_source: opts.observerAuthSource ?? null,
				observer_auth_type: opts.observerAuthType ?? null,
				observer_error_code: opts.observerErrorCode ?? null,
				observer_error_message: opts.observerErrorMessage ?? null,
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

			const insertRows = newEvents.map((event, offset) => {
				const tsWallMs = typeof event.tsWallMs === "number" ? event.tsWallMs : null;
				const tsMonoMs = typeof event.tsMonoMs === "number" ? event.tsMonoMs : null;
				return {
					source,
					stream_id: streamId,
					opencode_session_id: streamId,
					event_id: event.eventId,
					event_seq: startSeq + offset,
					event_type: event.eventType,
					ts_wall_ms: tsWallMs,
					ts_mono_ms: tsMonoMs,
					payload_json: toJson(event.payload),
					created_at: now,
				};
			});

			const result = this.d.insert(schema.rawEvents).values(insertRows).onConflictDoNothing().run();
			const inserted = Number(result.changes ?? 0);
			skippedConflict += newEvents.length - inserted;

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
		const conditions = [inArray(schema.rawEventFlushBatches.status, ["error", "failed"])];
		if (source != null) {
			conditions.push(
				eq(schema.rawEventFlushBatches.source, source.trim().toLowerCase() || "opencode"),
			);
		}

		const row = this.d
			.select({
				id: schema.rawEventFlushBatches.id,
				source: schema.rawEventFlushBatches.source,
				stream_id: schema.rawEventFlushBatches.stream_id,
				opencode_session_id: schema.rawEventFlushBatches.opencode_session_id,
				start_event_seq: schema.rawEventFlushBatches.start_event_seq,
				end_event_seq: schema.rawEventFlushBatches.end_event_seq,
				extractor_version: schema.rawEventFlushBatches.extractor_version,
				status: schema.rawEventFlushBatches.status,
				updated_at: schema.rawEventFlushBatches.updated_at,
				attempt_count: schema.rawEventFlushBatches.attempt_count,
				error_message: schema.rawEventFlushBatches.error_message,
				error_type: schema.rawEventFlushBatches.error_type,
				observer_provider: schema.rawEventFlushBatches.observer_provider,
				observer_model: schema.rawEventFlushBatches.observer_model,
				observer_runtime: schema.rawEventFlushBatches.observer_runtime,
				observer_auth_source: schema.rawEventFlushBatches.observer_auth_source,
				observer_auth_type: schema.rawEventFlushBatches.observer_auth_type,
				observer_error_code: schema.rawEventFlushBatches.observer_error_code,
				observer_error_message: schema.rawEventFlushBatches.observer_error_message,
			})
			.from(schema.rawEventFlushBatches)
			.where(and(...conditions))
			.orderBy(desc(schema.rawEventFlushBatches.updated_at))
			.limit(1)
			.get();
		if (!row) return null;
		return { ...row, status: "error" };
	}

	getSyncDaemonState(): Record<string, unknown> | null {
		const row = this.d
			.select({
				last_error: schema.syncDaemonState.last_error,
				last_traceback: schema.syncDaemonState.last_traceback,
				last_error_at: schema.syncDaemonState.last_error_at,
				last_ok_at: schema.syncDaemonState.last_ok_at,
			})
			.from(schema.syncDaemonState)
			.where(eq(schema.syncDaemonState.id, 1))
			.get();
		return row ? { ...row } : null;
	}

	sameActorPeerIds(): string[] {
		if (!tableExists(this.db, "sync_peers")) return [];
		const rows = this.d
			.select({ peer_device_id: schema.syncPeers.peer_device_id })
			.from(schema.syncPeers)
			.where(
				or(
					eq(schema.syncPeers.claimed_local_actor, 1),
					eq(schema.syncPeers.actor_id, this.actorId),
				),
			)
			.orderBy(schema.syncPeers.peer_device_id)
			.all();
		return rows.map((row) => String(row.peer_device_id ?? "").trim()).filter(Boolean);
	}

	claimedSameActorLegacyActorIds(): string[] {
		return this.sameActorPeerIds().map((peerId) => `legacy-sync:${peerId}`);
	}

	claimableLegacyDeviceIds(): Record<string, unknown>[] {
		const rows = this.d
			.select({
				origin_device_id: schema.memoryItems.origin_device_id,
				memory_count: sql<number>`COUNT(*)`,
				last_seen_at: sql<string | null>`MAX(${schema.memoryItems.created_at})`,
			})
			.from(schema.memoryItems)
			.where(
				and(
					isNotNull(schema.memoryItems.origin_device_id),
					sql`TRIM(${schema.memoryItems.origin_device_id}) != ''`,
					sql`${schema.memoryItems.origin_device_id} != 'unknown'`,
					sql`(
						(${schema.memoryItems.actor_id} IS NULL OR TRIM(${schema.memoryItems.actor_id}) = '' OR ${schema.memoryItems.actor_id} LIKE 'legacy-sync:%')
						AND (
							${schema.memoryItems.actor_id} IS NULL
							OR TRIM(${schema.memoryItems.actor_id}) = ''
							OR ${schema.memoryItems.actor_id} LIKE 'legacy-sync:%'
							OR ${schema.memoryItems.actor_display_name} = ${LEGACY_SYNC_ACTOR_DISPLAY_NAME}
							OR ${schema.memoryItems.workspace_id} = ${LEGACY_SHARED_WORKSPACE_ID}
							OR ${schema.memoryItems.trust_state} = 'legacy_unknown'
						)
					)`,
					sql`${schema.memoryItems.origin_device_id} != ${this.deviceId}`,
					sql`${schema.memoryItems.origin_device_id} NOT IN (
						SELECT ${schema.syncPeers.peer_device_id}
						FROM ${schema.syncPeers}
						WHERE ${schema.syncPeers.peer_device_id} IS NOT NULL
					)`,
				),
			)
			.groupBy(schema.memoryItems.origin_device_id)
			.orderBy(
				desc(sql`MAX(${schema.memoryItems.created_at})`),
				schema.memoryItems.origin_device_id,
			)
			.all();
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
			const row = this.d
				.select({
					projects_include_json: schema.syncPeers.projects_include_json,
					projects_exclude_json: schema.syncPeers.projects_exclude_json,
				})
				.from(schema.syncPeers)
				.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
				.limit(1)
				.get();
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
		const ownershipConditions = [eq(schema.memoryItems.actor_id, this.actorId)];
		if (claimedPeers.length > 0) {
			ownershipConditions.push(inArray(schema.memoryItems.origin_device_id, claimedPeers));
		}
		if (legacyActorIds.length > 0) {
			ownershipConditions.push(inArray(schema.memoryItems.actor_id, legacyActorIds));
		}
		const ownershipWhere =
			ownershipConditions.length === 1 ? ownershipConditions[0] : or(...ownershipConditions);
		const rows = this.d
			.select({
				peer_device_id: schema.syncPeers.peer_device_id,
				name: schema.syncPeers.name,
				actor_id: schema.syncPeers.actor_id,
				actor_display_name: schema.actors.display_name,
				project: schema.sessions.project,
				visibility: schema.memoryItems.visibility,
				total: sql<number>`COUNT(*)`,
			})
			.from(schema.syncPeers)
			.leftJoin(schema.actors, eq(schema.actors.actor_id, schema.syncPeers.actor_id))
			.innerJoin(schema.memoryItems, sql`1 = 1`)
			.innerJoin(schema.sessions, eq(schema.sessions.id, schema.memoryItems.session_id))
			.where(
				and(
					eq(schema.memoryItems.active, 1),
					isNotNull(schema.syncPeers.actor_id),
					sql`TRIM(${schema.syncPeers.actor_id}) != ''`,
					sql`${schema.syncPeers.actor_id} != ${this.actorId}`,
					ownershipWhere,
				),
			)
			.groupBy(
				schema.syncPeers.peer_device_id,
				schema.syncPeers.name,
				schema.syncPeers.actor_id,
				schema.actors.display_name,
				schema.sessions.project,
				schema.memoryItems.visibility,
			)
			.orderBy(schema.syncPeers.name, schema.syncPeers.peer_device_id)
			.all();
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
		this.db.pragma("optimize");
		this.db.close();
	}
}
