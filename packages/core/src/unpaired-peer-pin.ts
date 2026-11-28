import type { Database } from "./db.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

/*
 * The last verified pin of a peer this device unpaired, kept for Remove device and nothing
 * else. Unpairing deletes the pairing, and with it the pinned key that Remove needs to ask
 * the coordinator about the device by key, to find a key-only revocation filed under
 * another device ID, and to retire the key. Nothing reads this record to authorize sync,
 * pull, push, or open a channel: only `sync_peers` does. Remove, a removal answer, and a
 * revocation clear it. So does a different verified pin saved for the same device ID: the
 * record is then superseded, and asking the coordinator about the old key could end the
 * replacement device's binding.
 */

const TABLE = "unpaired_peer_pins";

export interface UnpairedPeerPin {
	deviceId: string;
	publicKey: string;
	pinnedFingerprint: string;
	recordedAt: string;
}

function hasTable(db: Database): boolean {
	return (
		db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.pluck()
			.get(TABLE) === 1
	);
}

function validPin(publicKey: unknown, fingerprint: unknown): publicKey is string {
	if (typeof publicKey !== "string" || typeof fingerprint !== "string") return false;
	if (!publicKey || !fingerprint) return false;
	try {
		return fingerprintPublicKey(publicKey) === fingerprint;
	} catch {
		return false;
	}
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
	local_device_id TEXT NOT NULL,
	peer_device_id TEXT NOT NULL,
	public_key TEXT NOT NULL,
	pinned_fingerprint TEXT NOT NULL,
	recorded_at TEXT NOT NULL,
	PRIMARY KEY (local_device_id, peer_device_id)
)`;

/*
 * Whatever writes the replacement pin, a pairing row that names a different key for the
 * device supersedes the record. A trigger sees every writer, and no writer can forget it.
 */
const SUPERSEDE_WHEN = `NEW.public_key IS NOT NULL AND NEW.pinned_fingerprint IS NOT NULL`;
const SUPERSEDE_DELETE = `DELETE FROM ${TABLE}
	WHERE peer_device_id = NEW.peer_device_id AND public_key IS NOT NEW.public_key;`;

/** Creates the record's table and the triggers that drop a superseded pin. */
export function ensureUnpairedPeerPinSchema(db: Database): void {
	if (db.readonly) return;
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_peers'").get())
		return;
	const present = db
		.prepare(
			`SELECT COUNT(*) FROM sqlite_master WHERE name IN
			 ('${TABLE}', 'unpaired_peer_pin_superseded_insert', 'unpaired_peer_pin_superseded_update')`,
		)
		.pluck()
		.get();
	if (present === 3) return;
	db.exec(CREATE_TABLE);
	db.exec(`CREATE TRIGGER IF NOT EXISTS unpaired_peer_pin_superseded_insert
		AFTER INSERT ON sync_peers WHEN ${SUPERSEDE_WHEN}
		BEGIN ${SUPERSEDE_DELETE} END`);
	db.exec(`CREATE TRIGGER IF NOT EXISTS unpaired_peer_pin_superseded_update
		AFTER UPDATE OF public_key, pinned_fingerprint ON sync_peers WHEN ${SUPERSEDE_WHEN}
		BEGIN ${SUPERSEDE_DELETE} END`);
}

/** Keeps the peer's pin before its pairing is deleted, in the same transaction. */
export function recordUnpairedPeerPin(
	db: Database,
	options: { localDeviceId: string; peerDeviceId: string; recordedAt: string },
): void {
	if (!db.inTransaction) throw new Error("unpaired_peer_pin_transaction_required");
	const row = db
		.prepare("SELECT public_key, pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
		.get(options.peerDeviceId) as
		| { public_key: string | null; pinned_fingerprint: string | null }
		| undefined;
	if (!row || !validPin(row.public_key, row.pinned_fingerprint)) return;
	ensureUnpairedPeerPinSchema(db);
	// The last pin this device verified wins, unlike retirement trust, which keeps the first.
	db.prepare(
		`INSERT OR REPLACE INTO ${TABLE}
		 (local_device_id, peer_device_id, public_key, pinned_fingerprint, recorded_at)
		 VALUES (?, ?, ?, ?, ?)`,
	).run(
		options.localDeviceId,
		options.peerDeviceId,
		row.public_key,
		row.pinned_fingerprint,
		options.recordedAt,
	);
}

/** The recorded pin, only when its key still matches its fingerprint. */
export function readUnpairedPeerPin(
	db: Database,
	options: { localDeviceId: string; peerDeviceId: string },
): UnpairedPeerPin | null {
	if (!hasTable(db)) return null;
	const row = db
		.prepare(
			`SELECT public_key, pinned_fingerprint, recorded_at FROM ${TABLE}
			 WHERE local_device_id = ? AND peer_device_id = ?`,
		)
		.get(options.localDeviceId, options.peerDeviceId) as
		| { public_key: string; pinned_fingerprint: string; recorded_at: string }
		| undefined;
	if (!row || !validPin(row.public_key, row.pinned_fingerprint)) return null;
	return {
		deviceId: options.peerDeviceId,
		publicKey: row.public_key,
		pinnedFingerprint: row.pinned_fingerprint,
		recordedAt: row.recorded_at,
	};
}

/** Every recorded pin of this device, for the signed lookup that asks about removed keys. */
export function listUnpairedPeerPins(db: Database, localDeviceId: string): UnpairedPeerPin[] {
	if (!hasTable(db)) return [];
	const rows = db
		.prepare(
			`SELECT peer_device_id, public_key, pinned_fingerprint, recorded_at FROM ${TABLE}
			 WHERE local_device_id = ? ORDER BY peer_device_id`,
		)
		.all(localDeviceId) as Array<{
		peer_device_id: string;
		public_key: string;
		pinned_fingerprint: string;
		recorded_at: string;
	}>;
	return rows
		.filter((row) => validPin(row.public_key, row.pinned_fingerprint))
		.map((row) => ({
			deviceId: row.peer_device_id,
			publicKey: row.public_key,
			pinnedFingerprint: row.pinned_fingerprint,
			recordedAt: row.recorded_at,
		}));
}

/** Drops the record once Remove, a removal answer, or a revocation has dealt with the device. */
export function clearUnpairedPeerPins(db: Database, peerDeviceIds: readonly string[]): void {
	if (!hasTable(db) || peerDeviceIds.length === 0) return;
	const clear = db.prepare(`DELETE FROM ${TABLE} WHERE peer_device_id = ?`);
	for (const deviceId of peerDeviceIds) clear.run(deviceId);
}
