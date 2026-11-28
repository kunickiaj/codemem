import type { AddressInfo } from "node:net";
import net from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";
import {
	createGuardedSyncServer,
	createSyncListenerLimiter,
	remoteAddressKey,
	SYNC_LISTENER_LIMITS,
	type SyncListenerLimits,
} from "./sync-listener-guard.js";

const servers: { close(callback?: () => void): unknown }[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();
	await Promise.all(
		servers
			.splice(0)
			.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

async function listen(limits: Partial<SyncListenerLimits>, hostname = "127.0.0.1") {
	const handled = vi.fn();
	const app = new Hono();
	app.get("/v1/status", (c) => {
		handled();
		return c.json({ ok: true });
	});
	const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
		const started = serve(
			{ fetch: app.fetch, hostname, port: 0, createServer: createGuardedSyncServer({ limits }) },
			() => resolve(started),
		);
	});
	servers.push(server);
	return { server, handled, port: (server.address() as AddressInfo).port };
}

function connect(port: number, host: string): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ port, host }, () => resolve(socket));
		socket.once("error", reject);
		sockets.push(socket);
	});
}

function closed(socket: net.Socket): Promise<number> {
	const started = Date.now();
	return new Promise((resolve) => {
		if (socket.destroyed) resolve(0);
		socket.once("close", () => resolve(Date.now() - started));
	});
}

async function status(port: number, host = "127.0.0.1") {
	const url = host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
	return fetch(`${url}/v1/status`, { headers: { connection: "close" } });
}

/** Stalled clients use ::1 and the legitimate client uses 127.0.0.1, so they count as two addresses. */
async function dualStackAvailable(): Promise<boolean> {
	const probe = net.createServer();
	try {
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(0, "::1", () => resolve());
		});
		return true;
	} catch {
		return false;
	} finally {
		probe.close();
	}
}

it("applies the header, request and expiry-check limits and leaves the caps off by default", async () => {
	const { server, port } = await listen({
		headerMs: 4_000,
		requestMs: 9_000,
		checkIntervalMs: 500,
	});

	expect(server).toMatchObject({ headersTimeout: 4_000, requestTimeout: 9_000 });
	expect(server.maxConnections).toBeUndefined();
	expect(SYNC_LISTENER_LIMITS).toEqual({
		headerMs: 10_000,
		requestMs: 30_000,
		checkIntervalMs: 1_000,
	});
	// Thirty open sockets from one address all stay connected, and requests are not throttled.
	const held = await Promise.all(Array.from({ length: 30 }, () => connect(port, "127.0.0.1")));
	const statuses = [];
	for (let i = 0; i < 5; i++) statuses.push((await status(port)).status);
	expect(statuses.every((code) => code === 200)).toBe(true);
	expect(held.every((socket) => !socket.destroyed)).toBe(true);
});

it("accepts connections again after the total socket cap was full", async () => {
	const { port } = await listen({ maxSockets: 2, headerMs: 5_000 });
	const held = await Promise.all([1, 2].map(() => connect(port, "127.0.0.1")));
	const dropped = await connect(port, "127.0.0.1");
	expect(await closed(dropped)).toBeLessThan(500);

	for (const socket of held) socket.destroy();
	await Promise.all(held.map(closed));
	await new Promise((resolve) => setTimeout(resolve, 50));

	expect((await status(port)).status).toBe(200);
});

it("keeps the limiter's bucket map bounded under address churn", () => {
	const limiter = createInMemoryRequestRateLimiter(60_000, { maxBuckets: 8 });
	for (let i = 0; i < 1_000; i++) limiter.check(`sync-listener:198.51.100.${i % 250}:${i}`, 1);
	expect(limiter.bucketCount?.()).toBe(8);
	// The most recent key keeps its bucket, so it is still limited.
	expect(limiter.check("sync-listener:198.51.100.249:999", 1).allowed).toBe(false);
});

it("groups IPv6 clients by /64 and leaves IPv4 addresses whole", () => {
	const key = (remoteAddress: string) => remoteAddressKey({ remoteAddress });
	expect(key("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
	expect(key("2001:0db8:0001:0002:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
	expect(key("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
	expect(key("fe80::1%en0")).toBe("fe80:0:0:0::/64");
	expect(key("::ffff:192.0.2.7")).toBe("192.0.2.7");
	expect(key("192.0.2.7")).toBe("192.0.2.7");
});

it("closes stalled header senders at the per-address cap while another address still syncs", async (context) => {
	if (!(await dualStackAvailable())) context.skip();
	const { port, handled } = await listen(
		{ headerMs: 300, maxSocketsPerIp: 3, checkIntervalMs: 60_000 },
		"::",
	);
	const stalled = await Promise.all([1, 2, 3].map(() => connect(port, "::1")));
	for (const socket of stalled) socket.write("GET /v1/status HTTP/1.1\r\nHost: peer\r\n");
	const overCap = await connect(port, "::1");

	expect(await closed(overCap)).toBeLessThan(250);
	const legitimate = await status(port, "127.0.0.1");
	expect(legitimate.status).toBe(200);
	expect(handled).toHaveBeenCalledTimes(1);
	// Node's own check runs once a minute here, so only the guard's timer can close these in time.
	const waited = await Promise.all(stalled.map(closed));
	for (const ms of waited) expect(ms).toBeLessThan(1_500);
	expect((await status(port, "::1")).status).toBe(200);
});

it("throttles an address before the sync routes run", async () => {
	const { port, handled } = await listen({ requestsPerIpPerMinute: 2 });

	const statuses = [];
	for (let i = 0; i < 4; i++) statuses.push((await status(port)).status);
	const refused = await status(port);

	expect(statuses).toEqual([200, 200, 429, 429]);
	expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
	expect(await refused.json()).toMatchObject({ error: "rate_limited" });
	expect(handled).toHaveBeenCalledTimes(2);
});

it("answers an Upgrade request as an ordinary request when nothing handles upgrades", async () => {
	const { port } = await listen({});
	const socket = await connect(port, "127.0.0.1");
	const reply = new Promise<string>((resolve) =>
		socket.once("data", (chunk) => resolve(String(chunk))),
	);

	socket.write(
		"GET /v1/noise HTTP/1.1\r\nHost: peer\r\nConnection: Upgrade\r\nUpgrade: codemem-peer-stream/1\r\n\r\n",
	);

	expect(await reply).toMatch(/^HTTP\/1\.1 404 /);
});

it("builds the shared listener limiter with the listener's bucket ceiling", () => {
	const limiter = createSyncListenerLimiter();
	for (let i = 0; i < 5_000; i++) limiter.check(`sync-listener:203.0.113.${i}`, 10);
	expect(limiter.bucketCount?.()).toBe(4_096);
});
