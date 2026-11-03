import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	control,
	data,
	deferred,
	grantAndDrain,
	modelNativeBuffer,
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

describe("control text write ownership", () => {
	it("preflights unread control text when native DATA has partially drained before callbacks", async () => {
		// Arrange: native DATA can drain before its completion callback without draining control text.
		const { a, b, reverse, reverseId } = await f.oppositeRoutes();
		const native = modelNativeBuffer(b, 0, { nativeDataFraction: 0.5, retainText: true });
		for (let i = 0; i < 3; i++) {
			a.events.binary(data(65514));
			await settle();
		}
		await control(b.events, "OPEN", reverse.body, reverseId);
		// Act: the eighth DATA frame fits the cap only if pending control text is omitted.
		for (const id of [SESSION, ...Array.from({ length: 4 }, () => reverseId)]) {
			a.events.binary(data(65514, id));
			await settle();
		}
		// Assert: adapter-owned DATA plus control text must fit before another send.
		expect(native.pendingTextBytes()).toBeGreaterThan(0);
		expect(b.sendBinary).toHaveBeenCalledTimes(7);
		expect(b.buffered).toBeLessThanOrEqual(512 * 1024);
		expect(a.close).not.toHaveBeenCalled();
	});
	it("retains control text until completion and releases duplicate callbacks only once", async () => {
		// Arrange: report an empty native queue while adapter completion callbacks remain pending.
		const socket = f.adopt();
		const native = modelNativeBuffer(socket, 0, { retainText: true });
		await f.challenge(socket);
		const retained = native.pendingTextBytes();
		socket.bufferedBytes.mockReturnValue(0);
		const callback = native.textCallbacks[0];
		if (!callback) throw new Error("Missing control text callback");
		// Act
		const before = f.server.counters().queuedBytes;
		callback();
		const afterFirst = f.server.counters().queuedBytes;
		callback();
		const afterDuplicate = f.server.counters().queuedBytes;
		native.flushText();
		// Assert
		expect(retained).toBeGreaterThan(0);
		expect(before).toBe(retained);
		expect(afterFirst).toBeGreaterThan(0);
		expect(afterFirst).toBeLessThan(before);
		expect(afterDuplicate).toBe(afterFirst);
		expect(f.server.counters().queuedBytes).toBe(0);
		expect(socket.close).not.toHaveBeenCalled();
	});
	it("disconnects once when an outstanding control text write completes with an error", async () => {
		// Arrange
		const socket = f.adopt();
		const native = modelNativeBuffer(socket, 0, { retainText: true });
		await f.challenge(socket);
		const callback = native.textCallbacks[0];
		if (!callback) throw new Error("Missing control text callback");
		// Act
		callback(new Error("control write failed"));
		callback(new Error("duplicate completion"));
		// Assert
		expect(socket.close).toHaveBeenCalledOnce();
		expect(f.server.counters().sockets).toBe(1);
		socket.events.closed();
		expect(f.server.counters()).toMatchObject({ sockets: 0, queuedBytes: 0 });
	});
	it("retains a throwing control adapter's bytes until physical closure", async () => {
		// Arrange
		const socket = f.adopt();
		let retained = 0;
		let callback: ((error?: Error) => void) | undefined;
		socket.sendText.mockImplementationOnce((json, written) => {
			retained = Buffer.byteLength(json);
			callback = written;
			throw new Error("control adapter owns the text before throwing");
		});
		// Act
		await control(socket.events, "SERVICE_CHALLENGE", {
			audienceId: f.options.namespace.relayAudienceId,
		});
		const charged = f.server.counters().queuedBytes;
		socket.events.closed();
		callback?.();
		callback?.();
		// Assert
		expect(retained).toBeGreaterThan(0);
		expect(charged).toBe(retained);
		expect(socket.close).toHaveBeenCalledOnce();
		expect(f.server.counters()).toMatchObject({ sockets: 0, queuedBytes: 0 });
	});
});

describe("native buffering and device isolation", () => {
	it("does not enqueue DATA beyond the combined native control and DATA device cap", async () => {
		// Arrange: each route fits its direction cap, but the recipient also has unread controls.
		const { a, b, reverseId } = await f.oppositeRoutes();
		modelNativeBuffer(b, 600);
		const frames = [SESSION, reverseId].flatMap((id) =>
			Array.from({ length: 4 }, () => data(65514, id)),
		);
		// Act
		for (const frame of frames) {
			a.events.binary(frame);
			await settle();
		}
		// Assert: preflight must reject the eighth frame before the adapter owns it.
		expect(b.sendBinary).toHaveBeenCalledTimes(7);
		expect(b.buffered).toBe(7 * 65536 + 600);
		expect(f.server.counters()).toMatchObject({ routes: 1, queuedBytes: 7 * 65536 + 600 });
		expect(a.close).not.toHaveBeenCalled();
	});
	it("isolates an over-limit device while unrelated forwarding and service controls progress", async () => {
		// Arrange: even after close is requested, native bytes remain charged until physical closure.
		const { a, b } = await f.route();
		const slow = await f.register("third");
		slow.buffered = 512 * 1024 + 1;
		const fresh = f.adopt();
		// Act
		slow.events.binary(data(1, "0".repeat(32)));
		a.events.binary(data(5));
		await settle();
		await control(fresh.events, "SERVICE_CHALLENGE", {
			audienceId: f.options.namespace.relayAudienceId,
		});
		// Assert: the realm has room despite the other device exceeding its own allocation.
		expect(slow.close).toHaveBeenCalledOnce();
		expect(b.binaries).toEqual([data(5)]);
		expect(a.close).not.toHaveBeenCalled();
		expect(b.close).not.toHaveBeenCalled();
		expect(fresh.close).not.toHaveBeenCalled();
		expect(fresh.texts.map((m) => m.type)).toEqual(["SERVICE_PROOF", "SOCKET_CHALLENGE"]);
		expect(f.server.counters()).toMatchObject({ sockets: 4, routes: 1 });
	});
	it("releases physically closed native bytes before sending both route aborts to the peer", async () => {
		// Arrange: stale native bytes leave less realm headroom than one CLOSE message.
		f.dispose();
		f = await serverFixture({ queuedBytes: 4096 + 60 });
		const { a, b, reverseId } = await f.oppositeRoutes();
		b.buffered = 4096;
		// Act
		b.events.closed();
		// Assert: the physical closure releases its slot and bytes before peer notifications.
		expect(a.close).not.toHaveBeenCalled();
		expect(terminal(a)).toEqual([
			{ v: 1, type: "CLOSE", session: SESSION, body: { mode: "abort" } },
			{ v: 1, type: "CLOSE", session: reverseId, body: { mode: "abort" } },
		]);
		expect(f.server.counters()).toMatchObject({ sockets: 1, routes: 0, queuedBytes: 0 });
	});
});

describe("unadmitted DATA sessions", () => {
	it.each(["active", "expired"])(
		"disconnects a socket with %s registration once for repeated unknown-session DATA without spending quota",
		async (registration) => {
			// Arrange: exhausted traffic credits cannot turn unknown sessions into free discard work.
			const a = await f.register();
			const b = await f.register("target");
			f.credits.traffic = 0;
			if (registration === "expired") {
				f.clock.now = 900000;
				await vi.advanceTimersByTimeAsync(900000);
			}
			const quotaCalls = f.quota.reserve.mock.calls.length;
			const checks = f.coordinator.check.mock.calls.length;
			const responses = a.texts.length;
			// Act
			for (let i = 0; i < 3; i++) a.events.binary(data(65536, "0".repeat(32)));
			await settle();
			// Assert: logical disconnect retains the physical slot until the adapter reports closure.
			expect(a.close).toHaveBeenCalledOnce();
			expect(a.texts).toHaveLength(responses);
			expect(b.binaries).toHaveLength(0);
			expect(f.quota.reserve).toHaveBeenCalledTimes(quotaCalls);
			expect(f.coordinator.check).toHaveBeenCalledTimes(checks);
			expect(f.server.counters()).toMatchObject({ sockets: 2, routes: 0, queuedBytes: 0 });
			a.events.closed();
			expect(f.server.counters().sockets).toBe(1);
		},
	);
	it("disconnects for late DATA after clean closure and aborts another multiplexed route", async () => {
		// Arrange: the other admitted route shares the same physical sockets.
		const { a, b, reverseId } = await f.oppositeRoutes();
		await control(a.events, "CLOSE", { mode: "end" });
		await control(b.events, "CLOSE", { mode: "end" });
		const before = f.server.counters();
		const quotaCalls = f.quota.reserve.mock.calls.length;
		const checks = f.coordinator.check.mock.calls.length;
		// Act
		for (let i = 0; i < 3; i++) a.events.binary(data());
		await settle();
		// Assert: late DATA ends the physical connection even when another route is healthy.
		expect(before.routes).toBe(1);
		expect(a.close).toHaveBeenCalledOnce();
		expect(b.close).not.toHaveBeenCalled();
		expect(b.binaries).toHaveLength(0);
		expect(terminal(b)).toEqual([
			{ v: 1, type: "CLOSE", session: SESSION, body: { mode: "end" } },
			{ v: 1, type: "CLOSE", session: reverseId, body: { mode: "abort" } },
		]);
		expect(f.server.counters()).toMatchObject({ sockets: 2, routes: 0, queuedBytes: 0 });
		expect(f.quota.reserve).toHaveBeenCalledTimes(quotaCalls);
		expect(f.coordinator.check).toHaveBeenCalledTimes(checks);
	});
	it("continues admitted DATA within its original route lease after registration expires", async () => {
		// Arrange: open near registration expiry, with an independent route lease beyond it.
		const a = await f.register();
		const b = await f.register("target");
		f.clock.now = 880000;
		await vi.advanceTimersByTimeAsync(880000);
		f.refreshReadiness();
		const open = await f.openPacket({ createdAt: 990, admitBefore: 1020, routeNotAfter: 1045 });
		await control(a.events, "OPEN", open.body, open.session);
		await control(b.events, "ACCEPTED");
		const checks = f.coordinator.check.mock.calls.length;
		// Act
		f.clock.now = 900000;
		await vi.advanceTimersByTimeAsync(20000);
		a.events.binary(data(5));
		await settle();
		// Assert
		expect(b.binaries).toEqual([data(5)]);
		expect(a.close).not.toHaveBeenCalled();
		expect(b.close).not.toHaveBeenCalled();
		expect(f.server.counters().routes).toBe(1);
		expect(f.coordinator.check).toHaveBeenCalledTimes(checks);
	});
});

describe("per-direction write accounting", () => {
	it("keeps independent directions below 256 KiB alive on shared physical sockets", async () => {
		// Arrange: both routes use real, independently signed admission envelopes.
		const { a, b, reverseId } = await f.oppositeRoutes();
		const first = Array.from({ length: 3 }, (_, i) => data(65536, SESSION, i));
		const second = Array.from({ length: 2 }, (_, i) => data(65536, reverseId, i + 3));
		// Act: retain 192 KiB and 128 KiB on separate directions with the same sender/recipient.
		for (const frame of [...first, ...second]) {
			a.events.binary(frame);
			await settle();
		}
		const retained = f.server.counters();
		const delivered = [...b.binaries];
		while (b.callbacks.length) b.written();
		a.events.binary(data(1, SESSION));
		a.events.binary(data(1, reverseId));
		await settle();
		// Assert
		expect(retained).toMatchObject({ routes: 2, queuedBytes: 5 * (65536 + 22) });
		expect(delivered).toEqual([...first, ...second]);
		expect(b.binaries).toEqual([...first, ...second, data(1, SESSION), data(1, reverseId)]);
		expect(f.server.counters()).toMatchObject({ routes: 2, queuedBytes: 46 });
		expect(terminal(a).concat(terminal(b))).toHaveLength(0);
		expect(a.resumeInput).toHaveBeenCalled();
	});
	it("aborts only the direction's route when its own pending writes exceed 256 KiB", async () => {
		// Arrange
		const { a, b, reverseId } = await f.oppositeRoutes();
		const frames = Array.from({ length: 4 }, (_, i) => data(65514, SESSION, i));
		for (const frame of frames) {
			a.events.binary(frame);
			await settle();
		}
		// Act: four complete frames fill exactly 256 KiB, so one more byte exceeds it.
		a.events.binary(data(1));
		await settle();
		const afterOverflow = f.server.counters();
		while (b.callbacks.length) b.written();
		a.events.binary(data(1, reverseId));
		await settle();
		// Assert
		expect(afterOverflow).toMatchObject({ routes: 1, queuedBytes: 256 * 1024 });
		expect(terminal(a)).toEqual([
			{ v: 1, type: "CLOSE", session: SESSION, body: { mode: "abort" } },
		]);
		expect(b.binaries).toEqual([...frames, data(1, reverseId)]);
		expect(f.server.counters()).toMatchObject({ routes: 1, queuedBytes: 23 });
	});
	it("releases direction write bytes once when an adapter repeats its callback", async () => {
		// Arrange
		const { a, b } = await f.route();
		a.events.binary(data(65514));
		await settle();
		const callback = b.callbacks[0];
		if (!callback) throw new Error("Missing write callback");
		// Act
		b.written();
		callback();
		const released = f.server.counters().queuedBytes;
		for (let i = 0; i < 4; i++) {
			a.events.binary(data(65514));
			await settle();
		}
		a.events.binary(data(1));
		await settle();
		// Assert: duplicate completion must not create extra per-direction capacity.
		expect(released).toBe(0);
		expect(b.binaries).toHaveLength(5);
		expect(f.server.counters()).toMatchObject({ routes: 0, queuedBytes: 256 * 1024 });
	});
	it("retains a throwing adapter's write until physical closure and tolerates a late callback", async () => {
		// Arrange
		const { a, b } = await f.route();
		let callback: ((error?: Error) => void) | undefined;
		b.sendBinary.mockImplementationOnce((_frame, written) => {
			callback = written;
			throw new Error("adapter owns the frame before throwing");
		});
		// Act
		a.events.binary(data(100));
		await settle();
		const retained = f.server.counters();
		b.events.closed();
		callback?.();
		callback?.();
		// Assert
		expect(callback).toBeTypeOf("function");
		expect(b.close).toHaveBeenCalledOnce();
		expect(retained).toMatchObject({ routes: 0, queuedBytes: 122 });
		expect(f.server.counters()).toMatchObject({ sockets: 1, routes: 0, queuedBytes: 0 });
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
	it("enforces direction queued byte caps before retaining excess", async () => {
		// Arrange: four tracked writes fill exactly 256 KiB on one of two admitted routes.
		const { a, b } = await f.oppositeRoutes();
		const frames = [...Array.from({ length: 3 }, () => data(65536)), data(65448)];
		for (const frame of frames) {
			a.events.binary(frame);
			await settle();
		}
		const beforeOverflow = f.server.counters();
		const paused = a.pauseInput.mock.calls.length;
		// Act
		a.events.binary(data(1));
		await settle();
		// Assert: excess never reaches the adapter, and only the overflowing route aborts.
		expect(b.binaries).toEqual(frames);
		expect(beforeOverflow).toMatchObject({ routes: 2, queuedBytes: 256 * 1024 });
		expect(paused).toBeGreaterThan(0);
		expect(f.server.counters()).toMatchObject({ routes: 1, queuedBytes: 256 * 1024 });
		expect(terminal(a).concat(terminal(b))).toEqual([
			{ v: 1, type: "CLOSE", session: SESSION, body: { mode: "abort" } },
			{ v: 1, type: "CLOSE", session: SESSION, body: { mode: "abort" } },
		]);
	});
	it.each(["device", "realm"])(
		"enforces %s queued byte caps before retaining excess",
		async (limit) => {
			// Arrange
			f.dispose();
			f = await serverFixture(
				limit === "device" ? { deviceQueuedBytes: 8192 } : { queuedBytes: 8192 },
			);
			const { a, b } = await f.route();
			a.events.binary(data(100));
			await settle();
			b.written();
			// Act
			a.events.binary(data(8192));
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
