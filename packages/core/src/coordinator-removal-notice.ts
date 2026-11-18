import type { Database } from "./db.js";

/*
 * The removed device's own side. The coordinator answers a signed request from a
 * device it removed with `403 device_removed`, per group. This device records
 * each such answer. Once every configured group of the coordinator has given
 * it, this device is removed from sharing: it stops outbound sync to peers it
 * found through that coordinator and deletes nothing. Only the removal lookup
 * reads these answers, and only a lookup that every batch answered with a valid
 * reply clears the record. Other signed requests neither set nor clear it.
 */

const TABLE = "sync_coordinator_device_removed";

export interface CoordinatorRemovalState {
	/** Every configured group answered `device_removed`. */
	removed: boolean;
	/** The configured groups that gave that answer. */
	removedFromGroups: string[];
}

function tableExists(db: Database): boolean {
	return (
		db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(TABLE) !==
		undefined
	);
}

/** Records that these groups of the coordinator answered `device_removed`. */
export function recordCoordinatorDeviceRemoved(
	db: Database,
	notice: { coordinatorId: string; groupIds: string[]; now?: string },
): void {
	if (notice.groupIds.length === 0) return;
	db.transaction(() => {
		db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
			coordinator_id TEXT NOT NULL,
			group_id TEXT NOT NULL,
			noticed_at TEXT NOT NULL,
			PRIMARY KEY (coordinator_id, group_id)
		)`);
		const insert = db.prepare(
			`INSERT OR IGNORE INTO ${TABLE}(coordinator_id, group_id, noticed_at) VALUES (?, ?, ?)`,
		);
		const now = notice.now ?? new Date().toISOString();
		for (const groupId of notice.groupIds) insert.run(notice.coordinatorId, groupId, now);
	}).immediate();
}

/** The coordinator accepted a signed request from this device, so it is not removed. */
export function clearCoordinatorDeviceRemoved(db: Database, coordinatorId: string): void {
	if (!tableExists(db)) return;
	db.prepare(`DELETE FROM ${TABLE} WHERE coordinator_id = ?`).run(coordinatorId);
}

/** Whether this device is removed from sharing on the coordinator, judged against its configured groups. */
export function readCoordinatorRemovalState(
	db: Database,
	coordinator: { coordinatorId: string; groupIds: string[] },
): CoordinatorRemovalState {
	if (!tableExists(db)) return { removed: false, removedFromGroups: [] };
	const noticed = new Set(
		db
			.prepare(`SELECT group_id FROM ${TABLE} WHERE coordinator_id = ?`)
			.pluck()
			.all(coordinator.coordinatorId) as string[],
	);
	const removedFromGroups = coordinator.groupIds.filter((groupId) => noticed.has(groupId));
	return {
		removed:
			coordinator.groupIds.length > 0 && removedFromGroups.length === coordinator.groupIds.length,
		removedFromGroups,
	};
}
