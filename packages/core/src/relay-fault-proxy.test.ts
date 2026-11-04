import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createPeerHttpExecutor } from "./peer-http-client.js";
import { encodeRelayControl } from "./relay-control-codec.js";
import type {
	RelayFaultAction,
	RelayFaultDirection,
	RelayFaultEvent,
	RelayFaultProxyOptions,
	RelayFaultRule,
} from "./relay-fault-proxy-test-fixtures.js";
import { createRelayFaultProxy } from "./relay-fault-proxy-test-fixtures.js";
import { relayClientFixture, relayDeadline } from "./relay-peer-client-test-fixtures.js";

// Accept order is deterministic because the target registers before the source opens its socket.
const TARGET = 0;
const SOURCE = 1;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

/** Applies `action` to the nth DATA frame (0-based) that one socket carries in one direction. */
function onData(
	socket: number,
	direction: RelayFaultDirection,
	nth: number,
	action: RelayFaultAction,
): RelayFaultRule {
	let seen = 0;
	return (frame) => {
		if (frame.socket !== socket || frame.direction !== direction || frame.kind !== "data") return;
		return seen++ === nth ? action : undefined;
	};
}

/** Applies `action` to the first control frame of `type` that one socket carries in one direction. */
function onControl(
	socket: number,
	direction: RelayFaultDirection,
	type: string,
	action: RelayFaultAction,
): RelayFaultRule {
	let done = false;
	return (frame) => {
		if (done || frame.socket !== socket || frame.direction !== direction) return;
		if (frame.kind !== "control" || frame.type !== type) return;
		done = true;
		return action;
	};
}

function flipLastByte(original: Buffer): Buffer {
	const bytes = Buffer.from(original);
	bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
	return bytes;
}

async function settle<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
}

/** One real Noise-pinned HTTP exchange from source to target, routed only through the proxy. */
async function exchange(rule?: RelayFaultRule, budgetMs?: number) {
	const f = await relayClientFixture(undefined, undefined, { faultProxy: { rule } });
	cleanups.push(() => f.dispose());
	if (!f.proxy) throw new Error("Missing fault proxy");
	const proxy = f.proxy;
	const dispatch = vi.fn(async () => ({ status: 200, bodyBytes: Buffer.from('{"ok":true}') }));
	const completions: Promise<void>[] = [];
	const target = f.client("target", {
		onInbound: async (connection, context) => {
			completions.push(connection.completion);
			await context.serve({ origin: "https://peer.invalid", dispatch });
		},
	});
	const source = f.client("source");
	const registered = await settle(target.connect(new AbortController().signal, relayDeadline()));
	if (!registered.ok) return { f, proxy, registered, result: registered, dispatch };
	const execute = createPeerHttpExecutor({
		factory: source.factory("target", f.identities.target.expectedPin),
		deadlineMs: budgetMs === undefined ? undefined : performance.now() + budgetMs,
	});
	const result = await settle(execute("GET", "https://peer.invalid/private-marker"));
	await Promise.allSettled(completions);
	await vi.waitFor(() => expect(f.runtime.counters().routes).toBe(0));
	return { f, proxy, registered, result, dispatch };
}

function actions(events: readonly RelayFaultEvent[]) {
	return events.filter((event) => event.action !== "pass").map((event) => event.action);
}

function lane(events: readonly RelayFaultEvent[], socket: number, direction: RelayFaultDirection) {
	return events
		.filter((event) => event.socket === socket && event.direction === direction)
		.map((event) => (event.kind === "control" ? event.type : `DATA:${event.length}`));
}

describe("relay fault proxy pass-through", () => {
	it("forwards a real pinned Noise exchange byte-for-byte with a deterministic frame log", async () => {
		// Arrange: every binary send in the process is either a client, proxy, or runtime write.
		const sends = vi.spyOn(WebSocket.prototype, "send");
		// Act.
		const { f, proxy, result, dispatch } = await exchange();
		// Assert: the exchange succeeds and the runtime origin is never dialed by a client.
		expect(result).toEqual({ ok: true, value: [200, { ok: true }] });
		expect(dispatch).toHaveBeenCalledTimes(1);
		const runtimeAddress = f.runtime.server.address();
		if (!runtimeAddress || typeof runtimeAddress === "string") throw new Error("Missing runtime");
		expect(proxy.host).not.toBe(`127.0.0.1:${runtimeAddress.port}`);
		expect(proxy.events.every((event) => event.action === "pass")).toBe(true);
		expect(proxy.events.every((event) => event.forwardedBytes === event.byteLength)).toBe(true);
		expect(lane(proxy.events, SOURCE, "toRelay")).toEqual([
			"SERVICE_CHALLENGE",
			"REGISTER",
			"OPEN",
			"DATA:34",
			"DATA:172",
			"DATA:134",
			"CLOSE",
		]);
		expect(lane(proxy.events, TARGET, "toPeer")).toEqual([
			"SERVICE_PROOF",
			"SOCKET_CHALLENGE",
			"REGISTERED",
			"OPEN",
			"DATA:34",
			"DATA:172",
			"DATA:134",
			"CLOSE",
		]);
		// Each DATA frame is written four times (client, proxy, runtime, proxy) with identical bytes.
		const copies = new Map<string, number>();
		for (const [data] of sends.mock.calls)
			if (data instanceof Uint8Array && data[0] === 1 && data[1] === 1) {
				const key = Buffer.from(data).toString("hex");
				copies.set(key, (copies.get(key) ?? 0) + 1);
			}
		const dataFrames = proxy.events.filter((e) => e.kind === "data" && e.direction === "toRelay");
		expect(copies.size).toBe(dataFrames.length);
		expect([...copies.values()].every((count) => count === 4)).toBe(true);
	}, 15000);

	it("holds no Noise or identity key material", () => {
		// Arrange.
		const source = readFileSync(
			new URL("./relay-fault-proxy-test-fixtures.ts", import.meta.url),
			"utf8",
		);
		// Act.
		const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
		// Assert: options carry only the upstream URL and a rule, and no crypto module is imported.
		expectTypeOf<keyof RelayFaultProxyOptions>().toEqualTypeOf<"upstreamUrl" | "rule">();
		expect(imports.sort()).toEqual(["./relay-control-codec.js", "./relay-data-frame.js", "ws"]);
	});
});

describe("relay fault proxy scripted DATA faults", () => {
	it.each([
		["drop", { type: "drop" }],
		["duplicate", { type: "duplicate" }],
		["reorder", { type: "reorder" }],
		["truncate", { type: "truncate", keep: 40 }],
		["substitute", { type: "substitute", bytes: (original: Buffer) => flipLastByte(original) }],
	] as const)(
		"fails the exchange and closes the route when the handshake DATA frame is %s",
		async (name, action) => {
			// Arrange: the third Noise handshake message toward the target is the faulted frame.
			const rule = onData(TARGET, "toPeer", 1, action);
			// Act.
			const { proxy, result, dispatch } = await exchange(rule);
			// Assert.
			expect(result.ok).toBe(false);
			expect(dispatch).not.toHaveBeenCalled();
			expect(actions(proxy.events)[0]).toBe(name);
			const faulted = proxy.events.find((event) => event.action === name);
			expect(faulted).toMatchObject({
				socket: TARGET,
				direction: "toPeer",
				kind: "data",
				length: 172,
			});
		},
		15000,
	);

	it("fails the exchange when a source DATA frame is truncated toward the relay", async () => {
		// Arrange: the relay itself sees a DATA header whose declared length no longer matches.
		const rule = onData(SOURCE, "toRelay", 0, { type: "truncate", keep: 30 });
		// Act.
		const { proxy, result, dispatch } = await exchange(rule);
		// Assert.
		expect(result.ok).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
		expect(proxy.events.find((event) => event.action === "truncate")).toMatchObject({
			socket: SOURCE,
			direction: "toRelay",
			length: 34,
			forwardedBytes: 30,
		});
	}, 15000);

	it("completes the exchange when a DATA frame is delayed without being overtaken", async () => {
		// Arrange: the responder handshake message is the only frame in flight toward the source.
		const rule = onData(SOURCE, "toPeer", 0, { type: "delay", ms: 50 });
		// Act.
		const { proxy, result } = await exchange(rule);
		// Assert.
		expect(result).toEqual({ ok: true, value: [200, { ok: true }] });
		expect(actions(proxy.events)).toEqual(["delay", "release"]);
		expect(proxy.held()).toBe(0);
	}, 15000);
});

describe("relay fault proxy scripted control faults", () => {
	it("fails registration when the REGISTER control frame is truncated toward the relay", async () => {
		// Arrange.
		const rule = onControl(TARGET, "toRelay", "REGISTER", { type: "truncate", keep: 8 });
		// Act.
		const { proxy, registered } = await exchange(rule);
		// Assert.
		expect(registered.ok).toBe(false);
		expect(proxy.events.find((event) => event.action === "truncate")).toMatchObject({
			kind: "control",
			type: "REGISTER",
			forwardedBytes: 8,
		});
	}, 15000);

	it("fails registration when a delayed SERVICE_PROOF is overtaken by SOCKET_CHALLENGE", async () => {
		// Arrange: later frames keep flowing, so the challenge reaches the client first.
		const rule = onControl(TARGET, "toPeer", "SERVICE_PROOF", { type: "delay", ms: 200 });
		// Act.
		const { proxy, registered } = await exchange(rule);
		// Assert.
		expect(registered.ok).toBe(false);
		expect(lane(proxy.events, TARGET, "toPeer").slice(0, 2)).toEqual([
			"SERVICE_PROOF",
			"SOCKET_CHALLENGE",
		]);
		await vi.waitFor(() => expect(actions(proxy.events)).toEqual(["delay", "discard"]));
		expect(proxy.held()).toBe(0);
	}, 15000);

	it("fails the exchange when ACCEPTED is substituted with REJECTED toward the source", async () => {
		// Arrange: the replacement keeps the route session so only the control type changes.
		const rule = onControl(SOURCE, "toPeer", "ACCEPTED", {
			type: "substitute",
			bytes: (original) => {
				const { session } = JSON.parse(original.toString()) as { session: string };
				return encodeRelayControl({ v: 1, type: "REJECTED", session, body: {} });
			},
		});
		// Act.
		const { proxy, result, dispatch } = await exchange(rule);
		// Assert.
		expect(result.ok).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
		expect(actions(proxy.events)).toEqual(["substitute"]);
	}, 15000);

	it("fails the exchange when the forwarded OPEN control frame is dropped", async () => {
		// Arrange.
		const rule = onControl(TARGET, "toPeer", "OPEN", { type: "drop" });
		// Act: without the OPEN the target never accepts, so the source waits for its deadline.
		const { proxy, result, dispatch } = await exchange(rule, 1000);
		// Assert.
		expect(result.ok).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
		expect(actions(proxy.events)).toEqual(["drop"]);
	}, 15000);
});

describe("relay fault proxy memory release", () => {
	it("discards held frames and leaves nothing queued when the proxy closes", async () => {
		// Arrange: hold the socket challenge far beyond the test lifetime while the client waits.
		const f = await relayClientFixture(undefined, undefined, {
			faultProxy: {
				rule: onControl(TARGET, "toPeer", "SOCKET_CHALLENGE", { type: "delay", ms: 60_000 }),
			},
		});
		cleanups.push(() => f.dispose());
		const proxy = f.proxy;
		if (!proxy) throw new Error("Missing fault proxy");
		const connecting = settle(
			f.client("target").connect(new AbortController().signal, relayDeadline()),
		);
		await vi.waitFor(() => expect(proxy.held()).toBe(1));
		// Act.
		await proxy.close();
		// Assert.
		expect(proxy.held()).toBe(0);
		expect(actions(proxy.events)).toEqual(["delay", "discard"]);
		expect((await connecting).ok).toBe(false);
	}, 15000);
});

describe("relay fault proxy frame ordering", () => {
	it("releases a reordered frame after the delayed frame that follows it", async () => {
		// Arrange: a plain loopback upstream records the text frames it receives.
		const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await new Promise<void>((resolve) => upstream.once("listening", resolve));
		cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
		const received: string[] = [];
		upstream.on("connection", (socket) =>
			socket.on("message", (data) => received.push(String(data))),
		);
		const address = upstream.address();
		if (!address || typeof address === "string") throw new Error("Missing upstream listener");
		const rule: RelayFaultRule = (frame) => {
			if (frame.direction !== "toRelay") return;
			if (frame.index === 0) return { type: "reorder" };
			if (frame.index === 1) return { type: "delay", ms: 20 };
		};
		const proxy = await createRelayFaultProxy({
			upstreamUrl: `ws://127.0.0.1:${address.port}`,
			rule,
		});
		cleanups.push(() => proxy.close());
		const client = new WebSocket(`ws://${proxy.host}/v1/relay`);
		await new Promise<void>((resolve) => client.once("open", resolve));
		// Act.
		client.send("first");
		client.send("second");
		// Assert: the delayed frame is forwarded first, then the reordered one, with nothing held.
		await vi.waitFor(() => expect(received).toEqual(["second", "first"]));
		expect(proxy.held()).toBe(0);
		expect(actions(proxy.events)).toEqual(["reorder", "delay", "release", "release"]);
		client.close();
	}, 15000);
});
