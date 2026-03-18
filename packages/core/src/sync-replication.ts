/**
 * Sync replication: cursor tracking, op chunking, and payload extraction.
 *
 * Keeps replication functions decoupled from MemoryStore by accepting
 * a raw Database handle. Ported from codemem/sync/replication.py.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { fromJson, toJson } from "./db.js";
import type { ReplicationOp } from "./types.js";

// ---------------------------------------------------------------------------
// Op chunking
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cursor read/write
// ---------------------------------------------------------------------------

/**
 * Read the replication cursor for a peer device.
 *
 * Returns `[lastApplied, lastAcked]` — both null when no cursor exists.
 */
export function getReplicationCursor(
	db: Database,
	peerDeviceId: string,
): [lastApplied: string | null, lastAcked: string | null] {
	const row = db
		.prepare(
			`SELECT last_applied_cursor, last_acked_cursor
			 FROM replication_cursors
			 WHERE peer_device_id = ?`,
		)
		.get(peerDeviceId) as
		| { last_applied_cursor: string | null; last_acked_cursor: string | null }
		| undefined;

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

	// Atomic UPSERT — avoids TOCTOU race with concurrent sync workers
	db.prepare(
		`INSERT INTO replication_cursors(peer_device_id, last_applied_cursor, last_acked_cursor, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(peer_device_id) DO UPDATE SET
			last_applied_cursor = COALESCE(excluded.last_applied_cursor, last_applied_cursor),
			last_acked_cursor = COALESCE(excluded.last_acked_cursor, last_acked_cursor),
			updated_at = excluded.updated_at`,
	).run(peerDeviceId, lastApplied, lastAcked, now);
}

// ---------------------------------------------------------------------------
// Payload extraction
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Clock comparison
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Record a replication op
// ---------------------------------------------------------------------------

/**
 * Generate and INSERT a single replication op for a memory item.
 *
 * Reads the memory item's clock fields (rev, updated_at, metadata_json)
 * from the DB, builds the op row, and inserts into `replication_ops`.
 * Returns the generated op_id (UUID).
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
	const opId = randomUUID();
	const now = new Date().toISOString();

	// Read the full memory row for clock fields and payload
	const row = db.prepare("SELECT * FROM memory_items WHERE id = ?").get(opts.memoryId) as
		| Record<string, unknown>
		| undefined;

	const rev = Number(row?.rev ?? 0);
	const updatedAt = (row?.updated_at as string) ?? now;
	const entityId = (row?.import_key as string) ?? String(opts.memoryId);
	const metadata = fromJson(row?.metadata_json as string | null);
	const clockDeviceId = (metadata.clock_device_id as string) || opts.deviceId;

	// Build payload from the memory row so peers can reconstruct the full item.
	// Explicit payload override takes precedence (used by tests).
	let payloadJson: string | null;
	if (opts.payload) {
		payloadJson = toJson(opts.payload);
	} else if (row && opts.opType === "upsert") {
		// Parse JSON-string columns so they round-trip as objects, not double-encoded strings
		const parseSqliteJson = (val: unknown): unknown => {
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

	db.prepare(
		`INSERT INTO replication_ops(
			op_id, entity_type, entity_id, op_type, payload_json,
			clock_rev, clock_updated_at, clock_device_id, device_id, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		opId,
		"memory_item",
		entityId,
		opts.opType,
		payloadJson,
		rev,
		updatedAt,
		clockDeviceId,
		opts.deviceId,
		now,
	);

	return opId;
}

// ---------------------------------------------------------------------------
// Load replication ops with cursor pagination
// ---------------------------------------------------------------------------

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
	const params: (string | number)[] = [];
	const conditions: string[] = [];

	if (cursor) {
		const parsed = parseCursor(cursor);
		if (parsed) {
			const [createdAt, opId] = parsed;
			conditions.push("(created_at > ? OR (created_at = ? AND op_id > ?))");
			params.push(createdAt, createdAt, opId);
		}
	}

	if (deviceId) {
		conditions.push("(device_id = ? OR device_id = 'local')");
		params.push(deviceId);
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	params.push(limit);

	const rows = db
		.prepare(
			`SELECT op_id, entity_type, entity_id, op_type, payload_json,
				clock_rev, clock_updated_at, clock_device_id, device_id, created_at
			 FROM replication_ops
			 ${whereClause}
			 ORDER BY created_at ASC, op_id ASC
			 LIMIT ?`,
		)
		.all(...params) as Array<{
		op_id: string;
		entity_type: string;
		entity_id: string;
		op_type: string;
		payload_json: string | null;
		clock_rev: number;
		clock_updated_at: string;
		clock_device_id: string;
		device_id: string;
		created_at: string;
	}>;

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

// ---------------------------------------------------------------------------
// Apply inbound replication ops
// ---------------------------------------------------------------------------

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
				const existing = db.prepare("SELECT 1 FROM replication_ops WHERE op_id = ?").get(op.op_id);
				if (existing) {
					result.skipped++;
					continue;
				}

				if (op.op_type === "upsert") {
					const importKey = op.entity_id;
					const memRow = db
						.prepare(
							"SELECT id, rev, updated_at, metadata_json FROM memory_items WHERE import_key = ?",
						)
						.get(importKey) as
						| {
								id: number;
								rev: number | null;
								updated_at: string | null;
								metadata_json: string | null;
						  }
						| undefined;

					if (memRow) {
						const existingMeta = fromJson(memRow.metadata_json);
						const existingClockDeviceId = (existingMeta.clock_device_id as string) || "";
						const existingClock = clockTuple(
							memRow.rev ?? 0,
							memRow.updated_at ?? "",
							existingClockDeviceId,
						);
						const opClock = clockTuple(op.clock_rev, op.clock_updated_at, op.clock_device_id);

						if (!isNewerClock(opClock, existingClock)) {
							result.conflicts++;
							// Still record the op so we don't re-process it
							insertReplicationOpRow(db, op);
							continue;
						}

						// Update existing row from payload
						const payload = op.payload_json ? fromJson(op.payload_json) : {};
						const newMeta = payload.metadata_json ?? {};
						const metaObj =
							typeof newMeta === "object" && newMeta !== null
								? (newMeta as Record<string, unknown>)
								: {};
						metaObj.clock_device_id = op.clock_device_id;

						db.prepare(
							`UPDATE memory_items SET
							kind = COALESCE(?, kind),
							title = COALESCE(?, title),
							subtitle = ?,
							body_text = COALESCE(?, body_text),
							confidence = COALESCE(?, confidence),
							tags_text = COALESCE(?, tags_text),
							active = COALESCE(?, active),
							updated_at = ?,
							metadata_json = ?,
							rev = ?,
							deleted_at = ?,
							actor_id = COALESCE(?, actor_id),
							actor_display_name = COALESCE(?, actor_display_name),
							visibility = COALESCE(?, visibility),
							workspace_id = COALESCE(?, workspace_id),
							workspace_kind = COALESCE(?, workspace_kind),
							origin_device_id = COALESCE(?, origin_device_id),
							origin_source = COALESCE(?, origin_source),
							trust_state = COALESCE(?, trust_state),
							narrative = ?,
							facts = ?,
							concepts = ?,
							files_read = ?,
							files_modified = ?
						WHERE import_key = ?`,
						).run(
							(payload.kind as string) || null,
							(payload.title as string) || null,
							(payload.subtitle as string) ?? null,
							(payload.body_text as string) || null,
							payload.confidence != null ? Number(payload.confidence) : null,
							(payload.tags_text as string) ?? null,
							payload.active != null ? Number(payload.active) : null,
							op.clock_updated_at,
							toJson(metaObj),
							op.clock_rev,
							(payload.deleted_at as string) || null,
							(payload.actor_id as string) ?? null,
							(payload.actor_display_name as string) ?? null,
							(payload.visibility as string) ?? null,
							(payload.workspace_id as string) ?? null,
							(payload.workspace_kind as string) ?? null,
							(payload.origin_device_id as string) ?? null,
							(payload.origin_source as string) ?? null,
							(payload.trust_state as string) ?? null,
							(payload.narrative as string) ?? null,
							toJson(payload.facts ?? null),
							toJson(payload.concepts ?? null),
							toJson(payload.files_read ?? null),
							toJson(payload.files_modified ?? null),
							importKey,
						);
					} else {
						// Insert new memory item — need a local session (never reuse remote session_id)
						const payload = op.payload_json ? fromJson(op.payload_json) : {};
						const sessionId = ensureSessionForReplication(db, null, op.clock_updated_at);

						const newMeta = payload.metadata_json ?? {};
						const metaObj =
							typeof newMeta === "object" && newMeta !== null
								? (newMeta as Record<string, unknown>)
								: {};
						metaObj.clock_device_id = op.clock_device_id;

						db.prepare(
							`INSERT INTO memory_items(
							session_id, kind, title, subtitle, body_text, confidence, tags_text,
							active, created_at, updated_at, metadata_json, import_key,
							deleted_at, rev,
							actor_id, actor_display_name, visibility, workspace_id,
							workspace_kind, origin_device_id, origin_source, trust_state,
							narrative, facts, concepts, files_read, files_modified
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						).run(
							sessionId,
							(payload.kind as string) || "discovery",
							(payload.title as string) || "",
							(payload.subtitle as string) ?? null,
							(payload.body_text as string) || "",
							payload.confidence != null ? Number(payload.confidence) : 0.5,
							(payload.tags_text as string) || "",
							payload.active != null ? Number(payload.active) : 1,
							(payload.created_at as string) || op.clock_updated_at,
							op.clock_updated_at,
							toJson(metaObj),
							importKey,
							(payload.deleted_at as string) || null,
							op.clock_rev,
							(payload.actor_id as string) ?? null,
							(payload.actor_display_name as string) ?? null,
							(payload.visibility as string) ?? null,
							(payload.workspace_id as string) ?? null,
							(payload.workspace_kind as string) ?? null,
							(payload.origin_device_id as string) ?? null,
							(payload.origin_source as string) ?? null,
							(payload.trust_state as string) ?? null,
							(payload.narrative as string) ?? null,
							toJson(payload.facts ?? null),
							toJson(payload.concepts ?? null),
							toJson(payload.files_read ?? null),
							toJson(payload.files_modified ?? null),
						);
					}
				} else if (op.op_type === "delete") {
					const importKey = op.entity_id;
					const existingForDelete = db
						.prepare(
							"SELECT id, rev, updated_at, metadata_json FROM memory_items WHERE import_key = ? LIMIT 1",
						)
						.get(importKey) as Record<string, unknown> | undefined;

					if (existingForDelete) {
						// Clock-compare: only delete if the incoming op is newer
						const existingMeta =
							typeof existingForDelete.metadata_json === "string"
								? (fromJson(existingForDelete.metadata_json) as Record<string, unknown>)
								: {};
						const existingClock = clockTuple(
							Number(existingForDelete.rev ?? 1),
							String(existingForDelete.updated_at ?? ""),
							String(existingMeta.clock_device_id ?? ""),
						);
						const incomingClock = clockTuple(op.clock_rev, op.clock_updated_at, op.clock_device_id);
						if (!isNewerClock(incomingClock, existingClock)) {
							result.conflicts++;
							insertReplicationOpRow(db, op);
							continue;
						}
						const now = new Date().toISOString();
						db.prepare(
							"UPDATE memory_items SET active = 0, deleted_at = COALESCE(deleted_at, ?), rev = ?, updated_at = ? WHERE id = ?",
						).run(now, op.clock_rev, op.clock_updated_at, existingForDelete.id);
					}
					// If import_key not found, record the op as a tombstone for future resolution
				} else {
					result.skipped++;
					insertReplicationOpRow(db, op);
					continue;
				}

				// Record the applied op
				insertReplicationOpRow(db, op);
				result.applied++;
			} catch (err) {
				result.errors.push(`op ${op.op_id}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	});

	applyAll();
	return result;
}

/** Insert a replication op row into the replication_ops table. */
function insertReplicationOpRow(db: Database, op: ReplicationOp): void {
	db.prepare(
		`INSERT OR IGNORE INTO replication_ops(
			op_id, entity_type, entity_id, op_type, payload_json,
			clock_rev, clock_updated_at, clock_device_id, device_id, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		op.op_id,
		op.entity_type,
		op.entity_id,
		op.op_type,
		op.payload_json,
		op.clock_rev,
		op.clock_updated_at,
		op.clock_device_id,
		op.device_id,
		op.created_at,
	);
}

/**
 * Ensure a session row exists for replication inserts.
 * Creates a minimal session if one doesn't exist yet.
 */
function ensureSessionForReplication(
	db: Database,
	sessionId: number | null,
	createdAt: string,
): number {
	if (sessionId != null) {
		const row = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
		if (row) return sessionId;
	}
	// Create a new session for replicated data
	const now = createdAt || new Date().toISOString();
	const info = db
		.prepare(
			`INSERT INTO sessions(started_at, user, tool_version, metadata_json)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(now, "sync", "sync_replication", toJson({ source: "sync" }));
	return Number(info.lastInsertRowid);
}
