/**
 * How a sync request reached this device. Each mode states its own rules, and
 * the route code asks the mode instead of inferring them from other options.
 *
 * - plain-direct: the HTTP sync listener. Signed requests, bootstrap grants allowed.
 * - relay: a coordinator relay channel. Only scoped status, snapshot and ops,
 *   every request bound to the Noise peer's key, no bootstrap grants.
 * - noise-direct: a direct Noise channel. The plain-direct surface without
 *   bootstrap grants, every request bound to both the admitted device and its key.
 */
export type SyncServerMode =
	| { readonly kind: "plain-direct" }
	| { readonly kind: "relay"; readonly peerPin: (request: Request) => string | null }
	| {
			readonly kind: "noise-direct";
			readonly peer: (request: Request) => NoiseChannelPeer | null;
	  };

/** The device a direct Noise channel admitted, and the key its handshake proved. */
export interface NoiseChannelPeer {
	readonly deviceId: string;
	readonly pin: string;
}

export const PLAIN_DIRECT_MODE: SyncServerMode = Object.freeze({ kind: "plain-direct" });

/**
 * Checks that a signed request came from the peer its channel authenticated.
 * Undefined for plain-direct, where the signature is the only proof.
 */
export type ChannelBinding = (
	request: Request | undefined,
	deviceId: string,
	publicKey: string,
) => boolean;

function canonicalPin(publicKey: string): string | null {
	const [algorithm, blob] = publicKey.split(/\s+/);
	return algorithm === "ssh-ed25519" && blob ? `${algorithm} ${blob}` : null;
}

function bindsKey(pin: string | null | undefined, publicKey: string): boolean {
	const expected = canonicalPin(publicKey);
	return !!pin && !!expected && pin === expected;
}

export function channelBinding(mode: SyncServerMode): ChannelBinding | undefined {
	if (mode.kind === "plain-direct") return undefined;
	return (request, deviceId, publicKey) => {
		if (!request || request.signal.aborted) return false;
		try {
			if (mode.kind === "relay") return bindsKey(mode.peerPin(request), publicKey);
			const peer = mode.peer(request);
			return !!peer && peer.deviceId === deviceId && bindsKey(peer.pin, publicKey);
		} catch {
			return false;
		}
	};
}

/** Relay requests must name a scope. The default stream is never served there. */
export function requiresScope(mode: SyncServerMode): boolean {
	return mode.kind === "relay";
}

const CHANNEL_ROUTES = new Set([
	"GET /v1/status",
	"GET /v1/snapshot",
	"GET /v1/ops",
	"POST /v1/ops",
]);

/** Channels serve the peer protocol only. The plain listener keeps its own 404 for the rest. */
export function channelRouteAllowed(mode: SyncServerMode, method: string, path: string): boolean {
	return mode.kind === "plain-direct" || CHANNEL_ROUTES.has(`${method} ${path}`);
}
