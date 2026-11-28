import type { Database } from "./db.js";
import { type PairingRemovalCounts, removePairingState } from "./pairing-removal.js";

export interface PeerRemovalOptions {
	localDeviceId: string;
	peerDeviceId: string;
}

export interface PeerRemovalResult {
	/**
	 * Always `kept`. Unpairing never ends the peer's Identity binding. Removing the device
	 * from the coordinator group does, through its own route.
	 */
	binding: "kept";
	removed: PairingRemovalCounts;
}

/**
 * Deletes this device's pairing with the peer and its sync progress, in one transaction:
 * a failure leaves every table unchanged. It changes nothing about the peer's Identity
 * binding, cached scope authorization or Project recipients, on an admin device or any
 * other, so the peer keeps the access the coordinator gives it. Remove device is the
 * action that ends that access.
 */
export function removePeerFromThisDevice(
	db: Database,
	options: PeerRemovalOptions,
): PeerRemovalResult {
	const removed = removePairingState(db, {
		localDeviceId: options.localDeviceId,
		reason: "disconnect",
		deviceIds: [options.peerDeviceId],
	});
	return { binding: "kept", removed };
}
