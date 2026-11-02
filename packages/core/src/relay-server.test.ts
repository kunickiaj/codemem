import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeRelayControl } from "./relay-control-codec.js";
import { createRelayServer, type RelayServerLimits } from "./relay-server.js";
import {
	bytes,
	control,
	data,
	deferred,
	fakeSocket,
	finiteLimits,
	serverFixture,
	settle,
	terminal,
} from "./relay-server-test-fixtures.js";
import { relayRealmId } from "./relay-service-proof.js";

let f: Awaited<ReturnType<typeof serverFixture>>;
beforeEach(async () => {
	vi.useFakeTimers();
	f = await serverFixture();
});
afterEach(() => {
	f.dispose();
	vi.useRealTimers();
});

describe("disabled internal relay server", () => {
	it("defaults every limit to zero without invoking dependencies", () => {
		// Arrange
		const server = createRelayServer({ ...f.options, limits: undefined }),
			socket = fakeSocket();
		// Act
		const result = server.adopt(socket);
		// Assert
		expect(result).toBeNull();
		expect(server.counters()).toEqual({ sockets: 0, pendingSockets: 0, routes: 0, queuedBytes: 0 });
		expect(f.coordinator.check).not.toHaveBeenCalled();
		expect(f.quota.reserve).not.toHaveBeenCalled();
		expect(f.service.sign).not.toHaveBeenCalled();
	});
	it("adopts with explicit finite limits and releases capacity only on physical closure", () => {
		// Arrange
		const socket = f.adopt();
		// Act
		f.server.close();
		f.server.close();
		// Assert
		expect(socket.close).toHaveBeenCalledTimes(1);
		expect(f.server.counters().sockets).toBe(1);
		socket.events.closed();
		socket.events.closed();
		expect(f.server.counters().sockets).toBe(0);
		expect(f.server.adopt(fakeSocket())).toBeNull();
	});
	it.each(Object.keys(finiteLimits) as (keyof RelayServerLimits)[])(
		"rejects invalid %s limits",
		(key) => {
			// Arrange
			const invalid = [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER];
			// Act / Assert
			for (const value of invalid)
				expect(() =>
					createRelayServer({ ...f.options, limits: { ...finiteLimits, [key]: value } }),
				).toThrow("Invalid relay limits");
		},
	);
	it("bounds pending physical sockets and their setup lifetime", async () => {
		// Arrange
		const sockets = Array.from({ length: 4 }, () => f.adopt());
		// Act
		const extra = f.server.adopt(fakeSocket());
		f.clock.now = 30000;
		await vi.advanceTimersByTimeAsync(30000);
		// Assert
		expect(extra).toBeNull();
		expect(sockets.every((s) => s.close.mock.calls.length === 1)).toBe(true);
		expect(f.server.counters()).toMatchObject({ sockets: 4, pendingSockets: 4 });
		sockets[0]?.events.closed();
		expect(f.server.adopt(fakeSocket())).not.toBeNull();
	});
	it.each(["denied", "unknown", null] as const)(
		"fails closed on control quota %s",
		async (status) => {
			// Arrange
			const socket = f.adopt();
			f.quota.reserve.mockResolvedValueOnce(status as "denied");
			// Act
			await control(socket.events, "SERVICE_CHALLENGE", {
				audienceId: f.options.namespace.relayAudienceId,
			});
			// Assert
			expect(socket.close).toHaveBeenCalledOnce();
			expect(f.service.sign).not.toHaveBeenCalled();
			expect(socket.texts).toHaveLength(0);
		},
	);
	it.each([undefined, {}])("denies adoption without a quota reservation port (%j)", (quota) => {
		// Arrange
		const server = createRelayServer({ ...f.options, quota: quota as never }),
			socket = fakeSocket();
		// Act
		const events = server.adopt(socket);
		// Assert
		expect(events).toBeNull();
		expect(server.counters()).toEqual({ sockets: 0, pendingSockets: 0, routes: 0, queuedBytes: 0 });
		expect(f.service.sign).not.toHaveBeenCalled();
		expect(f.coordinator.check).not.toHaveBeenCalled();
		expect(f.quota.reserve).not.toHaveBeenCalled();
		for (const method of [
			socket.sendText,
			socket.sendBinary,
			socket.bufferedBytes,
			socket.pauseInput,
			socket.resumeInput,
			socket.close,
		])
			expect(method).not.toHaveBeenCalled();
		server.close();
	});
	it("reserves trusted realm control credits before service signing without a claimed identity", async () => {
		// Arrange
		const socket = f.adopt();
		// Act
		await f.challenge(socket);
		// Assert
		expect(f.quota.reserve).toHaveBeenCalledWith(
			{
				purpose: "control",
				realmId: relayRealmId(f.options.namespace.authorityId, f.options.namespace.groupId),
				deviceId: "",
				peerDeviceId: null,
				units: 1,
			},
			expect.any(AbortSignal),
		);
		expect(socket.texts.map((m) => m.type)).toEqual(["SERVICE_PROOF", "SOCKET_CHALLENGE"]);
		expect(f.coordinator.check).not.toHaveBeenCalled();
	});
});

describe("socket registration", () => {
	it("creates an immutable hashed realm mapping from its own real decision", async () => {
		// Arrange / Act
		const socket = await f.register();
		// Assert
		expect(socket.close).not.toHaveBeenCalled();
		expect(socket.texts.at(-1)).toMatchObject({
			type: "REGISTERED",
			body: {
				deviceId: "source",
				keyId: f.source.keyId,
				authorityId: f.options.namespace.authorityId,
				realmId: relayRealmId(f.options.namespace.authorityId, f.options.namespace.groupId),
				remainingMs: 900000,
			},
		});
		expect(f.server.counters()).toMatchObject({ sockets: 1, pendingSockets: 0, routes: 0 });
	});
	it.each(["challenge", "authority", "group", "audience", "key"])(
		"denies wrong registration %s",
		async (change) => {
			// Arrange
			const socket = f.adopt();
			const overrides = {
				challenge: { socketChallengeId: "0".repeat(32) },
				authority: { authorityId: "0".repeat(64) },
				group: { groupId: "other" },
				audience: { relayAudienceId: "0".repeat(64) },
				key: { keyId: "0".repeat(64) },
			};
			const request = await f.registration(
				socket,
				"source",
				overrides[change as keyof typeof overrides],
			);
			// Act
			await control(socket.events, "REGISTER", request.body, request.session);
			// Assert
			expect(socket.close).toHaveBeenCalledOnce();
			expect(socket.texts.some((m) => m.type === "REGISTERED")).toBe(false);
		},
	);
	it("consumes a registration challenge once", async () => {
		// Arrange
		const socket = f.adopt(),
			request = await f.registration(socket);
		await control(socket.events, "REGISTER", request.body, request.session);
		// Act
		await control(socket.events, "REGISTER", request.body, request.session);
		// Assert
		expect(socket.close).toHaveBeenCalledOnce();
		expect(f.coordinator.check).toHaveBeenCalledTimes(1);
	});
	it("does not accept a reply after challenge expiry or physical disconnect", async () => {
		// Arrange
		const socket = f.adopt(),
			request = await f.registration(socket),
			pending = deferred<Uint8Array>();
		const validReply = await f.coordinator.check({
			packet: request.body,
			deviceHeader: "source",
			signal: new AbortController().signal,
		});
		f.coordinator.check.mockImplementationOnce(() => pending.promise);
		const registering = control(socket.events, "REGISTER", request.body, request.session);
		await settle();
		// Act
		socket.events.closed();
		pending.resolve(validReply);
		await registering;
		// Assert
		expect(f.server.counters().sockets).toBe(0);
		expect(socket.texts.some((m) => m.type === "REGISTERED")).toBe(false);
	});
	it("anchors registration expiry to request start despite a slow reply", async () => {
		// Arrange
		const socket = f.adopt(),
			request = await f.registration(socket);
		const original = f.coordinator.check.getMockImplementation();
		if (!original) throw new Error("Missing coordinator fixture");
		f.coordinator.check.mockImplementationOnce(async (input) => {
			const reply = await original(input);
			f.clock.now += 2000;
			return reply;
		});
		// Act
		await control(socket.events, "REGISTER", request.body, request.session);
		// Assert
		expect(socket.texts.at(-1)).toMatchObject({
			type: "REGISTERED",
			body: { remainingMs: 898000 },
		});
		f.clock.now = 900000;
		await socket.events.text(bytes(encodeRelayControl(await f.openPacket())));
		expect(f.coordinator.check).toHaveBeenCalledTimes(1);
		expect(socket.texts.at(-1)?.type).toBe("REJECTED");
	});
	it("allows one active plus one physically closing replacement and denies a third", async () => {
		// Arrange
		const first = await f.register(),
			second = await f.register();
		// Act
		const third = await f.register();
		// Assert
		expect(first.close).toHaveBeenCalledOnce();
		expect(second.close).not.toHaveBeenCalled();
		expect(third.close).toHaveBeenCalledOnce();
		expect(f.server.counters().sockets).toBe(3);
		first.events.closed();
		const fourth = await f.register();
		expect(second.close).toHaveBeenCalledOnce();
		expect(fourth.close).not.toHaveBeenCalled();
	});
});

describe("same-socket registration renewal", () => {
	it("queues a fresh REGISTER behind an established route's pending CLOSE quota without disrupting traffic", async () => {
		// Arrange
		const a = await f.register(),
			b = await f.register("target");
		f.clock.now = 720000;
		f.refreshReadiness();
		const open = await f.openPacket({ createdAt: 830, admitBefore: 860, routeNotAfter: 885 });
		await a.events.text(bytes(encodeRelayControl(open)));
		await control(b.events, "ACCEPTED");
		const renewal = await f.registration(a, "source", { createdAt: 830, admitBefore: 860 });
		const gate = deferred<"reserved">(),
			original = f.coordinator.check.getMockImplementation();
		if (!original) throw new Error("Missing coordinator fixture");
		let endBeforeRenewal = false;
		f.coordinator.check.mockImplementationOnce(async (request) => {
			endBeforeRenewal = terminal(b).some((m) => m.type === "CLOSE" && m.body.mode === "end");
			return original(request);
		});
		f.quota.reserve.mockImplementationOnce(() => gate.promise);
		const ending = control(a.events, "CLOSE", { mode: "end" });
		await settle();
		// Act
		const registering = control(a.events, "REGISTER", renewal.body, renewal.session);
		b.events.binary(data(5));
		await settle();
		// Assert: the opposite direction progresses before the pending control receives credits.
		expect(a.close).not.toHaveBeenCalled();
		expect(b.close).not.toHaveBeenCalled();
		expect(a.binaries).toEqual([data(5)]);
		expect(f.coordinator.check).toHaveBeenCalledTimes(3);
		expect(f.server.counters().routes).toBe(1);
		gate.resolve("reserved");
		await Promise.all([ending, registering]);
		expect(endBeforeRenewal).toBe(true);
		expect(a.texts.filter((m) => m.type === "REGISTERED")).toHaveLength(2);
		expect(a.texts.at(-1)).toMatchObject({
			type: "REGISTERED",
			session: renewal.session,
			body: { deviceId: "source", keyId: f.source.keyId, remainingMs: 900000 },
		});
		expect(f.coordinator.check).toHaveBeenCalledTimes(4);
		expect(f.server.counters()).toMatchObject({ sockets: 2, routes: 1 });
		a.written();
		await control(b.events, "CLOSE", { mode: "end" });
		expect(f.server.counters()).toMatchObject({ sockets: 2, routes: 0, queuedBytes: 0 });
	});
	it("denies renewal before twelve minutes without signing or checking again", async () => {
		// Arrange
		const socket = await f.register();
		f.clock.now = 719999;
		// Act
		await control(
			socket.events,
			"SERVICE_CHALLENGE",
			{ audienceId: f.options.namespace.relayAudienceId },
			"1".repeat(32),
		);
		// Assert
		expect(socket.close).toHaveBeenCalledOnce();
		expect(f.service.sign).toHaveBeenCalledTimes(1);
		expect(f.coordinator.check).toHaveBeenCalledTimes(1);
	});
	it("renews the same identity at twelve minutes with a fresh challenge, nonce, and real decision", async () => {
		// Arrange
		const socket = await f.register();
		const initial = f.coordinator.check.mock.calls[0]?.[0].packet;
		f.clock.now = 720000;
		f.refreshReadiness();
		const renewal = await f.registration(socket, "source", { createdAt: 830, admitBefore: 860 });
		// Act
		await control(socket.events, "REGISTER", renewal.body, renewal.session);
		// Assert
		expect(socket.close).not.toHaveBeenCalled();
		expect(renewal.body.nonce).not.toBe(initial?.nonce);
		expect(renewal.session).not.toBe(
			socket.texts.find((m) => m.type === "SOCKET_CHALLENGE")?.session,
		);
		expect(socket.texts.filter((m) => m.type === "REGISTERED")).toHaveLength(2);
		expect(socket.texts.at(-1)).toMatchObject({
			type: "REGISTERED",
			body: { deviceId: "source", keyId: f.source.keyId, remainingMs: 900000 },
		});
		expect(f.coordinator.check).toHaveBeenCalledTimes(2);
		expect(f.server.counters()).toMatchObject({ sockets: 1, pendingSockets: 0, routes: 0 });
	});
	it.each(["device", "key"])(
		"denies changing the immutable %s on renewal before another coordinator check",
		async (field) => {
			// Arrange
			const socket = await f.register();
			f.clock.now = 720000;
			const change = field === "device" ? { deviceId: "third" } : { keyId: f.target.keyId };
			const renewal = await f.registration(socket, "source", {
				createdAt: 830,
				admitBefore: 860,
				...change,
			});
			// Act
			await control(socket.events, "REGISTER", renewal.body, renewal.session);
			// Assert
			expect(socket.close).toHaveBeenCalledOnce();
			expect(socket.texts.filter((m) => m.type === "REGISTERED")).toHaveLength(1);
			expect(f.coordinator.check).toHaveBeenCalledTimes(1);
			expect(f.server.counters()).toMatchObject({ sockets: 1, routes: 0 });
		},
	);
});
