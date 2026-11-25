import type { Database } from "./db.js";
import { canonicalKeyId } from "./retired-device-aliases.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

/*
 * Which local devices a verified coordinator removal applies to. The Viewer's
 * own removal commit and the Team replay both use this rule, so they end local
 * access for exactly the same devices.
 */

/** One removed enrollment: a device ID and the key fingerprint the coordinator removed. */
export interface RemovedDeviceKey {
	device_id: string;
	fingerprint: string;
}

interface Pairing {
	peer_device_id: string;
	public_key: string | null;
	pinned_fingerprint: string | null;
}

function matchesRemovedKey(pair: Pairing, keyId: string | null, fingerprints?: Set<string>) {
	const { public_key: publicKey, pinned_fingerprint: fingerprint } = pair;
	if (!publicKey || !fingerprint || fingerprintPublicKey(publicKey) !== fingerprint) return false;
	if (keyId !== null) return canonicalKeyId(publicKey) === keyId;
	return fingerprints?.has(fingerprint) === true;
}

/**
 * Local-only aliases must pin the verified canonical key. A replacement key
 * under the same ID stays, as does a binding recorded for another key. This
 * device is never included.
 */
export function localRemovedDeviceIds(
	db: Database,
	removal: { enrollments: readonly RemovedDeviceKey[]; keyId: string | null },
	ownId: string,
): string[] {
	const expected = new Map<string, Set<string>>();
	for (const row of removal.enrollments) {
		const fingerprints = expected.get(row.device_id) ?? new Set<string>();
		fingerprints.add(row.fingerprint);
		expected.set(row.device_id, fingerprints);
	}
	const aliases = new Set(expected.keys());
	const pairs = db
		.prepare("SELECT peer_device_id, public_key, pinned_fingerprint FROM sync_peers")
		.all() as Pairing[];
	for (const pair of pairs) {
		const id = pair.peer_device_id;
		if (matchesRemovedKey(pair, removal.keyId, expected.get(id))) {
			aliases.add(id);
			const fingerprint = pair.pinned_fingerprint;
			if (fingerprint) {
				const fingerprints = expected.get(id) ?? new Set<string>();
				fingerprints.add(fingerprint);
				expected.set(id, fingerprints);
			}
		} else aliases.delete(id);
	}
	aliases.delete(ownId);
	const binding = db.prepare("SELECT source_fingerprint FROM identity_devices WHERE device_id = ?");
	return [...aliases].filter((id) => {
		const row = binding.get(id) as { source_fingerprint: string | null } | undefined;
		return (
			row?.source_fingerprint == null || expected.get(id)?.has(row.source_fingerprint) === true
		);
	});
}
