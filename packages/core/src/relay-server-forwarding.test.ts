import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	control,
	data,
	deferred,
	grantAndDrain,
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
