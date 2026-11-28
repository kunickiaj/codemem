import { createPrivateKey, randomBytes } from "node:crypto";
import net, { type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { duplexPair } from "node:stream";
import { finished } from "node:stream/promises";
import {
	buildDirectPeerAuthHeaders,
	fingerprintPublicKey,
	loadPrivateKey,
	readPeerTransportPolicy,
} from "@codemem/core";
import { serve } from "@hono/node-server";
import { afterEach, expect, it, vi } from "vitest";
import {
	DIRECT_NOISE_LOGICAL_ORIGIN,
	directNoiseUpgradeTarget,
} from "../../core/src/direct-noise-upgrade.js";
import { createPeerHttpExecutor } from "../../core/src/peer-http-client.js";
import { prepareRelayNoiseInitiator } from "../../core/src/relay-noise.js";
import { ResponseByteBudget } from "./response-byte-budget.js";
import { createSyncApp } from "./sync-app.js";
import { channelStore, nonceCount } from "./sync-channel-dispatch-test-fixtures.js";
import { createGuardedSyncServer, type SyncListenerLimits } from "./sync-listener-guard.js";
import type { DirectNoiseGateLimits } from "./sync-noise-gate.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

type Fixture = Awaited<ReturnType<typeof gate>>;

async function gate(
	options: {
		limits?: Partial<DirectNoiseGateLimits>;
		active?: boolean;
		listener?: Partial<SyncListenerLimits>;
	} = {},
) {
	const f = await channelStore();
	cleanups.push(f.cleanup);
	const keysDir = join(dirname(f.peerKeysDir), "local-keys");
	const app = createSyncApp({ storeFactory: f.storeFactory });
	const createServer = createGuardedSyncServer({
		limits: options.listener,
		directNoise: {
			storeFactory: f.storeFactory,
			keysDir,
			limits: options.limits,
			active: options.active ?? true,
		},
	});
	const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
		const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0, createServer }, () =>
			resolve(started),
		);
	});
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
	return { ...f, port: (server.address() as AddressInfo).port };
}

interface UpgradeOptions {
	recipientId?: string;
	v2Only?: boolean;
	target?: (canonical: string) => string;
	extra?: string;
	raw?: string;
}

/** A signed upgrade request for the peer, plus the client half of its Noise handshake. */
async function upgradeRequest(f: Fixture, options: UpgradeOptions = {}) {
	const sessionId = randomBytes(16);
	const [client, wire] = duplexPair();
	const key = createPrivateKey(loadPrivateKey(f.peerKeysDir, undefined, f.peerDeviceId) as Buffer);
	const prepared = prepareRelayNoiseInitiator({
		transport: client,
		localIdentity: { key, expectedPin: f.peerPublicKey },
		expectedRemotePin: f.localPublicKey,
		context: { transportLabel: 2, sessionId },
		deadlineMs: performance.now() + 20_000,
	});
	const { digest } = await prepared.opening;
	const canonical = directNoiseUpgradeTarget(sessionId, digest);
	const target = options.target?.(canonical) ?? canonical;
	const headers: Record<string, string> = buildDirectPeerAuthHeaders({
		deviceId: f.peerDeviceId,
		recipientId: options.recipientId ?? f.localDeviceId,
		method: "GET",
		url: DIRECT_NOISE_LOGICAL_ORIGIN + target,
		bodyBytes: Buffer.alloc(0),
		keysDir: f.peerKeysDir,
	});
	if (options.v2Only) {
		delete headers["X-Codemem-Signature"];
		delete headers["X-Codemem-Recipient"];
	}
	const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
	const raw =
		options.raw ??
		`GET ${target} HTTP/1.1\r\nHost: peer\r\nConnection: Upgrade\r\nUpgrade: codemem-peer-stream/1\r\n${lines.join("\r\n")}\r\n\r\n`;
	cleanups.push(() => prepared.cancel());
	return { raw, prepared, wire };
}

/** Sends raw bytes and resolves with the status line and the socket, positioned after the head. */
function send(port: number, raw: string, options: { allowHalfOpen?: boolean } = {}) {
	return new Promise<{ status: number; socket: net.Socket; rest: Buffer }>((resolve, reject) => {
		const socket = net.connect({ port, host: "127.0.0.1", ...options }, () => socket.write(raw));
		cleanups.push(() => socket.destroy());
		let buffered = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			const end = buffered.indexOf("\r\n\r\n");
			if (end < 0) return;
			socket.off("data", onData);
			socket.pause();
			const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buffered.toString("latin1"))?.[1] ?? 0);
			resolve({ status, socket, rest: buffered.subarray(end + 4) });
		};
		socket.on("data", onData);
		socket.once("close", () => resolve({ status: 0, socket, rest: Buffer.alloc(0) }));
		socket.once("error", reject);
	});
}

/** Completes the handshake over the switched socket and runs one signed request inside it. */
async function exchange(
	f: Fixture,
	request: Awaited<ReturnType<typeof upgradeRequest>>,
	socket: net.Socket,
) {
	request.wire.pipe(socket);
	socket.pipe(request.wire);
	socket.resume();
	request.prepared.release(performance.now());
	const secured = await request.prepared.authenticated;
	const completion = Promise.all([finished(secured.duplex), finished(socket)]).then(() => {});
	void completion.catch(() => {});
	const execute = createPeerHttpExecutor({
		factory: {
			open: async () => ({
				duplex: secured.duplex,
				completion,
				async dispose(error: Error) {
					secured.duplex.destroy(error);
					socket.destroy(error);
				},
			}),
		},
	});
	const url = `${DIRECT_NOISE_LOGICAL_ORIGIN}/v1/status`;
	const headers = buildDirectPeerAuthHeaders({
		deviceId: f.peerDeviceId,
		recipientId: f.localDeviceId,
		method: "GET",
		url,
		bodyBytes: Buffer.alloc(0),
		keysDir: f.peerKeysDir,
	});
	return execute("GET", url, { headers });
}

function closedWithin(socket: net.Socket, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		if (socket.destroyed || socket.readableEnded) return resolve(true);
		const timer = setTimeout(() => resolve(false), ms);
		// A half-open client sees the server's close as end of its readable side.
		for (const event of ["close", "end"])
			socket.once(event, () => {
				clearTimeout(timer);
				resolve(true);
			});
		socket.resume();
	});
}

it("switches a signed upgrade to Noise and serves the peer's request inside it", async () => {
	const f = await gate();
	const request = await upgradeRequest(f);

	const { status, socket } = await send(f.port, request.raw);
	const [innerStatus, payload] = await exchange(f, request, socket);

	expect(status).toBe(101);
	expect(innerStatus).toBe(200);
	expect(payload).toMatchObject({
		device_id: f.localDeviceId,
		fingerprint: fingerprintPublicKey(f.localPublicKey),
	});
});

it("refuses a replayed upgrade before switching and changes no transport policy", async () => {
	const f = await gate();
	const request = await upgradeRequest(f);
	const first = await send(f.port, request.raw);
	expect(first.status).toBe(101);

	const replay = await send(f.port, request.raw);

	expect(replay.status).toBe(401);
	expect(replay.rest.toString()).toBe('{"error":"unauthorized"}');
	expect(readPeerTransportPolicy(f.store.db, f.peerDeviceId)).toBe("legacy_plaintext");
});

it("refuses an upgrade signed for another device and one with only a v2 signature", async () => {
	const f = await gate();
	for (const options of [{ recipientId: "some-other-device" }, { v2Only: true }]) {
		const request = await upgradeRequest(f, options);
		expect((await send(f.port, request.raw)).status).toBe(401);
	}
});

it.each([
	["an extra parameter", (t: string) => `${t}&x=1`],
	[
		"reordered parameters",
		(t: string) => t.replace(/\?session=(\w+)&opening=(\w+)/, "?opening=$2&session=$1"),
	],
	[
		"uppercase hex",
		(t: string) =>
			t
				.toUpperCase()
				.replace("/V1/NOISE?SESSION=", "/v1/noise?session=")
				.replace("&OPENING=", "&opening="),
	],
	["a missing opening", (t: string) => t.replace(/&opening=\w+/, "")],
])("refuses a target with %s before using the nonce", async (_name, change) => {
	const f = await gate();
	const request = await upgradeRequest(f, { target: change });

	const { status } = await send(f.port, request.raw);

	expect(status).toBe(400);
	expect(nonceCount(f)).toBe(0);
});

it("refuses bytes sent before the 101", async () => {
	const f = await gate();
	const request = await upgradeRequest(f);

	expect((await send(f.port, `${request.raw}early`)).status).toBe(400);
	expect(nonceCount(f)).toBe(0);
});

it("closes a switched socket that never sends Message A and frees its handshake slot", async () => {
	const f = await gate({ limits: { handshakeMs: 300, pendingPerIp: 1 } });
	const silent = await upgradeRequest(f);
	const held = await send(f.port, silent.raw);
	expect(held.status).toBe(101);

	const meanwhile = await upgradeRequest(f);
	expect((await send(f.port, meanwhile.raw)).status).toBe(503);
	expect(await closedWithin(held.socket, 2_000)).toBe(true);

	const after = await upgradeRequest(f);
	const { status, socket } = await send(f.port, after.raw);
	expect(status).toBe(101);
	expect((await exchange(f, after, socket))[0]).toBe(200);
});

it("caps open streams per peer before switching", async () => {
	const f = await gate({ limits: { streamsPerPeer: 1 } });
	const held = await send(f.port, (await upgradeRequest(f)).raw);
	expect(held.status).toBe(101);

	const second = await send(f.port, (await upgradeRequest(f)).raw);

	expect(second.status).toBe(503);
	expect(second.rest.toString()).toBe('{"error":"busy"}');
});

it("keeps a switched socket open past the listener's header deadline", async () => {
	const f = await gate({ listener: { headerMs: 200, requestMs: 200 } });
	const request = await upgradeRequest(f);
	const { status, socket } = await send(f.port, request.raw);
	expect(status).toBe(101);

	await new Promise((resolve) => setTimeout(resolve, 400));
	const [innerStatus] = await exchange(f, request, socket);

	expect(innerStatus).toBe(200);
});

it("ends the stream when the peer is re-pinned during the handshake", async () => {
	const f = await gate();
	const request = await upgradeRequest(f);
	const { status, socket } = await send(f.port, request.raw);
	expect(status).toBe(101);
	f.store.db
		.prepare(
			"UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ? WHERE peer_device_id = ?",
		)
		.run(f.localPublicKey, fingerprintPublicKey(f.localPublicKey), f.peerDeviceId);

	await expect(exchange(f, request, socket)).rejects.toThrow();
});

it("throttles upgrades with the listener's per-address budget", async () => {
	const f = await gate();
	const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
		const started = serve(
			{
				fetch: createSyncApp({ storeFactory: f.storeFactory }).fetch,
				hostname: "127.0.0.1",
				port: 0,
				createServer: createGuardedSyncServer({
					limits: { requestsPerIpPerMinute: 1 },
					directNoise: { storeFactory: f.storeFactory, active: true },
				}),
			},
			() => resolve(started),
		);
	});
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
	const port = (server.address() as AddressInfo).port;

	const first = await send(port, (await upgradeRequest(f)).raw);
	const second = await send(port, (await upgradeRequest(f)).raw);

	expect(first.status).not.toBe(429);
	expect(second.status).toBe(429);
});

it("does not switch protocols while direct Noise is off", async () => {
	const f = await gate({ active: false });
	const request = await upgradeRequest(f);

	const { status } = await send(f.port, request.raw);

	expect(status).not.toBe(101);
	expect(nonceCount(f)).toBe(0);
});

it("holds response reservations within the budget and serves waiters in order", async () => {
	const budget = new ResponseByteBudget(10);
	const first = await budget.acquire(6);
	const order: string[] = [];
	const second = budget.acquire(6).then((release) => {
		order.push("second");
		return release;
	});
	const aborted = new AbortController();
	const cancelled = budget.acquire(6, aborted.signal);
	aborted.abort();
	await expect(cancelled).rejects.toBeDefined();
	expect(budget.availableBytes).toBe(4);

	first();
	(await second)();

	expect(order).toEqual(["second"]);
	expect(budget.availableBytes).toBe(10);
	await expect(budget.acquire(11)).rejects.toThrow(RangeError);
});

const adoption = (f: Fixture) =>
	f.store.db
		.prepare(
			`SELECT state.highest_observed_direct_signature_version AS state, peer.highest_observed_direct_signature_version AS mirror
			 FROM sync_peers AS peer LEFT JOIN sync_peer_signature_state AS state USING (peer_device_id)
			 WHERE peer.peer_device_id = ?`,
		)
		.get(f.peerDeviceId);

it("leaves only the nonce when the handshake fails, and records v3 after inner traffic", async () => {
	const f = await gate({ limits: { handshakeMs: 300 } });
	const silent = await upgradeRequest(f);
	const held = await send(f.port, silent.raw);
	expect(held.status).toBe(101);
	expect(await closedWithin(held.socket, 2_000)).toBe(true);

	expect(nonceCount(f)).toBe(1);
	expect(adoption(f)).toEqual({ state: null, mirror: null });

	const request = await upgradeRequest(f);
	const { socket } = await send(f.port, request.raw);
	expect((await exchange(f, request, socket))[0]).toBe(200);
	expect(adoption(f)).toEqual({ state: 3, mirror: 3 });
});

it("destroys a refused socket whose client keeps writing open, returning its slot", async () => {
	const f = await gate({ listener: { maxSocketsPerIp: 1 } });
	const refused = await upgradeRequest(f, { target: (t) => `${t}&x=1` });

	const first = await send(f.port, refused.raw, { allowHalfOpen: true });
	expect(first.status).toBe(400);
	expect(await closedWithin(first.socket, 2_000)).toBe(true);

	const next = await upgradeRequest(f);
	const { status, socket } = await send(f.port, next.raw);
	expect(status).toBe(101);
	expect((await exchange(f, next, socket))[0]).toBe(200);
});
