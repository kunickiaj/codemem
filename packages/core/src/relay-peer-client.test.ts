import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createPeerHttpExecutor } from "./peer-http-client.js";
import type { PeerHttpServerRequest } from "./peer-http-server.js";
import { decodeRelayCheckPacket } from "./relay-admission-codec.js";
import { decodeRelayDataFrame, encodeRelayDataFrame } from "./relay-data-frame.js";
import type { RelayPeerClientOptions } from "./relay-peer-client.js";
import {
	disposableIdentity,
	relayClientFixture,
	relayDeadline,
} from "./relay-peer-client-test-fixtures.js";
import { relayBodyDigest } from "./relay-service-proof.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});
async function fixture(options?: Parameters<typeof relayClientFixture>[2]) {
	const f = await relayClientFixture(undefined, undefined, options);
	cleanups.push(() => f.dispose());
	return f;
}

describe("actual relay peer HTTP exchange", () => {
	it("authenticates both clients and completes one HTTP exchange with three independent admission roles", async () => {
		// Arrange: the dispatcher sees application bytes only after real Noise authentication.
		const f = await fixture();
		const wire = vi.spyOn(WebSocket.prototype, "send");
		const dispatch = vi.fn(async (request: PeerHttpServerRequest) => ({
			status: 200,
			bodyBytes: Buffer.from(JSON.stringify({ target: request.target, pin: request.peerPin })),
		}));
		const completions: Promise<void>[] = [];
		const target = f.client("target", {
			onInbound: async (connection, context) => {
				completions.push(connection.completion);
				await context.serve({ origin: "https://peer.invalid", dispatch });
			},
		});
		const source = f.client("source");
		await target.connect(new AbortController().signal, relayDeadline());
		const execute = createPeerHttpExecutor({
			factory: source.factory("target", f.identities.target.expectedPin),
		});
		// Act.
		const result = await execute("GET", "https://peer.invalid/private-marker?x=1");
		await Promise.all(completions);
		// Assert: success includes physical route completion, not merely HTTP parsing.
		expect(result).toEqual([
			200,
			{ target: "/private-marker?x=1", pin: f.identities.source.expectedPin },
		]);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(
			f.checks
				.map(({ packet }) => decodeRelayCheckPacket(packet))
				.filter((p) => p.kind === "admission")
				.map((p) => p.value.role)
				.sort(),
		).toEqual(["relay", "responder", "source"]);
		expect(f.runtime.counters().routes).toBe(0);
		const frames = wire.mock.calls
			.map(([data]) => data)
			.filter((data): data is Uint8Array => data instanceof Uint8Array)
			.map(decodeRelayDataFrame);
		const opening = frames[0]?.payload;
		expect(opening?.byteLength).toBe(34);
		expect(frames.length).toBeGreaterThan(3);
		for (const frame of frames)
			expect(Buffer.from(frame.payload).toString()).not.toContain("private-marker");
		const packets = f.checks.filter(
			({ packet }) => decodeRelayCheckPacket(packet).kind === "admission",
		);
		expect(new Set(packets.map(({ packet }) => packet.nonce)).size).toBe(3);
		if (!opening) throw new Error("Missing Noise opening");
		for (const { packet } of packets) {
			const decoded = decodeRelayCheckPacket(packet);
			if (decoded.kind !== "admission") throw new Error("Expected admission packet");
			expect(decoded.value.messageADigest).toBe(relayBodyDigest(opening));
		}
	}, 10000);

	it("fails an offline target once without dispatch or retry", async () => {
		// Arrange.
		const f = await fixture();
		const source = f.client("source");
		const execute = createPeerHttpExecutor({
			factory: source.factory("target", f.identities.target.expectedPin),
		});
		// Act.
		const result = execute("POST", "https://peer.invalid/private-marker", {
			bodyBytes: Buffer.from("{}"),
		});
		// Assert.
		await expect(result).rejects.toThrow();
		expect(
			f.checks
				.map(({ packet }) => decodeRelayCheckPacket(packet))
				.filter((p) => p.kind === "admission")
				.map((p) => p.value.role)
				.sort(),
		).toEqual(["relay", "source"]);
		expect(f.runtime.counters().routes).toBe(0);
	}, 10000);

	it.each(["disabled", "stale-pin", "cancelled"])(
		"rejects %s before any network admission",
		async (condition) => {
			// Arrange.
			const f = await fixture();
			const source = f.client("source", {
				enabled: condition === "disabled" ? undefined : true,
				resolvePeerPin:
					condition === "stale-pin"
						? () => null
						: (id) => (id === "target" ? f.identities.target.expectedPin : null),
			});
			const abort = new AbortController();
			if (condition === "cancelled") abort.abort();
			// Act.
			const result = source
				.factory("target", f.identities.target.expectedPin)
				.open({ signal: abort.signal, deadlineMs: relayDeadline() });
			// Assert.
			await expect(result).rejects.toThrow();
			expect(f.checks).toEqual([]);
			expect(f.runtime.counters().sockets).toBe(0);
		},
	);
});

describe("relay peer trust and independent admission", () => {
	it.each(["source", "responder"])(
		"requires the %s independent coordinator check before application dispatch",
		async (role) => {
			// Arrange: registration and relay checks still use the real HTTP coordinator.
			const f = await fixture();
			const deny = vi.fn(async () => null);
			const dispatch = vi.fn(async () => ({ status: 200, bodyBytes: Buffer.from("{}") }));
			const target = f.client("target", {
				...(role === "responder" ? { coordinator: { check: deny } } : {}),
				onInbound: async (_connection, context) =>
					context.serve({ origin: "https://peer.invalid", dispatch }),
			});
			const source = f.client("source", role === "source" ? { coordinator: { check: deny } } : {});
			await target.connect(new AbortController().signal, relayDeadline());
			const execute = createPeerHttpExecutor({
				factory: source.factory("target", f.identities.target.expectedPin),
			});
			// Act.
			const result = execute("POST", "https://peer.invalid/private-marker", {
				bodyBytes: Buffer.from("{}"),
			});
			// Assert.
			await expect(result).rejects.toThrow();
			expect(deny).toHaveBeenCalledTimes(1);
			expect(dispatch).not.toHaveBeenCalled();
			expect(f.runtime.counters().routes).toBe(0);
		},
		10000,
	);

	it("revalidates the current source pin immediately before shared HTTP dispatch", async () => {
		// Arrange: invalidate trust only after Noise authenticated the inbound connection.
		const f = await fixture();
		let current = true;
		const dispatch = vi.fn(async () => ({ status: 200, bodyBytes: Buffer.from("{}") }));
		const inbound = vi.fn<RelayPeerClientOptions["onInbound"]>(async (_connection, context) => {
			current = false;
			await context.serve({ origin: "https://peer.invalid", dispatch });
		});
		const target = f.client("target", {
			resolvePeerPin: () => (current ? f.identities.source.expectedPin : null),
			onInbound: inbound,
		});
		const source = f.client("source");
		await target.connect(new AbortController().signal, relayDeadline());
		// Act.
		const result = createPeerHttpExecutor({
			factory: source.factory("target", f.identities.target.expectedPin),
		})("POST", "https://peer.invalid/private-marker", { bodyBytes: Buffer.from("{}") });
		// Assert.
		await expect(result).rejects.toThrow();
		expect(inbound).toHaveBeenCalledTimes(1);
		expect(dispatch).not.toHaveBeenCalled();
	}, 10000);

	it.each(["rotated-key", "stale-readiness"])(
		"fails registration against actual coordinator %s state",
		async (condition) => {
			// Arrange.
			const f = await fixture();
			if (condition === "rotated-key")
				f.db
					.prepare("UPDATE enrolled_devices SET public_key = ? WHERE device_id = 'source'")
					.run(f.identities.target.expectedPin);
			else {
				for (const scope of ["authority", "realm"])
					f.db
						.prepare(
							"UPDATE relay_admission_readiness SET revision = revision + 1, observed_at_ms = ? WHERE scope = ?",
						)
						.run(Date.now() - 120000, scope);
			}
			const source = f.client("source");
			// Act.
			const result = source.connect(new AbortController().signal, relayDeadline());
			// Assert.
			await expect(result).rejects.toThrow();
			expect(f.checks).toHaveLength(1);
			expect(f.runtime.counters().routes).toBe(0);
		},
		10000,
	);
});

describe("relay peer initial registration cancellation", () => {
	it("cancels one peer's initial opener without closing shared registration for another peer", async () => {
		// Arrange: different peers create independent routes, rather than a same-peer capacity waiter.
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture({
			beforeCheck: async ({ packet }) => {
				const decoded = decodeRelayCheckPacket(packet);
				if (decoded.kind === "registration" && decoded.value.deviceId === "source") {
					entered.resolve();
					await release.promise;
				}
			},
		});
		cleanups.push(async () => release.resolve());
		const dispatch = vi.fn(async () => ({
			status: 200,
			bodyBytes: Buffer.from('{"survived":true}'),
		}));
		const target = f.client("target", {
			onInbound: async (_connection, context) =>
				context.serve({ origin: "https://peer.invalid", dispatch }),
		});
		const otherPin = disposableIdentity(4).expectedPin;
		const source = f.client("source", {
			resolvePeerPin: (id) => {
				if (id === "cancelled-peer") return otherPin;
				if (id === "target") return f.identities.target.expectedPin;
				return null;
			},
		});
		await target.connect(new AbortController().signal, relayDeadline());
		const wire = vi.spyOn(WebSocket.prototype, "send");
		const registration = vi.spyOn(source, "maintainRegistration");
		const abort = new AbortController();
		const first = source.factory("cancelled-peer", otherPin).open({
			signal: abort.signal,
			deadlineMs: relayDeadline(),
		});
		const cancelled = expect(first).rejects.toThrow(/cancelled|expired|removed/);
		await entered.promise;
		const second = source.factory("target", f.identities.target.expectedPin).open({
			signal: new AbortController().signal,
			deadlineMs: relayDeadline(),
		});
		void second.catch(() => {});
		await nextTurn();
		const state = source as unknown as {
			socket: WebSocket;
			routes: Map<string, { peer: string; opened: boolean }>;
			waiters: Map<string, unknown>;
		};
		const socket = state.socket;
		expect(registration).toHaveBeenCalledTimes(2);
		expect([...state.routes.values()].map(({ peer, opened }) => ({ peer, opened }))).toEqual([
			{ peer: "cancelled-peer", opened: false },
			{ peer: "target", opened: false },
		]);
		expect(state.waiters.size).toBe(0);
		// Act: cancellation belongs to the first route, while both await the same registration.
		abort.abort();
		await cancelled;
		await nextTurn();
		// Assert: an unopened route must not send CLOSE during the server's pending REGISTER check.
		const prematureCloses = wire.mock.calls.filter(
			([message], index) =>
				wire.mock.contexts[index] === socket &&
				typeof message === "string" &&
				JSON.parse(message).type === "CLOSE",
		);
		expect(prematureCloses).toEqual([]);
		release.resolve();
		const owner = await second;
		expect(state.socket).toBe(socket);
		await expect(
			createPeerHttpExecutor({ factory: { open: async () => owner } })(
				"GET",
				"https://peer.invalid/after-cancellation",
			),
		).resolves.toEqual([200, { survived: true }]);
		await expect(owner.completion).resolves.toBeUndefined();
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(
			f.checks.filter(({ packet }) => {
				const decoded = decodeRelayCheckPacket(packet);
				return decoded.kind === "registration" && decoded.value.deviceId === "source";
			}),
		).toHaveLength(1);
	}, 10000);
});

describe("relay peer crossed cancellation", () => {
	it("keeps a reverse route usable when forwarded DATA crosses local cancellation", async () => {
		// Arrange: both directions authenticate before holding the forward response on the wire.
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const forwarded = Promise.withResolvers<void>();
		cleanups.push(async () => release.resolve());
		const target = f.client("target", {
			onInbound: async (_connection, context) =>
				context.serve({
					origin: "https://peer.invalid",
					dispatch: async () => {
						entered.resolve();
						await release.promise;
						return { status: 200, bodyBytes: Buffer.from('{"cancelled":"marker"}') };
					},
				}),
		});
		const source = f.client("source", {
			onInbound: async (_connection, context) =>
				context.serve({
					origin: "https://peer.invalid",
					dispatch: async () => ({ status: 200, bodyBytes: Buffer.from('{"reverse":true}') }),
				}),
		});
		const send = WebSocket.prototype.send;
		const wire = vi.spyOn(WebSocket.prototype, "send");
		await target.connect(new AbortController().signal, relayDeadline());
		const abort = new AbortController();
		const owner = await source.factory("target", f.identities.target.expectedPin).open({
			signal: abort.signal,
			deadlineMs: relayDeadline(),
		});
		const reverse = await target.factory("source", f.identities.source.expectedPin).open({
			signal: new AbortController().signal,
			deadlineMs: relayDeadline(),
		});
		const state = source as unknown as {
			socket: WebSocket;
			routes: Map<string, { side: string }>;
		};
		const session = [...state.routes].find(([, route]) => route.side === "source")?.[0];
		const index = wire.mock.calls.findIndex(
			([data]) =>
				typeof data === "string" && data.includes('"REGISTERED"') && data.includes('"source"'),
		);
		const relaySocket = wire.mock.contexts[index];
		if (!session || !relaySocket) throw new Error("Missing forward route or relay socket");
		wire.mockImplementation(function (this: WebSocket, ...args: Parameters<typeof send>) {
			const result = send.apply(this, args);
			if (
				this === relaySocket &&
				args[0] instanceof Uint8Array &&
				decodeRelayDataFrame(args[0]).sessionId === session
			)
				forwarded.resolve();
			return result;
		});
		const delivered = vi.fn();
		const response = createPeerHttpExecutor({ factory: { open: async () => owner } })(
			"GET",
			"https://peer.invalid/cancelled",
		);
		const rejected = expect(response).rejects.toThrow();
		await entered.promise;
		owner.duplex.on("data", delivered);
		const socket = state.socket;
		socket.pause();
		cleanups.push(async () => socket.resume());
		// Act: DATA is already forwarded, but local cancellation removes its route before receive.
		release.resolve();
		await forwarded.promise;
		abort.abort();
		await rejected;
		await expect(owner.completion).rejects.toThrow();
		expect(state.routes.has(session)).toBe(false);
		socket.resume();
		// Assert: cancelled plaintext never reaches the app, and the unrelated route still works.
		const result = createPeerHttpExecutor({ factory: { open: async () => reverse } })(
			"GET",
			"https://peer.invalid/reverse",
		);
		expect(delivered).not.toHaveBeenCalled();
		await expect(result).resolves.toEqual([200, { reverse: true }]);
		await expect(reverse.completion).resolves.toBeUndefined();
	}, 10000);
});

describe("relay peer retired session capacity", () => {
	it.each(["DATA", "ACCEPTED"])(
		"ignores crossed %s without evicting old IDs or recycling a busy socket",
		async (type) => {
			// Arrange: keep a reverse exchange alive while retiring the forward route at the cap.
			const f = await fixture();
			const wire = vi.spyOn(WebSocket.prototype, "send");
			const source = f.client("source", {
				onInbound: async (_connection, context) =>
					context.serve({
						origin: "https://peer.invalid",
						dispatch: async () => ({ status: 200, bodyBytes: Buffer.from("{}") }),
					}),
			});
			const target = f.client("target", { onInbound: async (connection) => connection.completion });
			await target.connect(new AbortController().signal, relayDeadline());
			const forward = await source.factory("target", f.identities.target.expectedPin).open({
				signal: new AbortController().signal,
				deadlineMs: relayDeadline(),
			});
			const reverse = await target.factory("source", f.identities.source.expectedPin).open({
				signal: new AbortController().signal,
				deadlineMs: relayDeadline(),
			});
			const state = source as unknown as {
				socket: WebSocket;
				routes: Map<string, { side: string }>;
				retiredRoutes: Set<string>;
			};
			const session = [...state.routes].find(([, route]) => route.side === "source")?.[0];
			const index = wire.mock.calls.findIndex(
				([data]) =>
					typeof data === "string" && data.includes('"REGISTERED"') && data.includes('"source"'),
			);
			const relaySocket = wire.mock.contexts[index];
			if (!session || !relaySocket) throw new Error("Missing forward route or relay socket");
			const socket = state.socket;
			const oldest = "0".repeat(32);
			// Model earlier sessions without thousands of Noise handshakes.
			for (let id = 0; id < 4094; id++) state.retiredRoutes.add(id.toString(16).padStart(32, "0"));
			// Act: retire one route, then deliver frames that crossed its cancellation.
			await forward.dispose(new Error("Local cancellation"));
			expect(state.retiredRoutes.has(session)).toBe(true);
			expect(state.retiredRoutes.size).toBe(4095);
			await expect(
				source.factory("target", f.identities.target.expectedPin).open({
					signal: new AbortController().signal,
					deadlineMs: relayDeadline(),
				}),
			).rejects.toThrow("capacity exhausted");
			const received = once(socket, "message");
			relaySocket.send(
				type === "ACCEPTED"
					? JSON.stringify({ v: 1, type: "ACCEPTED", session, body: {} })
					: encodeRelayDataFrame({ sessionId: oldest, payload: Buffer.from("cancelled bytes") }),
			);
			await received;
			// Assert: history and the unrelated route survive until that last exchange completes.
			expect(state.retiredRoutes.has(oldest)).toBe(true);
			expect(state.retiredRoutes.has(session)).toBe(true);
			expect(socket.readyState).toBe(WebSocket.OPEN);
			expect(reverse.duplex.destroyed).toBe(false);
			const closed = once(socket, "close");
			const relayClosed = once(relaySocket, "close");
			await expect(
				createPeerHttpExecutor({ factory: { open: async () => reverse } })(
					"GET",
					"https://peer.invalid/at-cap",
				),
			).resolves.toEqual([200, {}]);
			await expect(reverse.completion).resolves.toBeUndefined();
			await closed;
			await relayClosed;
			expect(state.routes.size).toBe(0);
			expect(state.retiredRoutes.size).toBe(0);
			// Replenish the fixture's two-upgrade address burst without a real-time sleep.
			const runtime = f.runtime as unknown as { addresses: Map<string, { tokens: number }> };
			for (const allowance of runtime.addresses.values()) allowance.tokens = 1;
			await source.connect(new AbortController().signal, relayDeadline());
			expect(state.socket).not.toBe(socket);
			expect(state.socket.readyState).toBe(WebSocket.OPEN);
			expect(state.retiredRoutes.size).toBe(0);
		},
		10000,
	);
});

describe("relay peer active route cleanup", () => {
	it("rejects unknown-session DATA instead of delivering it to an authenticated application", async () => {
		// Arrange: retain one real authenticated connection without sending an HTTP request.
		const f = await fixture();
		const wire = vi.spyOn(WebSocket.prototype, "send");
		const target = f.client("target", { onInbound: async (connection) => connection.completion });
		const source = f.client("source");
		await target.connect(new AbortController().signal, relayDeadline());
		const owner = await source
			.factory("target", f.identities.target.expectedPin)
			.open({ signal: new AbortController().signal, deadlineMs: relayDeadline() });
		const index = wire.mock.calls.findIndex(
			([data]) =>
				typeof data === "string" && data.includes('"REGISTERED"') && data.includes('"source"'),
		);
		const socket = wire.mock.contexts[index];
		if (!socket) throw new Error("Missing source relay socket");
		const closed = once(socket, "close");
		// Act.
		socket.send(
			encodeRelayDataFrame({
				sessionId: "0".repeat(32),
				payload: Buffer.from("unauthenticated marker"),
			}),
		);
		// Assert.
		await expect(owner.completion).rejects.toThrow();
		await closed;
		expect(owner.duplex.readableLength).toBe(0);
	}, 10000);

	it("allows only one active source route and one waiting attempt per peer, then cancels the waiter", async () => {
		// Arrange.
		const f = await fixture();
		const target = f.client("target", { onInbound: async (connection) => connection.completion });
		const source = f.client("source");
		await target.connect(new AbortController().signal, relayDeadline());
		const factory = source.factory("target", f.identities.target.expectedPin);
		const owner = await factory.open({
			signal: new AbortController().signal,
			deadlineMs: relayDeadline(),
		});
		const abort = new AbortController();
		const waiting = factory.open({ signal: abort.signal, deadlineMs: relayDeadline() });
		// Act.
		const excess = factory.open({
			signal: new AbortController().signal,
			deadlineMs: relayDeadline(),
		});
		// Assert.
		await expect(excess).rejects.toThrow("capacity exhausted");
		abort.abort();
		await expect(waiting).rejects.toThrow("cancelled or expired");
		expect(
			f.checks.filter(({ packet }) => decodeRelayCheckPacket(packet).kind === "admission"),
		).toHaveLength(3);
		await owner.dispose(new Error("Acceptance test complete"));
	}, 10000);
});

describe("relay peer pair pacing", () => {
	it.each(["cancel", "expire"])(
		"settles a %s during pacing without new admission proofs, OPEN or DATA",
		async (mode) => {
			// Arrange: a completed real exchange starts the client's six-second pair interval.
			const f = await fixture();
			const wire = vi.spyOn(WebSocket.prototype, "send");
			const completions: Promise<void>[] = [];
			const target = f.client("target", {
				onInbound: async (connection, context) => {
					completions.push(connection.completion);
					await context.serve({
						origin: "https://peer.invalid",
						dispatch: async () => ({ status: 200, bodyBytes: Buffer.from("{}") }),
					});
				},
			});
			const source = f.client("source");
			await target.connect(new AbortController().signal, relayDeadline());
			const factory = source.factory("target", f.identities.target.expectedPin);
			await createPeerHttpExecutor({ factory })("GET", "https://peer.invalid/first");
			await Promise.all(completions);
			const previousChecks = f.checks.length,
				previousWrites = wire.mock.calls.length;
			const abort = new AbortController();
			// Act: retain the original short deadline and cancel only after registration has yielded to pacing.
			const opening = factory.open({ signal: abort.signal, deadlineMs: performance.now() + 500 });
			const rejected = expect(opening).rejects.toThrow(/cancelled|expired/);
			await nextTurn();
			if (mode === "cancel") abort.abort();
			await rejected;
			// Assert: cleanup may send CLOSE, but the second route never starts authentication or application I/O.
			expect(f.checks).toHaveLength(previousChecks);
			for (const [message] of wire.mock.calls.slice(previousWrites)) {
				expect(message).not.toBeInstanceOf(Uint8Array);
				if (typeof message === "string") expect(JSON.parse(message).type).not.toBe("OPEN");
			}
			expect(f.runtime.counters().routes).toBe(0);
		},
		10000,
	);

	it("paces two honest sources within the shared real-clock pair quota", async () => {
		// Arrange: both directions use actual clients, Noise, admission and native SQLite quota time.
		const f = await fixture();
		const onInbound: RelayPeerClientOptions["onInbound"] = async (_connection, context) =>
			context.serve({
				origin: "https://peer.invalid",
				dispatch: async () => ({ status: 200, bodyBytes: Buffer.from("{}") }),
			});
		const source = f.client("source", { onInbound }),
			target = f.client("target", { onInbound });
		await Promise.all([
			source.connect(new AbortController().signal, relayDeadline()),
			target.connect(new AbortController().signal, relayDeadline()),
		]);
		const forward = createPeerHttpExecutor({
			factory: source.factory("target", f.identities.target.expectedPin),
		});
		const reverse = createPeerHttpExecutor({
			factory: target.factory("source", f.identities.source.expectedPin),
		});
		// Act: the second round must wait rather than exhaust the pair's two-token burst.
		const first = await Promise.all([
			forward("GET", "https://peer.invalid/first"),
			reverse("GET", "https://peer.invalid/first"),
		]);
		const second = await Promise.all([
			forward("GET", "https://peer.invalid/second"),
			reverse("GET", "https://peer.invalid/second"),
		]);
		// Assert: each direction checks admission at least six real seconds apart and all exchanges complete.
		expect([...first, ...second]).toEqual([
			[200, {}],
			[200, {}],
			[200, {}],
			[200, {}],
		]);
		for (const device of ["source", "target"]) {
			const times = f.checks.flatMap(({ packet }, index) => {
				const decoded = decodeRelayCheckPacket(packet);
				return decoded.kind === "admission" &&
					decoded.value.role === "source" &&
					decoded.value.sourceDeviceId === device
					? [f.checkTimes[index] ?? 0]
					: [];
			});
			expect(times).toHaveLength(2);
			expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(6000);
		}
		expect(f.runtime.counters().routes).toBe(0);
	}, 20000);
});

it("keeps an unrelated live Noise route and shared renewal alive when the first maintenance caller cancels", async () => {
	// Arrange: age only the relay's registration clock before opening the fresh live route.
	// The private client expiry tweak models its renewal window without changing UTC, SQLite or Noise clocks.
	let elapsed = 0,
		holdRenewal = false;
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const f = await fixture({
		monotonicMs: () => performance.now() + elapsed,
		beforeCheck: async ({ packet }) => {
			const decoded = decodeRelayCheckPacket(packet);
			if (holdRenewal && decoded.kind === "registration" && decoded.value.deviceId === "source") {
				entered.resolve();
				await release.promise;
			}
		},
	});
	cleanups.push(async () => release.resolve());
	const target = f.client("target", {
		onInbound: async (_connection, context) =>
			context.serve({
				origin: "https://peer.invalid",
				dispatch: async () => ({ status: 200, bodyBytes: Buffer.from("{}") }),
			}),
	});
	const source = f.client("source");
	await Promise.all([
		source.connect(new AbortController().signal, relayDeadline()),
		target.connect(new AbortController().signal, relayDeadline()),
	]);
	elapsed = 750200;
	const owner = await source
		.factory("target", f.identities.target.expectedPin)
		.open({ signal: new AbortController().signal, deadlineMs: relayDeadline() });
	(source as unknown as { registrationExpires: number }).registrationExpires =
		performance.now() + 149000;
	holdRenewal = true;
	const abort = new AbortController();
	const first = source.maintainRegistration(abort.signal, performance.now() + 3000);
	const cancelled = expect(first).rejects.toThrow(/cancelled|expired/);
	await entered.promise;
	const shared = source.maintainRegistration(new AbortController().signal, relayDeadline());
	void shared.catch(() => {});
	let routeEnded = false;
	void owner.completion.then(
		() => {
			routeEnded = true;
		},
		() => {
			routeEnded = true;
		},
	);
	// Act: the first caller owns only its wait, not the shared renewal or the existing route.
	abort.abort();
	await cancelled;
	await nextTurn();
	// Assert: another waiter finishes renewal, then the original authenticated route completes HTTP normally.
	expect(routeEnded).toBe(false);
	expect(owner.duplex.destroyed).toBe(false);
	release.resolve();
	await shared;
	const result = await createPeerHttpExecutor({ factory: { open: async () => owner } })(
		"GET",
		"https://peer.invalid/after-renewal",
	);
	expect(result).toEqual([200, {}]);
	await expect(owner.completion).resolves.toBeUndefined();
}, 10000);
