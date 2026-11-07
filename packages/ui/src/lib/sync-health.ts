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
	last_successful_connection?: {
		transport: "direct" | "relay" | null;
		at: string | null;
	};
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
	if (code === "snapshot_failed")
		return "Snapshot sync failed. Review sync diagnostics, then retry sync.";
	if (code === "scope_rejected")
		return "Received operations were rejected. Review shared-space access and sync diagnostics.";
	return null;
}

export function syncDirectionLabel(
	label: "Send" | "Receive",
	direction?: SyncDirectionHealth,
): string {
	if (direction?.state === "succeeded") return "Exchange succeeded";
	if (direction?.state === "needs_attention") return `${label} failed`;
	return syncHealthLabel(direction);
}

export function hasSyncAttemptFailure(health?: PeerSyncHealth | null): boolean {
	return (
		health?.state === "needs_attention" &&
		health.send.state !== "needs_attention" &&
		health.receive.state !== "needs_attention"
	);
}

export function syncDirectionActivity(
	label: "Send" | "Receive",
	direction?: SyncDirectionHealth,
): string {
	const count = direction?.operations_24h;
	if (count == null) return "Operations not recorded · Last 24h";
	if (count === 0) {
		const action = label === "Send" ? "sent" : "received";
		return `No operations ${action} · Last 24h`;
	}
	const noun = count === 1 ? "operation" : "operations";
	return `${count.toLocaleString()} ${noun} · Last 24h`;
}

export function syncHealthSummary(health?: OverallSyncHealth | null): string {
	if (!health) return "Directional sync evidence is unavailable. Refresh to check again.";
	if (health.state === "disabled") return "Turn on sync in Settings → Device Sync.";
	if (health.state === "no_peers") return "Pair a device to exchange operations.";
	return `${health.peer_count} paired devices · ${health.attention_count} need attention · ${health.unverified_count} not verified · ${health.stale_count} stale.`;
}
