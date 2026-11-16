import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorSyncConfig } from "./coordinator-sync-config.js";
import type { Database } from "./db.js";
import { retainRetirementPeerTrust } from "./memory-retirement-trust.js";
import type { MemoryStore } from "./store.js";
import { buildAuthHeaders } from "./sync-auth.js";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";

/** Matches the coordinator's per-request limit on `/v1/peers/revocations`. */
const CHECK_BATCH_SIZE = 25;

/** `unsupported` means the coordinator predates the check; `failed` means no group answered. */
export type PeerRevocationCheckStatus = "checked" | "unsupported" | "failed";

class CheckStatusError extends Error {
	constructor(readonly status: number) {
		super(`peer revocation check failed (${status})`);
	}
}

interface PinnedPeer {
	device_id: string;
	public_key: string;
}

type StoreLike = Pick<MemoryStore, "db" | "dbPath">;

function pinnedPeers(db: Database, localDeviceId: string): PinnedPeer[] {
	return (
		db
			.prepare(
				`SELECT peer_device_id, public_key FROM sync_peers
				 WHERE public_key IS NOT NULL AND TRIM(public_key) != '' AND peer_device_id != ?
				 ORDER BY peer_device_id`,
			)
			.all(localDeviceId) as Array<{ peer_device_id: string; public_key: string }>
	)
		.map((row) => ({ device_id: row.peer_device_id, public_key: row.public_key }))
		.filter(
			// The coordinator rejects identifiers its revocation store can't hold, which would fail a batch.
			(peer) =>
				isAuthControllerId(peer.device_id) &&
				peer.public_key.length <= 4096 &&
				!peer.public_key.includes("\0"),
		);
}

function revokedIdsFromResponse(response: Record<string, unknown> | null, sent: PinnedPeer[]) {
	if (response?.version !== 1 || !Array.isArray(response.revoked))
		throw new Error("peer_revocation_response_invalid");
	const sentIds = new Set(sent.map((peer) => peer.device_id));
	// Only IDs this device asked about can be removed, whatever else the reply contains.
	return response.revoked.filter(
		(value): value is string => typeof value === "string" && sentIds.has(value),
	);
}

async function checkBatch(
	store: StoreLike,
	config: CoordinatorSyncConfig,
	request: { localDeviceId: string; groupId: string; keysDir?: string },
	peers: PinnedPeer[],
): Promise<string[]> {
	const body = { peers };
	const bodyBytes = Buffer.from(JSON.stringify(body), "utf8");
	const url = `${buildBaseUrl(config.syncCoordinatorUrl)}/v1/peers/revocations?group_id=${encodeURIComponent(request.groupId)}`;
	const headers = buildAuthHeaders({
		deviceId: request.localDeviceId,
		dbPath: store.dbPath,
		method: "POST",
		url,
		bodyBytes,
		keysDir: request.keysDir,
	});
	const [status, response] = await requestJson("POST", url, {
		headers,
		body,
		bodyBytes,
		timeoutS: Math.max(1, config.syncCoordinatorTimeoutS),
	});
	if (status !== 200) throw new CheckStatusError(status);
	return revokedIdsFromResponse(response, peers);
}

/** The first configured group this device may sign the check for, or null when none can. */
async function firstAuthorizedGroup(
	store: StoreLike,
	config: CoordinatorSyncConfig,
	options: { localDeviceId: string; keysDir?: string },
	firstBatch: PinnedPeer[],
): Promise<{ groupId: string; revoked: string[] } | "unsupported" | null> {
	for (const groupId of config.syncCoordinatorGroups) {
		try {
			return {
				groupId,
				revoked: await checkBatch(store, config, { ...options, groupId }, firstBatch),
			};
		} catch (error) {
			if (!(error instanceof CheckStatusError)) throw error;
			if (error.status === 404) return "unsupported";
			// A disabled, removed, or archived enrollment in this group still leaves the others.
			if (error.status !== 401 && error.status !== 403 && error.status !== 409) throw error;
		}
	}
	return null;
}

/**
 * Asks the coordinator which pinned peers it has revoked by device ID or key.
 * Any failure keeps every pairing: `revoked` is empty unless the status is `checked`.
 */
export async function fetchRevokedPinnedPeers(
	store: StoreLike,
	config: CoordinatorSyncConfig,
	options: { localDeviceId: string; keysDir?: string },
): Promise<{ status: PeerRevocationCheckStatus; revoked: string[] }> {
	const peers = pinnedPeers(store.db, options.localDeviceId);
	if (peers.length === 0) return { status: "checked", revoked: [] };
	try {
		const first = await firstAuthorizedGroup(
			store,
			config,
			options,
			peers.slice(0, CHECK_BATCH_SIZE),
		);
		if (first === "unsupported") return { status: "unsupported", revoked: [] };
		if (!first) return { status: "failed", revoked: [] };
		const revoked = [...first.revoked];
		for (let start = CHECK_BATCH_SIZE; start < peers.length; start += CHECK_BATCH_SIZE) {
			const batch = peers.slice(start, start + CHECK_BATCH_SIZE);
			revoked.push(
				...(await checkBatch(store, config, { ...options, groupId: first.groupId }, batch)),
			);
		}
		return { status: "checked", revoked };
	} catch {
		return { status: "failed", revoked: [] };
	}
}

/** Deletes each revoked peer's pairing and replication cursors, whatever its trust source. */
export function removeRevokedPeers(
	db: Database,
	localDeviceId: string,
	peerDeviceIds: string[],
): number {
	if (peerDeviceIds.length === 0) return 0;
	return db
		.transaction(() => {
			let removed = 0;
			for (const peerDeviceId of peerDeviceIds) {
				// Content sync stops, but retirement controls still need this peer's pinned key.
				retainRetirementPeerTrust(db, { localDeviceId, peerDeviceId });
				db.prepare("DELETE FROM replication_cursors WHERE peer_device_id = ?").run(peerDeviceId);
				db.prepare("DELETE FROM replication_cursors_v2 WHERE peer_device_id = ?").run(peerDeviceId);
				removed += db
					.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?")
					.run(peerDeviceId).changes;
			}
			return removed;
		})
		.immediate();
}
