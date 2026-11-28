import type { Database } from "./db.js";
import {
	currentPeerPin,
	DirectNoiseNotOffered,
	directNoiseConnectionFactory,
} from "./direct-noise-client.js";
import { DIRECT_NOISE_LOGICAL_ORIGIN } from "./direct-noise-upgrade.js";
import { createPeerHttpExecutor } from "./peer-http-client.js";
import { buildDirectPeerAuthHeaders } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
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
 *   allowed. The policy is read again just before every plaintext request.
 *
 * A status counts only when it names the peer's current pin. It unlocks
 * snapshots only on the transport that carried it and only while that pin
 * stays current. A status over Noise, on a stream the current pin
 * authenticated, promotes the peer to noise_required. While direct Noise is
 * switched off this returns the plaintext executor unchanged.
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

type Transport = "noise" | "plaintext";

type AddressState = {
	mode: "untried" | Transport;
	/** The transport and pin of the last status that named the current pin. */
	validated: { transport: Transport; pin: string } | null;
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
type Sent = { result: ExecutorResult; transport: Transport; pin: string | null };

class PeerTransport {
	private readonly states = new Map<string, AddressState>();
	private readonly plaintextExecutor: RequestJsonExecutor;

	constructor(private readonly options: PeerTransportOptions) {
		this.plaintextExecutor = options.plaintext ?? requestJson;
	}

	async execute(...request: ExecutorArgs): Promise<ExecutorResult> {
		const parsed = new URL(request[1]);
		const state = this.stateFor(parsed.origin);
		const sent = await this.attempt(state, request, parsed.pathname === "/v1/snapshot");
		if (parsed.pathname === "/v1/status") this.recordStatus(state, sent);
		return sent.result;
	}

	private stateFor(origin: string): AddressState {
		const state = this.states.get(origin) ?? {
			mode: "untried",
			validated: null,
			grantPinned: false,
		};
		this.states.set(origin, state);
		return state;
	}

	private policy() {
		return readPeerTransportPolicy(this.options.db, this.options.peerDeviceId);
	}

	/**
	 * Snapshots need a status on the same transport, naming the pin that is
	 * current now. Returns that pin, which a Noise snapshot's handshake must prove.
	 */
	private requireStatusFor(state: AddressState, transport: Transport): string {
		const pin = currentPeerPin(this.options.db, this.options.peerDeviceId);
		const validated = state.validated;
		if (!validated || validated.transport !== transport || validated.pin !== pin)
			throw new PeerTransportRefused(
				"status_first: a snapshot needs a status on the same transport and pin",
			);
		return validated.pin;
	}

	private recordStatus(state: AddressState, sent: Sent): void {
		const pin = currentPeerPin(this.options.db, this.options.peerDeviceId);
		const [status, payload] = sent.result;
		const names =
			status === 200 && pin !== null && payload?.fingerprint === fingerprintPublicKey(pin);
		// A Noise status counts only if the stream that carried it proved the current pin.
		const valid = names && (sent.transport === "plaintext" || sent.pin === pin);
		state.validated = valid && pin ? { transport: sent.transport, pin } : null;
		// Promote only for this request: over Noise, on a stream the current pin authenticated.
		if (valid && sent.transport === "noise")
			promotePeerToNoiseRequired(
				this.options.db,
				this.options.peerDeviceId,
				"authenticated_exchange",
			);
	}

	private async attempt(
		state: AddressState,
		request: ExecutorArgs,
		snapshot: boolean,
	): Promise<Sent> {
		if (state.mode === "plaintext" && this.policy() !== "noise_required")
			return this.sendPlaintext(state, request, snapshot);
		const statusPin = snapshot ? this.requireStatusFor(state, "noise") : null;
		if (this.policy() === "noise_required") await this.pinWithGrant(state, request);
		try {
			const sent = await this.overNoise(request, statusPin);
			state.mode = "noise";
			return sent;
		} catch (error) {
			if (!(error instanceof DirectNoiseNotOffered)) throw error;
			if (state.mode === "noise")
				throw new PeerTransportRefused(`noise_required: ${error.message}; plaintext refused`);
			if (this.options.allowLegacy === false)
				throw new PeerTransportRefused(`legacy_not_allowed: ${error.message}`);
			state.mode = "plaintext";
			return this.sendPlaintext(state, request, snapshot);
		}
	}

	/** Reads the policy immediately before sending, so a promotion during an await still counts. */
	private async sendPlaintext(
		state: AddressState,
		request: ExecutorArgs,
		snapshot: boolean,
	): Promise<Sent> {
		if (this.policy() === "noise_required")
			throw new PeerTransportRefused("noise_required: plaintext refused");
		if (snapshot) this.requireStatusFor(state, "plaintext");
		return { result: await this.plaintextExecutor(...request), transport: "plaintext", pin: null };
	}

	private async pinWithGrant(state: AddressState, request: ExecutorArgs): Promise<void> {
		const grantId = this.options.bootstrapGrantId;
		if (!grantId || state.grantPinned) return;
		const url = `${new URL(request[1]).origin}/v1/status?transport=noise1`;
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
		// The caller's cancellation and timeout bound this request too, like the one it precedes.
		const { signal, timeoutS } = request[2] ?? {};
		const [status] = await this.plaintextExecutor("GET", url, {
			headers,
			redirect: "error",
			signal,
			timeoutS,
		});
		if (status !== 200) throw new PeerTransportRefused(`bootstrap_pin_failed: status ${status}`);
		state.grantPinned = true;
	}

	/**
	 * Sends one request over Noise. The handshake must prove expectedPin: the
	 * validated status pin for a snapshot, otherwise the pin current now. The
	 * answer is dropped if that pin stopped being current while it was pending.
	 */
	private async overNoise(
		[method, url, requestOptions = {}]: ExecutorArgs,
		statusPin: string | null,
	): Promise<Sent> {
		const parsed = new URL(url);
		const endpoint = endpointOf(parsed);
		if (!endpoint) throw new DirectNoiseNotOffered(`${parsed.protocol} address`);
		const expectedPin = statusPin ?? currentPeerPin(this.options.db, this.options.peerDeviceId);
		if (!expectedPin) throw new Error("peer not pinned");
		const factory = directNoiseConnectionFactory({ ...this.options, ...endpoint, expectedPin });
		const execute = createPeerHttpExecutor({ factory, signal: requestOptions.signal });
		// The caller signed the path and query, which the logical origin keeps unchanged.
		const logical = `${DIRECT_NOISE_LOGICAL_ORIGIN}${parsed.pathname}${parsed.search}`;
		const result = await execute(method, logical, requestOptions).catch((error: unknown) => {
			throw factory.lastFailure() ?? error;
		});
		const pin = factory.authenticatedPin();
		if (pin !== expectedPin || currentPeerPin(this.options.db, this.options.peerDeviceId) !== pin)
			throw new PeerTransportRefused("peer key changed while the response was pending");
		return { result, transport: "noise", pin };
	}
}

export function peerTransportExecutor(options: PeerTransportOptions): RequestJsonExecutor {
	if (!(options.active ?? DIRECT_NOISE_ACTIVE)) return options.plaintext ?? requestJson;
	const transport = new PeerTransport(options);
	return (method, url, requestOptions) => transport.execute(method, url, requestOptions);
}

/**
 * The policy executor for a sync pass, reading this device's identity and any
 * pending bootstrap grant for the peer from the store. Every direct sync path
 * gets its executor here.
 */
export function peerTransportExecutorFor(
	db: Database,
	peerDeviceId: string,
	options: {
		keysDir?: string;
		dbPath?: string;
		directNoise?: { active?: boolean; allowLegacy?: boolean };
	} = {},
): RequestJsonExecutor {
	const local = db.prepare("SELECT device_id FROM sync_device LIMIT 1").pluck().get();
	const grant = db
		.prepare("SELECT pending_bootstrap_grant_id FROM sync_peers WHERE peer_device_id = ?")
		.pluck()
		.get(peerDeviceId);
	return peerTransportExecutor({
		db,
		peerDeviceId,
		localDeviceId: typeof local === "string" ? local : "",
		bootstrapGrantId: typeof grant === "string" && grant.trim() ? grant.trim() : undefined,
		keysDir: options.keysDir,
		dbPath: options.dbPath,
		...options.directNoise,
	});
}
