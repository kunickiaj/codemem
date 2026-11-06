/**
 * Sync protocol capability negotiation helpers.
 *
 * Capability is intentionally separate from protocol_version. The wire protocol
 * remains version 2 while peers advertise how much of the future scope-aware
 * sync contract they understand.
 */

export const SYNC_CAPABILITIES = ["unsupported", "aware", "enforcing", "scoped"] as const;

export const SYNC_CAPABILITY_HEADER = "X-Codemem-Sync-Capability";

export const SYNC_FEATURES_HEADER = "X-Codemem-Sync-Features";
export const SYNC_AUTHORIZATION_REFRESH_HEADER = "X-Codemem-Refresh-Authorization";
export const SYNC_FEATURES = [
	"reassign_scope",
	"memory_scope_retirement_v1",
	"relay",
	"relay_aware",
] as const;
// Retirement is recognized but not advertised until snapshot and admission gates are complete.
// `relay_aware` marks a build that reports `relay` truthfully, so a peer can tell "this device
// runs no relay client" from "this device predates the `relay` feature". `relay` itself is
// advertised only by a viewer that runs a relay client; see `setLocalSyncFeature`.
export const LOCAL_SYNC_FEATURES: SyncFeature[] = ["reassign_scope", "relay_aware"];

/**
 * Turn a locally advertised feature on or off for this process. The viewer calls
 * this for `relay` once it knows whether it runs a relay client, before any peer
 * exchange, so status replies and outbound headers describe this device truthfully.
 */
export function setLocalSyncFeature(feature: SyncFeature, enabled: boolean): void {
	const index = LOCAL_SYNC_FEATURES.indexOf(feature);
	if (enabled && index < 0) LOCAL_SYNC_FEATURES.push(feature);
	if (!enabled && index >= 0) LOCAL_SYNC_FEATURES.splice(index, 1);
	LOCAL_SYNC_FEATURES.sort();
}

export type SyncCapability = (typeof SYNC_CAPABILITIES)[number];
export type SyncFeature = (typeof SYNC_FEATURES)[number];

export function normalizeSyncFeatures(value: unknown): SyncFeature[] {
	const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return [
		...new Set(
			values
				.map((item) => String(item).trim().toLowerCase())
				.filter((item): item is SyncFeature => SYNC_FEATURES.includes(item as SyncFeature)),
		),
	].toSorted();
}

export function supportsSyncFeature(value: unknown, feature: SyncFeature): boolean {
	return normalizeSyncFeatures(value).includes(feature);
}

/**
 * Local sync capability advertised on every wire response and outbound request.
 *
 * `scoped` (rank 3) signals the peer understands the per-Space sync protocol
 * defined in docs/plans/2026-05-25-scoped-sync-protocol.md:
 * - GET /v1/status emits `authorized_scopes` when caller is also scoped.
 * - GET /v1/ops and GET /v1/snapshot accept a signed `scope_id` query param.
 * - POST /v1/ops accepts a `scope_id` field in the signed body.
 *
 * Mixed-version pairs negotiate down to the lower rank (`aware`), so legacy
 * default-scope behavior is preserved end-to-end for either side that does
 * not advertise `scoped`.
 */
export const LOCAL_SYNC_CAPABILITY: SyncCapability = "scoped";

const CAPABILITY_RANK: Record<SyncCapability, number> = {
	unsupported: 0,
	aware: 1,
	enforcing: 2,
	scoped: 3,
};

/**
 * True when the negotiated capability supports per-Space scoped sync.
 *
 * Use this to gate `authorized_scopes` enumeration on /v1/status and to
 * decide whether to honor an explicit `scope_id` parameter on the other
 * sync routes. Returns false for `aware` / `enforcing` / `unsupported`,
 * preserving legacy default-scope behavior.
 */
export function isScopedSyncCapability(capability: SyncCapability): boolean {
	return CAPABILITY_RANK[capability] >= CAPABILITY_RANK.scoped;
}

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
