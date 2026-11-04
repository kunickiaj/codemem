import {
	decodeRelayCheckPacket,
	type RelayAdmissionBody,
	type RelayCheckPacket,
	type RelayRegistrationBody,
} from "./relay-admission-codec.js";
import type { RelayAdmissionBudgetStatus } from "./relay-admission-decision.js";
import { readRelayAdmissionReply } from "./relay-admission-reply.js";
import {
	decodeRelayControl,
	encodeRelayControl,
	type RelayControl,
	relayHex,
} from "./relay-control-codec.js";
import { decodeRelayDataFrame } from "./relay-data-frame.js";
import {
	RELAY_RENEW_AFTER_MS,
	type RelayRegistrationSnapshot,
	readRelayRegistrationSnapshot,
	snapshotRelayRegistration,
} from "./relay-server-restore.js";
import {
	createRelayServiceProof,
	type RelayServiceSigner,
	relayRealmId,
} from "./relay-service-proof.js";

export interface RelayServerSocket {
	/** Calls onWritten exactly once when the adapter no longer owns these bytes, or with an error. */
	sendText(json: string, onWritten: (error?: Error) => void): void;
	/** Calls onWritten exactly once when the adapter no longer owns these bytes, or with an error. */
	sendBinary(frame: Uint8Array, onWritten: (error?: Error) => void): void;
	bufferedBytes(): number;
	pauseInput(): void;
	resumeInput(): void;
	close(): void;
}
export interface RelaySocketEvents {
	text(bytes: Uint8Array): Promise<void>;
	binary(bytes: Uint8Array): void;
	closed(): void;
	pending(): boolean;
}
export interface RelayServerLimits {
	sockets: number;
	pendingSockets: number;
	routes: number;
	deviceRoutes: number;
	queuedBytes: number;
	deviceQueuedBytes: number;
	coordinatorTimeoutMs: number;
	quotaTimeoutMs: number;
	/** Wire bytes per exchange. Unlike other limits, an omitted value means the ceiling. */
	routeBytes: number;
}
export interface RelayQuotaPort {
	/** Must reserve durable or finite preallocated capacity. Missing or uncertain outcomes deny. */
	reserve(
		request: {
			readonly purpose: "control" | "open" | "traffic";
			readonly realmId: string;
			readonly deviceId: string;
			readonly peerDeviceId: string | null;
			readonly units: number;
		},
		signal: AbortSignal,
	): Promise<RelayAdmissionBudgetStatus>;
}
export interface RelayServerOptions {
	readonly namespace: {
		readonly authorityId: string;
		readonly groupId: string;
		readonly relayAudienceId: string;
	};
	readonly limits?: Partial<RelayServerLimits>;
	readonly coordinator: {
		check(request: {
			readonly packet: RelayCheckPacket;
			readonly deviceHeader: string;
			readonly signal: AbortSignal;
		}): Promise<Uint8Array | null>;
	};
	readonly quota: RelayQuotaPort;
	readonly signer: RelayServiceSigner;
	/** Defaults to globalThis.performance and Date.now. */
	readonly clock?: { monotonicMs(): number; utcMs(): number };
	/** Returns `bytes` cryptographically random bytes. Defaults to crypto.getRandomValues. */
	readonly random?: (bytes: number) => Uint8Array;
	/**
	 * Runs after a registration is verified and before REGISTERED is sent, so a hibernating
	 * host can store the snapshot with the socket. A null snapshot means there is no restorable
	 * lease, because the UTC clock is unusable or no more than the 10 s guard remains. The host must
	 * then clear any stored copy. Throwing closes the socket.
	 *
	 * Host adapters must also clear the stored snapshot when the engine calls `socket.close()`,
	 * so a socket the engine closed cannot be restored after a later wake.
	 */
	readonly onRegistration?: (
		socket: RelayServerSocket,
		snapshot: RelayRegistrationSnapshot | null,
	) => void;
}
const CEILINGS: RelayServerLimits = {
	sockets: 128,
	pendingSockets: 16,
	routes: 32,
	deviceRoutes: 4,
	queuedBytes: 16 * 1024 * 1024,
	deviceQueuedBytes: 2 * 1024 * 1024,
	coordinatorTimeoutMs: 30_000,
	quotaTimeoutMs: 3000,
	routeBytes: 20 * 1024 * 1024,
};
const DIRECTION_BYTES = 256 * 1024;
/** Longest lifetime of any route, from OPEN to forced expiry. */
const ROUTE_LIFETIME_MS = 60_000;
/** First traffic grant per direction. Later grants double up to DIRECTION_BYTES. */
const INITIAL_TRAFFIC_GRANT = 16 * 1024;
const MAX_FRAME = 65_558;
const textBytes = new TextEncoder();
function defaultRandom(bytes: number): Uint8Array {
	return globalThis.crypto.getRandomValues(new Uint8Array(bytes));
}
function randomHex(random: (bytes: number) => Uint8Array, bytes: number): string {
	const value = random(bytes);
	if (!(value instanceof Uint8Array) || value.length !== bytes)
		throw new Error("Invalid relay random bytes");
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Hosts whose timer handles lack unref, such as Workers, skip it. */
function background(timer: ReturnType<typeof setTimeout>): void {
	(timer as { unref?: () => unknown }).unref?.();
}
interface Registration {
	readonly deviceId: string;
	readonly keyId: string;
	readonly expires: number;
	readonly started: number;
}
interface Connection {
	readonly socket: RelayServerSocket;
	readonly cancel: AbortController;
	readonly setupExpires: number;
	registration?: Registration;
	challenge?: { readonly id: string; readonly expires: number };
	phase: "service" | "signing" | "register" | "checking" | "ready";
	closing: boolean;
	physicalClosed: boolean;
	pending: boolean;
	controlPending: boolean;
	readonly controls: { readonly message: RelayControl; readonly resolve: () => void }[];
	paused: boolean;
	/** Application bytes still owned by the adapter, including control text and DATA. */
	writes: number;
	held: number;
	timer?: ReturnType<typeof setTimeout>;
	/** Present only on restored sockets: wake time and sessions already answered with CLOSE abort. */
	readonly restored?: { readonly at: number; readonly orphans: Set<string> };
}
interface BufferChange {
	readonly additionalBytes?: number;
	readonly releasedHeld?: { readonly connection: Connection; readonly bytes: number };
	readonly deviceId?: string;
}
interface Direction {
	sender: Connection;
	credit: number;
	/** Minimum size of the next traffic reservation. */
	nextGrant: number;
	readonly frames: Uint8Array[];
	waiting: boolean;
	pendingEnd: boolean;
	ended: boolean;
	endForwarded: boolean;
	/** Bytes submitted by this direction whose write callback has not completed. */
	writes: number;
}
interface Route {
	readonly id: string;
	readonly source: Connection;
	target?: Connection;
	readonly context: RelayAdmissionBody;
	readonly cancel: AbortController;
	readonly directions: readonly [Direction, Direction];
	expires: number;
	accepted: boolean;
	closed: boolean;
	bytes: number;
	frames: number;
	timer?: ReturnType<typeof setTimeout>;
}

/** An unwired, single-namespace state machine. It opens no listeners and supplies no quota implementation. */
export function createRelayServer(options: RelayServerOptions) {
	const engine = new RelayServerEngine(options);
	return {
		adopt: (socket: RelayServerSocket) => engine.adopt(socket),
		/** Re-adopts a socket after host eviction, or returns null so the host closes it. */
		restore: (socket: RelayServerSocket, snapshot: unknown) => engine.restore(socket, snapshot),
		close: () => engine.close(),
		counters: () => engine.counters(),
	};
}

class RelayServerEngine {
	private readonly connections = new Set<Connection>();
	private readonly registrations = new Map<string, Connection>();
	private readonly routes = new Map<string, Route>();
	private readonly limits: RelayServerLimits;
	private readonly namespace: RelayServerOptions["namespace"];
	private readonly realmId: string;
	private stopped = false;
	/** Live routes aborted because a traffic reservation was denied, uncertain or timed out. */
	private trafficQuotaAborts = 0;
	constructor(private readonly options: RelayServerOptions) {
		this.namespace = Object.freeze({ ...options.namespace });
		this.realmId = relayRealmId(this.namespace.authorityId, this.namespace.groupId);
		if (!relayHex(this.namespace.relayAudienceId)) throw new Error("Invalid relay namespace");
		this.limits = { ...CEILINGS };
		for (const key of Object.keys(CEILINGS) as (keyof RelayServerLimits)[]) {
			const value = options.limits?.[key] ?? (key === "routeBytes" ? CEILINGS.routeBytes : 0);
			if (!Number.isSafeInteger(value) || value < 0 || value > CEILINGS[key])
				throw new Error("Invalid relay limits");
			this.limits[key] = value;
		}
	}
	private now(): number {
		return this.options.clock?.monotonicMs() ?? globalThis.performance.now();
	}
	private utc(): number {
		return this.options.clock?.utcMs() ?? Date.now();
	}
	counters() {
		return {
			sockets: this.connections.size,
			pendingSockets: [...this.connections].filter((connection) => connection.pending).length,
			routes: this.routes.size,
			queuedBytes: this.queuedBytes(),
			trafficQuotaAborts: this.trafficQuotaAborts,
		};
	}
	private accepting(): boolean {
		return (
			!this.stopped &&
			typeof this.options.quota?.reserve === "function" &&
			Object.values(this.limits).every((value) => value !== 0) &&
			this.connections.size < this.limits.sockets
		);
	}
	adopt(socket: RelayServerSocket): RelaySocketEvents | null {
		if ([...this.connections].some((connection) => connection.socket === socket)) return null;
		if (!this.accepting() || this.counters().pendingSockets >= this.limits.pendingSockets)
			return null;
		const connection: Connection = {
			socket,
			cancel: new AbortController(),
			setupExpires: this.now() + 30_000,
			phase: "service",
			closing: false,
			physicalClosed: false,
			pending: true,
			controlPending: false,
			controls: [],
			paused: false,
			writes: 0,
			held: 0,
		};
		this.connections.add(connection);
		this.armConnection(connection);
		return this.events(connection);
	}
	/** Restores only the registration. Routes, challenges, controls, and frames never survive. */
	restore(socket: RelayServerSocket, snapshot: unknown): RelaySocketEvents | null {
		const known = [...this.connections].find((connection) => connection.socket === socket);
		if (known) {
			// A tracked socket cannot be re-adopted. Fail closed instead of merging state.
			this.disconnect(known);
			return null;
		}
		if (!this.accepting()) return null;
		const lease = readRelayRegistrationSnapshot(snapshot, {
			realmId: this.realmId,
			utcMs: this.utc(),
		});
		if (!lease) return null;
		const claimants = [...this.connections].filter(
			// A closing peer still counts, so no third socket can take the device during teardown.
			(other) => other.registration?.deviceId === lease.deviceId,
		);
		if (claimants.length > 0) {
			// Two sockets claiming one device after wake cannot be ordered. Close both.
			for (const other of claimants) this.disconnect(other);
			return null;
		}
		const now = this.now();
		const registration: Registration = Object.freeze({
			deviceId: lease.deviceId,
			keyId: lease.keyId,
			started: now + lease.renewInMs - RELAY_RENEW_AFTER_MS,
			expires: now + lease.remainingMs,
		});
		const connection: Connection = {
			socket,
			cancel: new AbortController(),
			setupExpires: now,
			registration,
			phase: "ready",
			closing: false,
			physicalClosed: false,
			pending: false,
			controlPending: false,
			controls: [],
			paused: false,
			writes: 0,
			held: 0,
			restored: { at: now, orphans: new Set() },
		};
		this.connections.add(connection);
		this.registrations.set(registration.deviceId, connection);
		return this.events(connection);
	}
	private events(connection: Connection): RelaySocketEvents {
		return {
			pending: () => connection.pending && !connection.closing,
			text: (bytes) => this.text(connection, bytes),
			binary: (bytes) => {
				try {
					this.binary(connection, bytes);
				} catch {
					this.disconnect(connection);
				}
			},
			closed: () => {
				connection.physicalClosed = true;
				this.disconnect(connection);
				this.connections.delete(connection);
			},
		};
	}
	close(): void {
		this.stopped = true;
		for (const connection of this.connections) this.disconnect(connection);
	}
	private live(connection: Connection): boolean {
		if (connection.closing || this.stopped) return false;
		if (connection.pending && this.now() >= connection.setupExpires) {
			this.disconnect(connection);
			return false;
		}
		if (connection.registration && this.now() >= connection.registration.expires) {
			if (this.registrations.get(connection.registration.deviceId) === connection)
				this.registrations.delete(connection.registration.deviceId);
		}
		if (connection.challenge && this.now() >= connection.challenge.expires) {
			this.disconnect(connection);
			return false;
		}
		return true;
	}
	private registered(connection: Connection): Registration | null {
		if (!this.live(connection)) return null;
		const registration = connection.registration;
		if (
			!registration ||
			this.now() >= registration.expires ||
			this.registrations.get(registration.deviceId) !== connection
		)
			return null;
		return registration;
	}
	private armConnection(connection: Connection): void {
		if (connection.timer) clearTimeout(connection.timer);
		const deadlines: number[] = [];
		if (connection.pending) deadlines.push(connection.setupExpires);
		if (connection.challenge) deadlines.push(connection.challenge.expires);
		// Registration expiry is checked lazily, so an idle registered socket arms no timer.
		if (connection.closing || deadlines.length === 0) return;
		connection.timer = setTimeout(
			() => {
				if (this.live(connection)) this.armConnection(connection);
			},
			Math.max(1, Math.ceil(Math.min(...deadlines) - this.now())),
		);
		background(connection.timer);
	}
	private disconnect(connection: Connection): void {
		if (connection.closing) return;
		connection.closing = true;
		connection.cancel.abort();
		for (const control of connection.controls.splice(0)) control.resolve();
		if (connection.timer) clearTimeout(connection.timer);
		const registration = connection.registration;
		if (registration && this.registrations.get(registration.deviceId) === connection)
			this.registrations.delete(registration.deviceId);
		for (const route of this.routes.values())
			if (route.source === connection || route.target === connection)
				this.removeRoute(route, "abort");
		try {
			if (connection.paused) connection.socket.resumeInput();
			connection.socket.close();
		} catch {
			/* Physical slots remain charged until closed(). */
		}
	}
	private send(connection: Connection, message: RelayControl): void {
		if (!this.live(connection)) return;
		try {
			const json = encodeRelayControl(message);
			const bytes = textBytes.encode(json).byteLength;
			if (!this.withinBuffers(connection, { additionalBytes: bytes })) {
				this.disconnect(connection);
				return;
			}
			connection.writes += bytes;
			let written = false;
			connection.socket.sendText(json, (error) => {
				if (written) return;
				written = true;
				connection.writes -= bytes;
				if (error) this.disconnect(connection);
				this.updatePressure();
			});
			if (!this.withinBuffers(connection)) this.disconnect(connection);
		} catch {
			// A throwing adapter may still own text bytes until its callback or physical close.
			this.disconnect(connection);
		}
	}
	private reject(connection: Connection, session: string): void {
		this.send(connection, { v: 1, type: "REJECTED", session, body: {} });
	}
	private contextMatches(body: RelayRegistrationBody | RelayAdmissionBody): boolean {
		return (
			body.authorityId === this.namespace.authorityId &&
			body.groupId === this.namespace.groupId &&
			body.relayAudienceId === this.namespace.relayAudienceId
		);
	}
	private async bounded<T>(
		signal: AbortSignal,
		timeout: number,
		operation: (signal: AbortSignal) => Promise<T>,
	): Promise<T | null> {
		if (signal.aborted || timeout <= 0) return null;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let cancel = () => {};
		try {
			return await new Promise<T | null>((resolve) => {
				const finish = (value: T | null) => {
					resolve(value);
					controller.abort();
				};
				cancel = () => finish(null);
				signal.addEventListener("abort", cancel, { once: true });
				timer = setTimeout(cancel, timeout);
				background(timer);
				Promise.resolve()
					.then(() => {
						if (controller.signal.aborted) return null;
						return operation(controller.signal);
					})
					.then(finish, () => finish(null));
			});
		} catch {
			return null;
		} finally {
			if (timer) clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			controller.abort();
		}
	}
	private async quota(
		connection: Connection,
		purpose: "control" | "open" | "traffic",
		units: number,
		signal: AbortSignal,
		peerDeviceId: string | null = null,
	): Promise<boolean> {
		// Empty identity spends only the trusted realm's pre-registration control allocation.
		const deviceId = connection.registration?.deviceId ?? "";
		const status = await this.bounded(signal, this.limits.quotaTimeoutMs, (abort) =>
			this.options.quota.reserve(
				{ purpose, realmId: this.realmId, deviceId, peerDeviceId, units },
				abort,
			),
		);
		return status === "reserved" && !signal.aborted && this.live(connection);
	}
	private async text(connection: Connection, bytes: Uint8Array): Promise<void> {
		try {
			if (!this.live(connection)) return;
			const message = decodeRelayControl(bytes);
			if (
				connection.pending &&
				(connection.controlPending ||
					(connection.phase === "service" && message.type !== "SERVICE_CHALLENGE") ||
					(connection.phase === "register" && message.type !== "REGISTER"))
			) {
				this.disconnect(connection);
				return;
			}
			if (message.type === "OPEN" && !connection.controlPending) {
				await this.open(connection, message);
				return;
			}
			this.capturePendingEnd(connection, message);
			if (
				connection.controls.length + Number(connection.controlPending) >=
				this.limits.deviceRoutes + 1
			) {
				this.disconnect(connection);
				return;
			}
			await new Promise<void>((resolve) => {
				connection.controls.push({ message, resolve });
				this.nextControl(connection);
			});
		} catch {
			this.disconnect(connection);
		}
	}
	private nextControl(connection: Connection): void {
		if (connection.controlPending || !this.live(connection)) return;
		const control = connection.controls.shift();
		if (!control) return;
		connection.controlPending = true;
		void this.runControl(connection, control.message).finally(() => {
			connection.controlPending = false;
			control.resolve();
			this.nextControl(connection);
		});
	}
	private async runControl(connection: Connection, message: RelayControl): Promise<void> {
		try {
			if (!(await this.quota(connection, "control", 1, connection.cancel.signal))) {
				this.disconnect(connection);
				return;
			}
			await this.control(connection, message);
		} catch {
			this.disconnect(connection);
		}
	}
	private capturePendingEnd(connection: Connection, message: RelayControl): void {
		if (message.type !== "CLOSE" || message.body.mode !== "end") return;
		const route = this.routes.get(message.session);
		if (!route?.accepted || (connection !== route.source && connection !== route.target)) return;
		const direction = route.directions[Number(connection === route.target)];
		if (direction) direction.pendingEnd = true;
	}
	private async control(connection: Connection, message: RelayControl): Promise<void> {
		switch (message.type) {
			case "OPEN":
				// Busy OPENs remain denials, but their replies spend control quota first.
				this.reject(connection, message.session);
				return;
			case "SERVICE_CHALLENGE":
				await this.service(connection, message);
				return;
			case "REGISTER":
				await this.register(connection, message);
				return;
			case "ACCEPTED":
			case "REJECTED":
			case "CLOSE":
				this.routeControl(connection, message);
				return;
			default:
				this.disconnect(connection);
		}
	}
	private async service(
		connection: Connection,
		message: Extract<RelayControl, { type: "SERVICE_CHALLENGE" }>,
	): Promise<void> {
		if (
			(connection.phase !== "service" && connection.phase !== "ready") ||
			message.body.audienceId !== this.namespace.relayAudienceId ||
			(connection.registration &&
				this.now() < connection.registration.started + RELAY_RENEW_AFTER_MS)
		) {
			this.disconnect(connection);
			return;
		}
		connection.phase = "signing";
		const body = await this.bounded(
			connection.cancel.signal,
			this.limits.coordinatorTimeoutMs,
			() =>
				createRelayServiceProof({
					audienceId: this.namespace.relayAudienceId,
					challengeId: message.session,
					utcMs: this.utc(),
					signer: this.options.signer,
				}),
		);
		if (!body || !this.live(connection)) {
			this.disconnect(connection);
			return;
		}
		this.send(connection, { v: 1, type: "SERVICE_PROOF", session: message.session, body });
		if (!this.live(connection)) return;
		connection.challenge = {
			id: randomHex(this.options.random ?? defaultRandom, 16),
			expires: this.now() + 30_000,
		};
		connection.phase = "register";
		this.send(connection, {
			v: 1,
			type: "SOCKET_CHALLENGE",
			session: connection.challenge.id,
			body: {},
		});
		this.armConnection(connection);
	}
	private async check(connection: Connection, packet: RelayCheckPacket, signal: AbortSignal) {
		const started = this.now();
		const decoded = decodeRelayCheckPacket(packet);
		let deviceHeader: string;
		if (decoded.kind === "registration") deviceHeader = decoded.value.deviceId;
		else deviceHeader = decoded.value.sourceDeviceId;
		const bytes = await this.bounded(signal, this.limits.coordinatorTimeoutMs, (abort) =>
			this.options.coordinator.check({ packet, deviceHeader, signal: abort }),
		);
		if (!bytes || signal.aborted || !this.live(connection)) return null;
		const reply = readRelayAdmissionReply(bytes, packet);
		if (!reply || this.now() >= started + reply.remainingMs) return null;
		return { started, expires: started + reply.remainingMs };
	}
	private async register(
		connection: Connection,
		message: Extract<RelayControl, { type: "REGISTER" }>,
	): Promise<void> {
		const check = decodeRelayCheckPacket(message.body);
		const challenge = connection.challenge;
		if (
			connection.phase !== "register" ||
			!challenge ||
			check.kind !== "registration" ||
			message.session !== challenge.id ||
			check.value.socketChallengeId !== challenge.id ||
			!this.contextMatches(check.value) ||
			(connection.registration &&
				(connection.registration.deviceId !== check.value.deviceId ||
					connection.registration.keyId !== check.value.keyId))
		) {
			this.disconnect(connection);
			return;
		}
		connection.phase = "checking";
		// Retain the challenge deadline while the single-use request is in flight.
		const grant = await this.check(connection, message.body, connection.cancel.signal);
		if (!grant || !this.live(connection)) {
			this.disconnect(connection);
			return;
		}
		const identity = check.value;
		this.completeRegistration(
			connection,
			Object.freeze({
				deviceId: identity.deviceId,
				keyId: identity.keyId,
				started: grant.started,
				expires: grant.expires,
			}),
			message.session,
		);
	}
	private completeRegistration(
		connection: Connection,
		registration: Registration,
		session: string,
	): void {
		const peers = [...this.connections].filter(
			(other) => other !== connection && other.registration?.deviceId === registration.deviceId,
		);
		const hadClosingPeer = peers.some((other) => other.closing);
		// A verified key change invalidates old routes even when the replacement cannot fit.
		for (const other of peers)
			if (other.registration?.keyId !== registration.keyId) this.disconnect(other);
		if (hadClosingPeer || peers.length > 1) {
			this.disconnect(connection);
			return;
		}
		const reply: RelayControl = {
			v: 1,
			type: "REGISTERED",
			session,
			body: {
				deviceId: registration.deviceId,
				keyId: registration.keyId,
				authorityId: this.namespace.authorityId,
				realmId: this.realmId,
				remainingMs: Math.floor(registration.expires - this.now()),
			},
		};
		if (
			!this.withinBuffers(connection, {
				deviceId: registration.deviceId,
				additionalBytes: textBytes.encode(encodeRelayControl(reply)).byteLength,
			})
		) {
			this.disconnect(connection);
			return;
		}
		if (!this.announceRegistration(connection, registration)) {
			this.disconnect(connection);
			return;
		}
		for (const other of peers) this.disconnect(other);
		connection.registration = registration;
		connection.challenge = undefined;
		connection.pending = false;
		connection.phase = "ready";
		this.registrations.set(registration.deviceId, connection);
		this.send(connection, reply);
		this.armConnection(connection);
	}
	private announceRegistration(connection: Connection, registration: Registration): boolean {
		const hook = this.options.onRegistration;
		if (!hook) return true;
		try {
			hook(
				connection.socket,
				snapshotRelayRegistration({
					realmId: this.realmId,
					deviceId: registration.deviceId,
					keyId: registration.keyId,
					startedMs: registration.started,
					expiresMs: registration.expires,
					nowMs: this.now(),
					utcMs: this.utc(),
				}),
			);
			return true;
		} catch {
			return false;
		}
	}
	private reserveRoute(
		connection: Connection,
		message: Extract<RelayControl, { type: "OPEN" }>,
	): Route | null {
		const source = this.registered(connection);
		const check = decodeRelayCheckPacket(message.body.checks[0]);
		if (
			!source ||
			check.kind !== "admission" ||
			!this.contextMatches(check.value) ||
			source.deviceId !== check.value.sourceDeviceId ||
			source.keyId !== check.value.sourceKeyId ||
			this.routes.has(message.session) ||
			this.routes.size >= this.limits.routes
		)
			return null;
		const context = check.value;
		for (const device of [context.sourceDeviceId, context.targetDeviceId]) {
			const count = [...this.routes.values()].filter((route) =>
				[route.context.sourceDeviceId, route.context.targetDeviceId].includes(device),
			).length;
			if (count >= this.limits.deviceRoutes) return null;
		}
		if (
			[...this.routes.values()].some(
				(route) =>
					route.context.sourceDeviceId === context.sourceDeviceId &&
					route.context.targetDeviceId === context.targetDeviceId,
			)
		)
			return null;
		const direction = (sender: Connection): Direction => ({
			sender,
			credit: 0,
			nextGrant: INITIAL_TRAFFIC_GRANT,
			frames: [],
			waiting: false,
			pendingEnd: false,
			ended: false,
			endForwarded: false,
			writes: 0,
		});
		const route: Route = {
			id: message.session,
			source: connection,
			context,
			cancel: new AbortController(),
			directions: [direction(connection), direction(connection)],
			expires: this.now() + ROUTE_LIFETIME_MS,
			accepted: false,
			closed: false,
			bytes: 0,
			frames: 0,
		};
		this.routes.set(route.id, route);
		this.armRoute(route);
		return route;
	}
	private async open(
		connection: Connection,
		message: Extract<RelayControl, { type: "OPEN" }>,
	): Promise<void> {
		const route = this.reserveRoute(connection, message);
		connection.controlPending = true;
		try {
			if (!(await this.quota(connection, "control", 1, connection.cancel.signal))) {
				this.disconnect(connection);
				return;
			}
			if (!route) {
				this.reject(connection, message.session);
				return;
			}
			if (
				!(await this.quota(
					connection,
					"open",
					1,
					route.cancel.signal,
					route.context.targetDeviceId,
				))
			) {
				this.removeRoute(route, "reject");
				return;
			}
		} finally {
			connection.controlPending = false;
			this.nextControl(connection);
		}
		// A reserved route bounds coordinator work without blocking other routes' controls.
		await this.admitRoute(connection, message, route);
	}
	private async admitRoute(
		connection: Connection,
		message: Extract<RelayControl, { type: "OPEN" }>,
		route: Route,
	): Promise<void> {
		const grant = await this.check(connection, message.body.checks[0], route.cancel.signal);
		if (!grant || !this.routeLive(route) || !this.registered(connection)) {
			this.removeRoute(route, "reject");
			return;
		}
		route.expires = Math.min(route.expires, grant.expires);
		if (!this.routeLive(route)) return;
		// Presence lookup follows this relay's independent positive coordinator decision.
		const target = this.registrations.get(route.context.targetDeviceId);
		const registration = target && this.registered(target);
		if (
			!target ||
			target === connection ||
			!registration ||
			registration.keyId !== route.context.targetKeyId
		) {
			this.removeRoute(route, "reject");
			return;
		}
		route.target = target;
		route.directions[1].sender = target;
		this.armRoute(route);
		this.send(target, message);
	}
	private routeLive(route: Route): boolean {
		if (route.closed) return false;
		if (this.now() >= route.expires) {
			this.removeRoute(route, route.accepted ? "abort" : "reject");
			return false;
		}
		return true;
	}
	private armRoute(route: Route): void {
		if (route.timer) clearTimeout(route.timer);
		route.timer = setTimeout(
			() => {
				if (this.routeLive(route)) this.armRoute(route);
			},
			Math.max(1, Math.ceil(route.expires - this.now())),
		);
		background(route.timer);
	}
	private routeControl(connection: Connection, message: RelayControl): void {
		const route = this.routes.get(message.session);
		if (!route || !this.routeLive(route)) return;
		if (connection !== route.source && connection !== route.target) {
			this.disconnect(connection);
			return;
		}
		if (message.type === "CLOSE") {
			if (message.body.mode === "abort" || !route.accepted) {
				this.removeRoute(route, "abort");
				return;
			}
			const direction = route.directions[Number(connection === route.target)];
			if (!direction || direction.ended) {
				this.removeRoute(route, "abort");
				return;
			}
			direction.ended = true;
			this.flushEnd(route, direction);
			return;
		}
		if (
			connection !== route.target ||
			route.accepted ||
			(message.type !== "ACCEPTED" && message.type !== "REJECTED")
		) {
			this.removeRoute(route, "abort");
			return;
		}
		if (message.type === "REJECTED") {
			this.removeRoute(route, "reject");
			return;
		}
		route.accepted = true;
		this.send(route.source, { v: 1, type: "ACCEPTED", session: route.id, body: {} });
	}
	private removeRoute(route: Route, mode: "abort" | "reject" | "clean"): void {
		if (route.closed) return;
		route.closed = true;
		this.routes.delete(route.id);
		route.cancel.abort();
		if (route.timer) clearTimeout(route.timer);
		for (const direction of route.directions) {
			for (const frame of direction.frames) direction.sender.held -= frame.length;
			direction.frames.length = 0;
			direction.waiting = false;
		}
		if (mode === "reject") this.reject(route.source, route.id);
		if (mode === "abort")
			for (const connection of [route.source, route.target])
				if (connection)
					this.send(connection, {
						v: 1,
						type: "CLOSE",
						session: route.id,
						body: { mode: "abort" },
					});
		this.updatePressure();
	}
	private binary(connection: Connection, bytes: Uint8Array): void {
		if (!this.live(connection)) return;
		if (connection.pending) {
			this.disconnect(connection);
			return;
		}
		const frame = decodeRelayDataFrame(bytes);
		const route = this.routes.get(frame.sessionId);
		if (!route) {
			this.orphan(connection, frame.sessionId);
			return;
		}
		if (!this.routeLive(route)) return;
		if (connection !== route.source && connection !== route.target) {
			this.disconnect(connection);
			return;
		}
		const direction = route.directions[Number(connection === route.target)];
		if (
			!route.accepted ||
			!direction ||
			direction.pendingEnd ||
			direction.ended ||
			++route.frames > 2048 ||
			bytes.length > this.limits.routeBytes - route.bytes
		) {
			this.removeRoute(route, "abort");
			return;
		}
		route.bytes += bytes.length;
		// Already-parsed socket batches may arrive after pauseInput. Charge every retained copy.
		connection.held += bytes.length;
		if (
			!this.withinBuffers(connection) ||
			this.directionQueued(direction) + bytes.length > DIRECTION_BYTES
		) {
			connection.held -= bytes.length;
			this.removeRoute(route, "abort");
			return;
		}
		direction.frames.push(new Uint8Array(bytes));
		this.drainDirection(route, direction);
	}
	/** Restored sockets may still send DATA for routes lost with the evicted instance. */
	private orphan(connection: Connection, session: string): void {
		// After the longest lifetime of a lost route, unknown DATA is a protocol error as on Node.
		const restored = connection.restored;
		if (!restored || this.now() >= restored.at + ROUTE_LIFETIME_MS) {
			this.disconnect(connection);
			return;
		}
		const orphans = restored.orphans;
		if (orphans.has(session)) return;
		if (orphans.size >= this.limits.deviceRoutes) {
			this.disconnect(connection);
			return;
		}
		orphans.add(session);
		void this.abortOrphan(connection, session).catch(() => this.disconnect(connection));
	}
	private async abortOrphan(connection: Connection, session: string): Promise<void> {
		// The reply spends control quota like any other server-originated control.
		if (!(await this.quota(connection, "control", 1, connection.cancel.signal))) {
			this.disconnect(connection);
			return;
		}
		this.send(connection, { v: 1, type: "CLOSE", session, body: { mode: "abort" } });
	}
	private drainDirection(route: Route, direction: Direction): void {
		if (!this.routeLive(route) || direction.waiting) return;
		while (direction.frames[0] && direction.credit >= direction.frames[0].length) {
			this.forward(route, direction);
			if (route.closed) return;
		}
		if (direction.frames.length > 0) {
			direction.waiting = true;
			void this.reserveTraffic(route, direction).catch(() => this.removeRoute(route, "abort"));
		} else this.flushEnd(route, direction);
		this.updatePressure();
	}
	private async reserveTraffic(route: Route, direction: Direction): Promise<void> {
		const peer =
			direction.sender === route.source
				? route.context.targetDeviceId
				: route.context.sourceDeviceId;
		const queued = direction.frames.reduce((sum, frame) => sum + frame.length, 0);
		// Small exchanges spend roughly their actual size. Sustained transfers grow
		// toward full-size grants so the reservation count stays logarithmic.
		const units = Math.min(
			DIRECTION_BYTES,
			this.limits.routeBytes - route.bytes + queued,
			Math.max(queued, direction.nextGrant),
		);
		const reserved = await this.quota(
			direction.sender,
			"traffic",
			units,
			route.cancel.signal,
			peer,
		);
		if (!this.routeLive(route)) return;
		direction.waiting = false;
		if (!reserved) {
			this.trafficQuotaAborts++;
			this.removeRoute(route, "abort");
			return;
		}
		direction.credit += units;
		direction.nextGrant = Math.min(DIRECTION_BYTES, units * 2);
		this.drainDirection(route, direction);
	}
	private recipient(route: Route, direction: Direction): Connection | undefined {
		if (direction.sender === route.source) return route.target;
		return route.source;
	}
	private forward(route: Route, direction: Direction): void {
		const bytes = direction.frames[0];
		const target = this.recipient(route, direction);
		if (!bytes || !target || !this.routeLive(route)) return;
		if (
			!this.live(target) ||
			!this.withinBuffers(target, {
				additionalBytes: bytes.length,
				releasedHeld: { connection: direction.sender, bytes: bytes.length },
			}) ||
			this.directionQueued(direction) > DIRECTION_BYTES
		) {
			this.removeRoute(route, "abort");
			return;
		}
		direction.frames.shift();
		direction.sender.held -= bytes.length;
		direction.credit -= bytes.length;
		direction.writes += bytes.length;
		target.writes += bytes.length;
		if (!this.withinBuffers(target) || this.directionQueued(direction) > DIRECTION_BYTES) {
			target.writes -= bytes.length;
			direction.writes -= bytes.length;
			this.removeRoute(route, "abort");
			return;
		}
		let written = false;
		try {
			target.socket.sendBinary(bytes, (error) => {
				if (written) return;
				written = true;
				target.writes -= bytes.length;
				direction.writes -= bytes.length;
				if (error) this.removeRoute(route, "abort");
				else if (this.routeLive(route)) this.flushEnd(route, direction);
				this.updatePressure();
			});
			if (!this.withinBuffers(target) || this.directionQueued(direction) > DIRECTION_BYTES)
				this.removeRoute(route, "abort");
			this.updatePressure();
		} catch {
			// A throwing adapter may already own the frame. Only its callback or closure releases it.
			this.removeRoute(route, "abort");
			this.disconnect(target);
		}
	}
	private flushEnd(route: Route, direction: Direction): void {
		if (
			direction.ended &&
			direction.frames.length === 0 &&
			!direction.waiting &&
			direction.writes === 0 &&
			!direction.endForwarded
		) {
			direction.endForwarded = true;
			const target = this.recipient(route, direction);
			if (target)
				this.send(target, { v: 1, type: "CLOSE", session: route.id, body: { mode: "end" } });
		}
		if (route.directions.every((entry) => entry.endForwarded && entry.writes === 0))
			this.removeRoute(route, "clean");
	}
	private socketBytes(connection: Connection): number {
		// Physical closure releases adapter writes, while route cleanup still owns held frames.
		if (connection.physicalClosed) return connection.held;
		try {
			const bytes = connection.socket.bufferedBytes();
			if (!Number.isSafeInteger(bytes) || bytes < 0) return Number.POSITIVE_INFINITY;
			return Math.max(connection.writes, bytes) + connection.held;
		} catch {
			return Number.POSITIVE_INFINITY;
		}
	}
	private queuedBytes(): number {
		let total = 0;
		for (const connection of this.connections) total += this.socketBytes(connection);
		return total;
	}
	private withinBuffers(connection: Connection, change: BufferChange = {}): boolean {
		const additional = change.additionalBytes ?? 0;
		const deviceId = change.deviceId ?? connection.registration?.deviceId;
		let total = additional;
		let deviceBytes = additional;
		for (const current of this.connections) {
			let bytes = this.socketBytes(current);
			if (change.releasedHeld?.connection === current) bytes -= change.releasedHeld.bytes;
			if (bytes < 0) return false;
			total += bytes;
			const currentDevice = current === connection ? deviceId : current.registration?.deviceId;
			if (deviceId !== undefined && currentDevice === deviceId) deviceBytes += bytes;
		}
		return (
			total <= this.limits.queuedBytes &&
			(deviceId === undefined || deviceBytes <= this.limits.deviceQueuedBytes)
		);
	}
	private directionQueued(direction: Direction): number {
		return direction.frames.reduce((sum, frame) => sum + frame.length, direction.writes);
	}
	private updatePressure(): void {
		for (const connection of this.connections) {
			if (connection.closing) continue;
			const pressure = [...this.routes.values()].some((route) =>
				route.directions.some(
					(direction) =>
						direction.sender === connection &&
						(direction.waiting || this.directionQueued(direction) >= DIRECTION_BYTES - MAX_FRAME),
				),
			);
			if (pressure === connection.paused) continue;
			connection.paused = pressure;
			try {
				if (pressure) connection.socket.pauseInput();
				else connection.socket.resumeInput();
			} catch {
				this.disconnect(connection);
			}
		}
	}
}
