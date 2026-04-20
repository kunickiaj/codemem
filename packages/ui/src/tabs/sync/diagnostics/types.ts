/* Shared diagnostics types + DOM constants. The type aliases describe
 * the shapes inside the viewer's /api/sync/status payload so the
 * renderers can narrow it instead of reaching through `unknown`. */

export type SyncRetention = {
	enabled?: boolean;
	last_deleted_ops?: number | string;
	last_error?: string;
	last_run_at?: string | null;
};

export type SyncPayloadState = {
	seconds_since_last?: number;
};

export type PingPayloadState = SyncPayloadState & {
	last_ping_at?: string | null;
};

export type SyncStatusState = {
	daemon_detail?: string;
	daemon_state?: string;
	enabled?: boolean;
	last_ping_at?: string | null;
	last_ping_error?: string;
	last_sync_at?: string | null;
	last_sync_at_utc?: string | null;
	last_sync_error?: string;
	pending?: number | string;
	peers?: Record<string, unknown>;
	ping?: PingPayloadState;
	retention?: SyncRetention;
	sync?: SyncPayloadState;
};

export type SyncAttemptState = {
	address?: string;
	error?: string;
	finished_at?: string;
	ops_in?: number;
	ops_out?: number;
	peer_device_id?: string;
	started_at?: string;
	started_at_utc?: string;
	status?: string;
};

export type PairingPayloadState = Record<string, unknown> & {
	addresses?: unknown[];
	redacted?: boolean;
};

export const SYNC_REDACT_MOUNT_ID = "syncRedactMount";
export const SYNC_REDACT_LABEL_ID = "syncRedactLabel";
