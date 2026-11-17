import type { Database } from "./db.js";
import { deleteUnpairedSyncChannelProgress } from "./sync-channel-progress.js";

/*
 * Earlier versions deleted a pairing and left its sync progress behind in the
 * cursor tables and the channel pass's progress table. A later pairing with the
 * same device ID then resumed from the old position. A progress row whose device
 * has no pairing has no peer to sync with, so deleting it cannot move a live
 * pairing's position. The cleanup runs once per database and records that it ran.
 */

const MARKER_TABLE = "replication_cursor_orphan_cleanup";
const REQUIRED_TABLES = ["sync_peers", "replication_cursors", "replication_cursors_v2"];

export interface OrphanCursorCleanupCounts {
	replicationCursors: number;
	replicationCursorsV2: number;
	syncChannelProgress: number;
}

function tableExists(db: Database, table: string): boolean {
	return (
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
		undefined
	);
}

function alreadyRan(db: Database): boolean {
	if (!tableExists(db, MARKER_TABLE)) return false;
	return db.prepare(`SELECT 1 FROM ${MARKER_TABLE} WHERE id = 1`).get() !== undefined;
}

function deleteOrphans(db: Database, table: string): number {
	return db
		.prepare(
			// NOT IN matches nothing when any pairing has a NULL device ID, which old schemas allow.
			`DELETE FROM ${table} AS progress
			 WHERE NOT EXISTS (
			  SELECT 1 FROM sync_peers peer WHERE peer.peer_device_id = progress.peer_device_id
			 )`,
		)
		.run().changes;
}

/**
 * Deletes every sync progress row, in all three tables, whose device has no pairing. Returns
 * the counts on the one run that does the work and null on every other call.
 * One immediate transaction: a failure deletes nothing and leaves the cleanup
 * to the next open.
 */
export function deleteOrphanReplicationCursorsOnce(db: Database): OrphanCursorCleanupCounts | null {
	if (db.readonly) return null;
	if (!REQUIRED_TABLES.every((table) => tableExists(db, table))) return null;
	// Checked before taking the write lock, so ordinary opens never wait on a writer.
	if (alreadyRan(db)) return null;
	return db
		.transaction(() => {
			db.exec(`CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				completed_at TEXT NOT NULL
			)`);
			// Another process can finish the cleanup between the check and the lock.
			if (alreadyRan(db)) return null;
			const counts = {
				replicationCursors: deleteOrphans(db, "replication_cursors"),
				replicationCursorsV2: deleteOrphans(db, "replication_cursors_v2"),
				syncChannelProgress: deleteUnpairedSyncChannelProgress(db),
			};
			db.prepare(`INSERT INTO ${MARKER_TABLE}(id, completed_at) VALUES (1, ?)`).run(
				new Date().toISOString(),
			);
			return counts;
		})
		.immediate();
}
