import { createPublicKey, KeyObject, randomBytes, sign } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import type { OwnedPeerHttpConnection, PeerHttpConnectionFactory } from "./peer-http-client.js";
import { PeerHttpExchangeError, type PeerHttpExchangeErrorCode } from "./peer-http-policy.js";
import { type PeerHttpServerOptions, servePeerHttpConnection } from "./peer-http-server.js";
import {
	decodeRelayCheckPacket,
	encodeRelayAdmissionBody,
	encodeRelayCheckPacket,
	encodeRelayRegistrationBody,
	type RelayAdmissionBody,
	type RelayCheckPacket,
} from "./relay-admission-codec.js";
import { verifyRelayCheckProof } from "./relay-admission-proof.js";
import { readRelayAdmissionReply } from "./relay-admission-reply.js";
import {
	decodeRelayControl,
	encodeRelayControl,
	type RelayControl,
} from "./relay-control-codec.js";
import { decodeRelayDataFrame } from "./relay-data-frame.js";
import { parseRelayEd25519PublicKey } from "./relay-ed25519.js";
import {
	asRelayFailure,
	createRelayFailureRecorder,
	RELAY_FAILURE_REASONS,
	RelayFailure,
	type RelayFailureReason,
	relayFailureReason,
} from "./relay-failure-reason.js";
import { acceptRelayNoiseResponder, prepareRelayNoiseInitiator } from "./relay-noise.js";
import type { RelayNoiseLocalIdentity } from "./relay-noise-identity.js";
import {
	ownRelayPeerConnection,
	RelayPeerTransport,
	relayAbortReason,
	relayPeerError,
} from "./relay-peer-transport.js";
import {
	relayAudienceId,
	relayBodyDigest,
	relayRealmId,
	verifyRelayServiceProof,
} from "./relay-service-proof.js";

type Deferred<T> = ReturnType<typeof Promise.withResolvers<T>>;
type ControlOf<T extends RelayControl["type"]> = Extract<RelayControl, { type: T }>;
const MAX_SOCKET_SESSIONS = 4096;
export interface RelayPeerContext {
	readonly peerDeviceId: string;
	readonly peerPin: string;
	readonly sessionId: string;
	readonly deadlineMs: number;
	readonly signal: AbortSignal;
	/** Invoke again immediately before shared HTTP dispatch. Admission grants no scope. */
	revalidate(): void;
	setReceivingPartial(options: { active: boolean }): void;
	/** Serves one exchange and handles receive-idle suspension and pre-dispatch pin revalidation. */
	serve(options: PeerHttpServerOptions): Promise<void>;
}

export interface RelayPairPacing {
	readonly monotonicMs: () => number;
	delay(milliseconds: number, signal: AbortSignal): Promise<void>;
}

const nativePairPacing: RelayPairPacing = {
	monotonicMs: () => performance.now(),
	delay: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
};

export interface RelayPeerClientOptions {
	readonly enabled?: boolean;
	readonly url: string;
	readonly allowLoopbackWs?: boolean;
	readonly servicePublicKey: string;
	readonly deviceId: string;
	readonly localIdentity: RelayNoiseLocalIdentity & { readonly key: KeyObject };
	readonly authorityId: string;
	readonly groupId: string;
	readonly relayAudienceId: string;
	readonly externalPathname: string;
	readonly coordinator: RelayPeerCoordinator;
	readonly resolvePeerPin: (peerDeviceId: string) => string | null;
	readonly validateLocal: () => boolean;
	/** Pair pacing only. Registration, proof freshness and route lifetimes use native clocks. */
	readonly pairPacing?: RelayPairPacing;
	readonly onInbound: (
		connection: OwnedPeerHttpConnection,
		context: RelayPeerContext,
	) => Promise<void>;
	/** Local diagnostics only. Never includes peer, route, key, payload, or raw error text. */
	readonly onInboundFailure?: (failure: RelayInboundFailure) => void;
	/** Local diagnostics with an ephemeral session for correlation with relay decisions. */
	readonly onRouteFailure?: (event: RelayRouteFailure) => void | Promise<void>;
}

export interface RelayRouteFailure {
	readonly sessionId: string;
	readonly side: "source" | "target";
	readonly reason: RelayFailureReason;
}

export interface RelayInboundFailure {
	readonly stage: "admission" | "handshake" | "http";
	readonly reason: RelayFailureReason;
	readonly httpCode?: PeerHttpExchangeErrorCode;
}

export interface RelayPeerCoordinator {
	check(options: {
		readonly packet: RelayCheckPacket;
		readonly deviceHeader: string;
		readonly signal: AbortSignal;
	}): Promise<Uint8Array | null>;
}

export interface RelayPeerConnectionFactory extends PeerHttpConnectionFactory {
	/** The first local failure reason across this factory's routes. Later failures never replace it. */
	failureReason(): RelayFailureReason | undefined;
}

export interface RelayPeerClient {
	connect(signal: AbortSignal, deadlineMs: number): Promise<void>;
	maintainRegistration(signal: AbortSignal, deadlineMs: number): Promise<void>;
	/** Create one factory per sync pass so its failure reason describes only that pass. */
	factory(peerDeviceId: string, currentPin: string): RelayPeerConnectionFactory;
	/** Call synchronously when local trust or the operator switch changes. */
	revalidate(): void;
	close(): Promise<void>;
}

interface Setup {
	readonly session: string;
	readonly proof: Deferred<ControlOf<"SERVICE_PROOF">>;
	readonly challenge: Deferred<RelayControl>;
	readonly registered: Deferred<ControlOf<"REGISTERED">>;
	proofReceived: boolean;
	challengeId?: string;
	registerSent: boolean;
}
interface Route {
	readonly id: string;
	socket?: WebSocket;
	readonly peer: string;
	readonly pin: string;
	readonly side: "source" | "target";
	readonly raw: RelayPeerTransport;
	readonly cancel: AbortController;
	readonly accepted: Deferred<void>;
	deadline: number;
	timer: ReturnType<typeof setTimeout>;
	active: boolean;
	opened: boolean;
	acceptedAtMs: number;
	inboundStage?: RelayInboundFailure["stage"];
}

function deferred<T>(): Deferred<T> {
	const value = Promise.withResolvers<T>();
	void value.promise.catch(() => {});
	return value;
}

function wait<T>(promise: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (result: { value: T } | { error: Error }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if ("error" in result) reject(result.error);
			else resolve(result.value);
		};
		const abort = (): void =>
			finish({ error: new RelayFailure("relay_expired", "Relay operation cancelled or expired") });
		const timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
		signal.addEventListener("abort", abort, { once: true });
		void promise.then(
			(value) => finish({ value }),
			(error: unknown) => finish({ error: relayPeerError(error) }),
		);
		if (signal.aborted || deadline <= performance.now()) abort();
	});
}

/**
 * Registration runs on its own client-owned deadline, so a timeout there means the relay did not
 * answer. Service proof, association, timeout, and socket failures all leave the relay unusable.
 */
function registrationFailure(error: unknown): RelayFailure {
	const failure = asRelayFailure(error, "relay_unavailable");
	if (failure.reason !== "relay_expired") return failure;
	return new RelayFailure("relay_unavailable", failure.message);
}

/** REJECTED and CLOSE abort carry no cause on the wire. Other controls here violate route order. */
function routeControlReason(message: RelayControl): RelayFailureReason {
	if (message.type === "REJECTED") return "relay_rejected";
	if (message.type === "CLOSE" && message.body.mode === "abort") return "relay_aborted";
	return "relay_frame_invalid";
}

function keyId(pin: string): string {
	return relayBodyDigest(parseRelayEd25519PublicKey(pin).wireKey);
}

function endpoint(options: RelayPeerClientOptions): string {
	const url = new URL(options.url);
	const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback && options.allowLoopbackWs)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error("Invalid relay WebSocket endpoint");
	// Disposable ws fixtures bind their audience to the same host/port with the wss scheme.
	const secureOrigin = url.origin.replace(/^ws:/, "wss:");
	if (relayAudienceId(secureOrigin, keyId(options.servicePublicKey)) !== options.relayAudienceId)
		throw new Error("Relay audience does not match the configured origin and service pin");
	return url.href;
}

class Client implements RelayPeerClient {
	private readonly options: RelayPeerClientOptions;
	private readonly url: string;
	private readonly localKeyId: string;
	private readonly pairPacing: RelayPairPacing;
	private socket?: WebSocket;
	private socketClosed?: Deferred<void>;
	/**
	 * Sockets already failed. A terminated socket can still deliver queued messages
	 * and its close event, and routes created for the next socket must survive both.
	 */
	private readonly failedSockets = new WeakSet<WebSocket>();
	private opening?: Deferred<void>;
	private setup?: Setup;
	private connecting?: Promise<void>;
	private registrationAbort?: AbortController;
	private registrationExpires = 0;
	private pendingBytes = 0;
	private readonly writes = new Set<(error?: Error) => void>();
	private readonly routes = new Map<string, Route>();
	private readonly retiredRoutes = new Set<string>();
	private readonly waiters = new Map<string, Deferred<void>>();
	private readonly nextPairOpen = new Map<string, number>();
	private closed = false;

	constructor(options: RelayPeerClientOptions) {
		this.options = { ...options, localIdentity: { ...options.localIdentity } };
		this.pairPacing = options.pairPacing ?? nativePairPacing;
		this.url = endpoint(options);
		this.localKeyId = keyId(options.localIdentity.expectedPin);
		const key = options.localIdentity.key;
		if (
			!(key instanceof KeyObject) ||
			key.type !== "private" ||
			key.asymmetricKeyType !== "ed25519"
		)
			throw new Error("Relay client requires an existing Ed25519 private KeyObject");
		const publicKey = createPublicKey(key).export({ format: "jwk" });
		if (
			publicKey.x !==
			Buffer.from(parseRelayEd25519PublicKey(options.localIdentity.expectedPin).rawKey).toString(
				"base64url",
			)
		)
			throw new Error("Relay local identity mismatch");
		const path = options.externalPathname;
		if (
			!path.startsWith("/") ||
			path.startsWith("//") ||
			/[\s?#\\]/u.test(path) ||
			!path.endsWith("/v1/relay/admission-check")
		)
			throw new Error("Invalid externally signed admission pathname");
	}

	private validate(peer?: string, pin?: string): void {
		if (this.closed || this.options.enabled !== true || !this.options.validateLocal())
			throw new RelayFailure(
				"relay_disabled",
				"Relay client disabled or local identity no longer current",
			);
		if (peer !== undefined && this.options.resolvePeerPin(peer) !== pin)
			throw new RelayFailure("relay_peer_revoked", "Relay peer pin no longer current");
	}

	connect(signal: AbortSignal, deadlineMs: number): Promise<void> {
		return this.maintainRegistration(signal, deadlineMs);
	}

	async maintainRegistration(signal: AbortSignal, deadlineMs: number): Promise<void> {
		this.validate();
		this.failClosingSocket();
		const deadline = Math.min(deadlineMs, performance.now() + 30_000);
		if (!Number.isFinite(deadlineMs) || signal.aborted || deadline <= performance.now())
			throw new RelayFailure("relay_expired", "Invalid relay setup lifetime");
		if (
			this.socket?.readyState === WebSocket.OPEN &&
			this.registrationExpires - performance.now() >= 150_000
		)
			return;
		if (!this.connecting) {
			const registrationAbort = new AbortController();
			this.registrationAbort = registrationAbort;
			const operation = this.register(registrationAbort.signal, performance.now() + 30_000);
			this.connecting = operation;
			void operation
				.finally(() => {
					if (this.connecting === operation) this.connecting = undefined;
					if (this.registrationAbort === registrationAbort) this.registrationAbort = undefined;
				})
				.catch(() => {});
		}
		await wait(this.connecting, signal, deadline);
	}

	private async openSocket(signal: AbortSignal, deadline: number): Promise<void> {
		if (this.socket?.readyState === WebSocket.OPEN) return;
		// A failed socket is terminated at once but clears only on its close event,
		// so the next open waits for that within its own deadline instead of failing.
		if (this.socket) await wait(this.socketClosed?.promise ?? Promise.resolve(), signal, deadline);
		if (this.socket) throw new Error("Relay socket still closing");
		const webSocketOptions: ClientOptions & {
			maxFragments: number;
			maxBufferedChunks: number;
			closeTimeout: number;
		} = {
			perMessageDeflate: false,
			autoPong: false,
			allowSynchronousEvents: false,
			closeTimeout: 1500,
			maxFragments: 32,
			maxBufferedChunks: 256,
			maxPayload: 65_558,
			followRedirects: false,
			handshakeTimeout: Math.max(1, deadline - performance.now()),
		};
		const socket = new WebSocket(this.url, webSocketOptions);
		this.socket = socket;
		const socketClosed = deferred<void>();
		this.socketClosed = socketClosed;
		const opened = deferred<void>();
		this.opening = opened;
		socket.once("open", () => opened.resolve());
		socket.on("error", () => {
			opened.reject(new Error("Relay WebSocket failed"));
			this.failSocket(socket);
		});
		socket.once("close", () => {
			this.failSocket(socket);
			if (this.socket !== socket) return;
			for (const write of this.writes)
				write(new RelayFailure("relay_unavailable", "Relay WebSocket closed"));
			this.retiredRoutes.clear();
			this.socket = undefined;
			socketClosed.resolve();
		});
		socket.on("message", (bytes, binary) => this.receive(socket, bytes, binary));
		socket.on("ping", () => this.failSocket(socket, "relay_frame_invalid"));
		socket.on("pong", () => this.failSocket(socket, "relay_frame_invalid"));
		try {
			await wait(opened.promise, signal, deadline);
		} finally {
			if (this.opening === opened) this.opening = undefined;
		}
	}

	private async register(signal: AbortSignal, deadline: number): Promise<void> {
		try {
			await this.openSocket(signal, deadline);
			this.validate();
			const setup: Setup = {
				session: randomBytes(16).toString("hex"),
				proof: deferred(),
				challenge: deferred(),
				registered: deferred(),
				proofReceived: false,
				registerSent: false,
			};
			this.setup = setup;
			const started = performance.now();
			await this.send({
				v: 1,
				type: "SERVICE_CHALLENGE",
				session: setup.session,
				body: { audienceId: this.options.relayAudienceId },
			});
			const proof = await wait(setup.proof.promise, signal, Math.min(deadline, started + 5000));
			if (
				!(await verifyRelayServiceProof({
					audienceId: this.options.relayAudienceId,
					challengeId: setup.session,
					publicKey: this.options.servicePublicKey,
					body: proof.body,
					startedAtMs: started,
					nowMs: performance.now(),
					deadlineMs: deadline,
				}))
			)
				throw new Error("Relay service proof invalid");
			const challenge = await wait(setup.challenge.promise, signal, deadline);
			this.validate();
			const packet = this.registrationPacket(challenge.session);
			setup.registerSent = true;
			const registrationStarted = performance.now();
			await this.send({ v: 1, type: "REGISTER", session: challenge.session, body: packet });
			const reply = await wait(setup.registered.promise, signal, deadline);
			this.checkRegistration(reply);
			this.validate();
			this.registrationExpires = registrationStarted + reply.body.remainingMs;
		} catch (error) {
			if (this.socket) this.failSocket(this.socket);
			throw registrationFailure(error);
		} finally {
			this.setup = undefined;
		}
	}

	private registrationPacket(socketChallengeId: string): RelayCheckPacket {
		const createdAt = Math.floor(Date.now() / 1000);
		return this.signPacket(
			encodeRelayRegistrationBody({
				authorityId: this.options.authorityId,
				groupId: this.options.groupId,
				deviceId: this.options.deviceId,
				keyId: this.localKeyId,
				relayAudienceId: this.options.relayAudienceId,
				socketChallengeId,
				createdAt,
				admitBefore: createdAt + 30,
			}),
			createdAt,
		);
	}

	private checkRegistration(reply: ControlOf<"REGISTERED">): void {
		const body = reply.body;
		if (
			body.deviceId !== this.options.deviceId ||
			body.keyId !== this.localKeyId ||
			body.authorityId !== this.options.authorityId ||
			body.realmId !== relayRealmId(this.options.authorityId, this.options.groupId)
		)
			throw new Error("Relay socket registration association mismatch");
	}

	private signPacket(bodyBytes: Uint8Array, createdAt: number): RelayCheckPacket {
		const nonce = randomBytes(16).toString("hex");
		const timestamp = String(createdAt);
		const canonical = [
			"POST",
			this.options.externalPathname,
			timestamp,
			nonce,
			relayBodyDigest(bodyBytes),
		].join("\n");
		return encodeRelayCheckPacket({
			bodyBytes,
			timestamp,
			nonce,
			signatureBytes: sign(null, Buffer.from(canonical), this.options.localIdentity.key),
		});
	}

	private send(message: RelayControl | Uint8Array): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const socket = this.socket;
			const bytes = message instanceof Uint8Array ? message : encodeRelayControl(message);
			const length = Buffer.byteLength(bytes) + 14;
			if (
				!socket ||
				socket.readyState !== WebSocket.OPEN ||
				this.writes.size >= 16 ||
				Math.max(socket.bufferedAmount, this.pendingBytes) + length > 1024 * 1024
			) {
				reject(new RelayFailure("relay_unavailable", "Relay WebSocket write capacity unavailable"));
				return;
			}
			this.pendingBytes += length;
			const done = (error?: Error): void => {
				if (!this.writes.delete(done)) return;
				this.pendingBytes -= length;
				if (error) reject(asRelayFailure(error, "relay_unavailable"));
				else resolve();
			};
			this.writes.add(done);
			try {
				socket.send(bytes, { binary: message instanceof Uint8Array }, done);
			} catch {
				this.failSocket(socket);
			}
		});
	}

	private receive(socket: WebSocket, data: RawData, binary: boolean): void {
		if (socket !== this.socket || this.failedSockets.has(socket)) return;
		try {
			this.validate();
			let bytes: Uint8Array;
			if (Array.isArray(data)) bytes = Buffer.concat(data);
			else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
			else bytes = data;
			if (binary) {
				const frame = decodeRelayDataFrame(bytes);
				if (this.retiredRoutes.has(frame.sessionId)) return;
				const route = this.routes.get(frame.sessionId);
				if (!route?.active) throw new Error("Relay DATA for unknown or unaccepted route");
				route.raw.receive(frame.payload);
				return;
			}
			this.control(decodeRelayControl(bytes));
		} catch (error) {
			// Untagged errors here are cleartext frame decode or ordering failures.
			this.failSocket(socket, relayFailureReason(error, "relay_frame_invalid"));
		}
	}

	private control(message: RelayControl): void {
		if (this.connectionControl(message)) return;
		if (message.type === "OPEN") {
			this.incoming(message);
			return;
		}
		const route = this.routes.get(message.session);
		if (!route) {
			if (message.type === "ACCEPTED" && this.retiredRoutes.has(message.session)) return;
			if (message.type === "CLOSE" || message.type === "REJECTED") return;
			throw new Error("Unexpected relay control");
		}
		if (message.type === "ACCEPTED" && route.side === "source" && route.opened && !route.active) {
			this.rememberOpen(route.peer);
			route.active = true;
			route.acceptedAtMs = performance.now();
			route.accepted.resolve();
		} else if (message.type === "CLOSE" && message.body.mode === "end" && route.active)
			route.raw.receiveEnd();
		else
			route.raw.destroy(
				new RelayFailure(routeControlReason(message), "Relay route rejected or aborted"),
			);
	}

	private connectionControl(message: RelayControl): boolean {
		const setup = this.setup;
		if (
			message.type === "SERVICE_PROOF" &&
			setup &&
			!setup.proofReceived &&
			message.session === setup.session
		) {
			setup.proofReceived = true;
			setup.proof.resolve(message);
			return true;
		}
		if (message.type === "SOCKET_CHALLENGE" && setup?.proofReceived && !setup.challengeId) {
			setup.challengeId = message.session;
			setup.challenge.resolve(message);
			return true;
		}
		if (
			message.type === "REGISTERED" &&
			setup?.registerSent &&
			message.session === setup.challengeId
		) {
			setup.registerSent = false;
			setup.registered.resolve(message);
			return true;
		}
		return false;
	}

	private failSocket(socket: WebSocket, reason: RelayFailureReason = "relay_unavailable"): void {
		if (this.socket !== socket || this.failedSockets.has(socket)) return;
		this.failedSockets.add(socket);
		this.registrationAbort?.abort();
		this.registrationExpires = 0;
		const error = new RelayFailure(reason, "Relay WebSocket disconnected");
		this.opening?.reject(error);
		this.setup?.proof.reject(error);
		this.setup?.challenge.reject(error);
		this.setup?.registered.reject(error);
		this.endRoutes(error);
		socket.terminate();
	}

	/**
	 * A graceful close leaves the socket CLOSING, without an event, until the peer
	 * ends TCP or closeTimeout passes. Fail it now, before a new route or
	 * registration exists, so its later close event cannot end them.
	 */
	private failClosingSocket(): void {
		const socket = this.socket;
		if (
			socket &&
			socket.readyState !== WebSocket.CONNECTING &&
			socket.readyState !== WebSocket.OPEN
		)
			this.failSocket(socket);
	}

	/** Ends every route and capacity waiter, including any created while a failed socket closes. */
	private endRoutes(error: Error): void {
		for (const route of this.routes.values()) route.raw.destroy(error);
		for (const waiter of this.waiters.values()) waiter.reject(error);
		this.waiters.clear();
	}

	factory(peerDeviceId: string, currentPin: string): RelayPeerConnectionFactory {
		const failures = createRelayFailureRecorder();
		return {
			open: async ({ signal, deadlineMs }) => {
				// A caller can abort and return before this open settles, so record the abort at once.
				const aborted = (): void => failures.record(relayAbortReason(signal, { secured: false }));
				signal.addEventListener("abort", aborted, { once: true });
				try {
					return await this.open(peerDeviceId, currentPin, signal, deadlineMs, failures.record);
				} catch (error) {
					// Routes record their own reason first. This covers failures before a route exists.
					failures.record(relayFailureReason(error, "relay_unavailable"));
					throw error;
				} finally {
					signal.removeEventListener("abort", aborted);
				}
			},
			failureReason: failures.reason,
		};
	}

	private hasRoute(peer: string, side: Route["side"]): boolean {
		return [...this.routes.values()].some((route) => route.peer === peer && route.side === side);
	}

	private async capacity(peer: string, signal: AbortSignal, deadline: number): Promise<void> {
		if (!this.hasRoute(peer, "source") && this.routes.size < 4) return;
		if (this.waiters.has(peer) || this.waiters.size >= 4)
			throw new RelayFailure("relay_unavailable", "Relay capacity exhausted");
		const waiter = deferred<void>();
		this.waiters.set(peer, waiter);
		try {
			await wait(waiter.promise, signal, Math.min(deadline, performance.now() + 3000)).catch(
				(error: unknown) => {
					// Only the local 3 s cap ends the wait with relay_expired while the caller is still
					// live and in time. Keep any other failure, such as a socket failure rejecting the waiter.
					const capTimedOut =
						error instanceof RelayFailure &&
						error.reason === "relay_expired" &&
						!signal.aborted &&
						performance.now() < deadline;
					if (!capTimedOut) throw error;
					throw new RelayFailure("relay_unavailable", "Relay capacity exhausted");
				},
			);
			if (this.hasRoute(peer, "source") || this.routes.size >= 4)
				throw new RelayFailure("relay_unavailable", "Relay capacity exhausted");
		} finally {
			if (this.waiters.get(peer) === waiter) this.waiters.delete(peer);
		}
	}

	private createRoute(
		id: string,
		peer: string,
		pin: string,
		side: Route["side"],
		signal: AbortSignal,
		deadline: number,
		onFailure?: (reason: RelayFailureReason) => void,
	): Route {
		this.validate(peer, pin);
		if (signal.aborted || deadline <= performance.now())
			throw new RelayFailure("relay_expired", "Relay route lifetime expired");
		if (
			this.routes.has(id) ||
			this.retiredRoutes.has(id) ||
			this.routes.size >= 4 ||
			this.retiredRoutes.size + this.routes.size >= MAX_SOCKET_SESSIONS ||
			this.hasRoute(peer, side)
		)
			throw new RelayFailure("relay_unavailable", "Relay route capacity exhausted");
		const cancel = new AbortController();
		const abort = (): void => cancel.abort(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) cancel.abort(signal.reason);
		const raw = new RelayPeerTransport({
			sessionId: id,
			side,
			deadlineMs: deadline,
			signal: cancel.signal,
			validate: () => this.validate(peer, pin),
			send: (message) => this.sendRouteMessage(message, { id, side }),
			terminate: () => {
				if (this.socket) this.failSocket(this.socket);
			},
			remove: ({ clean }) =>
				this.removeRoute(id, () => {
					signal.removeEventListener("abort", abort);
					if (!clean) cancel.abort();
				}),
			onFailure: (reason) => {
				onFailure?.(reason);
				this.reportRouteFailure(id, side, reason);
			},
		});
		const route: Route = {
			id,
			socket: this.socket,
			peer,
			pin,
			side,
			raw,
			cancel,
			accepted: deferred(),
			deadline,
			timer: setTimeout(() => cancel.abort(), Math.max(0, deadline - performance.now())),
			active: false,
			opened: false,
			acceptedAtMs: 0,
		};
		route.timer.unref();
		this.routes.set(id, route);
		return route;
	}

	private reportRouteFailure(
		sessionId: string,
		side: Route["side"],
		reason: RelayFailureReason,
	): void {
		if (
			sessionId.length !== 32 ||
			!/^[0-9a-f]{32}$/u.test(sessionId) ||
			!RELAY_FAILURE_REASONS.includes(reason)
		)
			return;
		try {
			void Promise.resolve(this.options.onRouteFailure?.({ sessionId, side, reason })).catch(
				() => {},
			);
		} catch {
			// A diagnostic reporter must not interrupt transport failure recording or cleanup.
		}
	}

	private sendRouteMessage(
		message: RelayControl | Uint8Array,
		{ id, side }: Pick<Route, "id" | "side">,
	): Promise<void> {
		// A reserved source route is unknown to the relay until OPEN is submitted.
		if (
			side === "source" &&
			!this.routes.get(id)?.opened &&
			!(message instanceof Uint8Array) &&
			message.type === "CLOSE"
		)
			return Promise.resolve();
		return this.send(message);
	}

	private removeRoute(id: string, cleanup: () => void): void {
		const route = this.routes.get(id);
		if (!route) return;
		if (route.socket === this.socket && this.socket?.readyState === WebSocket.OPEN)
			this.retiredRoutes.add(id);
		this.routes.delete(id);
		clearTimeout(route.timer);
		cleanup();
		route.accepted.reject(new Error("Relay route removed"));
		// Never evict session IDs while late frames can still arrive on this socket.
		if (this.routes.size === 0 && this.retiredRoutes.size >= MAX_SOCKET_SESSIONS && this.socket)
			this.failSocket(this.socket);
		this.wakeWaiters();
	}

	private wakeWaiters(): void {
		let capacity = 4 - this.routes.size;
		for (const [peer, waiter] of this.waiters) {
			if (capacity <= 0) return;
			if (this.hasRoute(peer, "source")) continue;
			capacity--;
			waiter.resolve();
		}
	}

	private async check(packet: RelayCheckPacket, deviceHeader: string, route: Route): Promise<void> {
		const started = performance.now();
		const bytes = await wait(
			this.options.coordinator.check({ packet, deviceHeader, signal: route.cancel.signal }),
			route.cancel.signal,
			route.deadline,
		).catch((error: unknown) => {
			throw asRelayFailure(error, "relay_admission_failed");
		});
		const reply = bytes && readRelayAdmissionReply(bytes, packet);
		// The coordinator client returns null for both a denial and an unreachable coordinator.
		if (!reply)
			throw new RelayFailure(
				"relay_admission_failed",
				"Relay independent coordinator check denied",
			);
		this.validate(route.peer, route.pin);
		route.deadline = Math.min(route.deadline, started + reply.remainingMs);
		if (route.deadline <= performance.now())
			throw new RelayFailure("relay_expired", "Relay admission expired in transit");
		clearTimeout(route.timer);
		route.timer = setTimeout(() => route.cancel.abort(), route.deadline - performance.now());
		route.timer.unref();
	}

	private pairNow(): number {
		const now = this.pairPacing.monotonicMs();
		if (!Number.isFinite(now))
			throw new RelayFailure("relay_unavailable", "Invalid relay pair pacing clock");
		return now;
	}

	private rememberOpen(peer: string): void {
		const now = this.pairNow();
		for (const [id, deadline] of this.nextPairOpen)
			if (deadline <= now) this.nextPairOpen.delete(id);
		if (!this.nextPairOpen.has(peer) && this.nextPairOpen.size >= 128)
			throw new RelayFailure("relay_unavailable", "Relay pacing capacity unavailable");
		// Each direction receives half the pair's 20 opens/minute and burst of two.
		// Acceptance anchors the delay after the relay actually reserved the previous open.
		this.nextPairOpen.set(peer, Math.max(this.nextPairOpen.get(peer) ?? 0, now + 6000));
	}

	private async pacePair(route: Route): Promise<void> {
		let remaining = (this.nextPairOpen.get(route.peer) ?? 0) - this.pairNow();
		while (remaining > 0) {
			const cancelDelay = new AbortController();
			try {
				// Keep native deadline/abort fences even when an injected delay ignores its signal.
				await wait(
					this.pairPacing.delay(Math.ceil(remaining), cancelDelay.signal),
					route.cancel.signal,
					route.deadline,
				);
			} finally {
				cancelDelay.abort();
			}
			this.validate(route.peer, route.pin);
			remaining = (this.nextPairOpen.get(route.peer) ?? 0) - this.pairNow();
		}
	}

	private async open(
		peer: string,
		pin: string,
		signal: AbortSignal,
		deadlineMs: number,
		record: (reason: RelayFailureReason) => void,
	): Promise<OwnedPeerHttpConnection> {
		if (!Number.isFinite(deadlineMs))
			throw new RelayFailure("relay_expired", "Invalid relay exchange deadline");
		const deadline = Math.min(deadlineMs, performance.now() + 60_000);
		this.validate(peer, pin);
		parseRelayEd25519PublicKey(pin);
		this.failClosingSocket();
		if (this.hasRoute(peer, "source") || this.routes.size >= 4)
			await this.capacity(peer, signal, deadline);
		// Reserve before registration yields, so concurrent invocations cannot bypass pair capacity.
		const route = this.createRoute(
			randomBytes(16).toString("hex"),
			peer,
			pin,
			"source",
			signal,
			deadline,
			record,
		);
		// The transport records its reason synchronously. This covers a route that ends otherwise.
		void route.raw.completion.catch(() => record(route.raw.failureReason ?? "relay_unavailable"));
		try {
			await this.maintainRegistration(route.cancel.signal, deadline);
			await this.pacePair(route);
			const prepared = prepareRelayNoiseInitiator(this.noiseOptions(route));
			const opening = await wait(prepared.opening, route.cancel.signal, route.deadline);
			const packets = this.admissionPackets(route, opening.digest);
			await this.check(packets[0], this.options.deviceId, route);
			this.validate(peer, pin);
			route.socket = this.socket;
			route.opened = true;
			await this.send({
				v: 1,
				type: "OPEN",
				session: route.id,
				body: { checks: [packets[1], packets[2]] },
			});
			this.rememberOpen(peer);
			await wait(route.accepted.promise, route.cancel.signal, route.deadline);
			this.validate(peer, pin);
			prepared.release(route.acceptedAtMs);
			const secured = await wait(prepared.authenticated, route.cancel.signal, route.deadline);
			route.raw.markSecured();
			this.validate(peer, pin);
			return ownRelayPeerConnection(route.raw, secured.duplex);
		} catch (error) {
			route.raw.destroy(relayPeerError(error));
			await route.raw.completion.catch(() => {});
			throw relayPeerError(error);
		}
	}

	private admissionPackets(
		route: Route,
		messageADigest: string,
	): readonly [RelayCheckPacket, RelayCheckPacket, RelayCheckPacket] {
		const createdAt = Math.floor(Date.now() / 1000);
		const common: Omit<RelayAdmissionBody, "role"> = {
			authorityId: this.options.authorityId,
			groupId: this.options.groupId,
			sourceDeviceId: this.options.deviceId,
			sourceKeyId: this.localKeyId,
			targetDeviceId: route.peer,
			targetKeyId: keyId(route.pin),
			relayAudienceId: this.options.relayAudienceId,
			routeSessionId: route.id,
			messageADigest,
			createdAt,
			admitBefore: createdAt + 30,
			routeNotAfter: createdAt + 55,
		};
		const packet = (role: RelayAdmissionBody["role"]): RelayCheckPacket =>
			this.signPacket(encodeRelayAdmissionBody({ role, ...common }), createdAt);
		const packets = [packet("source"), packet("relay"), packet("responder")] as const;
		if (new Set(packets.map((value) => value.nonce)).size !== 3)
			throw new Error("Relay admission nonces must be distinct");
		return packets;
	}

	private noiseOptions(route: Route) {
		return {
			transport: route.raw,
			localIdentity: this.options.localIdentity,
			expectedRemotePin: route.pin,
			context: { transportLabel: 1 as const, sessionId: Buffer.from(route.id, "hex") },
			signal: route.cancel.signal,
			deadlineMs: route.deadline,
		};
	}

	private incoming(message: ControlOf<"OPEN">): void {
		let route: Route;
		try {
			if (this.registrationExpires <= performance.now())
				throw new Error("Relay registration expired");
			const check = decodeRelayCheckPacket(message.body.checks[1]);
			if (check.kind !== "admission") throw new Error("Invalid relay admission");
			const body = check.value;
			const pin = this.options.resolvePeerPin(body.sourceDeviceId);
			if (
				!pin ||
				body.targetDeviceId !== this.options.deviceId ||
				body.targetKeyId !== this.localKeyId ||
				body.sourceKeyId !== keyId(pin) ||
				body.authorityId !== this.options.authorityId ||
				body.groupId !== this.options.groupId ||
				body.relayAudienceId !== this.options.relayAudienceId
			)
				throw new Error("Relay inbound tuple mismatch");
			route = this.createRoute(
				message.session,
				body.sourceDeviceId,
				pin,
				"target",
				new AbortController().signal,
				performance.now() + 60_000,
			);
			route.inboundStage = "admission";
			void this.acceptIncoming(route, message.body.checks[1], body.messageADigest).catch(
				(error: unknown) => {
					this.reportInboundFailure(error, route);
					route.raw.destroy(relayPeerError(error));
				},
			);
		} catch (error) {
			this.reportInboundFailure(error);
			void this.send({ v: 1, type: "REJECTED", session: message.session, body: {} }).catch(
				() => {},
			);
		}
	}

	private reportInboundFailure(error: unknown, route?: Route): void {
		const stage = route?.inboundStage ?? "admission";
		// Route cleanup can cancel the waiter before the HTTP handler rejects.
		const originalError = route?.raw.errored ?? error;
		let fallback: RelayFailureReason = "relay_admission_failed";
		if (stage === "handshake") fallback = "relay_handshake_failed";
		if (stage === "http") fallback = "relay_record_invalid";
		const candidate = route?.raw.failureReason ?? relayFailureReason(originalError, fallback);
		const reason = RELAY_FAILURE_REASONS.includes(candidate) ? candidate : fallback;
		let httpCode: PeerHttpExchangeErrorCode | undefined;
		if (
			originalError instanceof PeerHttpExchangeError &&
			["framing", "response_too_large", "deadline", "cancelled", "transport", "cleanup"].includes(
				originalError.code,
			)
		)
			httpCode = originalError.code;
		try {
			this.options.onInboundFailure?.({ stage, reason, ...(httpCode ? { httpCode } : {}) });
		} catch {
			// Diagnostics must not interrupt rejection, transport disposal, or socket cleanup.
		}
	}

	private async acceptIncoming(
		route: Route,
		packet: RelayCheckPacket,
		messageADigest: string,
	): Promise<void> {
		const proof = await verifyRelayCheckProof({
			packet,
			expected: { kind: "admission", role: "responder" },
			signer: { deviceId: route.peer, publicKey: route.pin },
			deviceHeader: route.peer,
			externalPathname: this.options.externalPathname,
		});
		if (!proof) throw new Error("Relay source admission signature invalid");
		await this.check(packet, route.peer, route);
		this.validate(route.peer, route.pin);
		route.inboundStage = "handshake";
		route.active = true;
		const acceptedAtMs = performance.now();
		await this.send({ v: 1, type: "ACCEPTED", session: route.id, body: {} });
		const secured = await acceptRelayNoiseResponder({
			...this.noiseOptions(route),
			verifiedMessageADigest: messageADigest,
			acceptedAtMs,
		});
		route.raw.markSecured();
		this.validate(route.peer, route.pin);
		const connection = ownRelayPeerConnection(route.raw, secured.duplex);
		try {
			route.inboundStage = "http";
			const context: RelayPeerContext = {
				peerDeviceId: route.peer,
				peerPin: route.pin,
				sessionId: route.id,
				deadlineMs: route.deadline,
				signal: route.cancel.signal,
				revalidate: () => this.validate(route.peer, route.pin),
				setReceivingPartial: (options) => route.raw.setReceivingPartial(options),
				serve: (options) =>
					servePeerHttpConnection(connection, {
						...options,
						deadlineMs: Math.min(options.deadlineMs ?? route.deadline, route.deadline),
						dispatch: async (request) => {
							route.raw.setReceivingPartial({ active: false });
							this.validate(route.peer, route.pin);
							return options.dispatch(request);
						},
					}),
			};
			await wait(this.options.onInbound(connection, context), route.cancel.signal, route.deadline);
			await wait(connection.completion, route.cancel.signal, route.deadline);
		} catch (error) {
			await connection.dispose(relayPeerError(error));
			throw error;
		}
	}

	revalidate(): void {
		try {
			this.validate();
		} catch (error) {
			const reason = relayFailureReason(error, "relay_disabled");
			if (this.socket) this.failSocket(this.socket, reason);
			// failSocket does nothing for a socket that already failed, so end routes here too.
			this.endRoutes(new RelayFailure(reason, "Relay client no longer trusted"));
			return;
		}
		for (const route of this.routes.values()) {
			try {
				this.validate(route.peer, route.pin);
			} catch (error) {
				route.raw.destroy(relayPeerError(error));
			}
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		const registration = this.connecting;
		this.registrationAbort?.abort();
		const completions = [...this.routes.values()].map((route) => route.raw.completion);
		const socketClosed = this.socketClosed?.promise ?? Promise.resolve();
		if (this.socket) this.failSocket(this.socket, "relay_disabled");
		this.endRoutes(new RelayFailure("relay_disabled", "Relay client closed"));
		await Promise.all([
			Promise.allSettled([...completions, registration]),
			wait(socketClosed, new AbortController().signal, performance.now() + 1500),
		]);
	}
}

/** Construction performs no I/O. Only explicit enabled clients can register or open routes. */
export function createRelayPeerClient(options: RelayPeerClientOptions): RelayPeerClient {
	return new Client(options);
}

export function isRelayPeerClient(value: unknown): value is RelayPeerClient {
	return value instanceof Client;
}
