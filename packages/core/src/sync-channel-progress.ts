import type { Database } from "./db.js";

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

/** Save only after durable pull success. A changed peer boundary invalidates its outbound ACK. */
export function saveSyncChannelCompletedBoundary(db: Database, target: ProgressTarget): void {
	ensureSyncChannelProgress(db);
	const { peerDeviceId, scopeId, boundary } = target;
	db.prepare(`INSERT INTO sync_channel_progress
		(peer_device_id, scope_id, generation, snapshot_id, baseline_cursor, last_acked_cursor)
		VALUES (?, ?, ?, ?, ?, NULL)
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
	);
}

/** Bind ACK to the completed pull boundary, including when another pass changed it meanwhile. */
export function saveSyncChannelOutboundAck(
	db: Database,
	target: ProgressTarget & { cursor: string },
): void {
	const { peerDeviceId, scopeId, boundary, cursor } = target;
	const result = db
		.prepare(`UPDATE sync_channel_progress SET last_acked_cursor = ?
		WHERE peer_device_id = ? AND scope_id = ? AND generation = ? AND snapshot_id = ?
		AND baseline_cursor IS ? AND (last_acked_cursor IS NULL OR last_acked_cursor <= ?)`)
		.run(
			cursor,
			peerDeviceId,
			scopeId,
			boundary.generation,
			boundary.snapshot_id,
			boundary.baseline_cursor,
			cursor,
		);
	if (result.changes !== 1) throw new Error("channel progress changed");
}
