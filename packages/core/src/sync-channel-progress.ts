import type { Database } from "./db.js";
import { pairingStillExists } from "./pairing-instance.js";

export interface SyncChannelBoundary {
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
}

export interface SyncChannelProgress extends SyncChannelBoundary {
	last_acked_cursor: string | null;
}

interface ProgressTarget {
	peerDeviceId: string;
	scopeId: string;
	boundary: SyncChannelBoundary;
	/** The pairing instance the pass started under. A write for any other pairing is skipped. */
	pairingInstanceId?: string | null;
}

// Installed only by the opt-in channel pass, after explicit scope authorization.
function ensureSyncChannelProgress(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS sync_channel_progress (
		peer_device_id TEXT NOT NULL,
		scope_id TEXT NOT NULL,
		generation INTEGER NOT NULL,
		snapshot_id TEXT NOT NULL,
		baseline_cursor TEXT,
		last_acked_cursor TEXT,
		PRIMARY KEY (peer_device_id, scope_id)
	)`);
}

export function getSyncChannelProgress(
	db: Database,
	peerDeviceId: string,
	scopeId: string,
): SyncChannelProgress | null {
	ensureSyncChannelProgress(db);
	return (
		(db
			.prepare(`SELECT generation, snapshot_id, baseline_cursor, last_acked_cursor
		FROM sync_channel_progress WHERE peer_device_id = ? AND scope_id = ?`)
			.get(peerDeviceId, scopeId) as SyncChannelProgress | undefined) ?? null
	);
}

export function clearSyncChannelProgress(
	db: Database,
	peerDeviceId: string,
	scopeId: string,
): void {
	ensureSyncChannelProgress(db);
	db.prepare("DELETE FROM sync_channel_progress WHERE peer_device_id = ? AND scope_id = ?").run(
		peerDeviceId,
		scopeId,
	);
}

function syncChannelProgressExists(db: Database): boolean {
	return (
		db
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_channel_progress'",
			)
			.get() !== undefined
	);
}

/**
 * Deletes a removed peer's progress in every scope. A device that never ran the
 * channel pass has no table, and removing a pairing does not install one.
 */
export function deletePeerSyncChannelProgress(db: Database, peerDeviceId: string): number {
	if (!syncChannelProgressExists(db)) return 0;
	return db.prepare("DELETE FROM sync_channel_progress WHERE peer_device_id = ?").run(peerDeviceId)
		.changes;
}

/** Deletes progress whose peer has no pairing. Does nothing when the table was never installed. */
export function deleteUnpairedSyncChannelProgress(db: Database): number {
	if (!syncChannelProgressExists(db)) return 0;
	return db
		.prepare(
			// NOT IN matches nothing when any pairing has a NULL device ID, which old schemas allow.
			`DELETE FROM sync_channel_progress AS progress
			 WHERE NOT EXISTS (
			  SELECT 1 FROM sync_peers peer WHERE peer.peer_device_id = progress.peer_device_id
			 )`,
		)
		.run().changes;
}

export function hasCompletedSyncChannelBoundary(
	progress: SyncChannelProgress | null,
	boundary: SyncChannelBoundary,
): boolean {
	return (
		progress !== null &&
		progress.generation === boundary.generation &&
		progress.snapshot_id === boundary.snapshot_id &&
		progress.baseline_cursor === boundary.baseline_cursor
	);
}

/*
 * A channel pass saves progress after network I/O, and the peer can be removed
 * meanwhile. Each write requires the pairing, and the pairing instance the pass started
 * under, in the same statement, so a pass that outlives its pairing cannot put progress
 * back, even into a pairing created again under the same device ID. A skipped write is
 * not an error.
 */

/** Save only after durable pull success. A changed peer boundary invalidates its outbound ACK. */
export function saveSyncChannelCompletedBoundary(db: Database, target: ProgressTarget): void {
	ensureSyncChannelProgress(db);
	const { peerDeviceId, scopeId, boundary } = target;
	const pairing = pairingStillExists(peerDeviceId, target.pairingInstanceId);
	db.prepare(`INSERT INTO sync_channel_progress
		(peer_device_id, scope_id, generation, snapshot_id, baseline_cursor, last_acked_cursor)
		SELECT ?, ?, ?, ?, ?, NULL WHERE ${pairing.sql}
		ON CONFLICT (peer_device_id, scope_id) DO UPDATE SET
		last_acked_cursor = CASE WHEN generation = excluded.generation
			AND snapshot_id = excluded.snapshot_id AND baseline_cursor IS excluded.baseline_cursor
			THEN last_acked_cursor ELSE NULL END,
		generation = excluded.generation, snapshot_id = excluded.snapshot_id,
		baseline_cursor = excluded.baseline_cursor`).run(
		peerDeviceId,
		scopeId,
		boundary.generation,
		boundary.snapshot_id,
		boundary.baseline_cursor,
		...pairing.params,
	);
}

/** Bind ACK to the completed pull boundary, including when another pass changed it meanwhile. */
export function saveSyncChannelOutboundAck(
	db: Database,
	target: ProgressTarget & { cursor: string },
): void {
	const { peerDeviceId, scopeId, boundary, cursor } = target;
	const pairing = pairingStillExists(peerDeviceId, target.pairingInstanceId);
	const result = db
		.prepare(`UPDATE sync_channel_progress SET last_acked_cursor = ?
		WHERE peer_device_id = ? AND scope_id = ? AND generation = ? AND snapshot_id = ?
		AND baseline_cursor IS ? AND (last_acked_cursor IS NULL OR last_acked_cursor <= ?)
		AND ${pairing.sql}`)
		.run(
			cursor,
			peerDeviceId,
			scopeId,
			boundary.generation,
			boundary.snapshot_id,
			boundary.baseline_cursor,
			cursor,
			...pairing.params,
		);
	if (result.changes === 1) return;
	// A pairing removed, or created again, during the pass has no progress to acknowledge against.
	if (
		!db
			.prepare(`SELECT ${pairing.sql}`)
			.pluck()
			.get(...pairing.params)
	)
		return;
	throw new Error("channel progress changed");
}
