import {
	type DeviceIdentityInventoryInput,
	type DeviceIdentityInventoryV1,
	fingerprintPublicKey,
	listDeviceIdentityInventory,
	type MemoryStore,
	readCoordinatorRejoinDiscovery,
	readCoordinatorSyncConfig,
} from "@codemem/core";

type ReadConfig = typeof readCoordinatorSyncConfig;
type Pin = { peer_device_id: string; public_key: string; pinned_fingerprint: string };
type Proof = Awaited<ReturnType<typeof readCoordinatorRejoinDiscovery>>;

function localPins(store: MemoryStore): Map<string, string> {
	const rows = store.db
		.prepare(
			`SELECT peer_device_id, public_key, pinned_fingerprint FROM sync_peers
			 WHERE public_key IS NOT NULL AND pinned_fingerprint IS NOT NULL
			 ORDER BY peer_device_id LIMIT 2000`,
		)
		.all() as Pin[];
	return new Map(
		rows.flatMap((row) =>
			row.public_key.startsWith("ssh-ed25519 ") &&
			fingerprintPublicKey(row.public_key) === row.pinned_fingerprint
				? [[row.peer_device_id, row.pinned_fingerprint] as const]
				: [],
		),
	);
}

function configPin(config: ReturnType<ReadConfig>) {
	return JSON.stringify([config.syncCoordinatorUrl, config.syncCoordinatorGroups]);
}

function applyDiscovery(
	inventory: DeviceIdentityInventoryV1,
	proofs: Proof,
	pins: ReadonlyMap<string, string>,
): DeviceIdentityInventoryV1 {
	return {
		...inventory,
		items: inventory.items.map((item) => {
			if (item.isLocal || ["retired", "service", "conflicted"].includes(item.state)) return item;
			const proof = proofs.get(item.deviceId);
			const pinned = pins.get(item.deviceId);
			if (
				!proof ||
				proof.rejoinedAtMs === null ||
				proof.fingerprint !== pinned ||
				proof.fingerprint !== item.validatedFingerprint
			)
				return item;
			return { ...item, rejoin: { deviceId: item.deviceId, rejoinedAtMs: proof.rejoinedAtMs } };
		}),
	};
}

/** Confirm the signed enrollment against the same local key used to project the row. */
export async function readInventoryWithRejoinEvidence(
	store: MemoryStore,
	input: DeviceIdentityInventoryInput,
	readConfig: ReadConfig = readCoordinatorSyncConfig,
	signal?: AbortSignal,
): Promise<DeviceIdentityInventoryV1> {
	const inventory = () => listDeviceIdentityInventory(store.db, input);
	if (input.coordinator.availability === "available") return inventory();
	try {
		const config = readConfig();
		const pin = configPin(config);
		const peerIds = new Set(localPins(store).keys());
		if (!peerIds.size || !config.syncCoordinatorUrl || signal?.aborted) return inventory();
		const proofs = await readCoordinatorRejoinDiscovery({
			config,
			deviceId: input.localDeviceId,
			dbPath: store.dbPath,
			peerIds,
			signal,
		});
		const current = inventory();
		if (
			!proofs.size ||
			signal?.aborted ||
			store.deviceId !== input.localDeviceId ||
			configPin(readConfig()) !== pin
		)
			return current;
		return applyDiscovery(current, proofs, localPins(store));
	} catch {
		return inventory();
	}
}
