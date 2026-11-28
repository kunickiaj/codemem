import { createHash } from "node:crypto";
import {
	canonicalKeyId,
	fingerprintPublicKey,
	getCodememConfigPath,
	type MemoryStore,
	readCodememConfigFileForMutation,
	readCoordinatorSyncConfig,
	readUnpairedPeerPin,
	removePairingState,
	verifiedLocalKeyId,
} from "@codemem/core";

type LocalStore = Pick<MemoryStore, "db" | "deviceId">;

/** A malformed setting must never authorize a local-only removal. */
export function hasNoRemovalCoordinator(readConfig?: typeof readCoordinatorSyncConfig): boolean {
	if (readConfig?.().syncCoordinatorUrl.trim()) return false;
	// An effective-settings reader may have treated a damaged file as empty.
	const config = readCodememConfigFileForMutation(getCodememConfigPath());
	if (config.status !== "missing" && config.status !== "valid") return false;
	const data = config.status === "valid" ? config.data : {};
	const url = data.sync_coordinator_url;
	if (url !== undefined && typeof url !== "string") return false;
	return !readCoordinatorSyncConfig(data).syncCoordinatorUrl;
}

/**
 * The pairing's pin, or the last verified pin kept when this device unpaired the device, so
 * Remove still works after Unpair. The kept pin only identifies the key to remove. It never
 * authorizes sync.
 */
function readPin(store: LocalStore, deviceId: string) {
	const live = store.db
		.prepare(
			"SELECT public_key, pinned_fingerprint, created_at FROM sync_peers WHERE peer_device_id = ?",
		)
		.get(deviceId) as
		| {
				public_key: string | null;
				pinned_fingerprint: string | null;
				created_at: string;
		  }
		| undefined;
	if (live) return live;
	const kept = readUnpairedPeerPin(store.db, {
		localDeviceId: store.deviceId,
		peerDeviceId: deviceId,
	});
	return kept
		? {
				public_key: kept.publicKey,
				pinned_fingerprint: kept.pinnedFingerprint,
				created_at: kept.recordedAt,
			}
		: undefined;
}

export function readLocalRemoval(store: LocalStore, deviceId: string) {
	if (deviceId === store.deviceId)
		return { error: "cannot_remove_this_device", status: 400 } as const;
	const localKeyId = verifiedLocalKeyId(store.db, store.deviceId);
	if (!localKeyId) return { error: "local_identity_unverified", status: 409 } as const;
	const pin = readPin(store, deviceId);
	if (!pin) return { error: "removal_target_not_enrolled", status: 404 } as const;
	const peerKeyId = pin.public_key && canonicalKeyId(pin.public_key);
	if (peerKeyId === localKeyId) return { error: "cannot_remove_this_device", status: 400 } as const;
	if (
		!pin.public_key ||
		!peerKeyId ||
		pin.pinned_fingerprint !== fingerprintPublicKey(pin.public_key)
	)
		return { error: "removal_target_unavailable", status: 409 } as const;
	return {
		mode: "local",
		device_id: deviceId,
		expected_digest: createHash("sha256")
			.update(
				JSON.stringify([
					store.deviceId,
					localKeyId,
					deviceId,
					pin.public_key,
					pin.pinned_fingerprint,
					pin.created_at,
				]),
			)
			.digest("hex"),
	} as const;
}

export function commitLocalRemoval(
	store: LocalStore,
	input: { deviceId: string; expectedDigest: string },
	readConfig?: typeof readCoordinatorSyncConfig,
) {
	return store.db
		.transaction(() => {
			if (!hasNoRemovalCoordinator(readConfig)) return false;
			const review = readLocalRemoval(store, input.deviceId);
			if ("error" in review || review.expected_digest !== input.expectedDigest) return false;
			removePairingState(store.db, {
				localDeviceId: store.deviceId,
				deviceIds: [input.deviceId],
				reason: "local",
			});
			return true;
		})
		.immediate();
}
