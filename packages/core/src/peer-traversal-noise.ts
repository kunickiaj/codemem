import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { DeferredTraversalTransport } from "./peer-traversal-noise-transport.js";
import { TraversalByteStream } from "./peer-traversal-stream.js";
import {
	type AuthenticatedRelayNoiseStream,
	acceptRelayNoiseResponder,
	prepareRelayNoiseInitiator,
	RELAY_NOISE_LIMITS,
	type RelayNoiseLimits,
} from "./relay-noise.js";
import type { RelayNoiseLocalIdentity } from "./relay-noise-identity.js";

export interface TraversalNoiseInitiatorOptions {
	readonly localIdentity: RelayNoiseLocalIdentity;
	readonly expectedRemotePin: string;
	readonly deadlineMs: number;
	readonly signal?: AbortSignal;
	readonly limits?: Partial<RelayNoiseLimits>;
}

export interface PreparedTraversalNoiseInitiator {
	readonly sessionId: Uint8Array;
	readonly opening: Promise<{ readonly bytes: Uint8Array; readonly digest: string }>;
	readonly authenticated: Promise<AuthenticatedRelayNoiseStream>;
	attachAndRelease(stream: TraversalByteStream): void;
	cancel(): void;
}

/** Caller-owned ANSWER-CHECK, pin, chain and RTC validation must precede attachment.
 * This primitive proves only Noise peer authentication and uses no coordinator authority. */
export function prepareTraversalNoiseInitiator(
	options: TraversalNoiseInitiatorOptions,
): PreparedTraversalNoiseInitiator {
	const sessionId = randomBytes(16);
	const transport = new DeferredTraversalTransport(
		options.limits?.bufferBytes ?? RELAY_NOISE_LIMITS.bufferBytes,
	);
	const prepared = prepareRelayNoiseInitiator({
		...options,
		transport,
		context: { transportLabel: 3, sessionId },
	});
	const opening = prepared.opening.then(({ bytes, digest }) => ({
		bytes: Uint8Array.from(bytes),
		digest,
	}));
	void opening.catch(() => {});
	return {
		get sessionId() {
			return Uint8Array.from(sessionId);
		},
		opening,
		authenticated: prepared.authenticated,
		attachAndRelease: (stream) => {
			try {
				transport.attach(stream);
				prepared.release(performance.now());
			} catch (error) {
				prepared.cancel();
				throw error;
			}
		},
		cancel: () => prepared.cancel(),
	};
}

/** The digest binds bytes only. The caller must supply the session from its checked chain. */
export async function acceptTraversalNoiseResponder(
	options: TraversalNoiseInitiatorOptions & {
		readonly stream: TraversalByteStream;
		readonly sessionId: Uint8Array;
		readonly verifiedMessageADigest: string;
	},
): Promise<AuthenticatedRelayNoiseStream> {
	try {
		if (!(options.stream instanceof TraversalByteStream) || options.stream.side !== "target")
			throw new TypeError("Traversal Noise responder requires a target TraversalByteStream");
		return await acceptRelayNoiseResponder({
			...options,
			transport: options.stream,
			context: { transportLabel: 3, sessionId: options.sessionId },
			acceptedAtMs: performance.now(),
		});
	} catch (error) {
		if (options.stream instanceof Duplex) options.stream.destroy();
		throw error;
	}
}
