import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import type { Upgrader } from "@libp2p/interface";
import { type NoiseComponents, noise } from "@libp2p/noise";
import {
	importRelayNoiseIdentity,
	type RelayNoiseContext,
	type RelayNoiseLocalIdentity,
	relayNoiseExpectedPeer,
	relayNoisePrologue,
	verifyRelayNoisePeer,
} from "./relay-noise-identity.js";
import { relayNoiseOpeningDigest, validateRelayNoiseOpeningDigest } from "./relay-noise-opening.js";
import { RelayNoiseDuplex, RelayNoiseWire, relayNoiseSilentLog } from "./relay-noise-stream.js";

export interface RelayNoiseLimits {
	readonly handshakeMs: number;
	readonly handshakeBytes: number;
	readonly sessionMs: number;
	readonly sentBytes: number;
	readonly receivedBytes: number;
	readonly bufferBytes: number;
}

export const RELAY_NOISE_LIMITS: Readonly<RelayNoiseLimits> = Object.freeze({
	handshakeMs: 10_000,
	handshakeBytes: 256 * 1024,
	sessionMs: 15 * 60 * 1000,
	sentBytes: 1024 * 1024 * 1024,
	receivedBytes: 1024 * 1024 * 1024,
	bufferBytes: 256 * 1024,
});

export interface RelayNoiseOptions {
	readonly transport: Duplex;
	readonly localIdentity: RelayNoiseLocalIdentity;
	readonly expectedRemotePin: string;
	readonly context: RelayNoiseContext;
	readonly signal?: AbortSignal;
	/** Absolute monotonic time from performance.now(), including local Message A preparation. */
	readonly deadlineMs: number;
	readonly limits?: Partial<RelayNoiseLimits>;
}

export interface AuthenticatedRelayNoiseStream {
	readonly duplex: Duplex;
	readonly observedPin: string;
	readonly observedPeerId: string;
	readonly observedPublicKey: Uint8Array;
}

export interface PreparedRelayNoiseInitiator {
	readonly opening: Promise<{ readonly bytes: Uint8Array; readonly digest: string }>;
	readonly authenticated: Promise<AuthenticatedRelayNoiseStream>;
	/** Call once after admission and ACCEPTED. The timestamp is local performance.now() at acceptance. */
	release(acceptedAtMs: number): void;
	cancel(): void;
}

export function restrictedRelayNoiseUpgrader(): Upgrader {
	const unsupported = (): never => {
		throw new Error("Standalone Noise streams do not support networking");
	};
	return {
		upgradeInbound: unsupported,
		upgradeOutbound: unsupported,
		createInboundAbortSignal: unsupported,
		getStreamMuxers: () => new Map(),
		getConnectionEncrypters: () => new Map(),
	};
}

function resolveLimits(input: Partial<RelayNoiseLimits> | undefined): RelayNoiseLimits {
	const result = { ...RELAY_NOISE_LIMITS };
	for (const name of Object.keys(result) as (keyof RelayNoiseLimits)[]) {
		const value = input?.[name] === undefined ? result[name] : input[name];
		if (!Number.isSafeInteger(value) || value <= 0 || value > RELAY_NOISE_LIMITS[name]) {
			throw new Error(`Invalid Noise limit: ${name}`);
		}
		result[name] = value;
	}
	return result;
}

function observe<T>(promise: Promise<T>): Promise<T> {
	void promise.catch(() => {});
	return promise;
}

class RelayNoiseAttempt {
	readonly wire: RelayNoiseWire;
	readonly limits: RelayNoiseLimits;
	readonly controller = new AbortController();
	private readonly owner: Pick<NoiseComponents, "peerId" | "privateKey">;
	private readonly expectedPin: string;
	private readonly prologue: Uint8Array;
	private readonly remote: ReturnType<typeof relayNoiseExpectedPeer>;
	private timer?: ReturnType<typeof setTimeout>;
	private handshaking = true;
	private accepted = false;
	private handshakeBytes = 0;
	private sentBytes = 0;
	private receivedBytes = 0;
	private phaseDeadline: number;
	private duplex?: RelayNoiseDuplex;
	private failed?: Error;
	private terminated = false;

	constructor(
		private readonly options: RelayNoiseOptions,
		opening: "hold" | { verifiedDigest: string },
	) {
		this.options = { ...options };
		try {
			this.limits = resolveLimits(options.limits);
			if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= performance.now())
				throw new Error("Noise deadline expired or invalid");
			if (
				options.transport.destroyed ||
				options.transport.readableEnded ||
				options.transport.writableEnded ||
				options.transport.readableObjectMode ||
				options.transport.writableObjectMode ||
				options.transport.readableHighWaterMark > this.limits.bufferBytes ||
				options.transport.writableHighWaterMark > this.limits.bufferBytes ||
				options.transport.readableLength > this.limits.bufferBytes ||
				options.transport.writableLength !== 0
			)
				throw new Error("Noise transport buffers exceed limits or contain pending writes");
			this.owner = importRelayNoiseIdentity(options.localIdentity);
			this.expectedPin = options.expectedRemotePin;
			this.remote = relayNoiseExpectedPeer(this.expectedPin);
			this.prologue = relayNoisePrologue(options.context);
			this.phaseDeadline = options.deadlineMs;
		} catch (error) {
			options.transport.destroy();
			throw error;
		}
		options.transport.on("error", this.transportError);
		options.transport.once("close", this.transportClosed);
		this.wire = new RelayNoiseWire(options.transport, {
			bufferBytes: this.limits.bufferBytes,
			opening,
			account: (bytes) => this.accountWire(bytes),
			onFailure: (error) => this.stop(error),
			onReadEnd: () => {
				if (this.handshaking) this.stop(new Error("Noise handshake truncated"));
			},
		});
		options.signal?.addEventListener("abort", this.cancel, { once: true });
		this.setTimer();
		if (options.signal?.aborted) this.cancel();
	}

	accept(acceptedAtMs: number): void {
		this.checkActive();
		const now = performance.now();
		if (this.accepted || !Number.isFinite(acceptedAtMs) || acceptedAtMs < 0 || acceptedAtMs > now) {
			const error = new Error("Noise acceptance timestamp invalid or reused");
			this.stop(error);
			throw error;
		}
		this.accepted = true;
		this.phaseDeadline = Math.min(this.options.deadlineMs, acceptedAtMs + this.limits.handshakeMs);
		this.checkActive();
		this.setTimer();
	}

	async authenticate(role: "initiator" | "responder"): Promise<AuthenticatedRelayNoiseStream> {
		try {
			this.checkActive();
			// A factory is private to this attempt. No static key, crypto override, or signer is accepted.
			const encrypter = noise({ prologueBytes: Uint8Array.from(this.prologue) })({
				...this.owner,
				logger: { forComponent: () => relayNoiseSilentLog },
				upgrader: restrictedRelayNoiseUpgrader(),
			});
			const settings = {
				remotePeer: this.remote.peerId,
				signal: this.controller.signal,
				skipStreamMuxerNegotiation: true,
			};
			let secured: Awaited<ReturnType<typeof encrypter.secureInbound>>;
			if (role === "initiator") secured = await encrypter.secureOutbound(this.wire, settings);
			else secured = await encrypter.secureInbound(this.wire, settings);
			this.checkActive();
			verifyRelayNoisePeer(secured.remotePeer, this.expectedPin);
			this.handshaking = false;
			this.phaseDeadline = Math.min(
				this.options.deadlineMs,
				performance.now() + this.limits.sessionMs,
			);
			this.setTimer();
			this.duplex = new RelayNoiseDuplex(secured.connection, {
				bufferBytes: this.limits.bufferBytes,
				accountSent: (bytes) => this.accountPlaintext("sentBytes", bytes),
				accountReceived: (bytes) => this.accountPlaintext("receivedBytes", bytes),
			});
			this.duplex.once("close", this.applicationClosed);
			return {
				duplex: this.duplex,
				observedPin: this.expectedPin,
				observedPeerId: secured.remotePeer.toString(),
				observedPublicKey: Uint8Array.from(this.remote.rawKey),
			};
		} catch (error) {
			const failure = error instanceof Error ? error : new Error("Noise authentication failed");
			this.stop(failure);
			throw failure;
		}
	}

	private accountWire(bytes: number): void {
		this.checkActive();
		if (!this.handshaking) return;
		if (
			!Number.isSafeInteger(bytes) ||
			bytes < 0 ||
			bytes > this.limits.handshakeBytes - this.handshakeBytes
		) {
			const error = new Error("Noise handshake byte budget exceeded");
			this.stop(error);
			throw error;
		}
		this.handshakeBytes += bytes;
	}
	private accountPlaintext(direction: "sentBytes" | "receivedBytes", bytes: number): void {
		this.checkActive();
		if (
			!Number.isSafeInteger(bytes) ||
			bytes < 0 ||
			bytes > this.limits[direction] - this[direction]
		) {
			const error = new Error("Noise plaintext byte budget exceeded");
			this.stop(error);
			throw error;
		}
		this[direction] += bytes;
	}
	private checkActive(): void {
		if (this.failed !== undefined) throw this.failed;
		if (this.terminated) throw new Error("Noise stream closed");
		if (performance.now() >= this.phaseDeadline) {
			const error = new Error("Noise deadline exceeded");
			this.stop(error);
			throw error;
		}
	}
	private setTimer(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		const timer = setTimeout(
			() => {
				if (this.timer !== timer || this.terminated) return;
				this.timer = undefined;
				if (performance.now() < this.phaseDeadline) {
					this.setTimer();
					return;
				}
				this.stop(new Error("Noise deadline exceeded"));
			},
			Math.min(2_147_483_647, Math.max(1, Math.ceil(this.phaseDeadline - performance.now()))),
		);
		timer.unref();
		this.timer = timer;
	}
	stop(error: Error): void {
		if (this.terminated) return;
		this.terminated = true;
		this.failed = error;
		this.clearLifecycle();
		this.controller.abort(error);
		this.duplex?.destroy(error);
		this.wire?.abort(error);
		this.options.transport.destroy(error);
	}
	private clearLifecycle(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.options.signal?.removeEventListener("abort", this.cancel);
	}
	private finishCleanly(): void {
		if (this.terminated) return;
		this.terminated = true;
		this.clearLifecycle();
		// Mark the wire terminal before disposing wrappers, so their reset path sends no error.
		this.wire.onTransportClosed();
		this.controller.abort();
		this.options.transport.destroy();
	}
	private hasCleanTransportEnd(): boolean {
		return (
			!this.handshaking &&
			this.duplex?.errored === null &&
			this.options.transport.errored === null &&
			this.options.transport.readableEnded &&
			this.options.transport.writableFinished
		);
	}
	private isCleanlyFinished(): boolean {
		return (
			this.hasCleanTransportEnd() &&
			this.duplex?.readableEnded === true &&
			this.duplex.writableFinished
		);
	}
	private readonly applicationClosed = (): void => {
		if (this.isCleanlyFinished()) {
			this.finishCleanly();
			return;
		}
		this.stop(this.duplex?.errored ?? new Error("Noise application stream closed prematurely"));
	};
	private readonly cancel = (): void => this.stop(new Error("Noise attempt cancelled"));
	private readonly transportError = (error: Error): void => this.stop(error);
	private readonly transportClosed = (): void => {
		if (this.isCleanlyFinished()) this.finishCleanly();
		else if (!this.hasCleanTransportEnd())
			this.stop(this.options.transport.errored ?? new Error("Noise transport closed prematurely"));
		// A clean physical close may precede consumption of buffered plaintext. Node owns that EOF.
		this.options.transport.off("error", this.transportError);
	};
}

/** Prepares locally, without sending wire bytes. The same attempt continues after release. */
export function prepareRelayNoiseInitiator(
	options: RelayNoiseOptions,
): PreparedRelayNoiseInitiator {
	const attempt = new RelayNoiseAttempt(options, "hold");
	const authenticated = observe(attempt.authenticate("initiator"));
	const opening = observe(
		attempt.wire.opening.then((bytes) => ({ bytes, digest: relayNoiseOpeningDigest(bytes) })),
	);
	return {
		opening,
		authenticated,
		release: (acceptedAtMs) => {
			try {
				attempt.accept(acceptedAtMs);
				attempt.wire.releaseOpening();
			} catch (error) {
				attempt.stop(error instanceof Error ? error : new Error("Noise release failed"));
				throw error;
			}
		},
		cancel: () => attempt.stop(new Error("Noise attempt cancelled")),
	};
}

/** Admission verification is caller-owned. A digest is only a byte binding, never authorization. */
export async function acceptRelayNoiseResponder(
	options: RelayNoiseOptions & {
		readonly verifiedMessageADigest: string;
		readonly acceptedAtMs: number;
	},
): Promise<AuthenticatedRelayNoiseStream> {
	try {
		validateRelayNoiseOpeningDigest(options.verifiedMessageADigest);
	} catch (error) {
		options.transport.destroy();
		throw error;
	}
	const attempt = new RelayNoiseAttempt(options, {
		verifiedDigest: options.verifiedMessageADigest,
	});
	try {
		attempt.accept(options.acceptedAtMs);
		await attempt.wire.opening;
		// Nothing has entered the inbound factory before the complete prefix check.
		attempt.wire.releaseOpening();
		return await attempt.authenticate("responder");
	} catch (error) {
		attempt.stop(error instanceof Error ? error : new Error("Noise opening rejected"));
		throw error;
	}
}
