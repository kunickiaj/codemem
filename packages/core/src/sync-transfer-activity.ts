import type { Database } from "./db.js";

export type SyncTransferDirection = "send" | "receive";
export type SyncTransferErrorCode = "exchange_failed" | "apply_failed" | "scope_rejected";
export type SyncTransferObservationSource = "initiated" | "inbound";

export interface SyncDirectionalActivity {
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	errorCode: SyncTransferErrorCode | null;
	/** Unique observed operations, not a reconstruction of pre-upgrade history. */
	operations24h: number | null;
	snapshotItems24h: number | null;
	observedSince: string | null;
}

export interface PeerSyncActivity {
	send: SyncDirectionalActivity;
	receive: SyncDirectionalActivity;
}

const initialized = new WeakSet<Database>();

/** Additive compatibility migration, independent of the legacy schema-version marker. */
export function ensureSyncTransferActivitySchema(db: Database): void {
	if (initialized.has(db)) return;
	db.exec(`
		CREATE TABLE IF NOT EXISTS sync_transfer_observations (
			peer_device_id TEXT NOT NULL,
			direction TEXT NOT NULL CHECK(direction IN ('send', 'receive')),
			source TEXT NOT NULL DEFAULT 'initiated' CHECK(source IN ('initiated', 'inbound')),
			observed_since TEXT NOT NULL,
			last_attempt_at TEXT NOT NULL,
			last_success_at TEXT,
			error_code TEXT,
			PRIMARY KEY(peer_device_id, direction, source)
		);
		CREATE TABLE IF NOT EXISTS sync_transfer_receipts (
			peer_device_id TEXT NOT NULL,
			direction TEXT NOT NULL,
			kind TEXT NOT NULL CHECK(kind IN ('operation', 'snapshot')),
			transfer_id TEXT NOT NULL,
			observed_at TEXT NOT NULL,
			PRIMARY KEY(peer_device_id, direction, kind, transfer_id)
		);
		CREATE INDEX IF NOT EXISTS idx_sync_transfer_receipts_recent
			ON sync_transfer_receipts(peer_device_id, direction, observed_at, kind);
	`);
	// A rolled-back schema must not be remembered as initialized.
	if (!db.inTransaction) initialized.add(db);
}

export function recordSyncTransferObservation(
	db: Database,
	peerDeviceId: string,
	direction: SyncTransferDirection,
	options: {
		errorCode?: SyncTransferErrorCode;
		/** A successful window cannot resolve an error until the full exchange completes. */
		preserveError?: boolean;
		now?: Date;
		source?: SyncTransferObservationSource;
	} = {},
): void {
	ensureSyncTransferActivitySchema(db);
	const now = (options.now ?? new Date()).toISOString();
	// Only the same request source can resolve its error. Incoming heartbeats cannot
	// resolve a pull's failed operation, and a pull cannot resolve a failed push.
	db.prepare(`INSERT INTO sync_transfer_observations
		(peer_device_id, direction, source, observed_since, last_attempt_at, last_success_at, error_code)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(peer_device_id, direction, source) DO UPDATE SET
		last_attempt_at = excluded.last_attempt_at,
		last_success_at = COALESCE(excluded.last_success_at, last_success_at),
		error_code = CASE
			WHEN excluded.error_code IS NULL AND ? = 1 THEN error_code
			WHEN excluded.error_code = 'exchange_failed' AND error_code IN ('apply_failed', 'scope_rejected')
			THEN error_code ELSE excluded.error_code END
	`).run(
		peerDeviceId,
		direction,
		options.source ?? "initiated",
		now,
		now,
		options.errorCode ? null : now,
		options.errorCode ?? null,
		options.preserveError ? 1 : 0,
	);
}

/** Call inside the transaction that commits the applied mutation or its acknowledgement. */
export function recordSyncTransferReceipts(
	db: Database,
	peerDeviceId: string,
	direction: SyncTransferDirection,
	transferIds: readonly string[],
	options: { kind?: "operation" | "snapshot"; now?: Date } = {},
): void {
	ensureSyncTransferActivitySchema(db);
	const now = (options.now ?? new Date()).toISOString();
	const insert = db.prepare(`INSERT OR IGNORE INTO sync_transfer_receipts
		(peer_device_id, direction, kind, transfer_id, observed_at) VALUES (?, ?, ?, ?, ?)`);
	for (const id of transferIds)
		insert.run(peerDeviceId, direction, options.kind ?? "operation", id, now);
}

function unknownActivity(): SyncDirectionalActivity {
	return {
		lastAttemptAt: null,
		lastSuccessAt: null,
		errorCode: null,
		operations24h: null,
		snapshotItems24h: null,
		observedSince: null,
	};
}

/** Batched indexed reads. Empty checks prove an exchange only, never stream exhaustion. */
export function readPeerSyncActivity(
	db: Database,
	peerIds: readonly string[],
	options: { now?: string } = {},
): Map<string, PeerSyncActivity> {
	const result = new Map(
		peerIds.map((id) => [id, { send: unknownActivity(), receive: unknownActivity() }]),
	);
	if (peerIds.length === 0) return result;
	ensureSyncTransferActivitySchema(db);
	const now = options.now ? new Date(options.now) : new Date();
	const cutoff = new Date(now.getTime() - 86_400_000).toISOString();
	// Stay below SQLite's parameter limit even for large peer inventories.
	for (let offset = 0; offset < peerIds.length; offset += 400) {
		const ids = peerIds.slice(offset, offset + 400);
		const placeholders = ids.map(() => "?").join(",");
		const rows = db
			.prepare(`SELECT o.peer_device_id, o.direction,
			MIN(o.observed_since) AS observed_since,
			MAX(o.last_attempt_at) AS last_attempt_at,
			MAX(o.last_success_at) AS last_success_at,
			(SELECT e.error_code FROM sync_transfer_observations e
			 WHERE e.peer_device_id = o.peer_device_id AND e.direction = o.direction AND e.error_code IS NOT NULL
			 ORDER BY CASE WHEN e.error_code IN ('apply_failed', 'scope_rejected') THEN 0 ELSE 1 END,
			 e.last_attempt_at DESC LIMIT 1) AS error_code,
			(SELECT count(*) FROM sync_transfer_receipts r WHERE r.peer_device_id = o.peer_device_id
			 AND r.direction = o.direction AND r.observed_at >= ? AND r.observed_at <= ? AND r.kind = 'operation') AS operations,
			(SELECT count(*) FROM sync_transfer_receipts r WHERE r.peer_device_id = o.peer_device_id
			 AND r.direction = o.direction AND r.observed_at >= ? AND r.observed_at <= ? AND r.kind = 'snapshot') AS snapshots
			FROM sync_transfer_observations o WHERE o.peer_device_id IN (${placeholders})
			GROUP BY o.peer_device_id, o.direction
		`)
			.all(cutoff, now.toISOString(), cutoff, now.toISOString(), ...ids) as Array<{
			peer_device_id: string;
			direction: SyncTransferDirection;
			observed_since: string;
			last_attempt_at: string;
			last_success_at: string | null;
			error_code: SyncTransferErrorCode | null;
			operations: number;
			snapshots: number;
		}>;
		for (const row of rows) {
			const peer = result.get(row.peer_device_id);
			if (!peer) continue;
			peer[row.direction] = {
				lastAttemptAt: row.last_attempt_at,
				lastSuccessAt: row.last_success_at,
				errorCode: row.error_code,
				observedSince: row.observed_since,
				operations24h: row.operations,
				snapshotItems24h: row.snapshots,
			};
		}
	}
	return result;
}
