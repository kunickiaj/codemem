export type DirectionHealthState = "succeeded" | "not_verified" | "stale" | "needs_attention";

export interface SyncDirectionHealth {
	state: DirectionHealthState;
	last_attempt_at: string | null;
	last_success_at: string | null;
	operations_24h: number | null;
	pending_count: number | null;
	reason_code: string | null;
	snapshot_items_24h?: number | null;
	observed_since?: string | null;
}

export interface PeerSyncHealth {
	state: "exchange_succeeded" | "not_verified" | "stale" | "needs_attention";
	send: SyncDirectionHealth;
	receive: SyncDirectionHealth;
}

export interface OverallSyncHealth {
	state: PeerSyncHealth["state"] | "disabled" | "no_peers";
	peer_count: number;
	attention_count: number;
	unverified_count: number;
	stale_count: number;
}

const LABELS: Record<OverallSyncHealth["state"] | DirectionHealthState, string> = {
	exchange_succeeded: "OK",
	succeeded: "OK",
	not_verified: "Not verified",
	stale: "Stale",
	needs_attention: "Needs attention",
	disabled: "Sync off",
	no_peers: "No paired devices",
};

export function syncHealthLabel(value?: { state: keyof typeof LABELS } | null): string {
	return LABELS[value?.state ?? "not_verified"] ?? LABELS.not_verified;
}

export function syncHealthReason(code: string | null | undefined): string | null {
	if (code === "transfer_failed")
		return "Transfer failed. Check the device connection and retry sync.";
	if (code === "apply_failed")
		return "Received operations could not be applied. Review sync diagnostics, then retry.";
	if (code === "scope_rejected")
		return "Received operations were rejected. Review shared-space access and sync diagnostics.";
	return null;
}

export function syncHealthSummary(health?: OverallSyncHealth | null): string {
	if (!health) return "Directional sync evidence is unavailable. Refresh to check again.";
	if (health.state === "disabled") return "Turn on sync in Settings → Device Sync.";
	if (health.state === "no_peers") return "Pair a device to exchange operations.";
	return `${health.peer_count} paired devices · ${health.attention_count} need attention · ${health.unverified_count} not verified · ${health.stale_count} stale.`;
}
