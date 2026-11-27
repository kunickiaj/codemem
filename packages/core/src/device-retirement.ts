import type { Database } from "./db.js";
import { removePairingState } from "./pairing-removal.js";
import { canonicalKeyId } from "./retired-device-aliases.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

/**
 * This device's canonical key ID, only when exactly one consistent identity row
 * exists for the ID the viewer runs as. Anything else can hide this device from
 * the inventory, so device-removal checks refuse rather than guess.
 */
export function verifiedLocalKeyId(db: Database, localDeviceId: string): string | null {
	const rows = db
		.prepare("SELECT device_id, public_key, fingerprint FROM sync_device")
		.all() as Array<{
		device_id: string;
		public_key: string | null;
		fingerprint: string | null;
	}>;
	const [row] = rows;
	if (rows.length !== 1 || !row || row.device_id !== localDeviceId || !row.public_key) return null;
	if (row.fingerprint !== fingerprintPublicKey(row.public_key)) return null;
	return canonicalKeyId(row.public_key);
}

/**
 * Deletes each revoked peer's pairing and cursors and ends its binding, whatever its
 * trust source. The coordinator doesn't say which subject matched, so each pinned key
 * is recorded as a key-only alias that a later pairing with a different key clears.
 */
export function removeRevokedPeers(
	db: Database,
	localDeviceId: string,
	peerDeviceIds: string[],
): number {
	const deviceIds = peerDeviceIds.filter((id) => id !== localDeviceId);
	if (deviceIds.length === 0) return 0;
	return removePairingState(db, { localDeviceId, reason: "revoked", deviceIds }).syncPeers;
}
