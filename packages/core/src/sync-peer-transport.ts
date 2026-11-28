import type { Database } from "./db.js";
import { DirectNoiseNotOffered, directNoiseConnectionFactory } from "./direct-noise-client.js";
import { DIRECT_NOISE_LOGICAL_ORIGIN } from "./direct-noise-upgrade.js";
import { createPeerHttpExecutor } from "./peer-http-client.js";
import { buildDirectPeerAuthHeaders } from "./sync-auth.js";
import { type RequestJsonExecutor, requestJson } from "./sync-http-client.js";
import {
	DIRECT_NOISE_ACTIVE,
	promotePeerToNoiseRequired,
	readPeerTransportPolicy,
} from "./sync-transport-policy.js";

/**
 * The one way a direct sync caller reaches a peer. It picks the transport
 * from the peer's stored policy, never from anything the network says:
 *
 * - noise_required: Noise only. A refused upgrade ends the request, with no
 *   plaintext retry on this or any later request.
 * - legacy_plaintext: one Noise attempt per address. If the peer does not
 *   switch, plaintext for the rest of the executor's life, when legacy is
 *   allowed. A status answered over Noise promotes the peer to noise_required.
 *
 * A snapshot request is refused until a status exchange has succeeded at the
 * same address. While direct Noise is switched off this returns the
 * plaintext executor unchanged.
 */
export interface PeerTransportOptions {
	readonly db: Database;
	readonly peerDeviceId: string;
	readonly localDeviceId: string;
	readonly keysDir?: string;
	readonly dbPath?: string;
	/** Plaintext executor for legacy peers. Defaults to requestJson. */
	readonly plaintext?: RequestJsonExecutor;
	/** Defaults to DIRECT_NOISE_ACTIVE. */
	readonly active?: boolean;
	/** Whether a legacy_plaintext peer may fall back to plaintext. Defaults to true. */
	readonly allowLegacy?: boolean;
	/**
	 * A bootstrap grant this device still holds for the peer. The peer cannot
	 * admit this device over Noise until the grant pins it, so a pin-only
	 * plaintext status marked transport=noise1 goes first. Its answer is never
	 * read: the full status comes over Noise, where the peer proves its key.
	 */
	readonly bootstrapGrantId?: string;
}

type AddressState = {
	mode: "untried" | "noise" | "plaintext";
	statusSeen: boolean;
	grantPinned: boolean;
};

export class PeerTransportRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PeerTransportRefused";
	}
}

function endpointOf(url: URL) {
	if (url.protocol !== "http:") return null;
	const port = Number(url.port || 80);
	return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

type ExecutorArgs = Parameters<RequestJsonExecutor>;
type ExecutorResult = Awaited<ReturnType<RequestJsonExecutor>>;

class PeerTransport {
	private readonly states = new Map<string, AddressState>();
	private readonly plaintext: RequestJsonExecutor;

	constructor(private readonly options: PeerTransportOptions) {
		this.plaintext = options.plaintext ?? requestJson;
	}

	async execute(...request: ExecutorArgs): Promise<ExecutorResult> {
		const parsed = new URL(request[1]);
		const state = this.stateFor(parsed.origin);
		if (parsed.pathname === "/v1/snapshot" && !state.statusSeen)
			throw new PeerTransportRefused("status_first: a snapshot needs a status exchange first");
		const result = await this.attempt(state, request);
		if (parsed.pathname === "/v1/status" && result[0] === 200) this.statusSucceeded(state);
		return result;
	}

	private stateFor(origin: string): AddressState {
		const state = this.states.get(origin) ?? {
			mode: "untried",
			statusSeen: false,
			grantPinned: false,
		};
		this.states.set(origin, state);
		return state;
	}

	private statusSucceeded(state: AddressState): void {
		state.statusSeen = true;
		if (state.mode !== "noise") return;
		promotePeerToNoiseRequired(
			this.options.db,
			this.options.peerDeviceId,
			"authenticated_exchange",
		);
	}

	private async attempt(state: AddressState, request: ExecutorArgs): Promise<ExecutorResult> {
		const policy = readPeerTransportPolicy(this.options.db, this.options.peerDeviceId);
		if (state.mode === "plaintext" && policy !== "noise_required")
			return this.plaintext(...request);
		if (policy === "noise_required") await this.pinWithGrant(state, new URL(request[1]).origin);
		try {
			const result = await this.overNoise(request);
			state.mode = "noise";
			return result;
		} catch (error) {
			if (!(error instanceof DirectNoiseNotOffered)) throw error;
			this.refuseDowngrade(policy, state, error);
			state.mode = "plaintext";
			return this.plaintext(...request);
		}
	}

	private refuseDowngrade(
		policy: ReturnType<typeof readPeerTransportPolicy>,
		state: AddressState,
		error: DirectNoiseNotOffered,
	): void {
		if (policy === "noise_required" || state.mode === "noise")
			throw new PeerTransportRefused(`noise_required: ${error.message}; plaintext refused`);
		if (this.options.allowLegacy === false)
			throw new PeerTransportRefused(`legacy_not_allowed: ${error.message}`);
	}

	private async pinWithGrant(state: AddressState, origin: string): Promise<void> {
		const grantId = this.options.bootstrapGrantId;
		if (!grantId || state.grantPinned) return;
		const url = `${origin}/v1/status?transport=noise1`;
		const headers = buildDirectPeerAuthHeaders({
			deviceId: this.options.localDeviceId,
			recipientId: this.options.peerDeviceId,
			method: "GET",
			url,
			bodyBytes: Buffer.alloc(0),
			keysDir: this.options.keysDir,
			dbPath: this.options.dbPath,
			bootstrapGrantId: grantId,
		});
		const [status] = await this.plaintext("GET", url, { headers });
		if (status !== 200) throw new PeerTransportRefused(`bootstrap_pin_failed: status ${status}`);
		state.grantPinned = true;
	}

	private async overNoise([method, url, requestOptions]: ExecutorArgs): Promise<ExecutorResult> {
		const parsed = new URL(url);
		const endpoint = endpointOf(parsed);
		if (!endpoint) throw new DirectNoiseNotOffered(`${parsed.protocol} address`);
		const factory = directNoiseConnectionFactory({ ...this.options, ...endpoint });
		const execute = createPeerHttpExecutor({ factory });
		// The caller signed the path and query, which the logical origin keeps unchanged.
		const logical = `${DIRECT_NOISE_LOGICAL_ORIGIN}${parsed.pathname}${parsed.search}`;
		return execute(method, logical, requestOptions).catch((error: unknown) => {
			throw factory.lastFailure() ?? error;
		});
	}
}

export function peerTransportExecutor(options: PeerTransportOptions): RequestJsonExecutor {
	if (!(options.active ?? DIRECT_NOISE_ACTIVE)) return options.plaintext ?? requestJson;
	const transport = new PeerTransport(options);
	return (method, url, requestOptions) => transport.execute(method, url, requestOptions);
}
