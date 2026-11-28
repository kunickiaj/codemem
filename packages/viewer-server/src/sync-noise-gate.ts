import { createPrivateKey, type KeyObject } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { fingerprintPublicKey, loadPrivateKey, type MemoryStore } from "@codemem/core";
import {
	acceptRelayNoiseResponder,
	DIRECT_NOISE_LOGICAL_ORIGIN,
	DIRECT_NOISE_TRANSPORT_LABEL,
	DIRECT_NOISE_UPGRADE_PROTOCOL,
	PEER_HTTP_LIMITS,
	parseDirectNoiseUpgradeTarget,
	RELAY_NOISE_LIMITS,
	servePeerHttpConnection,
} from "@codemem/core/internal/relay-runtime";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";
import { ResponseByteBudget } from "./response-byte-budget.js";
import { authorizeDirectNoiseUpgrade } from "./routes/sync.js";
import { createSyncChannelDispatcher, type SyncChannelRequest } from "./sync-channel-dispatch.js";

/** Provisional until the load measurement before activation, which may lower them. */
export interface DirectNoiseGateLimits {
	readonly pendingTotal: number;
	readonly pendingPerIp: number;
	readonly streamsTotal: number;
	readonly streamsPerPeer: number;
	readonly responseBudgetBytes: number;
	readonly handshakeMs: number;
}

export const DIRECT_NOISE_GATE_LIMITS: DirectNoiseGateLimits = Object.freeze({
	pendingTotal: 32,
	pendingPerIp: 4,
	streamsTotal: 64,
	streamsPerPeer: 8,
	responseBudgetBytes: 128 * 1024 * 1024,
	handshakeMs: RELAY_NOISE_LIMITS.handshakeMs,
});

export interface DirectNoiseGateOptions {
	readonly storeFactory: () => MemoryStore;
	readonly keysDir?: string;
	readonly limits?: Partial<DirectNoiseGateLimits>;
}

interface GateContext {
	readonly options: DirectNoiseGateOptions;
	readonly limits: DirectNoiseGateLimits;
	readonly pending: Counter;
	readonly streams: Counter;
	readonly budget: ResponseByteBudget;
	readonly dispatch: (request: SyncChannelRequest) => ReturnType<DispatchFn>;
}

type DispatchFn = ReturnType<typeof createSyncChannelDispatcher>;

/** Open slots in total and per key, each released exactly once. */
class Counter {
	private total = 0;
	private readonly byKey = new Map<string, number>();

	constructor(
		private readonly maxTotal: number,
		private readonly maxPerKey: number,
	) {}

	reserve(key: string): (() => void) | null {
		const count = this.byKey.get(key) ?? 0;
		if (this.total >= this.maxTotal || count >= this.maxPerKey) return null;
		this.total += 1;
		this.byKey.set(key, count + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.total -= 1;
			const remaining = (this.byKey.get(key) ?? 1) - 1;
			if (remaining > 0) this.byKey.set(key, remaining);
			else this.byKey.delete(key);
		};
	}
}

class GateRefusal extends Error {
	constructor(
		readonly status: 400 | 401 | 429 | 503,
		readonly body: string,
	) {
		super(body);
	}
}

const STATUS_TEXT = {
	400: "Bad Request",
	401: "Unauthorized",
	429: "Too Many Requests",
	503: "Service Unavailable",
};

/** Time a refused client has to read its refusal before the socket is destroyed anyway. */
const REFUSAL_FLUSH_MS = 1_000;

/**
 * Sends a plain HTTP refusal, then destroys the socket. Ending it would wait
 * for the client to close its side, so a client that kept writing open would
 * keep holding the socket and its slot.
 */
function refuse(socket: Socket, refusal: GateRefusal): void {
	const body = JSON.stringify({ error: refusal.body });
	const timer = setTimeout(() => socket.destroy(), REFUSAL_FLUSH_MS);
	timer.unref();
	socket.write(
		`HTTP/1.1 ${refusal.status} ${STATUS_TEXT[refusal.status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
		() => {
			clearTimeout(timer);
			socket.destroy();
		},
	);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name.toLowerCase()];
	return typeof value === "string" ? value : undefined;
}

/** A canonical upgrade request with nothing sent after its headers, or a refusal. */
function parseUpgrade(request: IncomingMessage, head: Buffer) {
	const target = parseDirectNoiseUpgradeTarget(request.url);
	const protocol = headerValue(request, "upgrade")?.trim().toLowerCase();
	if (request.method !== "GET" || protocol !== DIRECT_NOISE_UPGRADE_PROTOCOL || !target)
		throw new GateRefusal(400, "invalid_upgrade");
	// The client sends Message A only after 101. Earlier bytes are never Noise.
	if (head.byteLength !== 0) throw new GateRefusal(400, "invalid_upgrade");
	return target;
}

function authorize(store: MemoryStore, request: IncomingMessage) {
	const auth = authorizeDirectNoiseUpgrade(store, {
		method: "GET",
		url: `${DIRECT_NOISE_LOGICAL_ORIGIN}${request.url}`,
		header: (name) => headerValue(request, name),
	});
	if (!auth.ok) throw new GateRefusal(auth.busy ? 503 : 401, auth.busy ? "busy" : "unauthorized");
	return auth;
}

function localIdentity(store: MemoryStore, keysDir: string | undefined) {
	const row = store.db.prepare("SELECT device_id, public_key FROM sync_device LIMIT 1").get() as
		| { device_id: string; public_key: string }
		| undefined;
	const bytes = row ? loadPrivateKey(keysDir, store.dbPath, row.device_id) : null;
	if (!row?.public_key || !bytes) throw new GateRefusal(503, "unavailable");
	const key: KeyObject = createPrivateKey(bytes);
	return { key, expectedPin: row.public_key.trim() };
}

/** The peer's key as pinned now. A re-pin during the handshake ends the stream. */
function currentPin(store: MemoryStore, deviceId: string): string | null {
	const row = store.db
		.prepare("SELECT public_key, pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
		.get(deviceId) as { public_key: string | null; pinned_fingerprint: string | null } | undefined;
	const publicKey = row?.public_key?.trim();
	if (!publicKey || fingerprintPublicKey(publicKey) !== row?.pinned_fingerprint) return null;
	return publicKey;
}

function switchProtocols(socket: Socket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${DIRECT_NOISE_UPGRADE_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`,
			(error) => (error ? reject(error) : resolve()),
		);
	});
}

function ownStream(socket: Socket, duplex: Duplex) {
	const completion = Promise.all([
		finished(duplex, { cleanup: true }),
		finished(socket, { cleanup: true }),
	]).then(() => {});
	void completion.catch(() => {});
	return {
		duplex,
		completion,
		async dispose(error: Error) {
			duplex.destroy(error);
			socket.destroy(error);
			await completion.catch(() => {});
		},
	};
}

async function handshake(
	context: GateContext,
	socket: Socket,
	target: ReturnType<typeof parseUpgrade>,
	peer: { deviceId: string; publicKey: string },
) {
	const store = context.options.storeFactory();
	const identity = localIdentity(store, context.options.keysDir);
	await switchProtocols(socket);
	const acceptedAtMs = performance.now();
	const secured = await acceptRelayNoiseResponder({
		transport: socket,
		localIdentity: identity,
		expectedRemotePin: peer.publicKey,
		context: { transportLabel: DIRECT_NOISE_TRANSPORT_LABEL, sessionId: target.sessionId },
		verifiedMessageADigest: target.openingDigest,
		acceptedAtMs,
		deadlineMs: acceptedAtMs + context.limits.handshakeMs + PEER_HTTP_LIMITS.exchangeMs,
		limits: { handshakeMs: context.limits.handshakeMs },
	});
	if (currentPin(store, peer.deviceId) !== peer.publicKey) {
		secured.duplex.destroy();
		throw new Error("Peer key changed during the handshake");
	}
	return secured.duplex;
}

/** One exchange, holding a response reservation from dispatch until the response is written. */
async function serveStream(context: GateContext, socket: Socket, duplex: Duplex, deviceId: string) {
	let release: (() => void) | undefined;
	try {
		await servePeerHttpConnection(ownStream(socket, duplex), {
			origin: DIRECT_NOISE_LOGICAL_ORIGIN,
			dispatch: async (request) => {
				release = await context.budget.acquire(PEER_HTTP_LIMITS.responseBytes, request.signal);
				return context.dispatch({ ...request, peerDeviceId: deviceId });
			},
		});
	} finally {
		release?.();
	}
}

async function handleUpgrade(
	context: GateContext,
	request: IncomingMessage,
	socket: Socket,
	head: Buffer,
	address: string,
): Promise<void> {
	const releasePending = context.pending.reserve(address);
	if (!releasePending) throw new GateRefusal(503, "busy");
	// Node applies no timeout to an upgraded socket. This one covers everything
	// up to an authenticated stream, including writing the 101.
	const deadline = setTimeout(() => socket.destroy(), context.limits.handshakeMs);
	deadline.unref();
	let releaseStream: (() => void) | null = null;
	try {
		const target = parseUpgrade(request, head);
		const peer = authorize(context.options.storeFactory(), request);
		releaseStream = context.streams.reserve(peer.deviceId);
		if (!releaseStream) throw new GateRefusal(503, "busy");
		const duplex = await handshake(context, socket, target, peer);
		clearTimeout(deadline);
		releasePending();
		await serveStream(context, socket, duplex, peer.deviceId);
	} finally {
		clearTimeout(deadline);
		releasePending();
		releaseStream?.();
	}
}

/**
 * Accepts direct Noise upgrades on the sync listener. Each address is
 * throttled with the listener's own budget before any signature check, and
 * every refusal before 101 is plain HTTP that carries no Noise bytes.
 */
export function attachDirectNoiseGate(
	server: Server,
	options: DirectNoiseGateOptions,
	admit: {
		readonly limiter: InMemoryRequestRateLimiter;
		/** The listener's per-address request limit, or undefined while it is off. */
		readonly perMinute: number | undefined;
		/** Stops the listener's header timer. The handshake deadline takes over from here. */
		readonly settle: (socket: Socket) => void;
	},
	addressOf: (socket: Socket) => string,
): void {
	const limits = { ...DIRECT_NOISE_GATE_LIMITS, ...options.limits };
	const context: GateContext = {
		options,
		limits,
		pending: new Counter(limits.pendingTotal, limits.pendingPerIp),
		streams: new Counter(limits.streamsTotal, limits.streamsPerPeer),
		budget: new ResponseByteBudget(limits.responseBudgetBytes),
		dispatch: createSyncChannelDispatcher({
			storeFactory: () => options.storeFactory(),
			mode: "noise-direct",
			limiter: admit.limiter,
		}),
	};
	server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
		admit.settle(socket);
		socket.on("error", () => {});
		const address = addressOf(socket);
		const admitted =
			admit.perMinute === undefined
				? { allowed: true }
				: admit.limiter.check(`sync-listener:${address}`, admit.perMinute);
		if (!admitted.allowed) {
			refuse(socket, new GateRefusal(429, "rate_limited"));
			return;
		}
		void handleUpgrade(context, request, socket, head, address).catch((error: unknown) => {
			if (error instanceof GateRefusal && !socket.destroyed) refuse(socket, error);
			else socket.destroy();
		});
	});
}
