import {
	createCoordinatorReciprocalApproval,
	lookupCoordinatorPeers,
	MemoryStore,
	mergeAddresses,
	readCoordinatorSyncConfig,
} from "../../packages/core/src/index.ts";

const E2E_DB_PATH = "/data/mem.sqlite";
const SAFE_DEVICE_ID_RE = /^[A-Za-z0-9._:-]+$/;

function validatePeerDeviceId(value: string): string {
	if (!SAFE_DEVICE_ID_RE.test(value)) {
		throw new Error("--peer-device-id must use a safe device id format");
	}
	return value;
}

function parseArgs(argv: string[]): { peerDeviceId: string; fingerprint: string } {
	let peerDeviceId = "";
	let fingerprint = "";
	for (let index = 2; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--peer-device-id") {
			peerDeviceId = String(argv[index + 1] ?? "").trim();
			index += 1;
		} else if (arg === "--fingerprint") {
			fingerprint = String(argv[index + 1] ?? "").trim();
			index += 1;
		}
	}
	if (!peerDeviceId || !fingerprint) {
		throw new Error("--peer-device-id and --fingerprint are required");
	}
	return { peerDeviceId: validatePeerDeviceId(peerDeviceId), fingerprint };
}

async function main(): Promise<void> {
	const { peerDeviceId, fingerprint } = parseArgs(process.argv);
	const store = new MemoryStore(E2E_DB_PATH);
	try {
		const config = readCoordinatorSyncConfig();
		const discovered = await lookupCoordinatorPeers(store, config);
		const match = discovered.find(
			(peer) =>
				String(peer.device_id ?? "").trim() === peerDeviceId &&
				String(peer.fingerprint ?? "").trim() === fingerprint,
		);
		if (!match) throw new Error("discovered_peer_not_found");
		const matchedDeviceId = String(match.device_id ?? "").trim();
		const nextFingerprint = String(match.fingerprint ?? "").trim();
		const nextPublicKey = String(match.public_key ?? "").trim();
		const nextName = String(match.display_name ?? "").trim() || null;
		if (!matchedDeviceId) throw new Error("discovered_peer_missing_device_id");
		const nextAddresses = Array.isArray(match.addresses)
			? match.addresses.filter((value): value is string => typeof value === "string")
			: [];
		if (!nextPublicKey) throw new Error("discovered_peer_missing_public_key");
		const groupIds = Array.isArray(match.groups)
			? match.groups.map((value) => String(value ?? "").trim()).filter(Boolean)
			: [];
		if (groupIds.length !== 1) throw new Error("ambiguous_coordinator_group");
		const groupId = groupIds[0] as string;
		const existing = store.db
			.prepare(
				`SELECT peer_device_id, pinned_fingerprint, public_key, addresses_json
				   FROM sync_peers
				  WHERE peer_device_id = ?
				  LIMIT 1`,
			)
			.get(matchedDeviceId) as
			| {
					peer_device_id: string;
					pinned_fingerprint: string | null;
					public_key: string | null;
					addresses_json: string | null;
			  }
			| undefined;
		const existingFingerprint = String(existing?.pinned_fingerprint ?? "").trim();
		if (existing && existingFingerprint && existingFingerprint !== nextFingerprint) {
			throw new Error("peer_conflict");
		}
		const existingAddresses = (() => {
			try {
				const raw = JSON.parse(String(existing?.addresses_json ?? "[]"));
				return Array.isArray(raw)
					? raw.filter((value): value is string => typeof value === "string")
					: [];
			} catch {
				return [];
			}
		})();
		const addressesJson = JSON.stringify(mergeAddresses(existingAddresses, nextAddresses));
		await createCoordinatorReciprocalApproval(store, config, {
			groupId,
			requestedDeviceId: matchedDeviceId,
		});
		const now = new Date().toISOString();
		let result:
			| { ok: true; peer_device_id: string; created: boolean; updated: boolean; name: string | null }
			| undefined;
		if (!existing) {
			store.db
				.prepare(
					`INSERT INTO sync_peers(
						peer_device_id, name, pinned_fingerprint, public_key, addresses_json, created_at, last_seen_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(matchedDeviceId, nextName, nextFingerprint || null, nextPublicKey, addressesJson, now, now);
			result = {
				ok: true,
				peer_device_id: matchedDeviceId,
				created: true,
				updated: false,
				name: nextName,
			};
		} else {
			store.db
				.prepare(
					`UPDATE sync_peers
					    SET name = ?,
					        pinned_fingerprint = ?,
					        public_key = ?,
					        addresses_json = ?,
					        last_seen_at = ?
					  WHERE peer_device_id = ?`,
				)
				.run(
					nextName,
					nextFingerprint || existing.pinned_fingerprint || null,
					nextPublicKey || existing.public_key || null,
					addressesJson,
					now,
					matchedDeviceId,
				);
			result = {
				ok: true,
				peer_device_id: matchedDeviceId,
				created: false,
				updated: true,
				name: nextName,
			};
		}
		console.log(JSON.stringify(result, null, 2));
	} finally {
		store.close();
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
