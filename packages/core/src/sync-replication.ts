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
import { and, eq, gt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import { fromJson, fromJsonStrict, toJson, toJsonNullable } from "./db.js";
import * as schema from "./schema.js";
import type { ReplicationOp } from "./types.js";

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
	const clockDeviceId = (metadata.clock_device_id as string) || opts.deviceId;

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

// Apply inbound replication ops

export interface ApplyResult {
	applied: number;
	skipped: number;
	conflicts: number;
	errors: string[];
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

					const parsePayload = (json: string | null): Record<string, unknown> | null => {
						if (!json) return null;
						try {
							return fromJsonStrict(json);
						} catch (err) {
							result.errors.push(
								`op ${op.op_id}: skipped — payload_json is not a valid object: ${err instanceof Error ? err.message : String(err)}`,
							);
							return null;
						}
					};

					if (memRow) {
						const existingMeta = fromJson(memRow.metadata_json);
						const existingClockDeviceId = (existingMeta.clock_device_id as string) ?? "";
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
						const payload = parsePayload(op.payload_json);
						if (!payload) continue;
						const newMeta = payload.metadata_json ?? {};
						const metaObj =
							typeof newMeta === "object" && newMeta !== null
								? (newMeta as Record<string, unknown>)
								: {};
						metaObj.clock_device_id = op.clock_device_id;

						d.update(schema.memoryItems)
							.set({
								kind: sql`COALESCE(${(payload.kind as string) ?? null}, ${schema.memoryItems.kind})`,
								title: sql`COALESCE(${(payload.title as string) ?? null}, ${schema.memoryItems.title})`,
								subtitle: (payload.subtitle as string) ?? null,
								body_text: sql`COALESCE(${(payload.body_text as string) ?? null}, ${schema.memoryItems.body_text})`,
								confidence: sql`COALESCE(${payload.confidence != null ? Number(payload.confidence) : null}, ${schema.memoryItems.confidence})`,
								tags_text: sql`COALESCE(${(payload.tags_text as string) ?? null}, ${schema.memoryItems.tags_text})`,
								active: sql`COALESCE(${payload.active != null ? Number(payload.active) : null}, ${schema.memoryItems.active})`,
								updated_at: op.clock_updated_at,
								metadata_json: toJson(metaObj),
								rev: op.clock_rev,
								deleted_at: (payload.deleted_at as string) ?? null,
								actor_id: sql`COALESCE(${(payload.actor_id as string) ?? null}, ${schema.memoryItems.actor_id})`,
								actor_display_name: sql`COALESCE(${(payload.actor_display_name as string) ?? null}, ${schema.memoryItems.actor_display_name})`,
								visibility: sql`COALESCE(${(payload.visibility as string) ?? null}, ${schema.memoryItems.visibility})`,
								workspace_id: sql`COALESCE(${(payload.workspace_id as string) ?? null}, ${schema.memoryItems.workspace_id})`,
								workspace_kind: sql`COALESCE(${(payload.workspace_kind as string) ?? null}, ${schema.memoryItems.workspace_kind})`,
								origin_device_id: sql`COALESCE(${(payload.origin_device_id as string) ?? null}, ${schema.memoryItems.origin_device_id})`,
								origin_source: sql`COALESCE(${(payload.origin_source as string) ?? null}, ${schema.memoryItems.origin_source})`,
								trust_state: sql`COALESCE(${(payload.trust_state as string) ?? null}, ${schema.memoryItems.trust_state})`,
								narrative: (payload.narrative as string) ?? null,
								facts: toJsonNullable(payload.facts),
								concepts: toJsonNullable(payload.concepts),
								files_read: toJsonNullable(payload.files_read),
								files_modified: toJsonNullable(payload.files_modified),
							})
							.where(eq(schema.memoryItems.import_key, importKey))
							.run();
					} else {
						// Insert new memory item — skip if malformed
						const payload = parsePayload(op.payload_json);
						if (!payload) continue;
						const sessionId = ensureSessionForReplication(d, null, op.clock_updated_at);

						const newMeta = payload.metadata_json ?? {};
						const metaObj =
							typeof newMeta === "object" && newMeta !== null
								? (newMeta as Record<string, unknown>)
								: {};
						metaObj.clock_device_id = op.clock_device_id;

						d.insert(schema.memoryItems)
							.values({
								session_id: sessionId,
								kind: (payload.kind as string) ?? "discovery",
								title: (payload.title as string) ?? "",
								subtitle: (payload.subtitle as string) ?? null,
								body_text: (payload.body_text as string) ?? "",
								confidence: payload.confidence != null ? Number(payload.confidence) : 0.5,
								tags_text: (payload.tags_text as string) ?? "",
								active: payload.active != null ? Number(payload.active) : 1,
								created_at: (payload.created_at as string) ?? op.clock_updated_at,
								updated_at: op.clock_updated_at,
								metadata_json: toJson(metaObj),
								import_key: importKey,
								deleted_at: (payload.deleted_at as string) ?? null,
								rev: op.clock_rev,
								actor_id: (payload.actor_id as string) ?? null,
								actor_display_name: (payload.actor_display_name as string) ?? null,
								visibility: (payload.visibility as string) ?? null,
								workspace_id: (payload.workspace_id as string) ?? null,
								workspace_kind: (payload.workspace_kind as string) ?? null,
								origin_device_id: (payload.origin_device_id as string) ?? null,
								origin_source: (payload.origin_source as string) ?? null,
								trust_state: (payload.trust_state as string) ?? null,
								narrative: (payload.narrative as string) ?? null,
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
						const existingMeta = fromJson(existingForDelete.metadata_json);
						const existingClock = clockTuple(
							existingForDelete.rev ?? 1,
							existingForDelete.updated_at ?? "",
							String((existingMeta as Record<string, unknown>).clock_device_id ?? ""),
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
