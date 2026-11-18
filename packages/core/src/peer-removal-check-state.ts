import type { Database } from "./db.js";

/*
 * What this device tells the coordinator about removals it has applied.
 *
 * `applied_removal_seq` is the coordinator's removal number that the last
 * complete lookup covered. It is valid only for the pairings and bindings that
 * lookup asked about, so `generation` counts every write that changes what a
 * lookup would send: a new pairing or binding, a binding made active again, and
 * a change of the device ID or key a pairing pins. The same triggers set
 * `applied_removal_seq` back to 0, in the writer's own transaction. Triggers on
 * the tables see every writer, including older application versions.
 */

const STATE_TABLE = "sync_peer_removal_check_state";
const BUMP = `UPDATE ${STATE_TABLE} SET generation = generation + 1, applied_removal_seq = 0 WHERE id = 1`;

const TRIGGERS = [
	["pairing_insert", "AFTER INSERT ON sync_peers", ""],
	[
		"pairing_update",
		// UPDATE OF would miss a device ID written through a rowid alias.
		"AFTER UPDATE ON sync_peers",
		"WHEN OLD.peer_device_id IS NOT NEW.peer_device_id OR OLD.public_key IS NOT NEW.public_key OR OLD.pinned_fingerprint IS NOT NEW.pinned_fingerprint",
	],
	["binding_insert", "AFTER INSERT ON identity_devices", ""],
	[
		"binding_update",
		"AFTER UPDATE ON identity_devices",
		"WHEN NEW.status = 'active' AND (OLD.status IS NOT 'active' OR OLD.device_id IS NOT NEW.device_id)",
	],
].map(([suffix, event, condition]) => ({
	name: `sync_peer_removal_generation_${suffix}`,
	sql: `CREATE TRIGGER sync_peer_removal_generation_${suffix} ${event} ${condition}
	BEGIN ${BUMP}; END`,
}));

const REQUIRED_COLUMNS: Record<string, string[]> = {
	sync_peers: ["peer_device_id", "public_key", "pinned_fingerprint"],
	identity_devices: ["device_id", "status"],
};

export interface PeerRemovalCheckState {
	generation: number;
	appliedRemovalSeq: number;
}

function hasRequiredColumns(db: Database): boolean {
	return Object.entries(REQUIRED_COLUMNS).every(([table, required]) => {
		const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
		return required.every((name) => columns.some((column) => column.name === name));
	});
}

function hasCurrentTriggers(db: Database): boolean {
	const select = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?");
	return TRIGGERS.every(
		({ name, sql }) => (select.get(name) as { sql: string } | undefined)?.sql === sql,
	);
}

/**
 * The stored state, or null when the table, its row, or any trigger is missing.
 * Without every trigger the counter cannot vouch for the stored number.
 */
export function readPeerRemovalCheckState(db: Database): PeerRemovalCheckState | null {
	const table = db
		.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
		.get(STATE_TABLE);
	if (!table || !hasCurrentTriggers(db)) return null;
	const row = db
		.prepare(`SELECT generation, applied_removal_seq FROM ${STATE_TABLE} WHERE id = 1`)
		.get() as { generation: number; applied_removal_seq: number } | undefined;
	return row ? { generation: row.generation, appliedRemovalSeq: row.applied_removal_seq } : null;
}

/** Installs the state row and the triggers. Later opens only read `sqlite_schema`. */
export function ensurePeerRemovalCheckState(db: Database): void {
	if (db.readonly || !hasRequiredColumns(db)) return;
	if (readPeerRemovalCheckState(db)) return;
	db.transaction(() => {
		db.exec(`CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			generation INTEGER NOT NULL DEFAULT 0,
			applied_removal_seq INTEGER NOT NULL DEFAULT 0
		)`);
		db.prepare(`INSERT OR IGNORE INTO ${STATE_TABLE}(id) VALUES (1)`).run();
		for (const { name, sql } of TRIGGERS) {
			db.exec(`DROP TRIGGER IF EXISTS ${name}`);
			db.exec(sql);
		}
		// Writes made while a trigger was missing were not counted.
		db.exec(BUMP);
	}).immediate();
}

/** The number to advertise in presence. 0 until a complete lookup has covered every current entry. */
export function readAppliedRemovalSeq(db: Database): number {
	return readPeerRemovalCheckState(db)?.appliedRemovalSeq ?? 0;
}

/**
 * Stores a complete lookup's number, only while the counter still has the value
 * the lookup read with its entries. One statement, so no write can slip between
 * the comparison and the store. Returns whether it stored.
 */
export function storeAppliedRemovalSeq(
	db: Database,
	lookup: { generation: number; removalSeq: number },
): boolean {
	if (!readPeerRemovalCheckState(db)) return false;
	return (
		db
			.prepare(`UPDATE ${STATE_TABLE} SET applied_removal_seq = ? WHERE id = 1 AND generation = ?`)
			.run(lookup.removalSeq, lookup.generation).changes === 1
	);
}
