import type { Database } from "./db.js";

/**
 * Session key prefix only `memory import` assigns, for exports without a
 * canonical session key. The canonical `export-session:` key isn't evidence:
 * export bookkeeping also writes it onto sessions started on this device.
 */
const LEGACY_IMPORTED_SESSION_KEY_PREFIX = "export|session|";

function hasExportSource(metadataJson: string | null | undefined): boolean {
	if (typeof metadataJson !== "string") return false;
	try {
		const metadata = JSON.parse(metadataJson) as unknown;
		return (
			typeof metadata === "object" &&
			metadata !== null &&
			!Array.isArray(metadata) &&
			(metadata as Record<string, unknown>).source === "export"
		);
	} catch {
		return false;
	}
}

/**
 * Whether `memory import` brought the memory in.
 *
 * Import records `"source": "export"` in the metadata of every memory it
 * inserts and every session it creates, and local edits keep existing metadata
 * keys. The memory's own marker matters because import can add memories to an
 * existing session started on this device, when the export names that
 * session's key. Sessions and memories written on a device don't carry the
 * marker unless a caller supplies it, which no caller does, and a match only
 * ever leaves a memory out.
 */
export function isImportedMemory(memory: {
	metadataJson: string | null | undefined;
	sessionImportKey: string | null | undefined;
	sessionMetadataJson: string | null | undefined;
}): boolean {
	if (memory.sessionImportKey?.startsWith(LEGACY_IMPORTED_SESSION_KEY_PREFIX)) return true;
	return hasExportSource(memory.metadataJson) || hasExportSource(memory.sessionMetadataJson);
}

/**
 * Metadata for an incoming update that keeps this device's record that
 * `memory import` brought the memory in. Without it, a peer's update could drop
 * the only sign that the memory isn't this device's own.
 */
export function keepImportMarker(
	incoming: Record<string, unknown>,
	existingMetadataJson: string | null | undefined,
): Record<string, unknown> {
	return hasExportSource(existingMetadataJson) ? { ...incoming, source: "export" } : incoming;
}

/** Whether a memory's origin names no device: "local", empty or missing. */
export function hasUnattributedOrigin(originDeviceId: string | null | undefined): boolean {
	const origin = typeof originDeviceId === "string" ? originDeviceId.trim() : "";
	return origin === "" || origin === "local";
}

/** SQL for `hasExportSource`; CASE keeps JSON functions off malformed text. */
function exportSourceSql(column: string): string {
	return `COALESCE(CASE WHEN json_valid(${column}) THEN
		CASE WHEN json_type(${column}) = 'object'
			THEN json_extract(${column}, '$.source') = 'export' END END, 0)`;
}

/** `isImportedMemory` for `memory_items` and its session aliased `s`. */
const IMPORTED_MEMORY_SQL = `(${exportSourceSql("memory_items.metadata_json")}
	OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = memory_items.session_id
		AND (COALESCE(substr(s.import_key, 1, ${LEGACY_IMPORTED_SESSION_KEY_PREFIX.length}), '') = '${LEGACY_IMPORTED_SESSION_KEY_PREFIX}'
			OR ${exportSourceSql("s.metadata_json")})))`;

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
 * See `isImportedMemory`.
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
				   )
				   AND NOT ${IMPORTED_MEMORY_SQL}`,
			)
			.run(owner, memoryId).changes > 0
	);
}
