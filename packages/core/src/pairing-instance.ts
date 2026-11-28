import type { Database } from "./db.js";

/*
 * A pairing instance is one `sync_peers` row's lifetime. Every new row gets its own random
 * ID, so a pass that started under one pairing can tell that the pairing was deleted and
 * created again under the same device ID and key. Checking only that the device ID exists
 * would let a late ACK from the old pass write its position into the new pairing's progress
 * and skip history in that direction.
 */

const COLUMN = "pairing_instance_id";
const TRIGGER = "sync_peers_pairing_instance";

function hasColumn(db: Database): boolean {
	return (
		db
			.prepare("SELECT 1 FROM pragma_table_info('sync_peers') WHERE name = ?")
			.pluck()
			.get(COLUMN) === 1
	);
}

function hasTrigger(db: Database): boolean {
	return (
		db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?")
			.pluck()
			.get(TRIGGER) === 1
	);
}

/** Adds the column, the trigger that gives each new pairing its ID, and IDs for existing rows. */
export function ensurePairingInstanceSchema(db: Database): void {
	if (db.readonly) return;
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_peers'").get())
		return;
	const complete = hasColumn(db) && hasTrigger(db);
	if (complete && !db.prepare(`SELECT 1 FROM sync_peers WHERE ${COLUMN} IS NULL LIMIT 1`).get())
		return;
	db.transaction(() => {
		if (!hasColumn(db)) db.exec(`ALTER TABLE sync_peers ADD COLUMN ${COLUMN} TEXT`);
		db.exec(`CREATE TRIGGER IF NOT EXISTS ${TRIGGER}
			AFTER INSERT ON sync_peers WHEN NEW.${COLUMN} IS NULL
			BEGIN
				UPDATE sync_peers SET ${COLUMN} = lower(hex(randomblob(16)))
				WHERE peer_device_id = NEW.peer_device_id;
			END`);
		db.exec(`UPDATE sync_peers SET ${COLUMN} = lower(hex(randomblob(16))) WHERE ${COLUMN} IS NULL`);
	}).immediate();
}

/**
 * The ID of the peer's current pairing, or null when it has none or this database predates
 * pairing instances. A pass reads it when it starts and hands it to every progress write.
 */
export function readPairingInstanceId(db: Database, peerDeviceId: string): string | null {
	if (!hasColumn(db)) return null;
	const id = db
		.prepare(`SELECT ${COLUMN} FROM sync_peers WHERE peer_device_id = ?`)
		.pluck()
		.get(peerDeviceId);
	return typeof id === "string" && id !== "" ? id : null;
}

/**
 * SQL for "this pairing still exists", with its parameters. A write that carries the
 * instance it started under also requires that instance, so a pairing deleted and created
 * again under the same device ID is not the pairing the pass saw.
 */
export function pairingStillExists(
	peerDeviceId: string,
	pairingInstanceId: string | null | undefined,
): { sql: string; params: string[] } {
	if (!pairingInstanceId) {
		return {
			sql: "EXISTS (SELECT 1 FROM sync_peers WHERE peer_device_id = ?)",
			params: [peerDeviceId],
		};
	}
	return {
		sql: `EXISTS (SELECT 1 FROM sync_peers WHERE peer_device_id = ? AND ${COLUMN} = ?)`,
		params: [peerDeviceId, pairingInstanceId],
	};
}
