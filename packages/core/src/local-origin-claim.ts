import type { Database } from "./db.js";

/**
 * Records this device as the origin of a memory it wrote before it had a sync
 * identity.
 *
 * A memory written before sync was set up keeps origin "local" (or none), and
 * identity setup deliberately leaves that provenance alone. Once such a memory
 * is shared, peers store the same "local" origin, and they refuse this device's
 * cleanup of it because the stored origin isn't this device. Claiming the
 * origin when the memory moves into a shared Project makes every later payload
 * carry this device's ID.
 *
 * Only rows whose origin is "local", empty or missing, from a session that isn't
 * a sync session, are claimed: the rule share provisioning already uses to treat
 * a memory as this device's own. A row with any other origin is left alone.
 * Call it inside the write transaction that moves the row. Returns whether the
 * row changed; a missing or "local" device ID changes nothing.
 */
export function claimLocalOrigin(db: Database, memoryId: number, deviceId: string): boolean {
	const owner = deviceId.trim();
	// Without a real device ID there is nothing better to record.
	if (!owner || owner === "local") return false;
	return (
		db
			.prepare(
				`UPDATE memory_items SET origin_device_id = ?
				 WHERE id = ?
				   AND COALESCE(TRIM(origin_device_id), '') IN ('', 'local')
				   AND NOT EXISTS (
					SELECT 1 FROM sessions s
					WHERE s.id = memory_items.session_id
					  AND (COALESCE(TRIM(s.user), '') = 'sync'
					       OR COALESCE(TRIM(s.tool_version), '') = 'sync_replication')
				   )`,
			)
			.run(owner, memoryId).changes > 0
	);
}
