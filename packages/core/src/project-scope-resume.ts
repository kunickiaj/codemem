/**
 * Undoing a local withdrawal from a Project. While withdrawn, this device skipped
 * the Project's ops in both directions without recording them, so peers' ops it
 * skipped and its own ops it held back both have to flow again:
 *
 * - Its pull cursor for the boundary is reset with every peer, so the next pass
 *   catches up through the normal membership checks. That is what keeps an undo
 *   from delivering anything this device is no longer entitled to.
 * - Every memory in the boundary whose stored revision this device wrote gets a
 *   fresh op, whoever created the memory. A push while withdrawn moved the
 *   default outbound position past held-back ops, including ones recorded just
 *   before the withdrawal that no peer had received yet. A memory last changed
 *   by another device is left alone, so no remote change is replayed. The fresh
 *   op carries the memory's current clock, so peers apply it idempotently.
 */
import type { Database } from "./db.js";
import { resumeProjectScope } from "./project-scope-withdrawal.js";
import {
	clearReplicationCursorLastApplied,
	clockDeviceIdFromMetadataJson,
	recordReplicationOp,
} from "./sync-replication.js";

export interface ResumeProjectScopeSyncResult {
	resumed: boolean;
	resentMemoryCount: number;
}

/**
 * Memories in the scope whose stored revision this device wrote. Conflict
 * resolution records the winning revision's device as `clock_device_id`; a
 * logged op can't stand in for it, because a losing remote op is logged too.
 * A memory with no recorded clock counts when this device created it, the same
 * fallback `recordReplicationOp` uses.
 */
function memoriesLastChangedHere(
	db: Database,
	scopeId: string,
	deviceId: string,
): Array<{ id: number; active: number }> {
	const rows = db
		.prepare(
			`SELECT id, active, metadata_json, origin_device_id FROM memory_items
			 WHERE scope_id = ? ORDER BY id`,
		)
		.all(scopeId) as Array<{
		id: number;
		active: number;
		metadata_json: string | null;
		origin_device_id: string | null;
	}>;
	return rows
		.filter((row) => {
			const writer = clockDeviceIdFromMetadataJson(row.metadata_json).trim();
			return (writer || row.origin_device_id) === deviceId;
		})
		.map(({ id, active }) => ({ id, active }));
}

export function resumeProjectScopeSync(
	db: Database,
	input: { scopeId: string; deviceId: string; now: string },
): ResumeProjectScopeSyncResult {
	return db
		.transaction((): ResumeProjectScopeSyncResult => {
			if (!resumeProjectScope(db, { scopeId: input.scopeId, now: input.now }))
				return { resumed: false, resentMemoryCount: 0 };
			const peers = db
				.prepare("SELECT DISTINCT peer_device_id FROM replication_cursors_v2 WHERE scope_id = ?")
				.pluck()
				.all(input.scopeId) as string[];
			for (const peer of peers) clearReplicationCursorLastApplied(db, peer, input.scopeId);
			const memories = memoriesLastChangedHere(db, input.scopeId, input.deviceId);
			for (const memory of memories) {
				recordReplicationOp(db, {
					memoryId: memory.id,
					opType: memory.active ? "upsert" : "delete",
					deviceId: input.deviceId,
					createdAt: input.now,
				});
			}
			return { resumed: true, resentMemoryCount: memories.length };
		})
		.immediate();
}
