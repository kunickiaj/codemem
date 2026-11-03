import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { data, deferred, SESSION, settle } from "./relay-server-test-fixtures.js";
import { createRelayWebSocketRuntime } from "./relay-websocket-runtime.js";
import {
	heldUpgradeFixture,
	runtimeFixture,
	runtimeLimits,
} from "./relay-websocket-runtime-test-fixtures.js";

let f: Awaited<ReturnType<typeof runtimeFixture>> | undefined;
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await f?.dispose();
	f = undefined;
});

describe("loopback relay WebSocket runtime", () => {
	it("requires explicit enablement, both sets of limits, and upgrade quota", async () => {
		// Arrange
		f = await runtimeFixture({ enabled: false });
		const reserve = vi.fn(async () => "reserved" as const);
		// Act / Assert
		for (const overrides of [
			{},
			{ enabled: true },
			{ enabled: true, limits: runtimeLimits },
			{
				enabled: true,
				limits: runtimeLimits,
				relay: { ...f.options, limits: undefined },
				reserveUpgrade: reserve,
			},
		]) {
			const runtime = createRelayWebSocketRuntime({ relay: f.options, ...overrides });
			expect(runtime.server.listening).toBe(false);
			await runtime.close();
		}
		const client = f.connect();
		expect(await client.opened).toBe(false);
		await client.closed;
		expect(f.runtime.counters().sockets).toBe(0);
		expect(reserve).not.toHaveBeenCalled();
	});
	it.each(["sockets", "pendingSockets", "writeBytes"] as const)(
		"rejects invalid physical %s limits",
		async (key) => {
			// Arrange
			f = await runtimeFixture();
			const relay = f.options;
			// Act / Assert
			for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER])
				expect(() =>
					createRelayWebSocketRuntime({
						relay,
						limits: { ...runtimeLimits, [key]: value },
					}),
				).toThrow("Invalid relay WebSocket limits");
		},
	);
	it("registers signed identities, declines compression, forwards ordered DATA and directional ends", async () => {
		// Arrange
		f = await runtimeFixture();
		const { a, b } = await f.route();
		const frames = [data(65536), data(3, SESSION, 22)];
		// Act
		for (const frame of frames) a.ws.send(frame);
		a.control("CLOSE", { mode: "end" });
		// Assert
		expect(a.ws.extensions).toBe("");
		expect(b.ws.extensions).toBe("");
		for (const frame of frames)
			expect(await b.next()).toEqual({ bytes: Buffer.from(frame), binary: true });
		expect(await b.controlMessage()).toMatchObject({ type: "CLOSE", body: { mode: "end" } });
		b.ws.send(data(2, SESSION, 33));
		expect((await a.next()).bytes).toEqual(Buffer.from(data(2, SESSION, 33)));
		b.control("CLOSE", { mode: "end" });
		expect(await a.controlMessage()).toMatchObject({ type: "CLOSE", body: { mode: "end" } });
		await f.runtime.close();
		expect(f.runtime.counters()).toEqual({
			sockets: 0,
			pendingSockets: 0,
			routes: 0,
			queuedBytes: 0,
			pendingUpgrades: 0,
		});
	});
	it("rejects an offline target without creating a route", async () => {
		// Arrange
		f = await runtimeFixture();
		const a = await f.register();
		// Act
		a.ws.send(JSON.stringify(await f.openPacket()));
		// Assert
		expect(await a.controlMessage()).toMatchObject({ type: "REJECTED" });
		expect(f.runtime.counters().routes).toBe(0);
	});
	it.each(["binary", "text", "ping", "pong", "unknown-session", "malformed"])(
		"terminates %s input without forwarding it",
		async (kind) => {
			// Arrange
			f = await runtimeFixture();
			const client = await f.register();
			// Act
			if (kind === "binary") client.ws.send(Buffer.alloc(65559));
			if (kind === "text") client.ws.send(" ".repeat(4097));
			if (kind === "ping") client.ws.ping();
			if (kind === "pong") client.ws.pong();
			if (kind === "unknown-session") client.ws.send(data(1, "f".repeat(32)));
			if (kind === "malformed") client.ws.send("{}");
			await client.closed;
			await f.runtime.close();
			// Assert
			expect(f.runtime.counters().sockets).toBe(0);
			expect(f.runtime.counters().routes).toBe(0);
		},
	);
	it.each([32, 33])("enforces the fragment cap for %i fragments", async (count) => {
		// Arrange
		f = await runtimeFixture();
		const client = f.connect();
		await client.opened;
		const message = JSON.stringify({
			v: 1,
			type: "SERVICE_CHALLENGE",
			session: SESSION,
			body: { audienceId: f.options.namespace.relayAudienceId },
		});
		// Act
		for (let index = 0; index < count; index++)
			client.ws.send(index === count - 1 ? message.slice(index) : message[index], {
				fin: index === count - 1,
				binary: false,
			});
		// Assert
		if (count === 32)
			expect(await client.controlMessage()).toMatchObject({ type: "SERVICE_PROOF" });
		else {
			await client.closed;
			expect(f.service.sign).not.toHaveBeenCalled();
		}
	});
});

describe("upgrade admission and cancellation", () => {
	it.each(["denied", "unknown", "throw"])(
		"fails closed when upgrade quota is %s",
		async (status) => {
			// Arrange
			f = await runtimeFixture({
				reserveUpgrade: async () => {
					if (status === "throw") throw new Error("unavailable");
					return status as "denied";
				},
			});
			// Act
			const client = f.connect();
			await client.closed;
			// Assert
			expect(await client.opened).toBe(false);
			expect(f.runtime.counters().pendingUpgrades).toBe(0);
			expect(f.coordinator.check).not.toHaveBeenCalled();
		},
	);
	it.each(["disconnect", "disable", "timeout"])(
		"cancels stalled upgrade quota on %s",
		async (action) => {
			// Arrange
			if (action === "timeout") vi.useFakeTimers();
			const entered = deferred<AbortSignal>();
			f = await runtimeFixture({
				reserveUpgrade: (signal) => {
					entered.resolve(signal);
					return new Promise(() => {});
				},
			});
			const client = f.connect();
			const signal = await entered.promise;
			// Act
			if (action === "disconnect") client.ws.terminate();
			if (action === "disable") f.runtime.disable();
			if (action === "timeout") {
				await vi.advanceTimersByTimeAsync(3000);
				vi.useRealTimers();
			}
			await client.closed;
			await f.runtime.close();
			// Assert
			expect(signal.aborted).toBe(true);
			expect(f.runtime.counters().pendingUpgrades).toBe(0);
		},
	);
	it("limits two pending upgrades per TCP address despite different forwarding headers", async () => {
		// Arrange
		const first = deferred<AbortSignal>(),
			second = deferred<AbortSignal>();
		const entered = [first, second];
		let calls = 0;
		f = await runtimeFixture({
			reserveUpgrade: (signal) => {
				entered[calls++]?.resolve(signal);
				return new Promise(() => {});
			},
		});
		const a = f.connect({ headers: { "x-forwarded-for": "192.0.2.1" } });
		await first.promise;
		const b = f.connect({ headers: { forwarded: "for=192.0.2.2" } });
		await second.promise;
		// Act
		const c = f.connect({ headers: { "x-forwarded-for": "192.0.2.3" } });
		await c.closed;
		// Assert
		expect(await c.opened).toBe(false);
		expect(calls).toBe(2);
		expect(f.runtime.counters().pendingUpgrades).toBe(2);
		await f.runtime.close();
		await Promise.all([a.closed, b.closed]);
		expect((await first.promise).aborted).toBe(true);
	});
	it("denies a wrong upgrade path before reserving quota", async () => {
		// Arrange
		const reserveUpgrade = vi.fn(async () => "reserved" as const);
		f = await runtimeFixture({ reserveUpgrade });
		// Act
		const client = f.connect(undefined, `${f.url}?other=1`);
		await client.closed;
		// Assert
		expect(await client.opened).toBe(false);
		expect(reserveUpgrade).not.toHaveBeenCalled();
	});
});

describe("cohosted upgrade physical ownership", () => {
	it.each(["denied", "timeout", "throw"] as const)(
		"retains %s upgrades and waits for physical close",
		async (status) => {
			// Arrange: hold destroy on a real socket, without claiming native OS close timing.
			if (status === "timeout") vi.useFakeTimers();
			const held = await heldUpgradeFixture(status);
			try {
				const client = held.fixture.connect();
				await held.entered;
				if (status === "timeout") await vi.advanceTimersByTimeAsync(3000);
				await held.destroyRequested;
				await settle();
				// Act / Assert: a closing upgrade retains both pending and service capacity.
				expect(held.fixture.runtime.counters()).toMatchObject({ sockets: 0, pendingUpgrades: 1 });
				const second = held.fixture.connect();
				await second.closed;
				expect(await second.opened).toBe(false);
				expect(held.reserveUpgrade).toHaveBeenCalledTimes(1);
				let finished = false;
				const closing = held.fixture.runtime.close().then(() => {
					finished = true;
				});
				await settle();
				expect(finished).toBe(false);
				expect(held.fixture.runtime.counters().pendingUpgrades).toBe(1);
				held.release();
				await held.physicallyClosed;
				await closing;
				await client.closed;
				expect(finished).toBe(true);
				expect(held.fixture.runtime.counters().pendingUpgrades).toBe(0);
			} finally {
				vi.useRealTimers();
				await held.dispose();
			}
		},
	);
	it("transfers successful cohosted upgrades to live physical sockets", async () => {
		// Arrange
		const server = createServer((_request, response) => response.end());
		f = await runtimeFixture({ server });
		try {
			// Act
			const client = f.connect();
			expect(await client.opened).toBe(true);
			// Assert
			expect(f.runtime.counters()).toMatchObject({
				sockets: 1,
				pendingSockets: 1,
				pendingUpgrades: 0,
			});
			await f.runtime.close();
			await client.closed;
			expect(f.runtime.counters()).toMatchObject({ sockets: 0, pendingUpgrades: 0 });
		} finally {
			await f.dispose();
			f = undefined;
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		}
	});
});

describe("address admission after registration expiry", () => {
	it("admits a fresh upgrade when two registered leases expire on the same TCP address", async () => {
		// Arrange: replenish address tokens independently of the engine's registration clock.
		let now = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		f = await runtimeFixture();
		const a = await f.register(),
			b = await f.register("target");
		expect(f.runtime.counters()).toMatchObject({ sockets: 2, pendingSockets: 0 });
		// Act
		f.clock.now = 900001;
		now += 6001;
		const fresh = f.connect();
		// Assert
		expect(await fresh.opened).toBe(true);
		expect(a.ws.readyState).toBe(WebSocket.OPEN);
		expect(b.ws.readyState).toBe(WebSocket.OPEN);
		expect(f.runtime.counters()).toMatchObject({
			sockets: 3,
			pendingSockets: 1,
			pendingUpgrades: 0,
		});
	});
	it("still denies a third physical preauthentication socket after address tokens refill", async () => {
		// Arrange
		let now = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const reserveUpgrade = vi.fn(async () => "reserved" as const);
		f = await runtimeFixture({ reserveUpgrade });
		const a = f.connect();
		expect(await a.opened).toBe(true);
		const b = f.connect();
		expect(await b.opened).toBe(true);
		// Act
		now += 6001;
		const third = f.connect();
		await third.closed;
		// Assert
		expect(await third.opened).toBe(false);
		expect(reserveUpgrade).toHaveBeenCalledTimes(2);
		expect(f.runtime.counters()).toMatchObject({
			sockets: 2,
			pendingSockets: 2,
			pendingUpgrades: 0,
		});
	});
});

describe("runtime resource ownership", () => {
	it.each(["sockets", "pendingSockets"] as const)(
		"enforces the physical %s ceiling before another upgrade",
		async (limit) => {
			// Arrange
			const reserveUpgrade = vi.fn(async () => "reserved" as const);
			f = await runtimeFixture({ limits: { ...runtimeLimits, [limit]: 1 }, reserveUpgrade });
			const first = f.connect();
			expect(await first.opened).toBe(true);
			// Act
			const second = f.connect();
			await second.closed;
			// Assert
			expect(await second.opened).toBe(false);
			expect(reserveUpgrade).toHaveBeenCalledTimes(1);
			expect(f.runtime.counters()).toMatchObject({ sockets: 1, pendingSockets: 1 });
		},
	);
	it("denies later upgrades after disable while the listener is still open", async () => {
		// Arrange
		const reserveUpgrade = vi.fn(async () => "reserved" as const);
		f = await runtimeFixture({ reserveUpgrade });
		// Act
		f.runtime.disable();
		const client = f.connect();
		await client.closed;
		// Assert
		expect(await client.opened).toBe(false);
		expect(reserveUpgrade).not.toHaveBeenCalled();
	});
	it.each([
		{},
		{ enabled: true },
		{ enabled: true, limits: runtimeLimits },
		{
			enabled: true,
			limits: runtimeLimits,
			reserveUpgrade: async () => "reserved" as const,
			relayDisabled: true,
		},
	])(
		"denies actual traffic when activation prerequisites are missing (%j)",
		async (configuration) => {
			// Arrange
			f = await runtimeFixture(
				{
					enabled: undefined,
					limits: undefined,
					reserveUpgrade: undefined,
					...configuration,
				},
				configuration.relayDisabled ? { sockets: 0 } : {},
			);
			// Act
			const client = f.connect();
			await client.closed;
			// Assert
			expect(f.runtime.counters().sockets).toBe(0);
		},
	);
	it("disables active routes without waiting for coordinator progress and waits for physical cleanup", async () => {
		// Arrange
		f = await runtimeFixture();
		const { a, b } = await f.route();
		f.coordinator.check.mockImplementation(() => new Promise(() => {}));
		// Act
		f.runtime.disable();
		await f.runtime.close();
		await Promise.all([a.closed, b.closed]);
		// Assert
		expect(f.runtime.counters()).toEqual({
			sockets: 0,
			pendingSockets: 0,
			routes: 0,
			queuedBytes: 0,
			pendingUpgrades: 0,
		});
	});
	it("bounds asynchronous controls while quota is stalled", async () => {
		// Arrange
		f = await runtimeFixture();
		const entered = deferred<AbortSignal>();
		f.quota.reserve.mockImplementation((_request, signal) => {
			entered.resolve(signal);
			return new Promise(() => {});
		});
		const client = f.connect();
		await client.opened;
		client.control("SERVICE_CHALLENGE", { audienceId: f.options.namespace.relayAudienceId });
		const signal = await entered.promise;
		// Act
		for (let index = 0; index < 40; index++)
			client.control("SERVICE_CHALLENGE", { audienceId: f.options.namespace.relayAudienceId });
		await client.closed;
		// Assert
		expect(signal.aborted).toBe(true);
		expect(f.quota.reserve).toHaveBeenCalledTimes(1);
		expect(f.service.sign).not.toHaveBeenCalled();
	});
	it("limits adapter-owned writes with retained native callbacks alongside actual DATA traffic", async () => {
		// Arrange: retained callbacks model ownership, not an operating-system receive queue guarantee.
		f = await runtimeFixture({ limits: { ...runtimeLimits, writeBytes: 70000 } });
		const { a, b } = await f.route();
		const nativeSend = WebSocket.prototype.send;
		const held: ((error?: Error) => void)[] = [];
		vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
			this: WebSocket,
			chunk,
			options,
			callback,
		) {
			if (this !== a.ws && this !== b.ws && typeof options === "object" && options.binary) {
				if (callback) held.push(callback);
				nativeSend.call(this, chunk, options, () => {});
				return;
			}
			nativeSend.call(this, chunk, options, callback);
		});
		// Act
		a.ws.send(data(65536));
		expect((await b.next()).bytes).toEqual(Buffer.from(data(65536)));
		expect(held).toHaveLength(1);
		a.ws.send(data(65536));
		await b.closed;
		await f.runtime.close();
		// Assert
		expect(held).toHaveLength(1);
		expect(f.runtime.counters().queuedBytes).toBe(0);
		for (const callback of held) callback();
		expect(f.runtime.counters().queuedBytes).toBe(0);
	});
});
