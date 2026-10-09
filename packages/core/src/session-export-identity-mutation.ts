import type { Database } from "./db.js";
import { exportedSessionKey } from "./session-export-identity.js";

/** Preserve bookkeeping identity before changing memory anchors, never grant access. */
export function snapshotSessionExportKeysForMemoryIds(
	db: Database,
	memoryIds: readonly number[],
): void {
	if (!db.inTransaction) throw new Error("session_export_identity_transaction_required");
	// One JSON parameter carries numeric IDs without SQLite's variable limit.
	// Resolve only the supplied memory primary keys, then deduplicate actual sessions
	// before any per-session anchor reads while the caller holds its transaction.
	const sessions = db
		.prepare(`SELECT DISTINCT s.id, s.import_key FROM memory_items m
			JOIN sessions s ON s.id = m.session_id
			WHERE m.id IN (SELECT value FROM json_each(?))`)
		.all(JSON.stringify(memoryIds)) as { id: number; import_key: string | null }[];
	const findAnchor = db.prepare(`SELECT 1 FROM memory_items
		WHERE session_id = ? AND import_key IS NOT NULL AND trim(import_key) <> '' LIMIT 1`);
	// Match the original key (including NULL or whitespace), never replace a new key.
	const saveKey = db.prepare("UPDATE sessions SET import_key = ? WHERE id = ? AND import_key IS ?");
	for (const session of sessions) {
		if (session.import_key?.trim()) continue;
		// No prior helper identity exists without an anchor; cleanup must still proceed.
		if (!findAnchor.get(session.id)) continue;
		saveKey.run(exportedSessionKey(db, session), session.id, session.import_key);
	}
}
