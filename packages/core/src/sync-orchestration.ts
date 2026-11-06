import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import * as schema from "./schema.js";
import { recordSyncAttempt, type SyncPassOptions, type SyncResult, syncOnce } from "./sync-pass.js";
import { runReachableSyncPass } from "./sync-reachability-pass.js";

/**
 * Run a sync pass with a peer, resolving addresses from the database.
 *
 * Loads peer addresses from the sync_peers table and delegates to syncOnce.
 */
export async function runSyncPass(
	db: Database,
	peerDeviceId: string,
	options?: SyncPassOptions,
): Promise<SyncResult> {
	// Load stored addresses for this peer
	const d = drizzle(db, { schema });
	const row = d
		.select({ addresses_json: schema.syncPeers.addresses_json })
		.from(schema.syncPeers)
		.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
		.get();

	let addresses: string[] = [];
	if (row?.addresses_json) {
		try {
			const parsed = JSON.parse(row.addresses_json);
			if (Array.isArray(parsed)) {
				addresses = parsed.filter((a): a is string => typeof a === "string");
			}
		} catch {
			// Malformed JSON — proceed with empty addresses
		}
	}

	if (!options?.reachability) return syncOnce(db, peerDeviceId, addresses, options);
	let directRecord: Parameters<typeof recordSyncAttempt>[2] | undefined;
	const result = await runReachableSyncPass(db, peerDeviceId, addresses, {
		...options,
		attemptRecorder: (_db, _peer, record) => {
			directRecord = record;
		},
	});
	const inheritsDirect =
		result.transport === "direct" ||
		(result.transport === "wait" && result.error === directRecord?.error);
	const record = inheritsDirect && directRecord ? directRecord : result;
	recordSyncAttempt(db, peerDeviceId, record);
	return result;
}
