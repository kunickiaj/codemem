/**
 * Sync replication: cursor tracking, op chunking, and payload extraction.
 *
 * Keeps replication functions decoupled from MemoryStore by accepting
 * a raw Database handle. Ported from codemem/sync/replication.py.
 */

import type { Database } from "./db.js";
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
