/**
 * Sync protocol capability negotiation helpers.
 *
 * Capability is intentionally separate from protocol_version. The wire protocol
 * remains version 2 while peers advertise how much of the future scope-aware
 * sync contract they understand.
 */

export const SYNC_CAPABILITIES = ["unsupported", "aware", "enforcing"] as const;

export const SYNC_CAPABILITY_HEADER = "X-Codemem-Sync-Capability";

export type SyncCapability = (typeof SYNC_CAPABILITIES)[number];

export const LOCAL_SYNC_CAPABILITY: SyncCapability = "aware";

const CAPABILITY_RANK: Record<SyncCapability, number> = {
	unsupported: 0,
	aware: 1,
	enforcing: 2,
};

export function normalizeSyncCapability(value: unknown): SyncCapability {
	if (typeof value !== "string") return "unsupported";
	const normalized = value.trim().toLowerCase();
	return SYNC_CAPABILITIES.includes(normalized as SyncCapability)
		? (normalized as SyncCapability)
		: "unsupported";
}

export function negotiateSyncCapability(
	localCapability: unknown,
	peerCapability: unknown,
): SyncCapability {
	const local = normalizeSyncCapability(localCapability);
	const peer = normalizeSyncCapability(peerCapability);
	return CAPABILITY_RANK[local] <= CAPABILITY_RANK[peer] ? local : peer;
}
