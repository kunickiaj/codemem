import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { DIRECT_NOISE_ACTIVE } from "@codemem/core/internal/relay-runtime";
import {
	createInMemoryRequestRateLimiter,
	type InMemoryRequestRateLimiter,
} from "./request-rate-limit.js";
import { attachDirectNoiseGate, type DirectNoiseGateOptions } from "./sync-noise-gate.js";

/**
 * Limits for the network-facing sync listener. The socket caps and the
 * per-address request limit come from `pnpm run load:sync-listener`
 * (packages/viewer-server/scripts/sync-listener-load.ts). With them, an
 * authenticated flood or idle streams from one address left another
 * address's sync p95 within 10% of idle, at under 16 MiB added memory, and
 * 128 devices behind one address that start syncing within 10 s all succeed.
 * Set a cap to undefined to turn it off.
 */
export interface SyncListenerLimits {
	/** Time a socket has to deliver complete request headers. */
	readonly headerMs: number;
	/** Time a request has to finish arriving, body included. */
	readonly requestMs: number;
	/** How often Node checks header and request expiry. Its default is 30 s. */
	readonly checkIntervalMs: number;
	/** Open sockets in total. Off when undefined. */
	readonly maxSockets?: number;
	/** Open sockets per address, IPv6 grouped by /64. Off when undefined. */
	readonly maxSocketsPerIp?: number;
	/** Requests one address may start per minute, before any signature check. Off when undefined. */
	readonly requestsPerIpPerMinute?: number;
}

export const SYNC_LISTENER_LIMITS: SyncListenerLimits = Object.freeze({
	headerMs: 10_000,
	requestMs: 30_000,
	checkIntervalMs: 1_000,
	maxSockets: 256,
	// Bounds how many handshakes and streams one address can drive at once.
	maxSocketsPerIp: 16,
	// About 300 devices behind one address at the default 120 s sync interval.
	requestsPerIpPerMinute: 600,
});

/**
 * Distinct address buckets the listener's limiter keeps. When it is full, new
 * addresses share one overflow budget until a bucket goes unused for a minute.
 */
export const SYNC_LISTENER_MAX_BUCKETS = 4_096;

/**
 * The limiter the sync listener, its routes and its Noise streams share. It
 * holds at most SYNC_LISTENER_MAX_BUCKETS buckets.
 */
export function createSyncListenerLimiter(): InMemoryRequestRateLimiter {
	return createInMemoryRequestRateLimiter(60_000, { maxBuckets: SYNC_LISTENER_MAX_BUCKETS });
}

export interface SyncListenerGuardOptions {
	readonly limits?: Partial<SyncListenerLimits>;
	/** Shared with the upgrade gate, so every request from one address draws on one budget. */
	readonly limiter?: InMemoryRequestRateLimiter;
	/** Direct Noise upgrades. Attached only while direct Noise is active. */
	readonly directNoise?: DirectNoiseGateOptions & { readonly active?: boolean };
}

type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function ipv6Groups(address: string): number[] | null {
	const [head = "", tail, extra] = address.split("::");
	if (extra !== undefined) return null;
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const missing = 8 - left.length - right.length;
	if ((tail === undefined && missing !== 0) || (tail !== undefined && missing < 1)) return null;
	const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
	if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
	return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * One key per client address. IPv4 clients of a dual-stack socket arrive as
 * ::ffff:a.b.c.d. An IPv6 client usually holds a whole /64, so its addresses
 * share one key and cannot multiply its share of the caps.
 */
export function remoteAddressKey(socket: Pick<Socket, "remoteAddress">): string {
	const address = (socket.remoteAddress ?? "unknown").split("%")[0] ?? "unknown";
	if (address.startsWith("::ffff:") && address.includes(".")) return address.slice(7);
	if (!address.includes(":")) return address;
	const groups = ipv6Groups(address);
	if (!groups) return address;
	return `${groups
		.slice(0, 4)
		.map((group) => group.toString(16))
		.join(":")}::/64`;
}

function refuseRateLimited(response: ServerResponse, retryAfterS: number): void {
	response.writeHead(429, {
		"content-type": "application/json",
		"retry-after": String(retryAfterS),
		connection: "close",
	});
	response.end(JSON.stringify({ error: "rate_limited", retry_after_s: retryAfterS }));
}

/** Counts open sockets per address and closes any over the cap as soon as it connects. */
function capSocketsPerAddress(server: Server, maxPerAddress: number): void {
	const open = new Map<string, number>();
	server.on("connection", (socket: Socket) => {
		const key = remoteAddressKey(socket);
		const count = (open.get(key) ?? 0) + 1;
		open.set(key, count);
		socket.once("close", () => {
			const remaining = (open.get(key) ?? 1) - 1;
			if (remaining > 0) open.set(key, remaining);
			else open.delete(key);
		});
		if (count > maxPerAddress) socket.destroy();
	});
}

/**
 * Closes a socket that has not delivered complete headers in time. Node's own
 * header timeout also applies, but this timer starts at connect and does not
 * depend on Node's check interval. Returns the function that stops a socket's
 * timer. An upgrade handler must call it, because Node applies no timeouts to
 * an upgraded socket. With no upgrade handler, Node serves an Upgrade request
 * as an ordinary request, which stops the timer.
 */
function closeSilentSockets(server: Server, limits: SyncListenerLimits): (socket: Socket) => void {
	const timers = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
	const settle = (socket: Socket): void => {
		clearTimeout(timers.get(socket));
		timers.delete(socket);
	};
	server.on("connection", (socket: Socket) => {
		const timer = setTimeout(() => socket.destroy(), limits.headerMs);
		timer.unref();
		timers.set(socket, timer);
		socket.once("close", () => settle(socket));
	});
	server.on("request", (request: IncomingMessage) => settle(request.socket));
	return settle;
}

/** Answers 429 when the address is over its budget. Always allows while the limit is off. */
function admitRequest(
	limiter: InMemoryRequestRateLimiter,
	perMinute: number | undefined,
	request: IncomingMessage,
	response: ServerResponse,
): boolean {
	if (perMinute === undefined) return true;
	const result = limiter.check(`sync-listener:${remoteAddressKey(request.socket)}`, perMinute);
	if (!result.allowed) refuseRateLimited(response, result.retryAfterS);
	return result.allowed;
}

/**
 * A createServer replacement for the sync listener. It bounds how long headers
 * and requests may take, and can cap sockets and throttle each address before
 * the sync routes verify any signature.
 */
export function createGuardedSyncServer(
	options: SyncListenerGuardOptions = {},
): typeof createServer {
	const limits = { ...SYNC_LISTENER_LIMITS, ...options.limits };
	const limiter = options.limiter ?? createSyncListenerLimiter();
	const guarded = (_serverOptions: unknown, listener?: RequestListener): Server => {
		const server = createServer(
			{
				headersTimeout: limits.headerMs,
				requestTimeout: limits.requestMs,
				connectionsCheckingInterval: limits.checkIntervalMs,
			},
			(request, response) => {
				if (admitRequest(limiter, limits.requestsPerIpPerMinute, request, response))
					listener?.(request, response);
			},
		);
		if (limits.maxSockets !== undefined) server.maxConnections = limits.maxSockets;
		if (limits.maxSocketsPerIp !== undefined) capSocketsPerAddress(server, limits.maxSocketsPerIp);
		const settle = closeSilentSockets(server, limits);
		const directNoise = options.directNoise;
		if (directNoise && (directNoise.active ?? DIRECT_NOISE_ACTIVE)) {
			const admit = { limiter, perMinute: limits.requestsPerIpPerMinute, settle };
			attachDirectNoiseGate(server, directNoise, admit, remoteAddressKey);
		}
		return server;
	};
	return guarded as unknown as typeof createServer;
}
