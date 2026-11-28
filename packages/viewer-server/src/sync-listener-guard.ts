import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
	createInMemoryRequestRateLimiter,
	type InMemoryRequestRateLimiter,
} from "./request-rate-limit.js";

/**
 * Limits for the network-facing sync listener. They are provisional until the
 * load measurement before direct Noise activation, which may lower them.
 */
export interface SyncListenerLimits {
	/** Time a socket has to deliver complete request headers. */
	readonly headerMs: number;
	/** Time a request has to finish arriving, body included. */
	readonly requestMs: number;
	/** How often Node checks header and request expiry. Its default is 30 s. */
	readonly checkIntervalMs: number;
	readonly maxSockets: number;
	readonly maxSocketsPerIp: number;
	/** Requests one address may start per minute, counted before any signature check. */
	readonly requestsPerIpPerMinute: number;
}

export const SYNC_LISTENER_LIMITS: SyncListenerLimits = Object.freeze({
	headerMs: 10_000,
	requestMs: 30_000,
	checkIntervalMs: 1_000,
	maxSockets: 256,
	maxSocketsPerIp: 16,
	requestsPerIpPerMinute: 600,
});

export interface SyncListenerGuardOptions {
	readonly limits?: Partial<SyncListenerLimits>;
	/** Shared with the upgrade gate, so every request from one address draws on one budget. */
	readonly limiter?: InMemoryRequestRateLimiter;
}

type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;

/** One key per client address. IPv4 clients of a dual-stack socket arrive as ::ffff:a.b.c.d. */
export function remoteAddressKey(socket: Socket): string {
	const address = socket.remoteAddress ?? "unknown";
	return address.startsWith("::ffff:") ? address.slice(7) : address;
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
function capSocketsPerAddress(server: Server, limits: SyncListenerLimits): void {
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
		if (count > limits.maxSocketsPerIp) socket.destroy();
	});
}

/**
 * Closes a socket that has not delivered complete headers in time. Node's own
 * header timeout also applies, but this timer starts at connect and does not
 * depend on Node's check interval.
 */
function closeSilentSockets(server: Server, limits: SyncListenerLimits): void {
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
	server.on("upgrade", (request: IncomingMessage) => settle(request.socket));
}

/**
 * A createServer replacement for the sync listener. It caps sockets when they
 * are accepted, bounds how long headers and requests may take, and throttles
 * each address before the sync routes verify any signature.
 */
export function createGuardedSyncServer(
	options: SyncListenerGuardOptions = {},
): typeof createServer {
	const limits = { ...SYNC_LISTENER_LIMITS, ...options.limits };
	const limiter = options.limiter ?? createInMemoryRequestRateLimiter();
	const guarded = (_serverOptions: unknown, listener?: RequestListener): Server => {
		const server = createServer(
			{
				headersTimeout: limits.headerMs,
				requestTimeout: limits.requestMs,
				connectionsCheckingInterval: limits.checkIntervalMs,
			},
			(request, response) => {
				const result = limiter.check(
					`sync-listener:${remoteAddressKey(request.socket)}`,
					limits.requestsPerIpPerMinute,
				);
				if (!result.allowed) {
					refuseRateLimited(response, result.retryAfterS);
					return;
				}
				listener?.(request, response);
			},
		);
		server.maxConnections = limits.maxSockets;
		capSocketsPerAddress(server, limits);
		closeSilentSockets(server, limits);
		return server;
	};
	return guarded as unknown as typeof createServer;
}
