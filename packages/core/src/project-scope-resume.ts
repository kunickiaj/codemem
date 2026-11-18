/**
 * Undoing a local withdrawal from a Project. While withdrawn, this device skipped
 * the Project's ops in both directions without recording them, so peers' ops it
 * skipped and its own ops it held back both have to flow again:
 *
 * - Its pull cursor for the boundary is reset with every peer, so the next pass
 *   catches up through the normal membership checks. That is what keeps an undo
 *   from delivering anything this device is no longer entitled to.
 * - Its own memories in the boundary that changed while it was withdrawn get
 *   fresh ops, because the default push already moved past the held-back ones.
 *   Peers apply them idempotently.
 */
import type { Database } from "./db.js";
import { resumeProjectScope } from "./project-scope-withdrawal.js";
import { clearReplicationCursorLastApplied, recordReplicationOp } from "./sync-replication.js";

export interface ResumeProjectScopeSyncResult {
	resumed: boolean;
	resentMemoryCount: number;
}

export function resumeProjectScopeSync(
	db: Database,
	input: { scopeId: string; deviceId: string; now: string },
): ResumeProjectScopeSyncResult {
	return db
		.transaction((): ResumeProjectScopeSyncResult => {
			const withdrawnAt = db
				.prepare("SELECT withdrawn_at FROM project_scope_withdrawals WHERE scope_id = ?")
				.pluck()
				.get(input.scopeId) as string | undefined;
			if (withdrawnAt === undefined) return { resumed: false, resentMemoryCount: 0 };
			resumeProjectScope(db, { scopeId: input.scopeId, now: input.now });
			const peers = db
				.prepare("SELECT DISTINCT peer_device_id FROM replication_cursors_v2 WHERE scope_id = ?")
				.pluck()
				.all(input.scopeId) as string[];
			for (const peer of peers) clearReplicationCursorLastApplied(db, peer, input.scopeId);
			const memories = db
				.prepare(
					`SELECT id, active FROM memory_items
					 WHERE scope_id = ? AND origin_device_id = ? AND updated_at >= ?
					 ORDER BY id`,
				)
				.all(input.scopeId, input.deviceId, withdrawnAt) as Array<{ id: number; active: number }>;
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
