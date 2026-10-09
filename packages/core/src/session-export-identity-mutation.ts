import type { Database } from "./db.js";
import { exportedSessionKey } from "./session-export-identity.js";

/** Preserve bookkeeping identity before changing memory anchors, never grant access. */
export function snapshotSessionExportKeysForMemoryIds(
	db: Database,
	memoryIds: readonly number[],
): void {
	if (!db.inTransaction) throw new Error("session_export_identity_transaction_required");
	const findSession = db.prepare(`SELECT s.id, s.import_key FROM sessions s
		JOIN memory_items m ON m.session_id = s.id WHERE m.id = ?`);
	const findAnchor = db.prepare(`SELECT 1 FROM memory_items
		WHERE session_id = ? AND import_key IS NOT NULL AND trim(import_key) <> '' LIMIT 1`);
	const saveKey = db.prepare("UPDATE sessions SET import_key = ? WHERE id = ?");
	const seen = new Set<number>();
	for (const memoryId of memoryIds) {
		const session = findSession.get(memoryId) as
			| { id: number; import_key: string | null }
			| undefined;
		if (!session || seen.has(session.id)) continue;
		seen.add(session.id);
		if (session.import_key?.trim()) continue;
		// No prior helper identity exists without an anchor; cleanup must still proceed.
		if (!findAnchor.get(session.id)) continue;
		saveKey.run(exportedSessionKey(db, session), session.id);
	}
}
