import type { Database } from "./db.js";
import type { RetirementPeer } from "./memory-retirement-delivery.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

interface PinnedPeer {
	public_key: string | null;
	pinned_fingerprint: string | null;
}

function validPin(row: PinnedPeer | undefined): row is PinnedPeer & { public_key: string } {
	return Boolean(
		row?.public_key &&
			row.pinned_fingerprint &&
			fingerprintPublicKey(row.public_key) === row.pinned_fingerprint,
	);
}

/** Copy existing pairing evidence before deleting policy trust, inside the same transaction. */
export function retainRetirementPeerTrust(
	db: Database,
	options: { localDeviceId: string; peerDeviceId: string },
): void {
	if (!db.inTransaction) throw new Error("retirement_trust_transaction_required");
	const row = db
		.prepare("SELECT public_key, pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
		.get(options.peerDeviceId) as PinnedPeer | undefined;
	if (!validPin(row)) return;
	// First trusted binding wins. Discovery/key rotation cannot silently replace historical authority.
	db.prepare(`INSERT OR IGNORE INTO memory_retirement_peer_trust
		(local_device_id, peer_device_id, public_key, pinned_fingerprint) VALUES (?, ?, ?, ?)`).run(
		options.localDeviceId,
		options.peerDeviceId,
		row.public_key,
		row.pinned_fingerprint,
	);
}

/** Retirement delivery/ack/reset only. Never use this lookup to authorize content sync. */
export function getRetirementPeer(
	db: Database,
	options: { localDeviceId: string; peerDeviceId: string },
): RetirementPeer | null {
	const retained = db
		.prepare(`SELECT public_key, pinned_fingerprint FROM memory_retirement_peer_trust
		WHERE local_device_id = ? AND peer_device_id = ?`)
		.get(options.localDeviceId, options.peerDeviceId) as PinnedPeer | undefined;
	const row =
		retained ??
		(db
			.prepare("SELECT public_key, pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
			.get(options.peerDeviceId) as PinnedPeer | undefined);
	if (!validPin(row)) return null;
	return { deviceId: options.peerDeviceId, publicKey: row.public_key };
}
