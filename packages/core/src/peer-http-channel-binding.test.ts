import { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { AbstractMessageStream } from "@libp2p/utils";
import { afterEach, expect, it, vi } from "vitest";
import { createPeerHttpExecutor, type OwnedPeerHttpConnection } from "./peer-http-client.js";
import { PeerHttpExchangeError } from "./peer-http-policy.js";
import { type PeerHttpServerRequest, servePeerHttpConnection } from "./peer-http-server.js";
import { ORIGIN, serverNoisePair, TARGET } from "./peer-http-server-test-fixtures.js";
import { deferred } from "./peer-http-test-fixtures.js";
import { readAuthenticatedRelayNoisePeerPin } from "./relay-noise.js";
import { RelayNoiseDuplex, relayNoiseSilentLog } from "./relay-noise-stream.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});
async function pair(options?: Parameters<typeof serverNoisePair>[0]) {
	const result = await serverNoisePair(options);
	cleanups.push(() => result.close());
	return result;
}
function observe<T>(pending: Promise<T>): Promise<T> {
	void pending.catch(() => {});
	return pending;
}

/** Unauthenticated public MessageStream double, never an authentication proof. */
class UnauthenticatedMessageStream extends AbstractMessageStream {
	constructor() {
		super({ log: relayNoiseSilentLog, inactivityTimeout: 0 });
	}
	sendData(data: Parameters<AbstractMessageStream["sendData"]>[0]) {
		return { sentBytes: data.byteLength, canSendMore: true };
	}
	sendReset(_error: Error): void {}
	sendPause(): void {}
	sendResume(): void {}
	async close(): Promise<void> {
		this.writeStatus = "closed";
	}
}

function unauthenticatedOwner(): OwnedPeerHttpConnection {
	const duplex = new RelayNoiseDuplex(new UnauthenticatedMessageStream(), {
		bufferBytes: 256 * 1024,
		accountSent: () => {},
		accountReceived: () => {},
	});
	duplex.on("error", () => {});
	const completion = finished(duplex, { cleanup: true });
	void completion.catch(() => {});
	cleanups.push(async () => {
		duplex.destroy();
		await completion.catch(() => {});
	});
	return {
		duplex,
		completion,
		dispose: vi.fn(async (error: Error) => {
			duplex.destroy(error);
			await completion.catch(() => {});
		}),
	};
}

it("binds each frozen HTTP request to its actual remote channel pin despite unrelated owner metadata", async () => {
	// Arrange: both live channels authenticate distinct disposable identities.
	const first = await pair();
	const second = await pair();
	expect(first.sourcePin).not.toBe(second.sourcePin);
	for (const [current, other] of [
		[first, second],
		[second, first],
	] as const) {
		const captured = deferred<PeerHttpServerRequest>();
		const dispatch = vi.fn(async (request: PeerHttpServerRequest) => {
			captured.resolve(request);
			return { status: 200, bodyBytes: Buffer.from('{"ok":true}') };
		});
		const misleadingOwner = Object.assign({}, current.targetOwner, {
			peerPin: other.sourcePin,
			observedPin: other.sourcePin,
			session: { observedPin: other.sourcePin },
		});
		const serving = observe(servePeerHttpConnection(misleadingOwner, { origin: ORIGIN, dispatch }));
		const execute = createPeerHttpExecutor({ factory: { open: async () => current.sourceOwner } });
		// Act
		const [result] = await Promise.all([execute("GET", ORIGIN + TARGET), serving]);
		const request = await captured.promise;
		// Assert: copied session metadata cannot substitute another channel's identity.
		expect(result).toEqual([200, { ok: true }]);
		expect(request.peerPin).toBe(current.sourcePin);
		expect(request.peerPin).not.toBe(other.sourcePin);
		expect(request.peerPin).not.toBe(current.targetPin);
		expect(Object.isFrozen(request)).toBe(true);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(current.targetOwner.dispose).not.toHaveBeenCalled();
		expect(current.sourceOwner.dispose).not.toHaveBeenCalled();
		expect(current.errors).toEqual([]);
		expect(
			current.channels.map((channel) => [channel.disposals, channel.listeners, channel.dropped]),
		).toEqual([
			[1, 0, 0],
			[1, 0, 0],
		]);
	}
});

it("reads only the opposite peer's verified pin from each authenticated duplex", async () => {
	// Arrange
	const f = await pair();
	// Act
	const sourcePeer = readAuthenticatedRelayNoisePeerPin(f.source);
	const targetPeer = readAuthenticatedRelayNoisePeerPin(f.target);
	// Assert
	expect(sourcePeer).toBe(f.targetPin);
	expect(targetPeer).toBe(f.sourcePin);
	expect(sourcePeer).not.toBe(targetPeer);
});

it("canonicalizes an authenticated pin with tabs, extra spaces, and an unverified comment", async () => {
	// Arrange: change only the responder's expected pin text, preserving the actual identity key.
	const sourcePinTransform = (pin: string) =>
		`${pin.replace("ssh-ed25519 ", "ssh-ed25519\t  ")} unverified-comment`;
	const f = await pair({ sourcePinTransform });
	const captured = deferred<PeerHttpServerRequest>();
	const dispatch = vi.fn(async (request: PeerHttpServerRequest) => {
		captured.resolve(request);
		return { status: 200, bodyBytes: Buffer.from('{"ok":true}') };
	});
	const serving = observe(servePeerHttpConnection(f.targetOwner, { origin: ORIGIN, dispatch }));
	const execute = createPeerHttpExecutor({ factory: { open: async () => f.sourceOwner } });
	// Act
	const [result] = await Promise.all([execute("GET", ORIGIN + TARGET), serving]);
	const request = await captured.promise;
	const mappedPin = readAuthenticatedRelayNoisePeerPin(f.target);
	// Assert: both consumers receive key-derived text after a clean HTTP exchange.
	expect(result).toEqual([200, { ok: true }]);
	expect(dispatch).toHaveBeenCalledTimes(1);
	expect(f.errors).toEqual([]);
	expect(
		f.channels.map((channel) => [channel.disposals, channel.listeners, channel.dropped]),
	).toEqual([
		[1, 0, 0],
		[1, 0, 0],
	]);
	expect({ mappedPin, requestPin: request.peerPin }).toEqual({
		mappedPin: f.sourcePin,
		requestPin: f.sourcePin,
	});
	expect(mappedPin).not.toBe(sourcePinTransform(f.sourcePin));
});

it("does not transfer channel attestation through a proxy, copied properties, or a plain duplex", async () => {
	// Arrange
	const f = await pair();
	const plain = new Duplex({
		read() {},
		write(_bytes, _encoding, done) {
			done();
		},
	});
	cleanups.push(async () => {
		plain.destroy();
		await finished(plain).catch(() => {});
	});
	const copiedMetadata = Object.assign(plain, {
		peerPin: f.sourcePin,
		observedPin: f.sourcePin,
		session: { duplex: f.target, observedPin: f.sourcePin },
	});
	const proxy = new Proxy(f.target, {});
	// Act
	const pins = [
		readAuthenticatedRelayNoisePeerPin(copiedMetadata),
		readAuthenticatedRelayNoisePeerPin(proxy),
	];
	// Assert
	expect(pins).toEqual([null, null]);
	expect(readAuthenticatedRelayNoisePeerPin(f.target)).toBe(f.sourcePin);
});

it("rejects a fresh directly constructed Noise duplex with forged pin properties before HTTP attachment", async () => {
	// Arrange: class identity and caller metadata satisfy no authenticated handshake.
	const real = await pair();
	const owner = unauthenticatedOwner();
	Object.assign(owner.duplex, { peerPin: real.sourcePin, observedPin: real.sourcePin });
	const before = owner.duplex.eventNames().map((name) => [name, owner.duplex.listenerCount(name)]);
	const on = vi.spyOn(owner.duplex, "on");
	const pause = vi.spyOn(owner.duplex, "pause");
	const write = vi.spyOn(owner.duplex, "write");
	const dispatch = vi.fn();
	expect(owner.duplex.readableFlowing).not.toBe(true);
	expect(owner.duplex.readableLength).toBe(0);
	expect(owner.duplex.writableLength).toBe(0);
	expect(owner.duplex.destroyed).toBe(false);
	// Act
	const pin = readAuthenticatedRelayNoisePeerPin(owner.duplex);
	const failure: unknown = await servePeerHttpConnection(owner, { origin: ORIGIN, dispatch }).catch(
		(error: unknown) => error,
	);
	// Assert: no parser or plaintext audit may be attached before attestation.
	expect(pin).toBeNull();
	expect(failure).toBeInstanceOf(PeerHttpExchangeError);
	expect(failure).toHaveProperty("code", "transport");
	expect(failure).not.toHaveProperty("cause");
	expect(dispatch).not.toHaveBeenCalled();
	expect(write).not.toHaveBeenCalled();
	expect(pause).not.toHaveBeenCalled();
	expect(on.mock.calls.some(([name]) => name === "data")).toBe(false);
	expect(before.some(([name]) => name === "data")).toBe(false);
	expect(owner.duplex.destroyed).toBe(true);
	expect(owner.dispose).toHaveBeenCalledTimes(1);
});
