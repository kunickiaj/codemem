import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TraversalFrameEncoder } from "./peer-traversal-frame.js";
import { TraversalByteStream, type TraversalByteStreamOptions } from "./peer-traversal-stream.js";
import { channelPair, flush, MemoryChannel } from "./peer-traversal-stream-test-fixtures.js";

const active: TraversalByteStream[] = [];
function setup(options: Partial<TraversalByteStreamOptions> = {}, channel = new MemoryChannel()) {
	const stream = new TraversalByteStream({
		channel,
		side: "source",
		deadlineMs: performance.now() + 50000,
		...options,
	});
	const errors: Error[] = [];
	stream.on("error", (error) => errors.push(error));
	active.push(stream);
	return { stream, channel, errors };
}
const data = (bytes = Buffer.from([42])) => new TraversalFrameEncoder().encodeData(bytes);
const end = () => new TraversalFrameEncoder().encodeEnd();

afterEach(async () => {
	for (const stream of active.splice(0)) stream.destroy(new Error("Test cleanup"));
	await flush();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("TraversalByteStream controlled message ports", () => {
	it("exchanges ordered bytes above 64 KiB in both directions with simultaneous EOF", async () => {
		// Arrange
		const [left, right] = channelPair();
		const a = setup({}, left);
		const b = setup({ side: "target" }, right);
		const payload = Buffer.from(Array.from({ length: 70001 }, (_, i) => i % 251));
		const receivedA: Buffer[] = [];
		const receivedB: Buffer[] = [];
		a.stream.on("data", (chunk: Buffer) => receivedA.push(chunk));
		b.stream.on("data", (chunk: Buffer) => receivedB.push(chunk));
		// Act
		a.stream.end(payload);
		b.stream.end(payload);
		await Promise.all([a.stream.disposed, b.stream.disposed]);
		await flush();
		// Assert: the oracle checks the versioned wire independently of the decoder.
		expect(Buffer.concat(receivedA)).toEqual(payload);
		expect(Buffer.concat(receivedB)).toEqual(payload);
		for (const channel of [left, right]) {
			expect(channel.sent.map((frame) => frame.length)).toEqual([...Array(8).fill(8194), 4467, 2]);
			expect(channel.sent.slice(0, -1).every((frame) => frame[0] === 1 && frame[1] === 0)).toBe(
				true,
			);
			expect(channel.sent.at(-1)).toEqual(Uint8Array.of(1, 1));
			expect([channel.disposals, channel.listeners]).toEqual([1, 0]);
		}
		expect([...a.errors, ...b.errors]).toEqual([]);
	});

	it("fragments to the lowered channel cap and waits for actual zero after drain notifications", async () => {
		// Arrange
		const { stream, channel } = setup({ limits: { channelBufferBytes: 5 } });
		channel.held = true;
		const done = vi.fn();
		// Act
		stream.write(Buffer.from([1, 2, 3, 4]), done);
		channel.notifyDrain();
		await flush();
		// Assert
		expect(channel.sent).toEqual([Uint8Array.of(1, 0, 1, 2, 3)]);
		expect(done).not.toHaveBeenCalled();
		channel.release();
		await flush();
		expect(channel.sent).toEqual([Uint8Array.of(1, 0, 1, 2, 3), Uint8Array.of(1, 0, 4)]);
		expect(done).toHaveBeenCalledExactlyOnceWith(null);
	});

	it.each([1, 5])(
		"waits for an initially occupied channel (%i bytes) to drain before sending",
		async (amount) => {
			// Arrange
			const { stream, channel, errors } = setup({ limits: { channelBufferBytes: 5 } });
			channel.bufferedAmount = amount;
			const done = vi.fn();
			// Act
			stream.write(Buffer.from([42]), done);
			await flush();
			// Assert
			expect(channel.sent).toEqual([]);
			expect(done).not.toHaveBeenCalled();
			expect(errors).toEqual([]);
			channel.release();
			await flush();
			expect(channel.sent).toEqual([data()]);
			expect(done).toHaveBeenCalledExactlyOnceWith(null);
		},
	);

	it("copies accepted writes while corked before the caller can mutate its buffer", async () => {
		// Arrange
		const { stream, channel } = setup();
		const bytes = Buffer.from([1, 2]);
		stream.cork();
		// Act
		stream.write(bytes);
		bytes.fill(9);
		stream.uncork();
		await flush();
		// Assert
		expect(channel.sent).toEqual([data(Buffer.from([1, 2]))]);
	});
});

describe("TraversalByteStream read encoding", () => {
	it.each(["utf8", "base64", "utf16le", "hex", undefined])(
		"rejects %s without changing byte reads or bypassing the unread byte cap",
		async (encoding) => {
			// Arrange: UTF-16 character counts would undercount this eight-byte payload.
			const { stream, channel, errors } = setup({ limits: { bufferBytes: 16 } });
			const payload = Buffer.from("😀😀");
			// Act / Assert: invalid local configuration must leave the byte stream usable.
			expect(() => Reflect.apply(stream.setEncoding, stream, [encoding])).toThrow(TypeError);
			expect(stream.readableEncoding).toBeNull();
			channel.inject(data(payload));
			channel.inject(data(payload));
			await flush();
			expect(stream.readableLength).toBe(16);
			const accepted: unknown = stream.read(16);
			expect(Buffer.isBuffer(accepted)).toBe(true);
			expect(accepted).toEqual(Buffer.concat([payload, payload]));
			expect(errors).toEqual([]);
			channel.inject(data(payload));
			channel.inject(data(payload));
			await flush();
			expect(stream.readableLength).toBe(16);
			channel.inject(data(payload));
			await stream.disposed;
			await flush();
			expect(errors).toHaveLength(1);
			expect(errors[0]).toBeInstanceOf(RangeError);
			expect([channel.disposals, channel.listeners]).toEqual([1, 0]);
		},
	);
});

describe("TraversalByteStream protocol completion", () => {
	it("rejects target EOF before the source has sent its own EOF", async () => {
		// Arrange
		const { stream, channel, errors } = setup();
		// Act
		channel.inject(end());
		await stream.disposed;
		await flush();
		// Assert
		expect(errors).toHaveLength(1);
		expect(stream.readableEnded).toBe(false);
		expect(channel.disposals).toBe(1);
	});

	it("retains unread data when protocol EOF and transport close precede consumer reads", async () => {
		// Arrange: decoder EOF must not be confused with Node's readableEnded flag.
		const { stream, channel, errors } = setup();
		stream.end();
		await flush();
		channel.inject(data(Buffer.from([7, 8, 9])));
		channel.inject(end());
		await flush();
		expect(stream.readableEnded).toBe(false);
		// Act
		await stream.disposed;
		await flush();
		// Assert before teardown: destruction here would discard the queued data.
		expect(channel.state).toBe("closed");
		expect(stream.readableEnded).toBe(false);
		expect(stream.read()).toEqual(Buffer.from([7, 8, 9]));
		stream.resume();
		await flush();
		expect(stream.readableEnded).toBe(true);
		expect(stream.closed).toBe(true);
		expect(errors).toEqual([]);
	});

	it.each(["empty", "data", "pending-write"])(
		"reports truncation on channel close: %s",
		async (mode) => {
			// Arrange
			const { stream, channel, errors } = setup({ side: "target" });
			const done = vi.fn();
			if (mode === "data") channel.inject(data());
			if (mode === "pending-write") {
				channel.held = true;
				stream.write(Buffer.from([1]), done);
				channel.inject(end());
			}
			// Act
			channel.close();
			await stream.disposed;
			await flush();
			// Assert
			expect(errors).toHaveLength(1);
			expect(errors[0]).toBeInstanceOf(Error);
			if (mode === "pending-write") {
				expect(done).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
			} else expect(stream.readableEnded).toBe(false);
			expect(channel.disposals).toBe(1);
		},
	);

	it.each(["duplicate-end", "data-after-end", "short", "version", "kind", "nonbytes", "oversize"])(
		"fails malformed inbound frames: %s",
		async (kind) => {
			// Arrange
			const { stream, channel, errors } = setup({ side: "target" });
			const frames: Record<string, unknown[]> = {
				"duplicate-end": [end(), end()],
				"data-after-end": [end(), data()],
				short: [Uint8Array.of(1)],
				version: [Uint8Array.of(0, 1)],
				kind: [Uint8Array.of(1, 9)],
				nonbytes: ["frame"],
				oversize: [new Uint8Array(8195)],
			};
			// Act
			for (const frame of frames[kind] ?? []) channel.inject(frame);
			await stream.disposed;
			await flush();
			// Assert
			expect(errors).toHaveLength(1);
			expect(channel.listeners).toBe(0);
		},
	);
});

describe("TraversalByteStream causal shutdown", () => {
	it.each(["target-first", "source-first"])(
		"allows target DATA with %s EOF ordering",
		async (order) => {
			// Arrange
			const { stream, channel, errors } = setup({ side: "target" });
			const done = vi.fn();
			if (order === "source-first") {
				channel.inject(end());
				await flush();
			}
			// Act
			stream.end(Buffer.from([42]), done);
			await flush();
			// Assert: target may send DATA early, but its End must follow decoded source End.
			expect(channel.sent[0]).toEqual(data());
			if (order === "target-first") {
				expect(channel.sent).toHaveLength(1);
				expect(done).not.toHaveBeenCalled();
				channel.inject(end());
				await flush();
			}
			expect(channel.sent).toEqual([data(), end()]);
			expect(done).toHaveBeenCalledExactlyOnceWith(null);
			expect(channel.disposals).toBe(0);
			channel.close();
			await stream.disposed;
			expect(errors).toEqual([]);
			expect(channel.disposals).toBe(1);
		},
	);

	it("uses target EOF to settle the source final before readable EOF despite withheld SDK drain", async () => {
		// Arrange
		const { stream, channel, errors } = setup();
		channel.held = true;
		const done = vi.fn();
		const eofState: boolean[] = [];
		stream.on("end", () => eofState.push(stream.writableFinished));
		stream.resume();
		stream.end(done);
		await flush();
		expect(channel.sent).toEqual([end()]);
		expect(done).not.toHaveBeenCalled();
		// Act
		channel.inject(end());
		await stream.disposed;
		await flush();
		// Assert
		expect(done).toHaveBeenCalledExactlyOnceWith(null);
		expect(eofState).toEqual([true]);
		expect(errors).toEqual([]);
	});
});

describe("TraversalByteStream target waits after Node destruction", () => {
	it.each([
		"close",
		"abort",
		"deadline",
		"error",
		"late-data",
		"late-end",
		"close-abort",
		"dispose-reject",
	])("processes %s while Node.destroyed is true", async (action) => {
		// Arrange
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const controller = new AbortController();
		const { stream, channel, errors } = setup({
			side: "target",
			signal: controller.signal,
			deadlineMs: performance.now() + 100,
			limits: { closeMs: 3 },
		});
		const closed = vi.fn();
		const final = vi.fn();
		stream.on("close", closed);
		stream.resume();
		channel.inject(end());
		stream.end(final);
		await flush();
		stream.destroy();
		stream.destroy();
		expect([stream.destroyed, stream.closed, channel.disposals]).toEqual([true, false, 0]);
		expect(final).toHaveBeenCalledExactlyOnceWith(null);
		const result = stream.disposed.then(
			() => undefined,
			(error: unknown) => error,
		);
		// Act: closeMs does not start during the causal wait.
		await vi.advanceTimersByTimeAsync(10);
		expect(channel.disposals).toBe(0);
		const actions: Record<string, () => unknown> = {
			close: () => channel.close(),
			abort: () => controller.abort(),
			deadline: () => vi.advanceTimersByTimeAsync(100),
			error: () => stream.destroy(new Error("Explicit failure")),
			"late-data": () => channel.inject(data()),
			"late-end": () => channel.inject(end()),
			"close-abort": () => {
				channel.close();
				controller.abort();
			},
			"dispose-reject": () => {
				channel.disposalError = new Error("Disposal failed");
				channel.close();
			},
		};
		await actions[action]?.();
		const outcome = await result;
		await flush();
		// Assert
		if (action === "dispose-reject") expect(outcome).toBeInstanceOf(Error);
		else expect(outcome).toBeUndefined();
		expect(errors).toHaveLength(action === "close" ? 0 : 1);
		expect([channel.disposals, channel.listeners]).toEqual([1, 0]);
		expect(closed).toHaveBeenCalledTimes(1);
		expect(final).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("TraversalByteStream cancellation", () => {
	it.each(["write", "final"])(
		"settles %s on explicit destroy while waiting for drain",
		async (phase) => {
			// Arrange
			const { stream, channel, errors } = setup();
			channel.held = true;
			const done = vi.fn();
			if (phase === "write") stream.write(Buffer.from([42]), done);
			else stream.end(done);
			await flush();
			expect(done).not.toHaveBeenCalled();
			// Act
			stream.destroy();
			await stream.disposed;
			channel.release();
			await flush();
			// Assert
			expect(done).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
			expect(channel.disposals).toBe(1);
			expect(channel.listeners).toBe(0);
			expect(errors.length).toBeLessThanOrEqual(1);
		},
	);

	it.each(["write", "final"])(
		"settles the blocked %s callback once across abort/destroy/late events",
		async (phase) => {
			// Arrange
			const signal = new AbortController();
			const remove = vi.spyOn(signal.signal, "removeEventListener");
			const { stream, channel, errors } = setup({ signal: signal.signal });
			channel.held = true;
			const done = vi.fn();
			if (phase === "write") stream.write(Buffer.from([42]), done);
			else stream.end(done);
			// Act
			signal.abort();
			stream.destroy(new Error("Overlapping destroy"));
			await stream.disposed;
			await flush();
			for (const callback of channel.retiredMessages) callback(data());
			for (const callback of [...channel.retiredDrains, ...channel.retiredCloses]) callback();
			await flush();
			// Assert
			expect(done).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
			expect(errors).toHaveLength(1);
			expect([channel.disposals, channel.listeners]).toEqual([1, 0]);
			expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		},
	);

	it("disposes an already-aborted stream without sending bytes", async () => {
		// Arrange
		const controller = new AbortController();
		controller.abort();
		// Act
		const { stream, channel, errors } = setup({ signal: controller.signal });
		await stream.disposed;
		await flush();
		// Assert
		expect(errors).toHaveLength(1);
		expect([channel.sent.length, channel.disposals, channel.listeners]).toEqual([0, 1, 0]);
	});

	it.each(["caller", "absolute-cap"])(
		"enforces the %s deadline and removes timers",
		async (kind) => {
			// Arrange
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const duration = kind === "caller" ? 20 : 60000;
			const { stream, channel, errors } = setup({
				deadlineMs: performance.now() + (kind === "caller" ? 20 : 120000),
			});
			// Act
			await vi.advanceTimersByTimeAsync(duration + 1);
			await stream.disposed;
			await flush();
			// Assert
			expect(errors).toHaveLength(1);
			expect(channel.disposals).toBe(1);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});
