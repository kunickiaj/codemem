/**
 * Sync replication: cursor tracking, op chunking, and payload extraction.
 *
 * Uses Drizzle ORM for all SQL queries so that column mismatches are
 * compile-time errors instead of silent data-loss bugs at runtime.
 *
 * Keeps replication functions decoupled from MemoryStore by accepting
 * a raw Database handle. Ported from codemem/sync/replication.py.
 */

import { randomUUID } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import { fromJson, fromJsonStrict, toJson, toJsonNullable } from "./db.js";
import { readCodememConfigFile } from "./observer-config.js";
import * as schema from "./schema.js";
import type {
	ReplicationOp,
	ReplicationOpsPruneResult,
	SyncDirtyLocalState,
	SyncMemorySnapshotItem,
} from "./types.js";

export interface SyncResetBoundary {
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
	retained_floor_cursor: string | null;
}

export interface SyncResetRequired extends SyncResetBoundary {
	reset_required: true;
	reason: "stale_cursor" | "generation_mismatch" | "boundary_mismatch";
}

export interface LoadReplicationOpsForPeerOptions {
	since: string | null;
	limit?: number;
	deviceId?: string;
	generation?: number | null;
	snapshotId?: string | null;
	baselineCursor?: string | null;
}

export type LoadReplicationOpsForPeerResult =
	| {
			reset_required: false;
			boundary: SyncResetBoundary;
			ops: ReplicationOp[];
			nextCursor: string | null;
	  }
	| {
			reset_required: true;
			reset: SyncResetRequired;
	  };

export interface LoadMemorySnapshotPageForPeerOptions {
	limit?: number;
	pageToken?: string | null;
	peerDeviceId?: string | null;
	generation?: number | null;
	snapshotId?: string | null;
	baselineCursor?: string | null;
}

export interface LoadMemorySnapshotPageForPeerResult {
	boundary: SyncResetBoundary;
	items: SyncMemorySnapshotItem[];
	nextPageToken: string | null;
	hasMore: boolean;
}

type MemoryItemRow = typeof schema.memoryItems.$inferSelect;

interface MemoryPayload {
	session_id: number | null;
	kind: string | null;
	title: string | null;
	subtitle: string | null;
	body_text: string | null;
	confidence: number | null;
	tags_text: string | null;
	active: number | null;
	created_at: string | null;
	updated_at: string | null;
	metadata_json: Record<string, unknown>;
	actor_id: string | null;
	actor_display_name: string | null;
	visibility: string | null;
	workspace_id: string | null;
	workspace_kind: string | null;
	origin_device_id: string | null;
	origin_source: string | null;
	trust_state: string | null;
	narrative: string | null;
	facts: unknown;
	concepts: unknown;
	files_read: unknown;
	files_modified: unknown;
	user_prompt_id: number | null;
	prompt_number: number | null;
	deleted_at: string | null;
	rev: number;
	import_key: string | null;
}

function asNumberOrNull(value: unknown): number | null {
	if (value == null) return null;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function asStringOrNull(value: unknown): string | null {
	if (value == null) return null;
	return String(value);
}

function parseMemoryPayload(op: ReplicationOp, errors: string[]): MemoryPayload | null {
	if (!op.payload_json) return null;
	let raw: Record<string, unknown>;
	try {
		raw = fromJsonStrict(op.payload_json);
	} catch (err) {
		errors.push(
			`op ${op.op_id}: skipped — payload_json is not a valid object: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
	const metadataRaw = raw.metadata_json;
	const metadata_json =
		metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)
			? { ...(metadataRaw as Record<string, unknown>) }
			: {};
	return {
		session_id: asNumberOrNull(raw.session_id),
		kind: asStringOrNull(raw.kind),
		title: asStringOrNull(raw.title),
		subtitle: asStringOrNull(raw.subtitle),
		body_text: asStringOrNull(raw.body_text),
		confidence: asNumberOrNull(raw.confidence),
		tags_text: asStringOrNull(raw.tags_text),
		active: asNumberOrNull(raw.active),
		created_at: asStringOrNull(raw.created_at),
		updated_at: asStringOrNull(raw.updated_at),
		metadata_json,
		actor_id: asStringOrNull(raw.actor_id),
		actor_display_name: asStringOrNull(raw.actor_display_name),
		visibility: asStringOrNull(raw.visibility),
		workspace_id: asStringOrNull(raw.workspace_id),
		workspace_kind: asStringOrNull(raw.workspace_kind),
		origin_device_id: asStringOrNull(raw.origin_device_id),
		origin_source: asStringOrNull(raw.origin_source),
		trust_state: asStringOrNull(raw.trust_state),
		narrative: asStringOrNull(raw.narrative),
		facts: raw.facts ?? null,
		concepts: raw.concepts ?? null,
		files_read: raw.files_read ?? null,
		files_modified: raw.files_modified ?? null,
		user_prompt_id: asNumberOrNull(raw.user_prompt_id),
		prompt_number: asNumberOrNull(raw.prompt_number),
		deleted_at: asStringOrNull(raw.deleted_at),
		rev: asNumberOrNull(raw.rev) ?? 0,
		import_key: asStringOrNull(raw.import_key),
	};
}

function normalizeCursor(value: string | null | undefined): string | null {
	const trimmed = String(value ?? "").trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseSnapshotPageToken(
	token: string | null | undefined,
): { importKey: string; id: number } | null {
	const raw = normalizeCursor(token);
	if (!raw) return null;
	const idx = raw.lastIndexOf("|");
	if (idx <= 0) return null;
	const importKey = raw.slice(0, idx);
	const id = Number(raw.slice(idx + 1));
	if (!importKey || !Number.isFinite(id)) return null;
	return { importKey, id };
}

function makeSnapshotPageToken(importKey: string, id: number): string {
	return `${importKey}|${id}`;
}

function ensureSyncResetStateTable(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sync_reset_state (
			id INTEGER PRIMARY KEY,
			generation INTEGER NOT NULL,
			snapshot_id TEXT NOT NULL,
			baseline_cursor TEXT,
			retained_floor_cursor TEXT,
			updated_at TEXT NOT NULL
		)
	`);
}

export function getSyncResetState(db: Database): SyncResetBoundary {
	ensureSyncResetStateTable(db);
	const d = drizzle(db, { schema });
	const existing = d
		.select()
		.from(schema.syncResetState)
		.where(eq(schema.syncResetState.id, 1))
		.get();
	if (existing) {
		return {
			generation: Number(existing.generation ?? 1),
			snapshot_id: String(existing.snapshot_id),
			baseline_cursor: normalizeCursor(existing.baseline_cursor),
			retained_floor_cursor: normalizeCursor(existing.retained_floor_cursor),
		};
	}

	const now = new Date().toISOString();
	const created = {
		id: 1,
		generation: 1,
		snapshot_id: randomUUID(),
		baseline_cursor: null,
		retained_floor_cursor: null,
		updated_at: now,
	};
	d.insert(schema.syncResetState).values(created).run();
	return {
		generation: created.generation,
		snapshot_id: created.snapshot_id,
		baseline_cursor: created.baseline_cursor,
		retained_floor_cursor: created.retained_floor_cursor,
	};
}

export function setSyncResetState(
	db: Database,
	updates: Partial<SyncResetBoundary> & { generation?: number },
): SyncResetBoundary {
	const current = getSyncResetState(db);
	const now = new Date().toISOString();
	const next: SyncResetBoundary = {
		generation: updates.generation ?? current.generation,
		snapshot_id: updates.snapshot_id ?? current.snapshot_id,
		baseline_cursor:
			updates.baseline_cursor === undefined
				? current.baseline_cursor
				: normalizeCursor(updates.baseline_cursor),
		retained_floor_cursor:
			updates.retained_floor_cursor === undefined
				? current.retained_floor_cursor
				: normalizeCursor(updates.retained_floor_cursor),
	};
	const d = drizzle(db, { schema });
	d.insert(schema.syncResetState)
		.values({ id: 1, ...next, updated_at: now })
		.onConflictDoUpdate({
			target: schema.syncResetState.id,
			set: {
				generation: next.generation,
				snapshot_id: next.snapshot_id,
				baseline_cursor: next.baseline_cursor,
				retained_floor_cursor: next.retained_floor_cursor,
				updated_at: now,
			},
		})
		.run();
	return next;
}

function resetRequired(
	boundary: SyncResetBoundary,
	reason: SyncResetRequired["reason"],
): LoadReplicationOpsForPeerResult {
	return {
		reset_required: true,
		reset: {
			reset_required: true,
			reason,
			...boundary,
		},
	};
}

function mergePayloadMetadata(
	metadata: Record<string, unknown>,
	clockDeviceId: string,
): Record<string, unknown> {
	return {
		...metadata,
		clock_device_id: clockDeviceId,
	};
}

function clockDeviceIdFromMetadataJson(raw: string | null): string {
	const metadata = fromJson(raw);
	return typeof metadata.clock_device_id === "string" ? metadata.clock_device_id : "";
}

// Op chunking

/**
 * Split replication ops into batches that fit within a byte-size limit.
 *
 * Each batch is serialized as `{"ops": [...]}` and must not exceed maxBytes
 * when UTF-8 encoded. Throws if a single op exceeds the limit.
 */
export function chunkOpsBySize(ops: ReplicationOp[], maxBytes: number): ReplicationOp[][] {
	const encoder = new TextEncoder();
	// Overhead: {"ops":[]} = 9 bytes, comma between elements = 1 byte
	const WRAPPER_OVERHEAD = 9;
	const COMMA_OVERHEAD = 1;

	const batches: ReplicationOp[][] = [];
	let current: ReplicationOp[] = [];
	let currentBytes = WRAPPER_OVERHEAD;

	for (const op of ops) {
		const opBytes = encoder.encode(JSON.stringify(op)).byteLength;
		const addedBytes = current.length === 0 ? opBytes : opBytes + COMMA_OVERHEAD;

		if (currentBytes + addedBytes <= maxBytes) {
			current.push(op);
			currentBytes += addedBytes;
			continue;
		}
		if (current.length === 0) {
			throw new Error("single op exceeds size limit");
		}
		batches.push(current);
		current = [op];
		currentBytes = WRAPPER_OVERHEAD + opBytes;
		if (currentBytes > maxBytes) {
			throw new Error("single op exceeds size limit");
		}
	}
	if (current.length > 0) {
		batches.push(current);
	}
	return batches;
}

// Cursor read/write

/**
 * Read the replication cursor for a peer device.
 *
 * Returns `[lastApplied, lastAcked]` — both null when no cursor exists.
 */
export function getReplicationCursor(
	db: Database,
	peerDeviceId: string,
): [lastApplied: string | null, lastAcked: string | null] {
	const d = drizzle(db, { schema });
	const row = d
		.select({
			last_applied_cursor: schema.replicationCursors.last_applied_cursor,
			last_acked_cursor: schema.replicationCursors.last_acked_cursor,
		})
		.from(schema.replicationCursors)
		.where(eq(schema.replicationCursors.peer_device_id, peerDeviceId))
		.get();

	if (!row) return [null, null];
	return [row.last_applied_cursor, row.last_acked_cursor];
}

/**
 * Insert or update the replication cursor for a peer device.
 *
 * Uses COALESCE on update so callers can set only one of the two cursors
 * without clobbering the other.
 */
export function setReplicationCursor(
	db: Database,
	peerDeviceId: string,
	options: { lastApplied?: string | null; lastAcked?: string | null } = {},
): void {
	const now = new Date().toISOString();
	const lastApplied = options.lastApplied ?? null;
	const lastAcked = options.lastAcked ?? null;

	const d = drizzle(db, { schema });
	// Atomic UPSERT — avoids TOCTOU race with concurrent sync workers.
	// Drizzle's onConflictDoUpdate doesn't support COALESCE(excluded.col, col)
	// natively, so we use raw SQL for the SET expressions.
	d.insert(schema.replicationCursors)
		.values({
			peer_device_id: peerDeviceId,
			last_applied_cursor: lastApplied,
			last_acked_cursor: lastAcked,
			updated_at: now,
		})
		.onConflictDoUpdate({
			target: schema.replicationCursors.peer_device_id,
			set: {
				last_applied_cursor: sql`COALESCE(excluded.last_applied_cursor, ${schema.replicationCursors.last_applied_cursor})`,
				last_acked_cursor: sql`COALESCE(excluded.last_acked_cursor, ${schema.replicationCursors.last_acked_cursor})`,
				updated_at: sql`excluded.updated_at`,
			},
		})
		.run();
}

// Payload extraction

/**
 * Extract replication ops from a parsed JSON payload.
 *
 * Returns an empty array if the payload is not an object or lacks an `ops` array.
 */
/** Required fields for a valid replication op. */
const REQUIRED_OP_FIELDS = [
	"op_id",
	"entity_type",
	"entity_id",
	"op_type",
	"clock_rev",
	"clock_updated_at",
	"clock_device_id",
	"device_id",
	"created_at",
] as const;

/**
 * Extract and validate replication ops from a parsed JSON payload.
 *
 * Returns an empty array if the payload is not an object or lacks an `ops` array.
 * Silently filters out ops missing required fields to prevent garbage data
 * from entering the replication pipeline.
 */
export function extractReplicationOps(payload: unknown): ReplicationOp[] {
	if (typeof payload !== "object" || payload === null) return [];
	const obj = payload as Record<string, unknown>;
	const ops = obj.ops;
	if (!Array.isArray(ops)) return [];

	return ops.filter((op): op is ReplicationOp => {
		if (typeof op !== "object" || op === null) return false;
		const record = op as Record<string, unknown>;
		return REQUIRED_OP_FIELDS.every(
			(field) => record[field] !== undefined && record[field] !== null,
		);
	});
}

// Clock comparison

/**
 * Build a clock tuple from individual fields.
 *
 * Clock tuples enable lexicographic comparison for last-writer-wins
 * conflict resolution: higher rev wins, tiebreak on updated_at, then device_id.
 */
export function clockTuple(
	rev: number,
	updatedAt: string,
	deviceId: string,
): [number, string, string] {
	return [rev, updatedAt, deviceId];
}

/**
 * Return true if `candidate` clock is strictly newer than `existing`.
 *
 * Comparison order: rev (higher wins) → updated_at → device_id.
 * Mirrors Python's `_is_newer_clock` which relies on tuple ordering.
 */
export function isNewerClock(
	candidate: [number, string, string],
	existing: [number, string, string],
): boolean {
	if (candidate[0] !== existing[0]) return candidate[0] > existing[0];
	if (candidate[1] !== existing[1]) return candidate[1] > existing[1];
	return candidate[2] > existing[2];
}

// Record a replication op

/**
 * Generate and INSERT a single replication op for a memory item.
 *
 * Reads the memory item's clock fields (rev, updated_at, metadata_json)
 * from the DB, builds the op row, and inserts into `replication_ops`.
 * Returns the generated op_id (UUID).
 *
 * Uses Drizzle's typed select so all memory_items columns are captured
 * automatically — no hand-maintained column list to go out of sync.
 */
export function recordReplicationOp(
	db: Database,
	opts: {
		memoryId: number;
		opType: "upsert" | "delete";
		deviceId: string;
		payload?: Record<string, unknown>;
	},
): string {
	const d = drizzle(db, { schema });
	const opId = randomUUID();
	const now = new Date().toISOString();

	// Read the full memory row — typed via Drizzle schema
	const row = d
		.select()
		.from(schema.memoryItems)
		.where(eq(schema.memoryItems.id, opts.memoryId))
		.get();

	const rev = Number(row?.rev ?? 0);
	const updatedAt = row?.updated_at ?? now;
	const entityId = row?.import_key ?? String(opts.memoryId);
	const metadata = fromJson(row?.metadata_json);
	const clockDeviceId =
		typeof metadata.clock_device_id === "string" && metadata.clock_device_id.trim().length > 0
			? metadata.clock_device_id
			: opts.deviceId;

	// Build payload from the memory row so peers can reconstruct the full item.
	// Explicit payload override takes precedence (used by tests).
	let payloadJson: string | null;
	if (opts.payload) {
		payloadJson = toJson(opts.payload);
	} else if (row && opts.opType === "upsert") {
		// Parse JSON-string columns so they round-trip as objects, not double-encoded strings
		const parseSqliteJson = (val: string | null | undefined): unknown => {
			if (typeof val !== "string") return val ?? null;
			try {
				return JSON.parse(val);
			} catch {
				return val;
			}
		};

		payloadJson = toJson({
			session_id: row.session_id,
			kind: row.kind,
			title: row.title,
			subtitle: row.subtitle,
			body_text: row.body_text,
			confidence: row.confidence,
			tags_text: row.tags_text,
			active: row.active,
			created_at: row.created_at,
			updated_at: row.updated_at,
			metadata_json: parseSqliteJson(row.metadata_json),
			actor_id: row.actor_id,
			actor_display_name: row.actor_display_name,
			visibility: row.visibility,
			workspace_id: row.workspace_id,
			workspace_kind: row.workspace_kind,
			origin_device_id: row.origin_device_id,
			origin_source: row.origin_source,
			trust_state: row.trust_state,
			facts: parseSqliteJson(row.facts),
			narrative: row.narrative,
			concepts: parseSqliteJson(row.concepts),
			files_read: parseSqliteJson(row.files_read),
			files_modified: parseSqliteJson(row.files_modified),
			user_prompt_id: row.user_prompt_id,
			prompt_number: row.prompt_number,
			deleted_at: row.deleted_at,
		});
	} else {
		payloadJson = null;
	}

	d.insert(schema.replicationOps)
		.values({
			op_id: opId,
			entity_type: "memory_item",
			entity_id: entityId,
			op_type: opts.opType,
			payload_json: payloadJson,
			clock_rev: rev,
			clock_updated_at: updatedAt,
			clock_device_id: clockDeviceId,
			device_id: opts.deviceId,
			created_at: now,
		})
		.run();

	return opId;
}

// Load replication ops with cursor pagination

/** Parse a `created_at|op_id` cursor into its two components. */
function parseCursor(cursor: string): [createdAt: string, opId: string] | null {
	const idx = cursor.indexOf("|");
	if (idx < 0) return null;
	return [cursor.slice(0, idx), cursor.slice(idx + 1)];
}

/** Build a `created_at|op_id` cursor string. */
function computeCursor(createdAt: string, opId: string): string {
	return `${createdAt}|${opId}`;
}

/**
 * Load replication ops created after `cursor`, ordered by (created_at, op_id).
 *
 * Returns `[ops, nextCursor]` where nextCursor is the cursor for the last
 * returned row (or null if no rows matched). The cursor format is
 * `created_at|op_id`.
 */
export function loadReplicationOpsSince(
	db: Database,
	cursor: string | null,
	limit = 100,
	deviceId?: string,
): [ReplicationOp[], string | null] {
	const d = drizzle(db, { schema });
	const t = schema.replicationOps;
	const conditions = [];

	if (cursor) {
		const parsed = parseCursor(cursor);
		if (parsed) {
			const [createdAt, opId] = parsed;
			conditions.push(
				or(gt(t.created_at, createdAt), and(eq(t.created_at, createdAt), gt(t.op_id, opId))),
			);
		}
	}

	if (deviceId) {
		conditions.push(or(eq(t.device_id, deviceId), eq(t.device_id, "local")));
	}

	const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

	const rows = d
		.select()
		.from(t)
		.where(whereClause)
		.orderBy(t.created_at, t.op_id)
		.limit(limit)
		.all();

	const ops: ReplicationOp[] = rows.map((r) => ({
		op_id: r.op_id,
		entity_type: r.entity_type,
		entity_id: r.entity_id,
		op_type: r.op_type,
		payload_json: r.payload_json,
		clock_rev: r.clock_rev,
		clock_updated_at: r.clock_updated_at,
		clock_device_id: r.clock_device_id,
		device_id: r.device_id,
		created_at: r.created_at,
	}));

	let nextCursor: string | null = null;
	if (rows.length > 0) {
		const last = rows.at(-1);
		if (last) {
			nextCursor = computeCursor(last.created_at, last.op_id);
		}
	}

	return [ops, nextCursor];
}

export function loadReplicationOpsForPeer(
	db: Database,
	options: LoadReplicationOpsForPeerOptions,
): LoadReplicationOpsForPeerResult {
	const boundary = getSyncResetState(db);
	const since = normalizeCursor(options.since);
	const requestedGeneration = options.generation ?? null;
	const requestedSnapshotId = normalizeCursor(options.snapshotId);
	const requestedBaselineCursor = normalizeCursor(options.baselineCursor);
	const hasAnyBoundaryField =
		requestedGeneration != null || requestedSnapshotId != null || requestedBaselineCursor != null;

	if (requestedGeneration != null && requestedGeneration !== boundary.generation) {
		return resetRequired(boundary, "generation_mismatch");
	}

	const hasCompleteBoundary =
		requestedGeneration != null &&
		requestedSnapshotId != null &&
		requestedBaselineCursor === boundary.baseline_cursor;

	if (!hasAnyBoundaryField || !hasCompleteBoundary) {
		return resetRequired(boundary, "boundary_mismatch");
	}

	if (
		requestedSnapshotId !== boundary.snapshot_id ||
		requestedBaselineCursor !== boundary.baseline_cursor
	) {
		return resetRequired(boundary, "boundary_mismatch");
	}

	if (
		since != null &&
		boundary.retained_floor_cursor != null &&
		since < boundary.retained_floor_cursor
	) {
		return resetRequired(boundary, "stale_cursor");
	}

	const [ops, nextCursor] = loadReplicationOpsSince(db, since, options.limit, options.deviceId);
	return {
		reset_required: false,
		boundary,
		ops,
		nextCursor,
	};
}

export function loadMemorySnapshotPageForPeer(
	db: Database,
	options: LoadMemorySnapshotPageForPeerOptions,
): LoadMemorySnapshotPageForPeerResult {
	const boundary = getSyncResetState(db);
	if (options.generation !== boundary.generation) {
		throw new Error("generation_mismatch");
	}
	if (normalizeCursor(options.snapshotId) !== boundary.snapshot_id) {
		throw new Error("boundary_mismatch");
	}
	if (normalizeCursor(options.baselineCursor) !== boundary.baseline_cursor) {
		throw new Error("boundary_mismatch");
	}

	const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
	const pageToken = parseSnapshotPageToken(options.pageToken);
	const d = drizzle(db, { schema });
	const scanBatchSize = Math.min(Math.max(limit * 3, limit), 1000);
	const rowsAfterToken = (token: { importKey: string; id: number } | null, batchLimit: number) =>
		d
			.select({
				memory: schema.memoryItems,
				sessionProject: schema.sessions.project,
			})
			.from(schema.memoryItems)
			.innerJoin(schema.sessions, eq(schema.sessions.id, schema.memoryItems.session_id))
			.where(
				and(
					isNotNull(schema.memoryItems.import_key),
					token
						? or(
								gt(schema.memoryItems.import_key, token.importKey),
								and(
									eq(schema.memoryItems.import_key, token.importKey),
									gt(schema.memoryItems.id, token.id),
								),
							)
						: undefined,
				),
			)
			.orderBy(schema.memoryItems.import_key, schema.memoryItems.id)
			.limit(batchLimit)
			.all();

	const items: SyncMemorySnapshotItem[] = [];
	let nextScanToken = pageToken;
	let lastScannedToken: string | null = null;
	let hasMore = false;

	while (items.length < limit) {
		const rows = rowsAfterToken(nextScanToken, scanBatchSize);
		if (rows.length === 0) break;

		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index];
			if (!row) continue;
			const importKey = String(row.memory.import_key ?? "").trim();
			if (!importKey) continue;
			lastScannedToken = makeSnapshotPageToken(importKey, Number(row.memory.id));
			nextScanToken = { importKey, id: Number(row.memory.id) };

			const payload = buildPayloadFromMemoryRow(row.memory);
			if (
				!syncVisibilityAllowed(payload as unknown as Record<string, unknown>) &&
				!peerClaimedLocalActor(db, options.peerDeviceId ?? null)
			) {
				continue;
			}
			if (!syncProjectAllowed(db, row.sessionProject, options.peerDeviceId ?? null)) continue;
			const metadata =
				payload.metadata_json && typeof payload.metadata_json === "object"
					? payload.metadata_json
					: {};
			const clockDeviceId =
				typeof metadata.clock_device_id === "string" && metadata.clock_device_id.trim()
					? metadata.clock_device_id.trim()
					: String(row.memory.origin_device_id ?? "local");
			items.push({
				entity_id: importKey,
				op_type: row.memory.deleted_at || row.memory.active === 0 ? "delete" : "upsert",
				payload_json: toJson(payload),
				clock_rev: Number(row.memory.rev ?? 0),
				clock_updated_at: String(
					row.memory.updated_at ?? row.memory.created_at ?? new Date().toISOString(),
				),
				clock_device_id: clockDeviceId,
			});

			if (items.length >= limit) {
				hasMore = index < rows.length - 1 || rowsAfterToken(nextScanToken, 1).length > 0;
				break;
			}
		}

		if (items.length >= limit || rows.length < scanBatchSize) break;
	}
	return {
		boundary,
		items,
		nextPageToken: hasMore ? lastScannedToken : null,
		hasMore: hasMore && lastScannedToken != null,
	};
}

export function hasUnsyncedSharedMemoryChanges(db: Database, limit = 25): SyncDirtyLocalState {
	const d = drizzle(db, { schema });
	const rows = d.select().from(schema.memoryItems).orderBy(schema.memoryItems.updated_at).all();
	let count = 0;
	for (const row of rows) {
		if (!row.import_key) continue;
		const payload = buildPayloadFromMemoryRow(row);
		if (!syncVisibilityAllowed(payload as unknown as Record<string, unknown>)) continue;
		const opType: "upsert" | "delete" = row.deleted_at || row.active === 0 ? "delete" : "upsert";
		const exists = d
			.select({ one: sql<number>`1` })
			.from(schema.replicationOps)
			.where(
				and(
					eq(schema.replicationOps.entity_type, "memory_item"),
					eq(schema.replicationOps.entity_id, row.import_key),
					eq(schema.replicationOps.op_type, opType),
					eq(schema.replicationOps.clock_rev, Number(row.rev ?? 0)),
				),
			)
			.limit(1)
			.get();
		if (exists) continue;
		count += 1;
		if (count >= limit) break;
	}
	return { dirty: count > 0, count };
}

export function pruneReplicationOps(
	db: Database,
	options?: { maxAgeDays?: number; maxRows?: number },
): ReplicationOpsPruneResult {
	const maxAgeDays = Math.max(1, Math.floor(options?.maxAgeDays ?? 30));
	const maxRows = Math.max(1, Math.floor(options?.maxRows ?? 50_000));
	const d = drizzle(db, { schema });
	const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
	let deleted = 0;
	let lastDeletedCursor: string | null = null;

	const totalRows = Number(
		d.select({ c: sql<number>`COUNT(*)` }).from(schema.replicationOps).get()?.c ?? 0,
	);

	const ageCandidates = d
		.select({ op_id: schema.replicationOps.op_id })
		.from(schema.replicationOps)
		.where(sql`${schema.replicationOps.created_at} < ${cutoff}`)
		.orderBy(schema.replicationOps.created_at, schema.replicationOps.op_id)
		.all();
	if (ageCandidates.length > 0) {
		for (const row of ageCandidates) {
			const opRow = d
				.select({
					created_at: schema.replicationOps.created_at,
					op_id: schema.replicationOps.op_id,
				})
				.from(schema.replicationOps)
				.where(eq(schema.replicationOps.op_id, row.op_id))
				.limit(1)
				.get();
			if (opRow) {
				lastDeletedCursor = computeCursor(String(opRow.created_at), String(opRow.op_id));
			}
			deleted +=
				(
					db.prepare("DELETE FROM replication_ops WHERE op_id = ?").run(row.op_id) as {
						changes?: number;
					}
				).changes ?? 0;
		}
	}

	const remainingRows = Number(
		d.select({ c: sql<number>`COUNT(*)` }).from(schema.replicationOps).get()?.c ?? 0,
	);
	if (remainingRows > maxRows) {
		const overflow = remainingRows - maxRows;
		const overflowCandidates = d
			.select({ op_id: schema.replicationOps.op_id })
			.from(schema.replicationOps)
			.orderBy(schema.replicationOps.created_at, schema.replicationOps.op_id)
			.limit(overflow)
			.all();
		if (overflowCandidates.length > 0) {
			for (const row of overflowCandidates) {
				const opRow = d
					.select({
						created_at: schema.replicationOps.created_at,
						op_id: schema.replicationOps.op_id,
					})
					.from(schema.replicationOps)
					.where(eq(schema.replicationOps.op_id, row.op_id))
					.limit(1)
					.get();
				if (opRow) {
					lastDeletedCursor = computeCursor(String(opRow.created_at), String(opRow.op_id));
				}
				deleted +=
					(
						db.prepare("DELETE FROM replication_ops WHERE op_id = ?").run(row.op_id) as {
							changes?: number;
						}
					).changes ?? 0;
			}
		}
	}

	const currentBoundary = getSyncResetState(db);
	const retainedFloorCursor =
		deleted > 0 ? lastDeletedCursor : currentBoundary.retained_floor_cursor;
	setSyncResetState(db, { retained_floor_cursor: retainedFloorCursor });
	return { deleted, retained_floor_cursor: retainedFloorCursor };
}

function cleanList(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	const out: string[] = [];
	for (const raw of values) {
		const value = String(raw ?? "").trim();
		if (value) out.push(value);
	}
	return out;
}

function parseStringList(value: unknown): string[] {
	if (Array.isArray(value)) return cleanList(value);
	if (typeof value === "string") {
		return value
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean);
	}
	return [];
}

function parseJsonList(valuesJson: string | null | undefined): string[] {
	if (!valuesJson) return [];
	try {
		return cleanList(JSON.parse(valuesJson));
	} catch {
		return [];
	}
}

function projectBasename(value: string | null | undefined): string {
	const raw = String(value ?? "")
		.trim()
		.replaceAll("\\", "/");
	if (!raw) return "";
	const parts = raw.split("/").filter(Boolean);
	return parts.length > 0 ? (parts[parts.length - 1] ?? "") : "";
}

function effectiveSyncProjectFilters(
	db: Database,
	peerDeviceId: string | null,
): { include: string[]; exclude: string[] } {
	const d = drizzle(db, { schema });
	const config = readCodememConfigFile();
	const includeOverride = process.env.CODEMEM_SYNC_PROJECTS_INCLUDE;
	const excludeOverride = process.env.CODEMEM_SYNC_PROJECTS_EXCLUDE;
	const globalInclude =
		includeOverride !== undefined
			? parseStringList(includeOverride)
			: parseStringList(config.sync_projects_include);
	const globalExclude =
		excludeOverride !== undefined
			? parseStringList(excludeOverride)
			: parseStringList(config.sync_projects_exclude);
	if (!peerDeviceId) return { include: globalInclude, exclude: globalExclude };

	const row = d
		.select({
			projects_include_json: schema.syncPeers.projects_include_json,
			projects_exclude_json: schema.syncPeers.projects_exclude_json,
		})
		.from(schema.syncPeers)
		.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
		.limit(1)
		.get();
	if (!row) return { include: globalInclude, exclude: globalExclude };

	const hasOverride = row.projects_include_json != null || row.projects_exclude_json != null;
	if (!hasOverride) {
		return { include: globalInclude, exclude: globalExclude };
	}

	return {
		include: parseJsonList(row.projects_include_json),
		exclude: parseJsonList(row.projects_exclude_json),
	};
}

function syncProjectAllowed(
	db: Database,
	project: string | null,
	peerDeviceId: string | null,
): boolean {
	const { include, exclude } = effectiveSyncProjectFilters(db, peerDeviceId);
	const projectName = String(project ?? "").trim();
	const basename = projectBasename(projectName);

	if (exclude.some((item) => item === projectName || item === basename)) return false;
	if (include.length === 0) return true;
	return include.some((item) => item === projectName || item === basename);
}

function syncVisibilityAllowed(payload: Record<string, unknown> | null): boolean {
	if (!payload) return false;
	let visibility = String(payload.visibility ?? "")
		.trim()
		.toLowerCase();
	const metadata =
		payload.metadata_json &&
		typeof payload.metadata_json === "object" &&
		!Array.isArray(payload.metadata_json)
			? (payload.metadata_json as Record<string, unknown>)
			: {};
	const metadataVisibility = String(metadata.visibility ?? "")
		.trim()
		.toLowerCase();
	if (!visibility && metadataVisibility) {
		visibility = metadataVisibility;
	}

	if (!visibility) {
		let workspaceKind = String(payload.workspace_kind ?? "")
			.trim()
			.toLowerCase();
		let workspaceId = String(payload.workspace_id ?? "")
			.trim()
			.toLowerCase();
		if (!workspaceKind)
			workspaceKind = String(metadata.workspace_kind ?? "")
				.trim()
				.toLowerCase();
		if (!workspaceId)
			workspaceId = String(metadata.workspace_id ?? "")
				.trim()
				.toLowerCase();
		if (workspaceKind === "shared" || workspaceId.startsWith("shared:")) {
			visibility = "shared";
		} else {
			return true;
		}
	}

	return visibility === "shared";
}

function peerClaimedLocalActor(db: Database, peerDeviceId: string | null): boolean {
	if (!peerDeviceId) return false;
	const d = drizzle(db, { schema });
	const row = d
		.select({ claimed_local_actor: schema.syncPeers.claimed_local_actor })
		.from(schema.syncPeers)
		.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
		.limit(1)
		.get();
	return Boolean(row?.claimed_local_actor);
}

function parsePayload(payloadJson: string | null): Record<string, unknown> | null {
	if (!payloadJson || !payloadJson.trim()) return null;
	try {
		const parsed = JSON.parse(payloadJson) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

export interface FilterReplicationSkipped {
	reason: "visibility_filter" | "project_filter";
	op_id: string;
	created_at: string;
	entity_type: string;
	entity_id: string;
	skipped_count: number;
	project?: string | null;
	visibility?: string | null;
}

/**
 * Filter replication ops for peer sync scopes.
 *
 * Returns ops that pass project/visibility rules, a cursor for the last
 * processed op (including skipped ops), and skipped metadata when filtering
 * removed one or more ops.
 */
export function filterReplicationOpsForSyncWithStatus(
	db: Database,
	ops: ReplicationOp[],
	peerDeviceId: string | null,
): [ReplicationOp[], string | null, FilterReplicationSkipped | null] {
	const allowed: ReplicationOp[] = [];
	let nextCursor: string | null = null;
	let skippedCount = 0;
	let firstSkipped: FilterReplicationSkipped | null = null;
	for (const op of ops) {
		if (op.entity_type === "memory_item") {
			const payload = parsePayload(op.payload_json);
			if (op.op_type === "delete" && payload == null) {
				allowed.push(op);
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}
			if (!syncVisibilityAllowed(payload) && !peerClaimedLocalActor(db, peerDeviceId)) {
				skippedCount += 1;
				if (!firstSkipped) {
					firstSkipped = {
						reason: "visibility_filter",
						op_id: op.op_id,
						created_at: op.created_at,
						entity_type: op.entity_type,
						entity_id: op.entity_id,
						visibility: typeof payload?.visibility === "string" ? String(payload.visibility) : null,
						skipped_count: 0,
					};
				}
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}

			const project =
				typeof payload?.project === "string" && payload.project.trim()
					? payload.project.trim()
					: null;
			if (!syncProjectAllowed(db, project, peerDeviceId)) {
				skippedCount += 1;
				if (!firstSkipped) {
					firstSkipped = {
						reason: "project_filter",
						op_id: op.op_id,
						created_at: op.created_at,
						entity_type: op.entity_type,
						entity_id: op.entity_id,
						project,
						skipped_count: 0,
					};
				}
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}
		}

		allowed.push(op);
		nextCursor = computeCursor(op.created_at, op.op_id);
	}

	if (firstSkipped) {
		firstSkipped.skipped_count = skippedCount;
	}

	return [allowed, nextCursor, firstSkipped];
}

export function filterReplicationOpsForSync(
	db: Database,
	ops: ReplicationOp[],
	peerDeviceId: string | null,
): [ReplicationOp[], string | null] {
	const [allowed, nextCursor] = filterReplicationOpsForSyncWithStatus(db, ops, peerDeviceId);
	return [allowed, nextCursor];
}

// Apply inbound replication ops

export interface ApplyResult {
	applied: number;
	skipped: number;
	conflicts: number;
	errors: string[];
}

const LEGACY_IMPORT_KEY_OLD_RE = /^legacy:memory_item:(.+)$/;

/**
 * Rewrite legacy import keys into globally unique, device-scoped keys.
 *
 * Older databases may contain keys like `legacy:memory_item:<id>`, which can
 * collide across peers. This rewrites them to
 * `legacy:<device_id>:memory_item:<id>`.
 */
export function migrateLegacyImportKeys(db: Database, limit = 2000): number {
	const d = drizzle(db, { schema });
	const deviceRow = d
		.select({ device_id: schema.syncDevice.device_id })
		.from(schema.syncDevice)
		.limit(1)
		.get();
	const localDeviceId = String(deviceRow?.device_id ?? "").trim();
	if (!localDeviceId) return 0;

	const rows = d
		.select({
			id: schema.memoryItems.id,
			import_key: schema.memoryItems.import_key,
			metadata_json: schema.memoryItems.metadata_json,
		})
		.from(schema.memoryItems)
		.where(
			or(
				isNull(schema.memoryItems.import_key),
				sql`TRIM(${schema.memoryItems.import_key}) = ''`,
				like(schema.memoryItems.import_key, "legacy:memory_item:%"),
			),
		)
		.orderBy(schema.memoryItems.id)
		.limit(limit)
		.all();

	if (rows.length === 0) return 0;

	let updated = 0;
	for (const row of rows) {
		const memoryId = Number(row.id);
		const current = String(row.import_key ?? "").trim();
		const metadata = fromJson(row.metadata_json);
		const clockDeviceId =
			typeof metadata.clock_device_id === "string" ? metadata.clock_device_id.trim() : "";

		let canonical = "";
		if (!current) {
			canonical = `legacy:${localDeviceId}:memory_item:${memoryId}`;
		} else {
			const match = current.match(LEGACY_IMPORT_KEY_OLD_RE);
			if (!match) continue;
			const suffix = match[1] ?? "";
			const origin = clockDeviceId && clockDeviceId !== "local" ? clockDeviceId : localDeviceId;
			canonical = origin ? `legacy:${origin}:memory_item:${suffix}` : "";
		}

		if (!canonical || canonical === current) continue;

		const existing = d
			.select({ id: schema.memoryItems.id })
			.from(schema.memoryItems)
			.where(eq(schema.memoryItems.import_key, canonical))
			.limit(1)
			.get();
		if (existing && Number(existing.id) !== memoryId) {
			continue;
		}

		d.update(schema.memoryItems)
			.set({ import_key: canonical })
			.where(eq(schema.memoryItems.id, memoryId))
			.run();
		updated++;
	}

	return updated;
}

/**
 * Generate replication ops for rows that predate replication.
 *
 * Prioritizes delete/tombstone ops first, then active upserts, and only
 * generates ops when a matching op for the same entity/rev/op_type is missing.
 */
export function backfillReplicationOps(db: Database, limit = 200): number {
	if (limit <= 0) return 0;

	migrateLegacyImportKeys(db, 2000);

	const d = drizzle(db, { schema });
	const deviceRow = d
		.select({ device_id: schema.syncDevice.device_id })
		.from(schema.syncDevice)
		.limit(1)
		.get();
	const localDeviceId = String(deviceRow?.device_id ?? "").trim();

	const deletedRows = d
		.select()
		.from(schema.memoryItems)
		.where(
			and(
				or(isNotNull(schema.memoryItems.deleted_at), eq(schema.memoryItems.active, 0)),
				sql`NOT EXISTS (
					SELECT 1
					FROM replication_ops ro
					WHERE ro.entity_type = 'memory_item'
					  AND ro.entity_id = ${schema.memoryItems.import_key}
					  AND ro.op_type = 'delete'
					  AND ro.clock_rev = COALESCE(${schema.memoryItems.rev}, 0)
				)`,
			),
		)
		.orderBy(schema.memoryItems.updated_at)
		.limit(limit)
		.all();

	const remaining = Math.max(0, limit - deletedRows.length);
	let rows = deletedRows;
	if (remaining > 0) {
		const upsertRows = d
			.select()
			.from(schema.memoryItems)
			.where(
				and(
					isNull(schema.memoryItems.deleted_at),
					eq(schema.memoryItems.active, 1),
					sql`NOT EXISTS (
						SELECT 1
						FROM replication_ops ro
						WHERE ro.entity_type = 'memory_item'
						  AND ro.entity_id = ${schema.memoryItems.import_key}
						  AND ro.op_type = 'upsert'
						  AND ro.clock_rev = COALESCE(${schema.memoryItems.rev}, 0)
					)`,
				),
			)
			.orderBy(schema.memoryItems.updated_at)
			.limit(remaining)
			.all();
		rows = [...rows, ...upsertRows];
	}

	if (rows.length === 0) return 0;

	const now = new Date().toISOString();
	let inserted = 0;

	for (const row of rows) {
		const rowId = Number(row.id ?? 0);
		if (!rowId) continue;

		const metadata =
			typeof row.metadata_json === "string"
				? fromJson(row.metadata_json)
				: fromJsonNullableLike(row.metadata_json);
		const metadataClockDeviceId =
			typeof metadata.clock_device_id === "string" ? metadata.clock_device_id.trim() : "";
		const originDeviceId =
			metadataClockDeviceId && metadataClockDeviceId !== "local"
				? metadataClockDeviceId
				: localDeviceId;

		let importKey = String(row.import_key ?? "").trim();
		if (!importKey) {
			if (!originDeviceId) continue;
			importKey = `legacy:${originDeviceId}:memory_item:${rowId}`;
			d.update(schema.memoryItems)
				.set({ import_key: importKey })
				.where(eq(schema.memoryItems.id, rowId))
				.run();
		}

		const rev = Number(row.rev ?? 0);
		const active = Number(row.active ?? 1);
		const deletedAt = String(row.deleted_at ?? "").trim();
		const opType: "upsert" | "delete" = deletedAt || active === 0 ? "delete" : "upsert";
		const opId = `backfill:memory_item:${importKey}:${rev}:${opType}`;

		const exists = d
			.select({ one: sql<number>`1` })
			.from(schema.replicationOps)
			.where(eq(schema.replicationOps.op_id, opId))
			.limit(1)
			.get();
		if (exists) continue;

		const clockDeviceId = originDeviceId;
		if (!clockDeviceId) continue;
		const payload = buildPayloadFromMemoryRow(row);

		d.insert(schema.replicationOps)
			.values({
				op_id: opId,
				entity_type: "memory_item",
				entity_id: importKey,
				op_type: opType,
				payload_json: toJson(payload),
				clock_rev: rev,
				clock_updated_at: String(row.updated_at ?? now),
				clock_device_id: clockDeviceId,
				device_id: clockDeviceId,
				created_at: now,
			})
			.onConflictDoNothing()
			.run();

		inserted++;
	}

	return inserted;
}

function fromJsonNullableLike(value: unknown): Record<string, unknown> {
	if (typeof value === "string") return fromJson(value);
	if (value && typeof value === "object") return value as Record<string, unknown>;
	return {};
}

function buildPayloadFromMemoryRow(row: MemoryItemRow): MemoryPayload {
	const parseSqliteJson = (val: unknown): unknown => {
		if (typeof val !== "string") return val ?? null;
		try {
			return JSON.parse(val);
		} catch {
			return val;
		}
	};
	const metadataParsed = parseSqliteJson(row.metadata_json);
	const metadataJson =
		metadataParsed && typeof metadataParsed === "object" && !Array.isArray(metadataParsed)
			? (metadataParsed as Record<string, unknown>)
			: {};

	return {
		session_id: row.session_id ?? null,
		kind: row.kind ?? null,
		title: row.title ?? null,
		subtitle: row.subtitle ?? null,
		body_text: row.body_text ?? null,
		confidence: row.confidence ?? null,
		tags_text: row.tags_text ?? null,
		active: row.active ?? null,
		created_at: row.created_at ?? null,
		updated_at: row.updated_at ?? null,
		metadata_json: metadataJson,
		actor_id: row.actor_id ?? null,
		actor_display_name: row.actor_display_name ?? null,
		visibility: row.visibility ?? null,
		workspace_id: row.workspace_id ?? null,
		workspace_kind: row.workspace_kind ?? null,
		origin_device_id: row.origin_device_id ?? null,
		origin_source: row.origin_source ?? null,
		trust_state: row.trust_state ?? null,
		narrative: row.narrative ?? null,
		facts: parseSqliteJson(row.facts),
		concepts: parseSqliteJson(row.concepts),
		files_read: parseSqliteJson(row.files_read),
		files_modified: parseSqliteJson(row.files_modified),
		user_prompt_id: row.user_prompt_id ?? null,
		prompt_number: row.prompt_number ?? null,
		deleted_at: row.deleted_at ?? null,
		rev: row.rev ?? 0,
		import_key: row.import_key ?? null,
	};
}

/**
 * Apply inbound replication ops from a remote peer.
 *
 * Runs all ops in a single transaction. For each op:
 * - Skips if device_id matches localDeviceId (don't re-apply own ops)
 * - Skips if op_id already exists (idempotent)
 * - For upsert: finds existing memory by import_key; if existing has a newer
 *   clock, counts as conflict and skips; otherwise INSERT or UPDATE
 * - For delete: soft-deletes (active=0, deleted_at) by import_key
 * - Records the applied op in replication_ops
 */
export function applyReplicationOps(
	db: Database,
	ops: ReplicationOp[],
	localDeviceId: string,
): ApplyResult {
	const d = drizzle(db, { schema });
	const result: ApplyResult = { applied: 0, skipped: 0, conflicts: 0, errors: [] };

	const applyAll = db.transaction(() => {
		for (const op of ops) {
			try {
				// Skip own ops
				if (op.device_id === localDeviceId) {
					result.skipped++;
					continue;
				}

				// Idempotent: skip if already applied
				const existing = d
					.select({ one: sql<number>`1` })
					.from(schema.replicationOps)
					.where(eq(schema.replicationOps.op_id, op.op_id))
					.get();
				if (existing) {
					result.skipped++;
					continue;
				}

				if (op.op_type === "upsert") {
					const importKey = op.entity_id;
					const memRow = d
						.select({
							id: schema.memoryItems.id,
							rev: schema.memoryItems.rev,
							updated_at: schema.memoryItems.updated_at,
							metadata_json: schema.memoryItems.metadata_json,
						})
						.from(schema.memoryItems)
						.where(eq(schema.memoryItems.import_key, importKey))
						.get();

					if (memRow) {
						const existingClockDeviceId = clockDeviceIdFromMetadataJson(memRow.metadata_json);
						const existingClock = clockTuple(
							memRow.rev ?? 0,
							memRow.updated_at ?? "",
							existingClockDeviceId,
						);
						const opClock = clockTuple(op.clock_rev, op.clock_updated_at, op.clock_device_id);

						if (!isNewerClock(opClock, existingClock)) {
							result.conflicts++;
							// Still record the op so we don't re-process it
							insertReplicationOpRow(d, op);
							continue;
						}

						// Update existing row from payload — skip if malformed
						const payload = parseMemoryPayload(op, result.errors);
						if (!payload) continue;
						const metaObj = mergePayloadMetadata(payload.metadata_json, op.clock_device_id);

						d.update(schema.memoryItems)
							.set({
								kind: sql`COALESCE(${payload.kind}, ${schema.memoryItems.kind})`,
								title: sql`COALESCE(${payload.title}, ${schema.memoryItems.title})`,
								subtitle: payload.subtitle,
								body_text: sql`COALESCE(${payload.body_text}, ${schema.memoryItems.body_text})`,
								confidence: sql`COALESCE(${payload.confidence != null ? Number(payload.confidence) : null}, ${schema.memoryItems.confidence})`,
								tags_text: sql`COALESCE(${payload.tags_text}, ${schema.memoryItems.tags_text})`,
								active: sql`COALESCE(${payload.active != null ? Number(payload.active) : null}, ${schema.memoryItems.active})`,
								updated_at: op.clock_updated_at,
								metadata_json: toJson(metaObj),
								rev: op.clock_rev,
								deleted_at: payload.deleted_at,
								actor_id: sql`COALESCE(${payload.actor_id}, ${schema.memoryItems.actor_id})`,
								actor_display_name: sql`COALESCE(${payload.actor_display_name}, ${schema.memoryItems.actor_display_name})`,
								visibility: sql`COALESCE(${payload.visibility}, ${schema.memoryItems.visibility})`,
								workspace_id: sql`COALESCE(${payload.workspace_id}, ${schema.memoryItems.workspace_id})`,
								workspace_kind: sql`COALESCE(${payload.workspace_kind}, ${schema.memoryItems.workspace_kind})`,
								origin_device_id: sql`COALESCE(${payload.origin_device_id}, ${schema.memoryItems.origin_device_id})`,
								origin_source: sql`COALESCE(${payload.origin_source}, ${schema.memoryItems.origin_source})`,
								trust_state: sql`COALESCE(${payload.trust_state}, ${schema.memoryItems.trust_state})`,
								narrative: payload.narrative,
								facts: toJsonNullable(payload.facts),
								concepts: toJsonNullable(payload.concepts),
								files_read: toJsonNullable(payload.files_read),
								files_modified: toJsonNullable(payload.files_modified),
							})
							.where(eq(schema.memoryItems.import_key, importKey))
							.run();
					} else {
						// Insert new memory item — skip if malformed
						const payload = parseMemoryPayload(op, result.errors);
						if (!payload) continue;
						const sessionId = ensureSessionForReplication(d, null, op.clock_updated_at);
						const metaObj = mergePayloadMetadata(payload.metadata_json, op.clock_device_id);

						d.insert(schema.memoryItems)
							.values({
								session_id: sessionId,
								kind: payload.kind ?? "discovery",
								title: payload.title ?? "",
								subtitle: payload.subtitle,
								body_text: payload.body_text ?? "",
								confidence: payload.confidence != null ? Number(payload.confidence) : 0.5,
								tags_text: payload.tags_text ?? "",
								active: payload.active != null ? Number(payload.active) : 1,
								created_at: payload.created_at ?? op.clock_updated_at,
								updated_at: op.clock_updated_at,
								metadata_json: toJson(metaObj),
								import_key: importKey,
								deleted_at: payload.deleted_at,
								rev: op.clock_rev,
								actor_id: payload.actor_id,
								actor_display_name: payload.actor_display_name,
								visibility: payload.visibility,
								workspace_id: payload.workspace_id,
								workspace_kind: payload.workspace_kind,
								origin_device_id: payload.origin_device_id,
								origin_source: payload.origin_source,
								trust_state: payload.trust_state,
								narrative: payload.narrative,
								facts: toJsonNullable(payload.facts),
								concepts: toJsonNullable(payload.concepts),
								files_read: toJsonNullable(payload.files_read),
								files_modified: toJsonNullable(payload.files_modified),
							})
							.run();
					}
				} else if (op.op_type === "delete") {
					const importKey = op.entity_id;
					const existingForDelete = d
						.select({
							id: schema.memoryItems.id,
							rev: schema.memoryItems.rev,
							updated_at: schema.memoryItems.updated_at,
							metadata_json: schema.memoryItems.metadata_json,
						})
						.from(schema.memoryItems)
						.where(eq(schema.memoryItems.import_key, importKey))
						.limit(1)
						.get();

					if (existingForDelete) {
						// Clock-compare: only delete if the incoming op is newer
						const existingClock = clockTuple(
							existingForDelete.rev ?? 1,
							existingForDelete.updated_at ?? "",
							clockDeviceIdFromMetadataJson(existingForDelete.metadata_json),
						);
						const incomingClock = clockTuple(op.clock_rev, op.clock_updated_at, op.clock_device_id);
						if (!isNewerClock(incomingClock, existingClock)) {
							result.conflicts++;
							insertReplicationOpRow(d, op);
							continue;
						}
						const now = new Date().toISOString();
						d.update(schema.memoryItems)
							.set({
								active: 0,
								deleted_at: sql`COALESCE(${schema.memoryItems.deleted_at}, ${now})`,
								rev: op.clock_rev,
								updated_at: op.clock_updated_at,
							})
							.where(eq(schema.memoryItems.id, existingForDelete.id))
							.run();
					}
					// If import_key not found, record the op as a tombstone for future resolution
				} else {
					result.skipped++;
					insertReplicationOpRow(d, op);
					continue;
				}

				// Record the applied op
				insertReplicationOpRow(d, op);
				result.applied++;
			} catch (err) {
				result.errors.push(`op ${op.op_id}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	});

	applyAll();
	return result;
}

/** Insert a replication op row into the replication_ops table (ignore on conflict). */
function insertReplicationOpRow(d: ReturnType<typeof drizzle>, op: ReplicationOp): void {
	d.insert(schema.replicationOps)
		.values({
			op_id: op.op_id,
			entity_type: op.entity_type,
			entity_id: op.entity_id,
			op_type: op.op_type,
			payload_json: op.payload_json,
			clock_rev: op.clock_rev,
			clock_updated_at: op.clock_updated_at,
			clock_device_id: op.clock_device_id,
			device_id: op.device_id,
			created_at: op.created_at,
		})
		.onConflictDoNothing()
		.run();
}

/**
 * Ensure a session row exists for replication inserts.
 * Creates a minimal session if one doesn't exist yet.
 */
function ensureSessionForReplication(
	d: ReturnType<typeof drizzle>,
	sessionId: number | null,
	createdAt: string,
): number {
	if (sessionId != null) {
		const row = d
			.select({ id: schema.sessions.id })
			.from(schema.sessions)
			.where(eq(schema.sessions.id, sessionId))
			.get();
		if (row) return sessionId;
	}
	// Create a new session for replicated data
	const now = createdAt || new Date().toISOString();
	const rows = d
		.insert(schema.sessions)
		.values({
			started_at: now,
			user: "sync",
			tool_version: "sync_replication",
			metadata_json: toJson({ source: "sync" }),
		})
		.returning({ id: schema.sessions.id })
		.all();
	const id = rows[0]?.id;
	if (id == null) throw new Error("session insert returned no id");
	return id;
}
