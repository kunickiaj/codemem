import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeRelayControl } from "./relay-control-codec.js";
import {
	bytes,
	control,
	data,
	deferred,
	finiteLimits,
	SESSION,
	serverFixture,
	settle,
	terminal,
} from "./relay-server-test-fixtures.js";

let f: Awaited<ReturnType<typeof serverFixture>>;
beforeEach(async () => {
	vi.useFakeTimers();
	f = await serverFixture();
});
afterEach(() => {
	f.dispose();
	vi.useRealTimers();
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
