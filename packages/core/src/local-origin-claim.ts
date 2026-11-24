import type { Database } from "./db.js";

/**
 * Session keys `memory import` assigns to every session it creates. Sessions
 * started on a device get a random key instead. A local session from before
 * sessions had keys can also hold an `export-session:` key, so a match means
 * "maybe imported", and callers treat it as imported.
 */
const IMPORTED_SESSION_KEY_PREFIXES = ["export-session:", "export|session|"] as const;

/** Whether `memory import` created the session with this key. */
export function isImportedSessionKey(sessionImportKey: string | null | undefined): boolean {
	if (typeof sessionImportKey !== "string") return false;
	return IMPORTED_SESSION_KEY_PREFIXES.some((prefix) => sessionImportKey.startsWith(prefix));
}

/** Whether a memory's origin names no device: "local", empty or missing. */
export function hasUnattributedOrigin(originDeviceId: string | null | undefined): boolean {
	const origin = typeof originDeviceId === "string" ? originDeviceId.trim() : "";
	return origin === "" || origin === "local";
}

const IMPORTED_SESSION_SQL = IMPORTED_SESSION_KEY_PREFIXES.map(
	() => "substr(s.import_key, 1, ?) = ?",
).join(" OR ");
const IMPORTED_SESSION_PARAMS = IMPORTED_SESSION_KEY_PREFIXES.flatMap((prefix) => [
	prefix.length,
	prefix,
]);

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
 *
 * Rows brought in by `memory import` are left alone too, because an export from
 * another device carries the same "local" origin and nothing shows who wrote it.
 * See `isImportedSessionKey`.
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
					       OR COALESCE(TRIM(s.tool_version), '') = 'sync_replication'
					       OR ${IMPORTED_SESSION_SQL})
				   )`,
			)
			.run(owner, memoryId, ...IMPORTED_SESSION_PARAMS).changes > 0
	);
}
