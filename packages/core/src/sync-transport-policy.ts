import type { Database } from "better-sqlite3";

/**
 * Direct sync over Noise ships switched off. While this stays false, no build
 * advertises Noise support in pairing payloads or presence. Recording trusted
 * evidence from peers that do advertise it is safe because nothing enforces it
 * yet. Every Noise behavior turns on together when this flips.
 */
export const DIRECT_NOISE_ACTIVE = false;

/** Sync feature a device lists in its signed transport statement. */
export const DIRECT_NOISE_FEATURE = "direct_noise_v1";

/** Transport name a pairing payload lists when its device speaks Noise. */
export const PAIRING_NOISE_TRANSPORT = "noise1";

export type PeerTransportPolicy = "legacy_plaintext" | "noise_required";

export type PeerTransportPolicySource =
	| "pairing_payload"
	| "transport_statement"
	| "authenticated_exchange";

const TABLE = "sync_peer_transport_policy";
const INSERT_TRIGGER = "sync_peer_transport_policy_default_after_insert";
const DEMOTION_TRIGGER = "sync_peer_transport_policy_no_demotion";

/**
 * One row per peer device. No foreign key and no delete trigger: removing a
 * pairing must not forget that the device speaks Noise, or a later re-pair
 * could start in plaintext. Every new pairing starts as legacy_plaintext, and
 * only trusted evidence promotes it. Nothing here demotes a row.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
	peer_device_id TEXT PRIMARY KEY NOT NULL,
	policy TEXT NOT NULL CHECK (policy IN ('legacy_plaintext', 'noise_required')),
	source TEXT NOT NULL,
	recorded_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS ${INSERT_TRIGGER}
AFTER INSERT ON sync_peers
BEGIN
	INSERT OR IGNORE INTO ${TABLE} (peer_device_id, policy, source, recorded_at)
	VALUES (NEW.peer_device_id, 'legacy_plaintext', 'pairing', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER IF NOT EXISTS ${DEMOTION_TRIGGER}
BEFORE UPDATE OF policy ON ${TABLE}
WHEN OLD.policy = 'noise_required' AND NEW.policy <> 'noise_required'
BEGIN
	SELECT RAISE(ABORT, 'sync peer transport policy cannot be demoted');
END;
`;

function hasTable(db: Database, name: string): boolean {
	return (
		db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
			.get(name) !== undefined
	);
}

function schemaComplete(db: Database): boolean {
	const count = db
		.prepare(
			`SELECT COUNT(*) FROM sqlite_master
			 WHERE (type = 'table' AND name = ?) OR (type = 'trigger' AND name IN (?, ?))`,
		)
		.pluck()
		.get(TABLE, INSERT_TRIGGER, DEMOTION_TRIGGER);
	return count === 3;
}

function hasUnrecordedPeer(db: Database): boolean {
	return (
		db
			.prepare(
				`SELECT 1 FROM sync_peers AS peer
				 WHERE NOT EXISTS (
					SELECT 1 FROM ${TABLE} AS policy WHERE policy.peer_device_id = peer.peer_device_id
				 ) LIMIT 1`,
			)
			.get() !== undefined
	);
}

/**
 * Create the table and triggers, and record every existing pairing as
 * legacy_plaintext. Runs on every writable open and takes the write lock only
 * when something is missing.
 */
export function ensureSyncPeerTransportPolicySchema(db: Database): void {
	if (db.readonly || !hasTable(db, "sync_peers")) return;
	const complete = schemaComplete(db);
	if (complete && !hasUnrecordedPeer(db)) return;
	db.transaction(() => {
		db.exec(SCHEMA_SQL);
		db.prepare(
			`INSERT OR IGNORE INTO ${TABLE} (peer_device_id, policy, source, recorded_at)
			 SELECT peer_device_id, 'legacy_plaintext', 'migration', ?
			 FROM sync_peers`,
		).run(new Date().toISOString());
	}).immediate();
}

/** The recorded policy, or null when this store has no record for the device. */
export function readPeerTransportPolicy(
	db: Database,
	peerDeviceId: string,
): PeerTransportPolicy | null {
	if (!hasTable(db, TABLE)) return null;
	const policy = db
		.prepare(`SELECT policy FROM ${TABLE} WHERE peer_device_id = ?`)
		.pluck()
		.get(peerDeviceId);
	return policy === "noise_required" || policy === "legacy_plaintext" ? policy : null;
}

/**
 * Record that a peer must be reached over Noise. Callers pass only trusted
 * evidence. Returns whether the stored policy changed. Throws when the table is
 * missing, so evidence is never dropped without notice.
 */
export function promotePeerToNoiseRequired(
	db: Database,
	peerDeviceId: string,
	source: PeerTransportPolicySource,
): boolean {
	const deviceId = peerDeviceId.trim();
	if (!deviceId) throw new Error("peer device id required");
	const result = db
		.prepare(
			`INSERT INTO ${TABLE} (peer_device_id, policy, source, recorded_at)
			 VALUES (?, 'noise_required', ?, ?)
			 ON CONFLICT(peer_device_id) DO UPDATE SET
				policy = 'noise_required',
				source = excluded.source,
				recorded_at = excluded.recorded_at
			 WHERE ${TABLE}.policy <> 'noise_required'`,
		)
		.run(deviceId, source, new Date().toISOString());
	return result.changes > 0;
}
