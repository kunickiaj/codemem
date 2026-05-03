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
import { and, desc, eq, gt, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import { fromJson, fromJsonStrict, toJson, toJsonNullable } from "./db.js";
import { readCodememConfigFile } from "./observer-config.js";
import { projectBasename } from "./project.js";
import { clearMemoryRefs, populateMemoryRefs } from "./ref-populate.js";
import * as schema from "./schema.js";
import { getCachedScopeAuthorization } from "./scope-membership-cache.js";
import { ensureMemoryScopeId } from "./scope-stamping.js";
import { redactMemoryFields, SecretScanner } from "./secret-scanner.js";
import { deriveTags } from "./tags.js";
import type {
	ReplicationOp,
	ReplicationOpsAgePrunePlan,
	ReplicationOpsPruneResult,
	SyncDirtyLocalState,
	SyncMemorySnapshotItem,
} from "./types.js";

export const DEFAULT_SYNC_SCOPE_ID = "local-default";

export interface SyncResetBoundary {
	scope_id?: string | null;
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
	retained_floor_cursor: string | null;
}

export interface SyncResetRequired extends SyncResetBoundary {
	reset_required: true;
	reason:
		| "stale_cursor"
		| "generation_mismatch"
		| "boundary_mismatch"
		| "missing_scope"
		| "unsupported_scope";
}

export interface LoadReplicationOpsForPeerOptions {
	since: string | null;
	limit?: number;
	deviceId?: string;
	scopeId?: string | null;
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
	scopeId?: string | null;
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
	scope_id: string | null;
	// Wire payloads use this as "sender explicitly included deleted_at" so we can
	// distinguish a tombstone clear (`deleted_at: null`) from an omitted field.
	// Row-derived payloads set it from current storage truth instead.
	has_deleted_at: boolean;
	rev: number;
	import_key: string | null;
	project?: string | null;
}

function resolveReplicatedTextUpdate(
	nextValue: string | null | undefined,
	currentValue: string | null,
): string {
	if (nextValue == null) return currentValue ?? "";
	return nextValue;
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

/** Coerce an unknown payload field to `string[] | null` for ref population. */
function asStringArrayOrNull(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const strings = value.filter((v): v is string => typeof v === "string");
	return strings.length > 0 ? strings : null;
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
		scope_id: asStringOrNull(raw.scope_id),
		has_deleted_at: Object.hasOwn(raw, "deleted_at"),
		rev: asNumberOrNull(raw.rev) ?? 0,
		import_key: asStringOrNull(raw.import_key),
		project: asStringOrNull(raw.project),
	};
}

/**
 * Resolve tags_text for a replicated memory: use incoming tags if non-empty,
 * otherwise derive tags from available metadata (kind, title, concepts, files).
 */
function resolveReplicatedTags(payload: MemoryPayload): string {
	const incoming = (payload.tags_text ?? "").trim();
	if (incoming) return incoming;
	const concepts = Array.isArray(payload.concepts) ? payload.concepts.map(String) : [];
	const filesRead = Array.isArray(payload.files_read) ? payload.files_read.map(String) : [];
	const filesModified = Array.isArray(payload.files_modified)
		? payload.files_modified.map(String)
		: [];
	const tags = deriveTags({
		kind: payload.kind ?? "",
		title: payload.title ?? undefined,
		concepts,
		filesRead,
		filesModified,
	});
	return tags.join(" ");
}

function normalizeCursor(value: string | null | undefined): string | null {
	const trimmed = String(value ?? "").trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeSyncStateScopeId(scopeId: string | null | undefined): string {
	const trimmed = String(scopeId ?? "").trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_SYNC_SCOPE_ID;
}

function shouldReturnScopeId(scopeId: string | null | undefined): boolean {
	return scopeId !== undefined;
}

function resetBoundaryFromRow(
	row: {
		generation: number | null;
		snapshot_id: string | null;
		baseline_cursor: string | null;
		retained_floor_cursor: string | null;
	},
	scopeId: string,
	includeScopeId: boolean,
): SyncResetBoundary {
	const boundary: SyncResetBoundary = {
		generation: Number(row.generation ?? 1),
		snapshot_id: String(row.snapshot_id),
		baseline_cursor: normalizeCursor(row.baseline_cursor),
		retained_floor_cursor: normalizeCursor(row.retained_floor_cursor),
	};
	if (includeScopeId) boundary.scope_id = scopeId;
	return boundary;
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
	db.exec(`
		CREATE TABLE IF NOT EXISTS sync_reset_state_v2 (
			scope_id TEXT PRIMARY KEY NOT NULL,
			generation INTEGER NOT NULL,
			snapshot_id TEXT NOT NULL,
			baseline_cursor TEXT,
			retained_floor_cursor TEXT,
			updated_at TEXT NOT NULL
		)
	`);
}

function seedDefaultSyncResetStateFromLegacy(db: Database): void {
	db.exec(`
		INSERT OR IGNORE INTO sync_reset_state_v2
			(scope_id, generation, snapshot_id, baseline_cursor, retained_floor_cursor, updated_at)
		SELECT '${DEFAULT_SYNC_SCOPE_ID}', generation, snapshot_id, baseline_cursor, retained_floor_cursor, updated_at
		FROM sync_reset_state
		WHERE id = 1
	`);
}

function mirrorDefaultSyncResetStateToLegacy(
	db: Database,
	boundary: SyncResetBoundary,
	updatedAt: string,
): void {
	const d = drizzle(db, { schema });
	d.insert(schema.syncResetState)
		.values({
			id: 1,
			generation: boundary.generation,
			snapshot_id: boundary.snapshot_id,
			baseline_cursor: boundary.baseline_cursor,
			retained_floor_cursor: boundary.retained_floor_cursor,
			updated_at: updatedAt,
		})
		.onConflictDoUpdate({
			target: schema.syncResetState.id,
			set: {
				generation: boundary.generation,
				snapshot_id: boundary.snapshot_id,
				baseline_cursor: boundary.baseline_cursor,
				retained_floor_cursor: boundary.retained_floor_cursor,
				updated_at: updatedAt,
			},
		})
		.run();
}

export function getSyncResetState(db: Database, scopeId?: string | null): SyncResetBoundary {
	ensureSyncResetStateTable(db);
	const effectiveScopeId = normalizeSyncStateScopeId(scopeId);
	const includeScopeId = shouldReturnScopeId(scopeId);
	if (effectiveScopeId === DEFAULT_SYNC_SCOPE_ID) {
		seedDefaultSyncResetStateFromLegacy(db);
	}
	const d = drizzle(db, { schema });
	const existing = d
		.select()
		.from(schema.syncResetStateV2)
		.where(eq(schema.syncResetStateV2.scope_id, effectiveScopeId))
		.get();
	if (existing) {
		return resetBoundaryFromRow(existing, effectiveScopeId, includeScopeId);
	}

	const now = new Date().toISOString();
	const created = {
		scope_id: effectiveScopeId,
		generation: 1,
		snapshot_id: randomUUID(),
		baseline_cursor: null,
		retained_floor_cursor: null,
		updated_at: now,
	};
	d.insert(schema.syncResetStateV2).values(created).run();
	const boundary = resetBoundaryFromRow(created, effectiveScopeId, includeScopeId);
	if (effectiveScopeId === DEFAULT_SYNC_SCOPE_ID) {
		mirrorDefaultSyncResetStateToLegacy(db, boundary, now);
	}
	return boundary;
}

export function setSyncResetState(
	db: Database,
	updates: Partial<SyncResetBoundary> & { generation?: number },
	scopeId?: string | null,
): SyncResetBoundary {
	const requestedScopeId = scopeId !== undefined ? scopeId : updates.scope_id;
	const effectiveScopeId = normalizeSyncStateScopeId(requestedScopeId);
	const includeScopeId = scopeId !== undefined || updates.scope_id !== undefined;
	const current = getSyncResetState(db, includeScopeId ? effectiveScopeId : undefined);
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
	if (includeScopeId) next.scope_id = effectiveScopeId;
	const d = drizzle(db, { schema });
	d.insert(schema.syncResetStateV2)
		.values({
			scope_id: effectiveScopeId,
			generation: next.generation,
			snapshot_id: next.snapshot_id,
			baseline_cursor: next.baseline_cursor,
			retained_floor_cursor: next.retained_floor_cursor,
			updated_at: now,
		})
		.onConflictDoUpdate({
			target: schema.syncResetStateV2.scope_id,
			set: {
				generation: next.generation,
				snapshot_id: next.snapshot_id,
				baseline_cursor: next.baseline_cursor,
				retained_floor_cursor: next.retained_floor_cursor,
				updated_at: now,
			},
		})
		.run();
	if (effectiveScopeId === DEFAULT_SYNC_SCOPE_ID) {
		mirrorDefaultSyncResetStateToLegacy(db, next, now);
	}
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

function ensureReplicationCursorTables(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS replication_cursors (
			peer_device_id TEXT PRIMARY KEY,
			last_applied_cursor TEXT,
			last_acked_cursor TEXT,
			updated_at TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS replication_cursors_v2 (
			peer_device_id TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			last_applied_cursor TEXT,
			last_acked_cursor TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (peer_device_id, scope_id)
		);
		CREATE INDEX IF NOT EXISTS idx_replication_cursors_v2_scope
			ON replication_cursors_v2(scope_id)
	`);
}

function seedDefaultReplicationCursorFromLegacy(db: Database): void {
	db.exec(`
		INSERT OR IGNORE INTO replication_cursors_v2
			(peer_device_id, scope_id, last_applied_cursor, last_acked_cursor, updated_at)
		SELECT peer_device_id, '${DEFAULT_SYNC_SCOPE_ID}', last_applied_cursor, last_acked_cursor, updated_at
		FROM replication_cursors
	`);
}

function mirrorDefaultReplicationCursorToLegacy(
	db: Database,
	peerDeviceId: string,
	options: { lastApplied?: string | null; lastAcked?: string | null },
	updatedAt: string,
): void {
	const lastApplied = options.lastApplied ?? null;
	const lastAcked = options.lastAcked ?? null;
	const d = drizzle(db, { schema });
	d.insert(schema.replicationCursors)
		.values({
			peer_device_id: peerDeviceId,
			last_applied_cursor: lastApplied,
			last_acked_cursor: lastAcked,
			updated_at: updatedAt,
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

/**
 * Read the replication cursor for a peer device.
 *
 * Returns `[lastApplied, lastAcked]` — both null when no cursor exists.
 */
export function getReplicationCursor(
	db: Database,
	peerDeviceId: string,
	scopeId?: string | null,
): [lastApplied: string | null, lastAcked: string | null] {
	ensureReplicationCursorTables(db);
	const effectiveScopeId = normalizeSyncStateScopeId(scopeId);
	if (effectiveScopeId === DEFAULT_SYNC_SCOPE_ID) {
		seedDefaultReplicationCursorFromLegacy(db);
	}
	const d = drizzle(db, { schema });
	const row = d
		.select({
			last_applied_cursor: schema.replicationCursorsV2.last_applied_cursor,
			last_acked_cursor: schema.replicationCursorsV2.last_acked_cursor,
		})
		.from(schema.replicationCursorsV2)
		.where(
			and(
				eq(schema.replicationCursorsV2.peer_device_id, peerDeviceId),
				eq(schema.replicationCursorsV2.scope_id, effectiveScopeId),
			),
		)
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
	scopeId?: string | null,
): void {
	ensureReplicationCursorTables(db);
	const now = new Date().toISOString();
	const effectiveScopeId = normalizeSyncStateScopeId(scopeId);
	if (effectiveScopeId === DEFAULT_SYNC_SCOPE_ID) {
		seedDefaultReplicationCursorFromLegacy(db);
	}
	const lastApplied = options.lastApplied ?? null;
	const lastAcked = options.lastAcked ?? null;

	const d = drizzle(db, { schema });
	// Atomic UPSERT — avoids TOCTOU race with concurrent sync workers.
	// Drizzle's onConflictDoUpdate doesn't support COALESCE(excluded.col, col)
	// natively, so we use raw SQL for the SET expressions.
	d.insert(schema.replicationCursorsV2)
		.values({
			peer_device_id: peerDeviceId,
			scope_id: effectiveScopeId,
			last_applied_cursor: lastApplied,
			last_acked_cursor: lastAcked,
			updated_at: now,
		})
		.onConflictDoUpdate({
			target: [schema.replicationCursorsV2.peer_device_id, schema.replicationCursorsV2.scope_id],
			set: {
				last_applied_cursor: sql`COALESCE(excluded.last_applied_cursor, ${schema.replicationCursorsV2.last_applied_cursor})`,
				last_acked_cursor: sql`COALESCE(excluded.last_acked_cursor, ${schema.replicationCursorsV2.last_acked_cursor})`,
				updated_at: sql`excluded.updated_at`,
			},
		})
		.run();
	if (effectiveScopeId === DEFAULT_SYNC_SCOPE_ID) {
		mirrorDefaultReplicationCursorToLegacy(db, peerDeviceId, options, now);
	}
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
		scopeId?: string | null;
		clockRev?: number;
		clockUpdatedAt?: string;
		clockDeviceId?: string;
		createdAt?: string;
		opId?: string;
	},
): string {
	const d = drizzle(db, { schema });
	const opId = opts.opId ?? randomUUID();
	const now = opts.createdAt ?? new Date().toISOString();

	// Read the full memory row — typed via Drizzle schema
	const row = d
		.select()
		.from(schema.memoryItems)
		.where(eq(schema.memoryItems.id, opts.memoryId))
		.get();

	const rev = opts.clockRev ?? Number(row?.rev ?? 0);
	const updatedAt = opts.clockUpdatedAt ?? row?.updated_at ?? now;
	const entityId = row?.import_key ?? String(opts.memoryId);
	const metadata = fromJson(row?.metadata_json);
	// Backfill missing memory scope before emitting an op so storage, op row,
	// and payload all carry the same authoritative local scope.
	const scopeId =
		opts.scopeId !== undefined ? opts.scopeId : row ? ensureMemoryScopeId(db, opts.memoryId) : null;
	const clockDeviceId =
		typeof opts.clockDeviceId === "string" && opts.clockDeviceId.trim().length > 0
			? opts.clockDeviceId.trim()
			: typeof metadata.clock_device_id === "string" && metadata.clock_device_id.trim().length > 0
				? metadata.clock_device_id
				: opts.deviceId;

	// Resolve session project so peers can reconstruct the project association.
	const sessionProject = row?.session_id
		? (d
				.select({ project: schema.sessions.project })
				.from(schema.sessions)
				.where(eq(schema.sessions.id, row.session_id))
				.get()?.project ?? null)
		: null;

	// Build payload from the memory row so peers can reconstruct the full item.
	// Explicit payload override wins except for authoritative scope_id on upserts.
	let payloadJson: string | null;
	if (opts.payload) {
		payloadJson = toJson(
			row && opts.opType === "upsert" ? { ...opts.payload, scope_id: scopeId } : opts.payload,
		);
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
			project: sessionProject,
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
			scope_id: scopeId,
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
			scope_id: scopeId,
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
	scopeId?: string | null,
): [ReplicationOp[], string | null] {
	const d = drizzle(db, { schema });
	const t = schema.replicationOps;
	const conditions = [];
	const scopeFilterRequested = scopeId !== undefined;
	const effectiveScopeId = normalizeSyncStateScopeId(scopeId);

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

	if (scopeFilterRequested) {
		conditions.push(
			effectiveScopeId === DEFAULT_SYNC_SCOPE_ID
				? or(isNull(t.scope_id), eq(t.scope_id, DEFAULT_SYNC_SCOPE_ID))
				: eq(t.scope_id, effectiveScopeId),
		);
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
		scope_id: r.scope_id,
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
	const scopeFilterRequested = options.scopeId !== undefined;
	const effectiveScopeId = normalizeSyncStateScopeId(options.scopeId);
	const boundary = getSyncResetState(db, scopeFilterRequested ? options.scopeId : undefined);
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

	const [ops, nextCursor] = loadReplicationOpsSince(
		db,
		since,
		options.limit,
		options.deviceId,
		effectiveScopeId,
	);
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
	const scopeFilterRequested = options.scopeId !== undefined;
	const effectiveScopeId = normalizeSyncStateScopeId(options.scopeId);
	const boundary = getSyncResetState(db, scopeFilterRequested ? options.scopeId : undefined);
	if (options.generation !== boundary.generation) {
		throw new Error("generation_mismatch");
	}
	if (normalizeCursor(options.snapshotId) !== boundary.snapshot_id) {
		throw new Error("boundary_mismatch");
	}
	if (normalizeCursor(options.baselineCursor) !== boundary.baseline_cursor) {
		throw new Error("boundary_mismatch");
	}

	// Cap raised to 5000 to support elevated bootstrap page sizes (default 2000).
	const limit = Math.max(1, Math.min(options.limit ?? 200, 5000));
	const pageToken = parseSnapshotPageToken(options.pageToken);
	const d = drizzle(db, { schema });
	// Scan batch must be >= limit so high page sizes don't degrade into
	// multiple keyset-pagination round-trips per page.
	const scanBatchSize = Math.max(limit, Math.min(limit * 3, 10000));
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
					effectiveScopeId === DEFAULT_SYNC_SCOPE_ID
						? or(
								isNull(schema.memoryItems.scope_id),
								eq(schema.memoryItems.scope_id, DEFAULT_SYNC_SCOPE_ID),
							)
						: eq(schema.memoryItems.scope_id, effectiveScopeId),
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
				(replicationOpRequiresPersonalScopeAuthorization(
					{ scope_id: row.memory.scope_id },
					payload as unknown as Record<string, unknown>,
				) ||
					!syncVisibilityAllowed(payload as unknown as Record<string, unknown>)) &&
				!peerCanSyncPrivateOpByPersonalScopeGrant(
					db,
					{ scope_id: row.memory.scope_id },
					payload as unknown as Record<string, unknown>,
					options.peerDeviceId ?? null,
				)
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
			// Include session project in the payload so targets can associate
			// replicated memories with the correct project.
			const payloadWithProject = { ...payload, project: row.sessionProject ?? null };
			items.push({
				entity_id: importKey,
				op_type: row.memory.deleted_at || row.memory.active === 0 ? "delete" : "upsert",
				payload_json: toJson(payloadWithProject),
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
	// Single SQL query replacing the old O(N×M) JS loop that loaded every
	// memory item then queried replication_ops per-row.  This uses NOT EXISTS
	// to find shared memories whose current rev lacks a matching replication op,
	// which is exactly the "dirty" condition the old loop was checking.
	//
	// Visibility matching follows syncVisibilityAllowed semantics:
	//  - explicit 'shared', 'shared:default', 'shared:legacy' → sync-eligible
	//  - NULL/empty visibility with non-private content → sync-eligible (legacy default)
	//  - explicit 'private' or 'personal:*' → not sync-eligible
	const stmt = db.prepare(`
		SELECT count(*) as n FROM (
			SELECT 1 FROM memory_items m
			WHERE m.import_key IS NOT NULL
			  AND COALESCE(m.visibility, '') NOT LIKE 'private%'
			  AND COALESCE(m.visibility, '') NOT LIKE 'personal%'
			  AND NOT EXISTS (
				SELECT 1 FROM replication_ops r
				WHERE r.entity_type = 'memory_item'
				  AND r.entity_id = m.import_key
				  AND r.op_type = CASE WHEN m.deleted_at IS NOT NULL OR m.active = 0 THEN 'delete' ELSE 'upsert' END
				  AND r.clock_rev = COALESCE(m.rev, 0)
			  )
			LIMIT ?
		)
	`);
	const row = stmt.get(limit) as { n: number } | undefined;
	const count = Number(row?.n ?? 0);
	return { dirty: count > 0, count };
}

export function pruneReplicationOps(
	db: Database,
	options?: {
		maxAgeDays?: number;
		maxSizeBytes?: number;
		maxDeleteOps?: number;
		maxRuntimeMs?: number;
		scopeId?: string | null;
	},
): ReplicationOpsPruneResult {
	const maxAgeDays = Math.max(1, Math.floor(options?.maxAgeDays ?? 30));
	const maxSizeBytes = Math.max(1, Math.floor(options?.maxSizeBytes ?? 512 * 1024 * 1024));
	const maxDeleteOps = Math.max(1, Math.floor(options?.maxDeleteOps ?? Number.MAX_SAFE_INTEGER));
	const maxRuntimeMs = Math.max(1, Math.floor(options?.maxRuntimeMs ?? Number.MAX_SAFE_INTEGER));
	const scopeId = normalizeSyncStateScopeId(options?.scopeId);
	const d = drizzle(db, { schema });
	const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
	const startedAt = Date.now();
	let deleted = 0;
	let lastDeletedCursor: string | null = null;
	const deleteThroughCursor = (createdAt: string, opId: string): number => {
		const floorCursor = computeCursor(createdAt, opId);
		return db
			.transaction(() => {
				const result =
					scopeId === DEFAULT_SYNC_SCOPE_ID
						? (db
								.prepare(
									`DELETE FROM replication_ops
									 WHERE (scope_id IS NULL OR scope_id = ?)
									   AND (created_at < ? OR (created_at = ? AND op_id <= ?))`,
								)
								.run(scopeId, createdAt, createdAt, opId) as { changes?: number })
						: (db
								.prepare(
									`DELETE FROM replication_ops
									 WHERE scope_id = ?
									   AND (created_at < ? OR (created_at = ? AND op_id <= ?))`,
								)
								.run(scopeId, createdAt, createdAt, opId) as { changes?: number });
				const changes = result.changes ?? 0;
				if (changes > 0) {
					setSyncResetState(db, { retained_floor_cursor: floorCursor }, scopeId);
				}
				return changes;
			})
			.immediate();
	};
	const estimatedBytesBefore = estimateReplicationOpsScopeBytes(db, scopeId);
	if (estimatedBytesBefore == null) {
		throw new Error("replication_ops_size_unavailable");
	}
	let stoppedByBudget = false;
	const budgetExceeded = () => deleted >= maxDeleteOps || Date.now() - startedAt >= maxRuntimeMs;

	while (true) {
		if (budgetExceeded()) {
			stoppedByBudget = true;
			break;
		}
		const remainingDeleteBudget = Math.max(1, maxDeleteOps - deleted);
		const ageBatchSize = Math.max(1, Math.min(remainingDeleteBudget, 10_000));
		const ageCandidates = d
			.select({
				op_id: schema.replicationOps.op_id,
				created_at: schema.replicationOps.created_at,
			})
			.from(schema.replicationOps)
			.where(
				and(
					sql`${schema.replicationOps.created_at} < ${cutoff}`,
					scopeId === DEFAULT_SYNC_SCOPE_ID
						? or(
								isNull(schema.replicationOps.scope_id),
								eq(schema.replicationOps.scope_id, scopeId),
							)
						: eq(schema.replicationOps.scope_id, scopeId),
				),
			)
			.orderBy(schema.replicationOps.created_at, schema.replicationOps.op_id)
			.limit(ageBatchSize)
			.all();
		if (ageCandidates.length === 0) break;
		const boundary = ageCandidates[ageCandidates.length - 1];
		if (!boundary) break;
		lastDeletedCursor = computeCursor(String(boundary.created_at), String(boundary.op_id));
		deleted += deleteThroughCursor(String(boundary.created_at), String(boundary.op_id));
		if (budgetExceeded()) {
			stoppedByBudget = true;
			break;
		}
		if (ageCandidates.length < ageBatchSize) break;
	}

	let estimatedSizeBytes = estimatedBytesBefore;
	while (estimatedSizeBytes > maxSizeBytes) {
		if (budgetExceeded()) {
			stoppedByBudget = true;
			break;
		}
		const remainingDeleteBudget = Math.max(1, maxDeleteOps - deleted);
		const sizeBatchSize = Math.max(1, Math.min(remainingDeleteBudget, 10_000));
		const oldestChunk = d
			.select({
				op_id: schema.replicationOps.op_id,
				created_at: schema.replicationOps.created_at,
			})
			.from(schema.replicationOps)
			.where(
				scopeId === DEFAULT_SYNC_SCOPE_ID
					? or(isNull(schema.replicationOps.scope_id), eq(schema.replicationOps.scope_id, scopeId))
					: eq(schema.replicationOps.scope_id, scopeId),
			)
			.orderBy(schema.replicationOps.created_at, schema.replicationOps.op_id)
			.limit(sizeBatchSize)
			.all();
		const boundary = oldestChunk[oldestChunk.length - 1];
		if (!boundary) break;
		lastDeletedCursor = computeCursor(String(boundary.created_at), String(boundary.op_id));
		deleted += deleteThroughCursor(String(boundary.created_at), String(boundary.op_id));
		const nextEstimatedSize = estimateReplicationOpsScopeBytes(db, scopeId);
		if (nextEstimatedSize == null) {
			throw new Error("replication_ops_size_unavailable");
		}
		estimatedSizeBytes = nextEstimatedSize;
	}

	const currentBoundary = getSyncResetState(db, scopeId);
	const retainedFloorCursor =
		deleted > 0 ? lastDeletedCursor : currentBoundary.retained_floor_cursor;
	return {
		deleted,
		retained_floor_cursor: retainedFloorCursor,
		estimated_bytes_before: estimatedBytesBefore,
		estimated_bytes_after: estimatedSizeBytes,
		stopped_by_budget: stoppedByBudget,
	};
}

export interface ReplicationOpsPruneLoopResult {
	totalDeleted: number;
	passes: number;
	lastFloor: string | null;
	afterBytes: number;
	stoppedByBudget: boolean;
}

export function pruneReplicationOpsUntilCaughtUp(
	db: Database,
	options: {
		maxAgeDays: number;
		maxSizeBytes: number;
		maxDeleteOps: number;
		maxRuntimeMs: number;
		scopeId?: string | null;
		maxPasses?: number;
		signal?: AbortSignal;
		onPass?: (pass: {
			passNumber: number;
			deleted: number;
			afterBytes: number;
			stoppedByBudget: boolean;
		}) => void;
	},
): ReplicationOpsPruneLoopResult {
	const maxPasses = Math.max(1, Math.floor(options.maxPasses ?? 25));
	let totalDeleted = 0;
	let passes = 0;
	let lastFloor: string | null = null;
	let afterBytes = estimateReplicationOpsStorageBytes(db) ?? 0;
	let stoppedByBudget = false;

	while (true) {
		if (options.signal?.aborted || passes >= maxPasses) {
			stoppedByBudget = true;
			break;
		}
		const result = pruneReplicationOps(db, options);
		passes += 1;
		totalDeleted += result.deleted;
		lastFloor = result.retained_floor_cursor;
		afterBytes = result.estimated_bytes_after ?? estimateReplicationOpsStorageBytes(db) ?? 0;
		stoppedByBudget = result.stopped_by_budget ?? false;
		options.onPass?.({
			passNumber: passes,
			deleted: result.deleted,
			afterBytes,
			stoppedByBudget,
		});
		if (result.deleted === 0 || !result.stopped_by_budget) break;
	}

	return {
		totalDeleted,
		passes,
		lastFloor,
		afterBytes,
		stoppedByBudget,
	};
}

export function bulkPruneReplicationOpsByAgeCutoff(
	db: Database,
	maxAgeDays: number,
	maxDeleteOps = Number.MAX_SAFE_INTEGER,
	scopeIdInput?: string | null,
): ReplicationOpsPruneResult {
	const d = drizzle(db, { schema });
	const scopeId = normalizeSyncStateScopeId(scopeIdInput);
	const cutoff = new Date(
		Date.now() - Math.max(1, Math.floor(maxAgeDays)) * 24 * 60 * 60 * 1000,
	).toISOString();
	const estimatedBytesBefore = estimateReplicationOpsScopeBytes(db, scopeId);
	if (estimatedBytesBefore == null) {
		throw new Error("replication_ops_size_unavailable");
	}
	const oldestEligible = d
		.select({ op_id: schema.replicationOps.op_id, created_at: schema.replicationOps.created_at })
		.from(schema.replicationOps)
		.where(
			and(
				sql`${schema.replicationOps.created_at} < ${cutoff}`,
				scopeId === DEFAULT_SYNC_SCOPE_ID
					? or(isNull(schema.replicationOps.scope_id), eq(schema.replicationOps.scope_id, scopeId))
					: eq(schema.replicationOps.scope_id, scopeId),
			),
		)
		.orderBy(schema.replicationOps.created_at, schema.replicationOps.op_id)
		.limit(Math.max(1, maxDeleteOps))
		.all();
	const boundary = oldestEligible[oldestEligible.length - 1];
	if (!boundary) {
		const currentBoundary = getSyncResetState(db, scopeId);
		return {
			deleted: 0,
			retained_floor_cursor: currentBoundary.retained_floor_cursor,
			estimated_bytes_before: estimatedBytesBefore,
			estimated_bytes_after: estimatedBytesBefore,
			stopped_by_budget: false,
		};
	}
	const retainedFloorCursor = computeCursor(String(boundary.created_at), String(boundary.op_id));
	const deleted = db
		.transaction(() => {
			const result =
				scopeId === DEFAULT_SYNC_SCOPE_ID
					? (db
							.prepare(
								`DELETE FROM replication_ops
								 WHERE (scope_id IS NULL OR scope_id = ?)
								   AND (created_at < ? OR (created_at = ? AND op_id <= ?))`,
							)
							.run(scopeId, boundary.created_at, boundary.created_at, boundary.op_id) as {
							changes?: number;
						})
					: (db
							.prepare(
								`DELETE FROM replication_ops
								 WHERE scope_id = ?
								   AND (created_at < ? OR (created_at = ? AND op_id <= ?))`,
							)
							.run(scopeId, boundary.created_at, boundary.created_at, boundary.op_id) as {
							changes?: number;
						});
			const changes = result.changes ?? 0;
			if (changes > 0) {
				setSyncResetState(db, { retained_floor_cursor: retainedFloorCursor }, scopeId);
			}
			return changes;
		})
		.immediate();
	const estimatedBytesAfter = estimateReplicationOpsScopeBytes(db, scopeId);
	if (estimatedBytesAfter == null) {
		throw new Error("replication_ops_size_unavailable");
	}
	return {
		deleted,
		retained_floor_cursor: retainedFloorCursor,
		estimated_bytes_before: estimatedBytesBefore,
		estimated_bytes_after: estimatedBytesAfter,
		stopped_by_budget: false,
	};
}

export function planReplicationOpsAgePrune(
	db: Database,
	maxAgeDays: number,
	batchOps: number,
): ReplicationOpsAgePrunePlan {
	const d = drizzle(db, { schema });
	const cutoff = new Date(
		Date.now() - Math.max(1, Math.floor(maxAgeDays)) * 24 * 60 * 60 * 1000,
	).toISOString();
	const countRow = d
		.select({ total: sql<number>`COUNT(*)` })
		.from(schema.replicationOps)
		.where(sql`${schema.replicationOps.created_at} < ${cutoff}`)
		.get();
	const totalCountRow = d
		.select({ total: sql<number>`COUNT(*)` })
		.from(schema.replicationOps)
		.get();
	const boundary = d
		.select({ op_id: schema.replicationOps.op_id, created_at: schema.replicationOps.created_at })
		.from(schema.replicationOps)
		.where(sql`${schema.replicationOps.created_at} < ${cutoff}`)
		.orderBy(desc(schema.replicationOps.created_at), desc(schema.replicationOps.op_id))
		.limit(1)
		.get();
	const candidateOps = Number(countRow?.total ?? 0);
	const totalOps = Number(totalCountRow?.total ?? 0);
	const estimatedTotalBytes = estimateReplicationOpsStorageBytes(db) ?? 0;
	const estimatedCandidateBytes =
		totalOps > 0 ? Math.round((estimatedTotalBytes * candidateOps) / totalOps) : 0;
	return {
		candidate_ops: candidateOps,
		estimated_candidate_bytes: Math.max(0, estimatedCandidateBytes),
		cutoff_cursor: boundary
			? computeCursor(String(boundary.created_at), String(boundary.op_id))
			: null,
		estimated_batches: candidateOps > 0 ? Math.ceil(candidateOps / Math.max(1, batchOps)) : 0,
	};
}

function estimateReplicationOpsStorageBytes(db: Database): number | null {
	try {
		const row = db
			.prepare(
				`SELECT COALESCE(SUM(pgsize), 0) AS total_bytes
				 FROM dbstat
				 WHERE name = 'replication_ops'
				    OR name LIKE 'idx_replication_ops_%'
				    OR name LIKE 'sqlite_autoindex_replication_ops_%'`,
			)
			.get() as { total_bytes?: number | string | null } | undefined;
		const total = Number(row?.total_bytes ?? 0);
		return Number.isFinite(total) && total >= 0 ? total : null;
	} catch {
		return null;
	}
}

export function estimateReplicationOpsScopeBytes(db: Database, scopeId: string): number | null {
	const estimateSql = `SELECT COALESCE(SUM(
		LENGTH(COALESCE(op_id, '')) +
		LENGTH(COALESCE(entity_type, '')) +
		LENGTH(COALESCE(entity_id, '')) +
		LENGTH(COALESCE(op_type, '')) +
		LENGTH(COALESCE(payload_json, '')) +
		LENGTH(COALESCE(clock_updated_at, '')) +
		LENGTH(COALESCE(clock_device_id, '')) +
		LENGTH(COALESCE(device_id, '')) +
		LENGTH(COALESCE(created_at, '')) +
		LENGTH(COALESCE(scope_id, '')) +
		96
	), 0) AS total_bytes
	FROM replication_ops
	WHERE ${scopeId === DEFAULT_SYNC_SCOPE_ID ? "scope_id IS NULL OR scope_id = ?" : "scope_id = ?"}`;
	try {
		const row = db.prepare(estimateSql).get(scopeId) as
			| { total_bytes?: number | string | null }
			| undefined;
		const total = Number(row?.total_bytes ?? 0);
		return Number.isFinite(total) && total >= 0 ? total : null;
	} catch {
		return null;
	}
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
	return syncProjectAllowedByFilters(project, { include, exclude });
}

export function syncProjectAllowedByFilters(
	projectValue: string | null,
	filters: { include: string[]; exclude: string[] },
): boolean {
	const value = String(projectValue ?? "").trim();
	const valueBase = projectBasename(value);
	for (const blocked of filters.exclude) {
		if (blocked === value || blocked === valueBase) return false;
	}
	if (filters.include.length === 0) return true;
	for (const allowed of filters.include) {
		if (allowed === value || allowed === valueBase) return true;
	}
	return false;
}

export function syncVisibilityAllowed(payload: Record<string, unknown> | null): boolean {
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

function cleanText(value: unknown): string | null {
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed.length > 0 ? trimmed : null;
}

export interface PersonalScopeGrantStatus {
	scope_id: string | null;
	authorized: boolean;
	state: string;
}

export function personalScopeGrantStatusForPeer(
	db: Database,
	input: { peerDeviceId: string | null; actorId: string | null },
): PersonalScopeGrantStatus {
	const peerDeviceId = cleanText(input.peerDeviceId);
	const actorId = cleanText(input.actorId);
	if (!peerDeviceId || !actorId) {
		return { scope_id: null, authorized: false, state: "missing_peer_or_actor" };
	}
	const scopeId = `personal:${actorId}`;
	const auth = getCachedScopeAuthorization(db, { deviceId: peerDeviceId, scopeId });
	return { scope_id: scopeId, authorized: auth.authorized, state: auth.state };
}

function personalScopeAuthorizationRequirement(
	op: Pick<ReplicationOp, "scope_id">,
	payload: Record<string, unknown> | null,
): { required: boolean; scopeId: string | null } {
	const metadata =
		payload?.metadata_json &&
		typeof payload.metadata_json === "object" &&
		!Array.isArray(payload.metadata_json)
			? (payload.metadata_json as Record<string, unknown>)
			: {};
	const opScopeId = cleanText(op.scope_id);
	const payloadScopeId = cleanText(payload?.scope_id);
	const visibility = cleanText(payload?.visibility ?? metadata.visibility)?.toLowerCase() ?? null;
	const workspaceId = cleanText(payload?.workspace_id ?? metadata.workspace_id);
	const workspaceKind =
		cleanText(payload?.workspace_kind ?? metadata.workspace_kind)?.toLowerCase() ?? null;
	const actorId = cleanText(payload?.actor_id ?? metadata.actor_id);
	const personalWorkspaceId = workspaceId?.startsWith("personal:") ? workspaceId : null;
	const hasPersonalSignal =
		visibility === "private" ||
		visibility === "personal" ||
		workspaceKind === "personal" ||
		Boolean(personalWorkspaceId);
	const actorScopeId = actorId && hasPersonalSignal ? `personal:${actorId}` : null;
	const candidates = [opScopeId, payloadScopeId, personalWorkspaceId, actorScopeId].filter(
		(candidate): candidate is string => Boolean(candidate?.startsWith("personal:")),
	);
	const scopeId = candidates[0] ?? null;
	if (!scopeId) return { required: hasPersonalSignal, scopeId: null };
	if (candidates.some((candidate) => candidate !== scopeId)) {
		return { required: true, scopeId: null };
	}
	return { required: true, scopeId };
}

export function replicationOpRequiresPersonalScopeAuthorization(
	op: Pick<ReplicationOp, "scope_id">,
	payload: Record<string, unknown> | null,
): boolean {
	return personalScopeAuthorizationRequirement(op, payload).required;
}

export function peerCanSyncPrivateOpByPersonalScopeGrant(
	db: Database,
	op: Pick<ReplicationOp, "scope_id">,
	payload: Record<string, unknown> | null,
	peerDeviceId: string | null,
): boolean {
	const { scopeId } = personalScopeAuthorizationRequirement(op, payload);
	if (!scopeId) return false;
	const actorId = scopeId.slice("personal:".length);
	return personalScopeGrantStatusForPeer(db, { peerDeviceId, actorId }).authorized;
}

function parsePayload(payloadJson: string | null): Record<string, unknown> | null {
	if (!payloadJson?.trim()) return null;
	try {
		const parsed = JSON.parse(payloadJson) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

export interface FilterReplicationSkipped {
	reason: "scope_filter" | "visibility_filter" | "project_filter";
	op_id: string;
	created_at: string;
	entity_type: string;
	entity_id: string;
	skipped_count: number;
	project?: string | null;
	scope_id?: string | null;
	visibility?: string | null;
}

export interface FilterReplicationOpsForSyncOptions {
	localDeviceId?: string | null;
	applyScopeFilter?: boolean;
}

interface ExistingMemoryFilterContext {
	payload: Record<string, unknown>;
	project: string | null;
	scopeId: string | null;
}

function addSkipped(
	state: { count: number; first: FilterReplicationSkipped | null },
	op: ReplicationOp,
	skipped: Pick<FilterReplicationSkipped, "reason"> &
		Partial<Omit<FilterReplicationSkipped, "reason" | "skipped_count">>,
): void {
	state.count += 1;
	if (!state.first) {
		state.first = {
			...skipped,
			op_id: op.op_id,
			created_at: op.created_at,
			entity_type: op.entity_type,
			entity_id: op.entity_id,
			skipped_count: 0,
		};
	}
}

function metadataRecord(payload: Record<string, unknown> | null): Record<string, unknown> {
	const metadata = payload?.metadata_json;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
	return metadata as Record<string, unknown>;
}

function payloadScopeId(payload: Record<string, unknown> | null): string | null {
	const metadata = metadataRecord(payload);
	return cleanText(payload?.scope_id ?? metadata.scope_id);
}

function payloadContradictsOutboundScope(
	op: Pick<ReplicationOp, "scope_id">,
	payload: Record<string, unknown> | null,
): boolean {
	const opScopeId = cleanText(op.scope_id);
	const explicitPayloadScopeId = payloadScopeId(payload);
	if (explicitPayloadScopeId && explicitPayloadScopeId !== opScopeId) return true;
	if (!opScopeId) return explicitPayloadScopeId != null;

	const personalRequirement = personalScopeAuthorizationRequirement(op, payload);
	return Boolean(
		personalRequirement.required &&
			personalRequirement.scopeId &&
			personalRequirement.scopeId !== opScopeId,
	);
}

function existingMemoryFilterContext(
	db: Database,
	importKey: string,
): ExistingMemoryFilterContext | null {
	const key = cleanText(importKey);
	if (!key) return null;
	const row = db
		.prepare(
			`SELECT
				m.actor_id,
				m.metadata_json,
				m.scope_id,
				m.visibility,
				m.workspace_id,
				m.workspace_kind,
				s.project
			 FROM memory_items m
			 LEFT JOIN sessions s ON s.id = m.session_id
			 WHERE m.import_key = ?
			 LIMIT 1`,
		)
		.get(key) as
		| {
				actor_id: string | null;
				metadata_json: string | null;
				project: string | null;
				scope_id: string | null;
				visibility: string | null;
				workspace_id: string | null;
				workspace_kind: string | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		payload: {
			actor_id: row.actor_id,
			metadata_json: fromJson(row.metadata_json),
			visibility: row.visibility,
			workspace_id: row.workspace_id,
			workspace_kind: row.workspace_kind,
		},
		project: cleanText(row.project),
		scopeId: cleanText(row.scope_id),
	};
}

function outboundScopeAllowed(
	db: Database,
	op: ReplicationOp,
	payload: Record<string, unknown> | null,
	peerDeviceId: string | null,
	localDeviceId: string | null,
): boolean {
	if (payloadContradictsOutboundScope(op, payload)) return false;
	const scopeId = cleanText(op.scope_id);
	if (!scopeId) return true;
	if (scopeId === DEFAULT_SYNC_SCOPE_ID) return false;
	const peerId = cleanText(peerDeviceId);
	if (!peerId) return false;
	const peerAuth = getCachedScopeAuthorization(db, { deviceId: peerId, scopeId });
	if (!peerAuth.authorized || peerAuth.scope?.authority_type === "local") return false;
	const localId = cleanText(localDeviceId);
	if (!localId) return true;
	const localAuth = getCachedScopeAuthorization(db, { deviceId: localId, scopeId });
	return localAuth.authorized && localAuth.scope?.authority_type !== "local";
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
	options: FilterReplicationOpsForSyncOptions = {},
): [ReplicationOp[], string | null, FilterReplicationSkipped | null] {
	const allowed: ReplicationOp[] = [];
	let nextCursor: string | null = null;
	const skipped = { count: 0, first: null as FilterReplicationSkipped | null };
	const applyScopeFilter = options.applyScopeFilter !== false;
	for (const op of ops) {
		if (op.entity_type === "memory_item") {
			const payload = parsePayload(op.payload_json);
			if (
				applyScopeFilter &&
				!outboundScopeAllowed(db, op, payload, peerDeviceId, options.localDeviceId ?? null)
			) {
				addSkipped(skipped, op, { reason: "scope_filter", scope_id: cleanText(op.scope_id) });
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}
			if (op.op_type === "delete" && payload == null) {
				const existing = existingMemoryFilterContext(db, op.entity_id);
				if (existing) {
					if (applyScopeFilter && existing.scopeId && existing.scopeId !== cleanText(op.scope_id)) {
						addSkipped(skipped, op, { reason: "scope_filter", scope_id: cleanText(op.scope_id) });
						nextCursor = computeCursor(op.created_at, op.op_id);
						continue;
					}
					if (
						(replicationOpRequiresPersonalScopeAuthorization(op, existing.payload) ||
							!syncVisibilityAllowed(existing.payload)) &&
						!peerCanSyncPrivateOpByPersonalScopeGrant(db, op, existing.payload, peerDeviceId)
					) {
						addSkipped(skipped, op, {
							reason: "visibility_filter",
							visibility:
								typeof existing.payload.visibility === "string"
									? String(existing.payload.visibility)
									: null,
						});
						nextCursor = computeCursor(op.created_at, op.op_id);
						continue;
					}
					if (!syncProjectAllowed(db, existing.project, peerDeviceId)) {
						addSkipped(skipped, op, {
							reason: "project_filter",
							project: existing.project,
						});
						nextCursor = computeCursor(op.created_at, op.op_id);
						continue;
					}
				}
				if (
					replicationOpRequiresPersonalScopeAuthorization(op, payload) &&
					!peerCanSyncPrivateOpByPersonalScopeGrant(db, op, payload, peerDeviceId)
				) {
					addSkipped(skipped, op, { reason: "visibility_filter" });
					nextCursor = computeCursor(op.created_at, op.op_id);
					continue;
				}
				allowed.push(op);
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}
			if (
				(replicationOpRequiresPersonalScopeAuthorization(op, payload) ||
					!syncVisibilityAllowed(payload)) &&
				!peerCanSyncPrivateOpByPersonalScopeGrant(db, op, payload, peerDeviceId)
			) {
				addSkipped(skipped, op, {
					reason: "visibility_filter",
					visibility: typeof payload?.visibility === "string" ? String(payload.visibility) : null,
				});
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}

			const project =
				typeof payload?.project === "string" && payload.project.trim()
					? payload.project.trim()
					: null;
			if (!syncProjectAllowed(db, project, peerDeviceId)) {
				addSkipped(skipped, op, { reason: "project_filter", project });
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}
		}

		allowed.push(op);
		nextCursor = computeCursor(op.created_at, op.op_id);
	}

	if (skipped.first) {
		skipped.first.skipped_count = skipped.count;
	}

	return [allowed, nextCursor, skipped.first];
}

export function filterReplicationOpsForSync(
	db: Database,
	ops: ReplicationOp[],
	peerDeviceId: string | null,
	options: FilterReplicationOpsForSyncOptions = {},
): [ReplicationOp[], string | null] {
	const [allowed, nextCursor] = filterReplicationOpsForSyncWithStatus(
		db,
		ops,
		peerDeviceId,
		options,
	);
	return [allowed, nextCursor];
}

// Apply inbound replication ops

export interface ApplyResult {
	applied: number;
	skipped: number;
	rejected: number;
	conflicts: number;
	errors: string[];
	rejections: InboundScopeRejection[];
	vectorWork: ReplicationVectorWork;
}

export interface ReplicationVectorWork {
	upsertMemoryIds: number[];
	deleteMemoryIds: number[];
}

export type InboundScopeRejectionReason =
	| "missing_scope"
	| "sender_not_member"
	| "receiver_not_member"
	| "stale_epoch"
	| "scope_mismatch";

export interface InboundScopeRejection {
	op_id: string;
	entity_type: string;
	entity_id: string;
	scope_id: string | null;
	peer_device_id: string | null;
	reason: InboundScopeRejectionReason;
}

export interface InboundScopeValidationOptions {
	peerDeviceId?: string | null;
	enabled?: boolean;
}

export interface ApplyReplicationOpsOptions {
	inboundScopeValidation?: InboundScopeValidationOptions | null;
}

type CachedScopeAuthorizationResult = ReturnType<typeof getCachedScopeAuthorization>;

function inboundScopeRejection(
	op: ReplicationOp,
	reason: InboundScopeRejectionReason,
	peerDeviceId: string | null,
	scopeId: string | null,
): InboundScopeRejection {
	return {
		op_id: op.op_id,
		entity_type: op.entity_type,
		entity_id: op.entity_id,
		scope_id: scopeId,
		peer_device_id: peerDeviceId,
		reason,
	};
}

function normalizeInboundScopeId(value: unknown): string | null {
	return cleanText(value);
}

function metadataObject(payload: Record<string, unknown> | null): Record<string, unknown> {
	const metadata = payload?.metadata_json;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
	return metadata as Record<string, unknown>;
}

function payloadContradictsInboundScope(
	opScopeId: string,
	payload: Record<string, unknown> | null,
): boolean {
	const metadata = metadataObject(payload);
	const payloadScopeId = cleanText(payload?.scope_id ?? metadata.scope_id);
	if (payloadScopeId && payloadScopeId !== opScopeId) return true;

	const workspaceId = cleanText(payload?.workspace_id ?? metadata.workspace_id);
	if (workspaceId?.startsWith("personal:") && workspaceId !== opScopeId) return true;

	const workspaceKind = cleanText(
		payload?.workspace_kind ?? metadata.workspace_kind,
	)?.toLowerCase();
	const actorId = cleanText(payload?.actor_id ?? metadata.actor_id);
	if (workspaceKind === "personal" && actorId && `personal:${actorId}` !== opScopeId) {
		return true;
	}

	return false;
}

function authorizationFailureReason(
	auth: CachedScopeAuthorizationResult,
	notMemberReason: "sender_not_member" | "receiver_not_member",
): InboundScopeRejectionReason | null {
	if (auth.authorized) return null;
	if (
		!auth.scope ||
		auth.state === "revoked" ||
		auth.state === "stale_epoch" ||
		auth.state === "scope_unknown" ||
		auth.state === "scope_inactive"
	) {
		return "stale_epoch";
	}
	return notMemberReason;
}

function validateInboundScopeOp(
	db: Database,
	op: ReplicationOp,
	localDeviceId: string,
	options: InboundScopeValidationOptions,
): InboundScopeRejection | null {
	const peerDeviceId = cleanText(options.peerDeviceId) ?? cleanText(op.device_id);
	const senderDeviceId = peerDeviceId ?? cleanText(op.clock_device_id);
	const receiverDeviceId = cleanText(localDeviceId);
	const opScopeId = normalizeInboundScopeId(op.scope_id);

	if (!opScopeId) return inboundScopeRejection(op, "missing_scope", peerDeviceId, null);
	if (opScopeId === DEFAULT_SYNC_SCOPE_ID) {
		return inboundScopeRejection(op, "scope_mismatch", peerDeviceId, opScopeId);
	}

	const payload = parsePayload(op.payload_json);
	if (payloadContradictsInboundScope(opScopeId, payload)) {
		return inboundScopeRejection(op, "scope_mismatch", peerDeviceId, opScopeId);
	}

	if (
		!senderDeviceId ||
		cleanText(op.device_id) !== senderDeviceId ||
		cleanText(op.clock_device_id) !== senderDeviceId
	) {
		return inboundScopeRejection(op, "sender_not_member", peerDeviceId, opScopeId);
	}

	const senderAuth = getCachedScopeAuthorization(db, {
		deviceId: senderDeviceId,
		scopeId: opScopeId,
	});
	const senderFailure = authorizationFailureReason(senderAuth, "sender_not_member");
	if (senderFailure) return inboundScopeRejection(op, senderFailure, peerDeviceId, opScopeId);

	if (!receiverDeviceId) {
		return inboundScopeRejection(op, "receiver_not_member", peerDeviceId, opScopeId);
	}
	const receiverAuth = getCachedScopeAuthorization(db, {
		deviceId: receiverDeviceId,
		scopeId: opScopeId,
	});
	const receiverFailure = authorizationFailureReason(receiverAuth, "receiver_not_member");
	if (receiverFailure) return inboundScopeRejection(op, receiverFailure, peerDeviceId, opScopeId);

	return null;
}

function validateInboundScopeBatch(
	db: Database,
	ops: ReplicationOp[],
	localDeviceId: string,
	options: InboundScopeValidationOptions,
): InboundScopeRejection[] {
	const rejections: InboundScopeRejection[] = [];
	const expectedPeerDeviceId = cleanText(options.peerDeviceId);
	for (const op of ops) {
		if (!expectedPeerDeviceId && op.device_id === localDeviceId) continue;
		const rejection = validateInboundScopeOp(db, op, localDeviceId, options);
		if (rejection) rejections.push(rejection);
	}
	return rejections;
}

function ensureSyncScopeRejectionLogTable(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sync_scope_rejections (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			peer_device_id TEXT,
			op_id TEXT NOT NULL,
			entity_type TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			scope_id TEXT,
			reason TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_sync_scope_rejections_peer_created
			ON sync_scope_rejections(peer_device_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_sync_scope_rejections_scope_created
			ON sync_scope_rejections(scope_id, created_at);
	`);
}

function recordInboundScopeRejections(db: Database, rejections: InboundScopeRejection[]): void {
	if (rejections.length === 0) return;
	ensureSyncScopeRejectionLogTable(db);
	const now = new Date().toISOString();
	const insert = db.prepare(
		`INSERT INTO sync_scope_rejections(
			peer_device_id, op_id, entity_type, entity_id, scope_id, reason, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	db.transaction(() => {
		for (const rejection of rejections) {
			insert.run(
				rejection.peer_device_id,
				rejection.op_id,
				rejection.entity_type,
				rejection.entity_id,
				rejection.scope_id,
				rejection.reason,
				now,
			);
		}
	})();
}

function emptyApplyResult(): ApplyResult {
	return {
		applied: 0,
		skipped: 0,
		rejected: 0,
		conflicts: 0,
		errors: [],
		rejections: [],
		vectorWork: { upsertMemoryIds: [], deleteMemoryIds: [] },
	};
}

export function rejectInboundScopeFailures(
	db: Database,
	ops: ReplicationOp[],
	localDeviceId: string,
	options: InboundScopeValidationOptions,
): ApplyResult | null {
	if (options.enabled === false) return null;
	const rejections = validateInboundScopeBatch(db, ops, localDeviceId, options);
	if (rejections.length === 0) return null;
	const result = emptyApplyResult();
	result.rejected = rejections.length;
	result.rejections = rejections;
	result.errors.push(
		...rejections.map((rejection) => `op ${rejection.op_id}: rejected — ${rejection.reason}`),
	);
	try {
		recordInboundScopeRejections(db, rejections);
	} catch (err) {
		result.errors.push(
			`scope rejection log failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return result;
}

/** Aggregate counts of recorded inbound-scope rejections per peer device. */
export interface InboundScopeRejectionPeerSummary {
	peer_device_id: string | null;
	total: number;
	by_reason: Partial<Record<InboundScopeRejectionReason, number>>;
	last_at: string | null;
}

export interface InboundScopeRejectionSummaryOptions {
	/** ISO timestamp; rejections older than this are ignored. */
	sinceIso?: string;
	/** Optional: only summarize rejections recorded for this peer. */
	peerDeviceId?: string | null;
}

/**
 * Read-only summary of recorded inbound-scope rejections grouped by peer.
 * Pure aggregate over the rejection log — never reads payloads (the log
 * does not store any). Used by the sync API to render reason-code
 * breakdowns without exposing op contents.
 */
export function summarizeInboundScopeRejections(
	db: Database,
	options: InboundScopeRejectionSummaryOptions = {},
): InboundScopeRejectionPeerSummary[] {
	if (!syncScopeRejectionsTableExists(db)) return [];
	const params: unknown[] = [];
	const filters: string[] = [];
	if (options.sinceIso) {
		filters.push(`created_at >= ?`);
		params.push(options.sinceIso);
	}
	if (options.peerDeviceId !== undefined) {
		const id = cleanText(options.peerDeviceId);
		if (id === null) {
			filters.push(`peer_device_id IS NULL`);
		} else {
			filters.push(`peer_device_id = ?`);
			params.push(id);
		}
	}
	const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
	const rows = db
		.prepare(
			`SELECT peer_device_id, reason, COUNT(*) AS count, MAX(created_at) AS last_at
			   FROM sync_scope_rejections
			   ${where}
			  GROUP BY peer_device_id, reason`,
		)
		.all(...params) as Array<{
		peer_device_id: string | null;
		reason: string;
		count: number;
		last_at: string | null;
	}>;

	const summaries = new Map<string, InboundScopeRejectionPeerSummary>();
	for (const row of rows) {
		const key = row.peer_device_id ?? "";
		let entry = summaries.get(key);
		if (!entry) {
			entry = {
				peer_device_id: row.peer_device_id ?? null,
				total: 0,
				by_reason: {},
				last_at: null,
			};
			summaries.set(key, entry);
		}
		const reason = row.reason as InboundScopeRejectionReason;
		const count = Number(row.count ?? 0);
		entry.by_reason[reason] = (entry.by_reason[reason] ?? 0) + count;
		entry.total += count;
		if (row.last_at && (!entry.last_at || row.last_at > entry.last_at)) {
			entry.last_at = row.last_at;
		}
	}
	return Array.from(summaries.values());
}

export interface InboundScopeRejectionRecord extends InboundScopeRejection {
	id: number;
	created_at: string;
}

export interface ListInboundScopeRejectionsOptions {
	peerDeviceId?: string | null;
	sinceIso?: string;
	limit?: number;
}

/**
 * List recently recorded inbound-scope rejections (newest first). Each row
 * is metadata only — op id, entity ref, scope id, reason, timestamp — and
 * never includes op payloads (the log does not store them).
 */
export function listInboundScopeRejections(
	db: Database,
	options: ListInboundScopeRejectionsOptions = {},
): InboundScopeRejectionRecord[] {
	if (!syncScopeRejectionsTableExists(db)) return [];
	const params: unknown[] = [];
	const filters: string[] = [];
	if (options.sinceIso) {
		filters.push(`created_at >= ?`);
		params.push(options.sinceIso);
	}
	if (options.peerDeviceId !== undefined) {
		const id = cleanText(options.peerDeviceId);
		if (id === null) {
			filters.push(`peer_device_id IS NULL`);
		} else {
			filters.push(`peer_device_id = ?`);
			params.push(id);
		}
	}
	const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
	const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
	const rows = db
		.prepare(
			`SELECT id, peer_device_id, op_id, entity_type, entity_id, scope_id, reason, created_at
			   FROM sync_scope_rejections
			   ${where}
			  ORDER BY created_at DESC, id DESC
			  LIMIT ?`,
		)
		.all(...params, limit) as Array<{
		id: number;
		peer_device_id: string | null;
		op_id: string;
		entity_type: string;
		entity_id: string;
		scope_id: string | null;
		reason: string;
		created_at: string;
	}>;
	return rows.map((row) => ({
		id: Number(row.id),
		peer_device_id: row.peer_device_id ?? null,
		op_id: row.op_id,
		entity_type: row.entity_type,
		entity_id: row.entity_id,
		scope_id: row.scope_id ?? null,
		reason: row.reason as InboundScopeRejectionReason,
		created_at: row.created_at,
	}));
}

function syncScopeRejectionsTableExists(db: Database): boolean {
	const row = db
		.prepare(
			`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_scope_rejections' LIMIT 1`,
		)
		.get();
	return Boolean(row);
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
		const scopeId = ensureMemoryScopeId(db, rowId);
		const payload = buildPayloadFromMemoryRow({ ...row, scope_id: scopeId });

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
				scope_id: scopeId,
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
		scope_id: row.scope_id ?? null,
		has_deleted_at: row.deleted_at != null,
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
	scanner?: SecretScanner,
	options: ApplyReplicationOpsOptions = {},
): ApplyResult {
	const d = drizzle(db, { schema });
	// Peer-shipped content goes through the same redaction policy as
	// locally-authored writes. Callers that maintain their own scanner
	// (typically a MemoryStore instance) should pass it so workspace-level
	// rule overrides apply uniformly. Otherwise fall back to defaults.
	const activeScanner = scanner ?? new SecretScanner();
	const result: ApplyResult = emptyApplyResult();
	const inboundScopeValidation = options.inboundScopeValidation;
	if (inboundScopeValidation) {
		const rejected = rejectInboundScopeFailures(db, ops, localDeviceId, inboundScopeValidation);
		if (rejected) return rejected;
	}
	const upsertMemoryIds = new Set<number>();
	const deleteMemoryIds = new Set<number>();
	const queueVectorUpsert = (memoryId: number): void => {
		if (!Number.isInteger(memoryId) || memoryId <= 0) return;
		deleteMemoryIds.delete(memoryId);
		upsertMemoryIds.add(memoryId);
	};
	const queueVectorDelete = (memoryId: number): void => {
		if (!Number.isInteger(memoryId) || memoryId <= 0) return;
		upsertMemoryIds.delete(memoryId);
		deleteMemoryIds.add(memoryId);
	};

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
					const opScopeId =
						typeof op.scope_id === "string" && op.scope_id.trim().length > 0
							? op.scope_id.trim()
							: null;
					const memRow = d
						.select({
							id: schema.memoryItems.id,
							rev: schema.memoryItems.rev,
							updated_at: schema.memoryItems.updated_at,
							title: schema.memoryItems.title,
							body_text: schema.memoryItems.body_text,
							active: schema.memoryItems.active,
							deleted_at: schema.memoryItems.deleted_at,
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
						redactMemoryFields(payload, activeScanner);
						const metaObj = mergePayloadMetadata(payload.metadata_json, op.clock_device_id);
						const nextTitle = resolveReplicatedTextUpdate(payload.title, memRow.title);
						const nextBodyText = resolveReplicatedTextUpdate(payload.body_text, memRow.body_text);
						const contentChanged =
							nextTitle !== (memRow.title ?? "") || nextBodyText !== (memRow.body_text ?? "");
						const wasInactive = Number(memRow.active ?? 1) === 0 || memRow.deleted_at != null;
						const nextActive =
							payload.active != null ? Number(payload.active) : Number(memRow.active ?? 1);
						const nextDeletedAt = payload.has_deleted_at
							? payload.deleted_at
							: (memRow.deleted_at ?? null);
						const becomesActive = nextActive !== 0 && nextDeletedAt == null;
						const shouldDeleteVectors =
							payload.deleted_at != null ||
							(payload.active != null && Number(payload.active) === 0);
						const shouldQueueVectorUpsert =
							!shouldDeleteVectors && (contentChanged || (wasInactive && becomesActive));

						d.update(schema.memoryItems)
							.set({
								kind: sql`COALESCE(${payload.kind}, ${schema.memoryItems.kind})`,
								title: sql`COALESCE(${payload.title}, ${schema.memoryItems.title})`,
								subtitle: payload.subtitle,
								body_text: sql`COALESCE(${payload.body_text}, ${schema.memoryItems.body_text})`,
								confidence: sql`COALESCE(${payload.confidence != null ? Number(payload.confidence) : null}, ${schema.memoryItems.confidence})`,
								tags_text: sql`COALESCE(NULLIF(TRIM(${payload.tags_text}), ''), ${schema.memoryItems.tags_text})`,
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
								user_prompt_id: payload.user_prompt_id,
								prompt_number: payload.prompt_number,
								scope_id: sql`COALESCE(${opScopeId}, ${schema.memoryItems.scope_id})`,
							})
							.where(eq(schema.memoryItems.import_key, importKey))
							.run();
						// Re-populate junction tables with updated file/concept refs
						clearMemoryRefs(db, Number(memRow.id));
						populateMemoryRefs(
							db,
							Number(memRow.id),
							asStringArrayOrNull(payload.files_read),
							asStringArrayOrNull(payload.files_modified),
							asStringArrayOrNull(payload.concepts),
						);
						if (shouldDeleteVectors) queueVectorDelete(Number(memRow.id));
						else if (shouldQueueVectorUpsert) queueVectorUpsert(Number(memRow.id));
					} else {
						// Insert new memory item — skip if malformed
						const payload = parseMemoryPayload(op, result.errors);
						if (!payload) continue;
						redactMemoryFields(payload, activeScanner);
						const replicatedProject =
							typeof payload.project === "string" && payload.project.trim()
								? payload.project.trim()
								: null;
						const sessionId = ensureSessionForReplication(
							d,
							null,
							op.clock_updated_at,
							replicatedProject,
						);
						const metaObj = mergePayloadMetadata(payload.metadata_json, op.clock_device_id);
						const insertedRows = d
							.insert(schema.memoryItems)
							.values({
								session_id: sessionId,
								kind: payload.kind ?? "discovery",
								title: payload.title ?? "",
								subtitle: payload.subtitle,
								body_text: payload.body_text ?? "",
								confidence: payload.confidence != null ? Number(payload.confidence) : 0.5,
								tags_text: resolveReplicatedTags(payload),
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
								user_prompt_id: payload.user_prompt_id,
								prompt_number: payload.prompt_number,
								scope_id: opScopeId,
							})
							.returning({ id: schema.memoryItems.id })
							.all();
						const insertedId = Number(insertedRows[0]?.id ?? 0);
						// Populate junction tables for the new memory
						populateMemoryRefs(
							db,
							insertedId,
							asStringArrayOrNull(payload.files_read),
							asStringArrayOrNull(payload.files_modified),
							asStringArrayOrNull(payload.concepts),
						);
						if (payload.deleted_at != null || Number(payload.active ?? 1) === 0) {
							queueVectorDelete(insertedId);
						} else {
							queueVectorUpsert(insertedId);
						}
					}
				} else if (op.op_type === "delete") {
					const importKey = op.entity_id;
					const opScopeId =
						typeof op.scope_id === "string" && op.scope_id.trim().length > 0
							? op.scope_id.trim()
							: null;
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
						const deleteMetadata = fromJson(existingForDelete.metadata_json);
						deleteMetadata.clock_device_id = op.clock_device_id;
						d.update(schema.memoryItems)
							.set({
								active: 0,
								deleted_at: sql`COALESCE(${schema.memoryItems.deleted_at}, ${now})`,
								rev: op.clock_rev,
								updated_at: op.clock_updated_at,
								metadata_json: toJson(deleteMetadata),
								scope_id: sql`COALESCE(${opScopeId}, ${schema.memoryItems.scope_id})`,
							})
							.where(eq(schema.memoryItems.id, existingForDelete.id))
							.run();
						queueVectorDelete(Number(existingForDelete.id));
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
	result.vectorWork = {
		upsertMemoryIds: [...upsertMemoryIds],
		deleteMemoryIds: [...deleteMemoryIds],
	};
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
			scope_id: op.scope_id ?? null,
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
	project?: string | null,
): number {
	if (sessionId != null) {
		const row = d
			.select({ id: schema.sessions.id })
			.from(schema.sessions)
			.where(eq(schema.sessions.id, sessionId))
			.get();
		if (row) return sessionId;
	}
	// Create a new session for replicated data, preserving the source project.
	const now = createdAt || new Date().toISOString();
	const rows = d
		.insert(schema.sessions)
		.values({
			started_at: now,
			project: project ?? null,
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
