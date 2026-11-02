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
	SESSION,
	serverFixture,
	settle,
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
const terminal = (socket: ReturnType<typeof fakeSocket>) =>
	socket.texts.filter((m) => m.type === "CLOSE" || m.type === "REJECTED");

async function grantAndDrain(
	grants: ReturnType<typeof deferred<void>>[],
	receiver: ReturnType<typeof fakeSocket>,
) {
	for (let refill = 0; refill < 3; refill++) {
		for (const grant of grants.splice(0)) grant.resolve();
		await settle();
		while (receiver.callbacks.length) receiver.written();
		await settle();
	}
}

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

describe("strict state and OPEN schemas", () => {
	it.each(["SERVICE_PROOF", "SOCKET_CHALLENGE", "REGISTERED", "ACCEPTED"])(
		"rejects wrong client control direction %s before registration",
		async (type) => {
			// Arrange
			const socket = f.adopt();
			const body: Record<string, unknown> = {
				SERVICE_PROOF: {
					keyId: f.service.keyId,
					issuedAt: 110,
					expiresAt: 140,
					signature: Buffer.alloc(64).toString("base64"),
				},
				SOCKET_CHALLENGE: {},
				REGISTERED: {
					deviceId: "source",
					keyId: f.source.keyId,
					authorityId: f.options.namespace.authorityId,
					realmId: "a".repeat(64),
					remainingMs: 900000,
				},
				ACCEPTED: {},
			};
			// Act
			await socket.events.text(
				bytes(JSON.stringify({ v: 1, type, session: SESSION, body: body[type] })),
			);
			// Assert
			expect(socket.close).toHaveBeenCalledOnce();
			expect(f.coordinator.check).not.toHaveBeenCalled();
		},
	);
	it.each(["roles", "nonce", "session", "target", "digest"])(
		"rejects OPEN %s disagreement before coordinator or quota",
		async (change) => {
			// Arrange
			const a = await f.register(),
				open = await f.openPacket();
			const quotaCalls = f.quota.reserve.mock.calls.length;
			const other = await f.openPacket(
				change === "target" ? { targetDeviceId: "other" } : { messageADigest: "0".repeat(64) },
			);
			if (change === "roles") open.body = { checks: [open.body.checks[1], open.body.checks[0]] };
			if (change === "nonce")
				open.body = {
					checks: [
						open.body.checks[0],
						{ ...open.body.checks[1], nonce: open.body.checks[0].nonce },
					],
				};
			if (change === "session") open.session = "0".repeat(32);
			if (change === "target" || change === "digest")
				open.body = { checks: [open.body.checks[0], other.body.checks[1]] };
			// Act
			await a.events.text(bytes(JSON.stringify(open)));
			// Assert
			expect(a.close).toHaveBeenCalledOnce();
			expect(f.coordinator.check).toHaveBeenCalledTimes(1);
			expect(f.quota.reserve).toHaveBeenCalledTimes(quotaCalls);
		},
	);
	it("preserves an admitted route on an active session collision", async () => {
		// Arrange
		const { a, b, open } = await f.route();
		// Act
		await a.events.text(bytes(encodeRelayControl(open)));
		a.events.binary(data());
		await settle();
		// Assert
		expect(f.server.counters().routes).toBe(1);
		expect(b.binaries).toEqual([data()]);
		expect(a.texts.some((m) => m.type === "REJECTED")).toBe(true);
	});
	it.each(["denied", "unknown"] as const)(
		"denies OPEN quota %s before coordinator or target delivery",
		async (status) => {
			// Arrange
			const a = await f.register(),
				b = await f.register("target"),
				open = await f.openPacket();
			const original = f.quota.reserve.getMockImplementation();
			if (!original) throw new Error("Missing quota fixture");
			f.quota.reserve.mockImplementation(async (request, signal) =>
				request.purpose === "open" ? status : original(request, signal),
			);
			// Act
			await a.events.text(bytes(encodeRelayControl(open)));
			// Assert
			expect(f.coordinator.check).toHaveBeenCalledTimes(2);
			expect(b.texts.some((m) => m.type === "OPEN")).toBe(false);
			expect(a.texts.at(-1)?.type).toBe("REJECTED");
		},
	);
	it("does not deliver DATA for an unrelated session", async () => {
		// Arrange
		const { a, b } = await f.route();
		// Act
		a.events.binary(data(1, "0".repeat(32)));
		await settle();
		// Assert
		expect(b.binaries).toHaveLength(0);
		expect(f.quota.reserve.mock.calls.some(([request]) => request.purpose === "traffic")).toBe(
			false,
		);
	});
});

describe("bounded asynchronous lifecycle", () => {
	it("returns generic rejection when the route expires before target acceptance", async () => {
		// Arrange
		const { a } = await f.route({ accepted: false });
		// Act
		f.clock.now = 45000;
		await vi.advanceTimersByTimeAsync(45000);
		// Assert
		expect(terminal(a)).toEqual([{ v: 1, type: "REJECTED", session: SESSION, body: {} }]);
		expect(f.server.counters().routes).toBe(0);
	});
	it("ignores a late positive OPEN decision after source disconnect", async () => {
		// Arrange
		const a = await f.register(),
			b = await f.register("target"),
			open = await f.openPacket();
		const reply = await f.coordinator.check({
				packet: open.body.checks[0],
				deviceHeader: "source",
				signal: new AbortController().signal,
			}),
			pending = deferred<Uint8Array>();
		f.coordinator.check.mockImplementationOnce(() => pending.promise);
		const opening = a.events.text(bytes(encodeRelayControl(open)));
		await settle();
		// Act
		a.events.closed();
		pending.resolve(reply);
		await opening;
		// Assert
		expect(b.texts.some((m) => m.type === "OPEN")).toBe(false);
		expect(f.server.counters()).toMatchObject({ sockets: 1, routes: 0 });
	});
	it("closes registration at its 30-second challenge deadline despite a late positive reply", async () => {
		// Arrange
		const a = f.adopt(),
			request = await f.registration(a),
			pending = deferred<Uint8Array>();
		const reply = await f.coordinator.check({
			packet: request.body,
			deviceHeader: "source",
			signal: new AbortController().signal,
		});
		f.coordinator.check.mockImplementationOnce(() => pending.promise);
		const registering = control(a.events, "REGISTER", request.body, request.session);
		await settle();
		// Act
		f.clock.now = 30000;
		pending.resolve(reply);
		await registering;
		// Assert
		expect(a.close).toHaveBeenCalledOnce();
		expect(a.texts.some((m) => m.type === "REGISTERED")).toBe(false);
	});
	it("cancels a timed-out coordinator request and never forwards OPEN", async () => {
		// Arrange
		const a = await f.register(),
			b = await f.register("target"),
			open = await f.openPacket();
		f.coordinator.check.mockImplementationOnce(() => new Promise(() => {}));
		const opening = a.events.text(bytes(encodeRelayControl(open)));
		await settle();
		const request = f.coordinator.check.mock.calls.at(-1)?.[0];
		// Act
		f.clock.now = 5000;
		await vi.advanceTimersByTimeAsync(5000);
		await opening;
		// Assert
		expect(request?.signal.aborted).toBe(true);
		expect(b.texts.some((m) => m.type === "OPEN")).toBe(false);
		expect(a.texts.at(-1)?.type).toBe("REJECTED");
		expect(f.server.counters().routes).toBe(0);
	});
	it("keeps buffered bytes and physical capacity charged after logical abort until closure", async () => {
		// Arrange
		const { a, b } = await f.route();
		a.events.binary(data(100));
		await settle();
		// Act
		f.server.close();
		const closing = f.server.counters();
		a.events.closed();
		b.events.closed();
		// Assert
		expect(closing).toMatchObject({ sockets: 2, routes: 0, queuedBytes: 122 });
		expect(f.server.counters()).toMatchObject({ sockets: 0, routes: 0, queuedBytes: 0 });
	});
});

describe("OPEN binding and admission", () => {
	it("forwards exact envelopes only after its independent positive relay decision", async () => {
		// Arrange
		const { a, b, open } = await f.route({ accepted: false });
		// Act
		await control(b.events, "ACCEPTED");
		// Assert
		expect(b.texts.at(-1)).toEqual(open);
		expect(a.texts.at(-1)).toEqual({ v: 1, type: "ACCEPTED", session: SESSION, body: {} });
		expect(f.coordinator.check.mock.calls.at(-1)?.[0]).toMatchObject({
			packet: open.body.checks[0],
			deviceHeader: "source",
		});
	});
	it.each([
		"sourceKeyId",
		"sourceDeviceId",
		"targetKeyId",
		"authorityId",
		"groupId",
		"relayAudienceId",
	])("rejects mismatched %s", async (field) => {
		// Arrange
		const a = await f.register(),
			b = await f.register("target");
		const value =
			field.endsWith("Id") && field !== "sourceDeviceId" && field !== "groupId"
				? "0".repeat(64)
				: "other";
		const open = await f.openPacket({ [field]: value });
		// Act
		await a.events.text(bytes(encodeRelayControl(open)));
		// Assert
		expect(a.texts.at(-1)?.type).toBe("REJECTED");
		expect(b.texts.some((m) => m.type === "OPEN")).toBe(false);
		expect(f.server.counters().routes).toBe(0);
	});
	it("reserves a route slot before any asynchronous quota or coordinator work and preserves collisions", async () => {
		// Arrange
		const a = await f.register();
		await f.register("target");
		const open = await f.openPacket(),
			pending = deferred<"reserved">();
		f.quota.reserve.mockImplementationOnce(() => pending.promise);
		// Act
		const opening = a.events.text(bytes(encodeRelayControl(open)));
		const reserved = f.server.counters().routes;
		await a.events.text(bytes(encodeRelayControl(open)));
		pending.resolve("reserved");
		await opening;
		// Assert
		expect(reserved).toBe(1);
		expect(f.server.counters().routes).toBe(1);
		expect(a.close).not.toHaveBeenCalled();
		expect(a.texts.some((m) => m.type === "REJECTED")).toBe(true);
	});
	it.each(["offline", "denial", "null"])(
		"returns generic rejection for target/coordinator %s",
		async (kind) => {
			// Arrange
			const a = await f.register(),
				open = await f.openPacket();
			if (kind !== "offline") {
				await f.register("target");
				f.coordinator.check.mockResolvedValueOnce(
					kind === "null" ? (null as never) : bytes('{"v":1,"eligible":false}'),
				);
			}
			// Act
			await a.events.text(bytes(encodeRelayControl(open)));
			// Assert
			expect(a.texts.at(-1)).toEqual({ v: 1, type: "REJECTED", session: SESSION, body: {} });
			expect(f.server.counters().routes).toBe(0);
		},
	);
	it("rejects source ACCEPTED and never authorizes DATA", async () => {
		// Arrange
		const { a, b } = await f.route({ accepted: false });
		// Act
		await control(a.events, "ACCEPTED");
		a.events.binary(data());
		await settle();
		// Assert
		expect(f.server.counters().routes).toBe(0);
		expect(b.binaries).toHaveLength(0);
		expect(terminal(b).at(-1)).toMatchObject({ type: "CLOSE", body: { mode: "abort" } });
	});
});

describe("multiplexed route controls", () => {
	it("fails closed when queued route controls exceed deviceRoutes plus one", async () => {
		// Arrange
		const { a } = await f.route(),
			gate = deferred<"reserved">();
		const calls = f.quota.reserve.mock.calls.length;
		f.quota.reserve.mockImplementationOnce(() => gate.promise);
		const first = control(a.events, "CLOSE", { mode: "end" });
		await settle();
		// Act
		const queued = Array.from({ length: finiteLimits.deviceRoutes + 1 }, (_, index) =>
			control(a.events, "CLOSE", { mode: "end" }, index.toString(16).padStart(32, "0")),
		);
		await settle();
		gate.resolve("reserved");
		await Promise.all([first, ...queued]);
		// Assert
		expect(a.close).toHaveBeenCalledOnce();
		expect(f.server.counters()).toMatchObject({ sockets: 2, routes: 0 });
		expect(f.quota.reserve).toHaveBeenCalledTimes(calls + 1);
	});
	it("still denies concurrent preregistration service controls", async () => {
		// Arrange
		const socket = f.adopt(),
			gate = deferred<"reserved">(),
			body = { audienceId: f.options.namespace.relayAudienceId };
		f.quota.reserve.mockImplementationOnce(() => gate.promise);
		const first = control(socket.events, "SERVICE_CHALLENGE", body);
		await settle();
		// Act
		await control(socket.events, "SERVICE_CHALLENGE", body);
		gate.resolve("reserved");
		await first;
		// Assert
		expect(socket.close).toHaveBeenCalledOnce();
		expect(f.service.sign).not.toHaveBeenCalled();
		expect(f.coordinator.check).not.toHaveBeenCalled();
	});
	it("accepts the opposite route while its own OPEN coordinator check is pending", async () => {
		// Arrange
		const { a, b } = await f.route({ accepted: false }),
			reverseId = "2".repeat(32);
		const reverse = await f.openPacket(
			{
				sourceDeviceId: "target",
				sourceKeyId: f.target.keyId,
				targetDeviceId: "source",
				targetKeyId: f.source.keyId,
			},
			reverseId,
		);
		const gate = deferred<void>(),
			original = f.coordinator.check.getMockImplementation();
		if (!original) throw new Error("Missing coordinator fixture");
		f.coordinator.check.mockImplementationOnce(async (request) => {
			await gate.promise;
			return original(request);
		});
		const opening = b.events.text(bytes(encodeRelayControl(reverse)));
		await settle();
		// Act
		await control(b.events, "ACCEPTED");
		// Assert: this succeeds before releasing B's independent OPEN check.
		expect(b.close).not.toHaveBeenCalled();
		expect(a.texts.at(-1)).toMatchObject({ type: "ACCEPTED", session: SESSION });
		gate.resolve();
		await opening;
		expect(a.texts.at(-1)).toEqual(reverse);
		await control(a.events, "ACCEPTED", {}, reverseId);
		expect(b.texts.at(-1)).toMatchObject({ type: "ACCEPTED", session: reverseId });
		expect(f.server.counters()).toMatchObject({ sockets: 2, routes: 2 });
	});
	it("queues ACCEPTED and CLOSE for another route behind one pending control reservation", async () => {
		// Arrange
		const { a, b } = await f.route(),
			reverseId = "2".repeat(32);
		const reverse = await f.openPacket(
			{
				sourceDeviceId: "target",
				sourceKeyId: f.target.keyId,
				targetDeviceId: "source",
				targetKeyId: f.source.keyId,
			},
			reverseId,
		);
		await b.events.text(bytes(encodeRelayControl(reverse)));
		const gate = deferred<"reserved">();
		const quotaCalls = f.quota.reserve.mock.calls.length;
		f.quota.reserve.mockImplementationOnce(() => gate.promise);
		const firstEnd = control(a.events, "CLOSE", { mode: "end" });
		await settle();
		// Act
		const accepted = control(a.events, "ACCEPTED", {}, reverseId);
		const secondEnd = control(a.events, "CLOSE", { mode: "end" }, reverseId);
		await settle();
		// Assert
		expect(a.close).not.toHaveBeenCalled();
		expect(f.quota.reserve).toHaveBeenCalledTimes(quotaCalls + 1);
		gate.resolve("reserved");
		await Promise.all([firstEnd, accepted, secondEnd]);
		expect(b.texts.filter((m) => m.type === "ACCEPTED" || m.type === "CLOSE")).toEqual([
			{ v: 1, type: "CLOSE", session: SESSION, body: { mode: "end" } },
			{ v: 1, type: "ACCEPTED", session: reverseId, body: {} },
			{ v: 1, type: "CLOSE", session: reverseId, body: { mode: "end" } },
		]);
		expect(f.server.counters()).toMatchObject({ sockets: 2, routes: 2 });
	});
});

describe("opaque DATA, pressure, and terminal cleanup", () => {
	it("preserves exact binary frames in order in both directions", async () => {
		// Arrange
		const { a, b } = await f.route(),
			frames = [data(5, SESSION, 0), data(2, SESSION, 255)] as const;
		// Act
		a.events.binary(frames[0]);
		await settle();
		a.events.binary(frames[1]);
		b.events.binary(data(3));
		await settle();
		// Assert
		expect(b.binaries).toEqual(frames);
		expect(a.binaries).toEqual([data(3)]);
		expect(
			f.quota.reserve.mock.calls
				.filter(([r]) => r.purpose === "traffic")
				.every(([r]) => r.units > 0 && r.units <= 256 * 1024),
		).toBe(true);
	});
	it("aborts DATA before ACCEPTED", async () => {
		// Arrange
		const { a, b } = await f.route({ accepted: false });
		// Act
		a.events.binary(data());
		await settle();
		// Assert
		expect(b.binaries).toHaveLength(0);
		expect(f.server.counters().routes).toBe(0);
	});
	it("disconnects a socket that sends another route's DATA", async () => {
		// Arrange
		const { b } = await f.route(),
			intruder = await f.register("third");
		// Act
		intruder.events.binary(data());
		await settle();
		// Assert
		expect(intruder.close).toHaveBeenCalledOnce();
		expect(b.binaries).toHaveLength(0);
	});
	it("pauses and retains a bounded FIFO burst during one traffic reservation", async () => {
		// Arrange
		const { a, b } = await f.route(),
			pending = deferred<"reserved">(),
			frames = [data(100, SESSION, 1), data(200, SESSION, 2), data(300, SESSION, 3)];
		f.quota.reserve.mockImplementationOnce(() => pending.promise);
		// Act
		for (const frame of frames) a.events.binary(frame);
		await settle();
		const held = f.server.counters().queuedBytes;
		// Assert: parsed frames remain charged, with only one quota request in flight.
		expect(held).toBe(frames.reduce((total, frame) => total + frame.length, 0));
		expect(a.pauseInput).toHaveBeenCalled();
		expect(b.binaries).toHaveLength(0);
		expect(f.server.counters().routes).toBe(1);
		expect(f.quota.reserve.mock.calls.filter(([r]) => r.purpose === "traffic")).toHaveLength(1);
		pending.resolve("reserved");
		await settle();
		expect(b.binaries).toEqual(frames);
		expect(f.server.counters().queuedBytes).toBe(held);
		while (b.callbacks.length) b.written();
		expect(f.server.counters()).toMatchObject({ routes: 1, queuedBytes: 0 });
		expect(a.resumeInput).toHaveBeenCalled();
		expect(terminal(a).concat(terminal(b))).toHaveLength(0);
	});
	it("orders a pending end after quota, DATA, and its written callback", async () => {
		// Arrange
		const { a, b } = await f.route(),
			pending = deferred<"reserved">();
		f.quota.reserve.mockImplementationOnce(() => pending.promise);
		// Act
		a.events.binary(data());
		await settle();
		await control(a.events, "CLOSE", { mode: "end" });
		const early = terminal(b);
		pending.resolve("reserved");
		await settle();
		const beforeWritten = terminal(b);
		b.written();
		// Assert
		expect(early).toHaveLength(0);
		expect(beforeWritten).toHaveLength(0);
		expect(b.binaries).toEqual([data()]);
		expect(terminal(b).at(-1)).toMatchObject({ body: { mode: "end" } });
		expect(f.server.counters().routes).toBe(1);
	});
	it("cleans a route only after both ends and all prior writes complete", async () => {
		// Arrange
		const { a, b } = await f.route();
		a.events.binary(data());
		await settle();
		// Act
		await control(a.events, "CLOSE", { mode: "end" });
		await control(b.events, "CLOSE", { mode: "end" });
		const before = f.server.counters();
		b.written();
		// Assert
		expect(before.routes).toBe(1);
		expect(f.server.counters()).toMatchObject({ routes: 0, queuedBytes: 0 });
		expect(
			terminal(a)
				.concat(terminal(b))
				.every((m) => m.type === "CLOSE" && m.body.mode === "end"),
		).toBe(true);
	});
});

describe("traffic credit refills", () => {
	it("streams 600 KiB in parsed bursts across credit refills and orders the pending end", async () => {
		// Arrange
		const { a, b } = await f.route();
		const original = f.quota.reserve.getMockImplementation(),
			grants: ReturnType<typeof deferred<void>>[] = [];
		if (!original) throw new Error("Missing finite quota fixture");
		f.quota.reserve.mockImplementation(async (request, signal) => {
			if (request.purpose === "traffic") {
				const gate = deferred<void>();
				grants.push(gate);
				await gate.promise;
			}
			return original(request, signal);
		});
		const frames = Array.from({ length: 10 }, (_, index) => data(60 * 1024, SESSION, index));
		// Act
		for (const [start, end] of [
			[0, 3],
			[3, 6],
			[6, 10],
		] as const) {
			for (const frame of frames.slice(start, end)) a.events.binary(frame);
			await settle();
			if (end === 10) await control(a.events, "CLOSE", { mode: "end" });
			expect(f.server.counters().queuedBytes).toBeLessThanOrEqual(256 * 1024);
			expect(terminal(b)).toHaveLength(0);
			await grantAndDrain(grants, b);
		}
		// Assert
		expect(b.binaries).toEqual(frames);
		expect(f.quota.reserve.mock.calls.filter(([r]) => r.purpose === "traffic")).toHaveLength(3);
		expect(terminal(b)).toEqual([{ v: 1, type: "CLOSE", session: SESSION, body: { mode: "end" } }]);
		expect(f.server.counters()).toMatchObject({ routes: 1, queuedBytes: 0 });
		expect(a.close).not.toHaveBeenCalled();
		expect(a.resumeInput).toHaveBeenCalled();
	});
	it("aborts and releases the held FIFO once when a parsed burst exceeds 256 KiB", async () => {
		// Arrange
		const { a, b } = await f.route(),
			gate = deferred<"reserved">();
		for (let i = 0; i < 4; i++) {
			a.events.binary(data(65514));
			await settle();
			if (i < 3) b.written();
		}
		f.quota.reserve.mockImplementationOnce(() => gate.promise);
		// Act
		for (let i = 0; i < 3; i++) a.events.binary(data(65536));
		await settle();
		gate.resolve("reserved");
		await settle();
		// Assert
		expect(f.server.counters()).toMatchObject({ routes: 0, queuedBytes: 65536 });
		expect(b.binaries).toEqual(Array.from({ length: 4 }, () => data(65514)));
		b.written();
		expect(f.server.counters().queuedBytes).toBe(0);
		for (const socket of [a, b])
			expect(terminal(socket)).toEqual([
				{ v: 1, type: "CLOSE", session: SESSION, body: { mode: "abort" } },
			]);
	});
});

describe("relay failure limits", () => {
	it.each(["denied", "unknown", "timeout", "write error", "disconnect", "deadline", "after end"])(
		"aborts without EOF on %s",
		async (failure) => {
			// Arrange
			const { a, b } = await f.route();
			if (failure === "denied" || failure === "unknown")
				f.quota.reserve.mockResolvedValueOnce(failure);
			if (failure === "timeout")
				f.quota.reserve.mockImplementationOnce(() => new Promise(() => {}));
			if (failure === "after end") await control(a.events, "CLOSE", { mode: "end" });
			// Act
			a.events.binary(data());
			await settle();
			if (failure === "timeout") {
				f.clock.now = 3000;
				await vi.advanceTimersByTimeAsync(3000);
			}
			if (failure === "write error") b.written(new Error("write failed"));
			if (failure === "disconnect") b.events.closed();
			if (failure === "deadline") {
				f.clock.now = 45000;
				await vi.advanceTimersByTimeAsync(45000);
			}
			// Assert
			expect(f.server.counters().routes).toBe(0);
			expect(terminal(a).at(-1)).toMatchObject({ type: "CLOSE", body: { mode: "abort" } });
		},
	);
	it.each(["direction", "device", "realm"])(
		"enforces %s queued byte caps before retaining excess",
		async (limit) => {
			// Arrange
			if (limit !== "direction") {
				f.dispose();
				f = await serverFixture(
					limit === "device" ? { deviceQueuedBytes: 8192 } : { queuedBytes: 8192 },
				);
			}
			const { a, b } = await f.route();
			a.events.binary(data(100));
			await settle();
			b.written();
			if (limit === "direction") b.buffered = 256 * 1024;
			// Act
			a.events.binary(data(limit === "direction" ? 1 : 8192));
			await settle();
			// Assert
			expect(b.binaries).toEqual([data(100)]);
			expect(f.server.counters().routes).toBe(0);
		},
	);
	it("pauses and resumes input as observable outbound pressure drains", async () => {
		// Arrange
		const { a, b } = await f.route();
		// Act
		for (let i = 0; i < 3; i++) {
			a.events.binary(data(65536));
			await settle();
		}
		const paused = a.pauseInput.mock.calls.length;
		b.written();
		// Assert
		expect(paused).toBeGreaterThan(0);
		expect(a.resumeInput).toHaveBeenCalled();
		expect(f.server.counters().routes).toBe(1);
	});
	it.each(["frames", "bytes"])("enforces cumulative %s across both directions", async (cap) => {
		// Arrange
		const { a, b } = await f.route(),
			size = cap === "frames" ? 1 : 65536;
		const count = cap === "frames" ? 2048 : Math.floor((20 * 1024 * 1024) / (size + 22));
		// Act
		for (let i = 0; i < count; i++) {
			const sender = i % 2 ? b : a,
				receiver = i % 2 ? a : b;
			sender.events.binary(data(size));
			await settle();
			receiver.written();
		}
		const before = f.server.counters().routes;
		a.events.binary(data(size));
		await settle();
		// Assert
		expect(before).toBe(1);
		expect(f.server.counters().routes).toBe(0);
		expect(terminal(b).at(-1)).toMatchObject({ body: { mode: "abort" } });
	});
});
