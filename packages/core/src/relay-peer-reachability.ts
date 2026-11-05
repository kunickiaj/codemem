import { type SharedManagedScope, sharedManagedScopes } from "./coordinator-runtime.js";
import type { Database } from "./db.js";
import { RELAY_LOGICAL_ORIGIN } from "./relay-client-config.js";
import type { RelayPeerClient } from "./relay-peer-client.js";
import type { SyncPeerReachabilityResolver } from "./sync-reachability-pass.js";

/**
 * Coordinator Space kinds relay may carry. Both are coordinator-authority
 * Spaces whose membership the receiver checks on every exchange.
 */
const RELAY_SPACE_KINDS = ["managed_project", "team"] as const;

/** Every coordinator Project or team Space the local device shares with a peer, by scope ID. */
export function relayPeerScopes(
	db: Database,
	peerDeviceId: string,
	coordinatorId: string,
): SharedManagedScope[] {
	const local = db.prepare("SELECT device_id FROM sync_device LIMIT 1").get() as
		| { device_id: string }
		| undefined;
	const peerPublicKey = db
		.prepare("SELECT public_key FROM sync_peers WHERE peer_device_id = ?")
		.pluck()
		.get(peerDeviceId) as string | null | undefined;
	if (!local?.device_id || !peerPublicKey) return [];
	return sharedManagedScopes(db, {
		localDeviceId: local.device_id,
		peerDeviceId,
		coordinatorId,
		peerGroupIds: null,
		peerPublicKey,
		kinds: RELAY_SPACE_KINDS,
	}).scopes;
}

/**
 * In-memory rotation that picks one Space per peer per call and advances by
 * one each time, so a peer that shares several Spaces covers all of them
 * across ticks in scope ID order.
 */
export function createRelayScopeRotation() {
	const next = new Map<string, number>();
	return (peerDeviceId: string, scopes: readonly SharedManagedScope[]) => {
		if (scopes.length === 0) return undefined;
		const index = next.get(peerDeviceId) ?? 0;
		next.set(peerDeviceId, index + 1);
		return scopes[index % scopes.length];
	};
}

export interface RelayPeerReachabilityOptions {
	readonly coordinatorId: string;
	/** The relay client for a coordinator group, or undefined when relay is off or paused there. */
	readonly clientForGroup: (groupId: string) => RelayPeerClient | undefined;
	/** Every client the daemon must keep registered. */
	readonly clients: () => readonly RelayPeerClient[];
	readonly logicalOrigin?: string;
	readonly signal?: AbortSignal;
}

/**
 * Daemon resolver that routes each peer through the client of the group that
 * owns this tick's shared Space. Peers with no shared managed Space, or whose
 * shared Spaces all belong to groups without a client, get direct sync only.
 */
export function createRelayPeerReachability(
	options: RelayPeerReachabilityOptions,
): SyncPeerReachabilityResolver {
	const rotate = createRelayScopeRotation();
	const logicalOrigin = options.logicalOrigin ?? RELAY_LOGICAL_ORIGIN;
	return {
		forPeer(db, peerDeviceId) {
			const scopes = relayPeerScopes(db, peerDeviceId, options.coordinatorId).filter((scope) =>
				options.clientForGroup(scope.groupId),
			);
			const scope = rotate(peerDeviceId, scopes);
			const relay = scope && options.clientForGroup(scope.groupId);
			if (!scope || !relay) return undefined;
			return { scopeId: scope.scopeId, logicalOrigin, relay };
		},
		clients: options.clients,
		signal: options.signal,
	};
}
