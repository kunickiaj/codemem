import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TraversalFrameEncoder } from "./peer-traversal-frame.js";
import {
	TRAVERSAL_BYTE_STREAM_LIMITS,
	TraversalByteStream,
	type TraversalByteStreamOptions,
} from "./peer-traversal-stream.js";
import { flush, MemoryChannel } from "./peer-traversal-stream-test-fixtures.js";

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

describe("TraversalByteStream queue limits", () => {
	it("rechecks channel state after the initial drain before sending", async () => {
		// Arrange
		const { stream, channel, errors } = setup();
		channel.bufferedAmount = 1;
		channel.held = true;
		const done = vi.fn();
		stream.write(Buffer.from([42]), done);
		await flush();
		expect(channel.sent).toEqual([]);
		expect(done).not.toHaveBeenCalled();
		// Act
		channel.state = "closing";
		channel.bufferedAmount = 0;
		channel.notifyDrain();
		await stream.disposed;
		await flush();
		// Assert
		expect(channel.sent).toEqual([]);
		expect(done).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(Error);
		expect([channel.disposals, channel.listeners]).toEqual([1, 0]);
	});

	it.each(["write", "end", "cork"] as const)(
		"caps the sum of pending bytes through %s",
		async (path) => {
			// Arrange
			const { stream, channel, errors } = setup({ limits: { bufferBytes: 4 } });
			channel.held = true;
			if (path === "cork") stream.cork();
			const done = vi.fn();
			// Act
			stream.write(Buffer.alloc(3));
			if (path === "end") stream.end(Buffer.alloc(2), done);
			else stream.write(Buffer.alloc(2), done);
			await stream.disposed;
			await flush();
			// Assert
			expect(errors[0]).toBeInstanceOf(RangeError);
			expect(done).toHaveBeenCalledTimes(1);
			expect(done.mock.calls[0]?.[0]).toBeInstanceOf(Error);
			expect(stream.writableLength).toBeLessThanOrEqual(4);
		},
	);

	it.each(["write", "end"] as const)("rejects string %s before queueing bytes", (method) => {
		// Arrange
		const { stream, channel } = setup();
		// Act / Assert
		expect(() => stream[method]("not bytes")).toThrow(TypeError);
		expect([stream.writableLength, channel.sent.length]).toEqual([0, 0]);
	});

	it("accepts exact writable/readable buffer limits and rejects receive overflow", async () => {
		// Arrange
		const { stream, channel, errors } = setup({ limits: { bufferBytes: 4 } });
		// Act
		stream.write(Buffer.alloc(4));
		channel.inject(data(Buffer.alloc(4, 7)));
		await flush();
		// Assert
		expect(stream.readableLength).toBe(4);
		expect(errors).toEqual([]);
		channel.inject(data());
		await stream.disposed;
		await flush();
		expect(errors[0]).toBeInstanceOf(RangeError);
		expect(stream.readableLength).toBeLessThanOrEqual(4);
	});

	it("rejects oversized or nonnumeric reads before Node can grow the high-water mark", () => {
		// Arrange
		const { stream } = setup({ limits: { bufferBytes: 8 } });
		const highWaterMark = stream.readableHighWaterMark;
		// Act / Assert
		expect(() => stream.read(9)).toThrow(RangeError);
		expect(() => Reflect.apply(stream.read, stream, ["9"])).toThrow(TypeError);
		expect(stream.readableHighWaterMark).toBe(highWaterMark);
		expect(highWaterMark).toBeLessThanOrEqual(8);
	});

	it.each([undefined, null, 0, Number.NaN])(
		"preserves native empty read behavior for %s",
		(size) => {
			// Arrange
			const { stream } = setup();
			// Act
			const result: unknown = Reflect.apply(stream.read, stream, [size]);
			// Assert
			expect(result).toBeNull();
			expect(stream.readableHighWaterMark).toBeLessThanOrEqual(16384);
		},
	);
});

describe("TraversalByteStream quotas", () => {
	it("accepts EOF alone at minimum byte and frame budgets", async () => {
		// Arrange
		const { stream, channel, errors } = setup({
			limits: { sentBytes: 2, receivedBytes: 2, sentFrames: 1, receivedFrames: 1 },
		});
		// Act
		stream.end();
		await flush();
		channel.inject(end());
		await stream.disposed;
		await flush();
		// Assert
		expect(channel.sent).toEqual([end()]);
		expect(errors).toEqual([]);
	});

	it.each(["sentBytes", "receivedBytes", "sentFrames", "receivedFrames"] as const)(
		"accounts for headers and EOF at the %s boundary",
		async (key) => {
			// Arrange
			const cap = key.endsWith("Bytes") ? 5 : 2;
			const side = key.startsWith("sent") ? "source" : "target";
			const ok = setup({ side, limits: { [key]: cap } });
			const bad = setup({ side, limits: { [key]: cap - 1 } });
			// Act
			for (const item of [ok, bad]) {
				if (key.startsWith("sent")) item.stream.end(Buffer.from([42]));
				else {
					item.channel.inject(data());
					item.channel.inject(end());
				}
			}
			await bad.stream.disposed;
			await flush();
			// Assert
			expect(ok.errors).toEqual([]);
			expect(bad.errors[0]).toBeInstanceOf(RangeError);
			if (key.startsWith("sent")) expect(ok.channel.sent).toEqual([data(), end()]);
			else expect(ok.stream.read()).toEqual(Buffer.from([42]));
		},
	);

	it.each([Number.NaN, Infinity, -1, 0.5, 262145])(
		"fails closed on invalid live bufferedAmount %s",
		async (amount) => {
			// Arrange
			const { stream, channel, errors } = setup();
			channel.bufferedAmount = amount;
			// Act
			channel.notifyDrain();
			await stream.disposed;
			await flush();
			// Assert
			expect(errors).toHaveLength(1);
			expect(channel.sent).toEqual([]);
		},
	);
});

describe("TraversalByteStream ownership", () => {
	it.each([undefined, "responder", 0])(
		"rejects missing or invalid side %s before ownership",
		(side) => {
			// Arrange
			const channel = new MemoryChannel();
			const options = { channel, side, deadlineMs: performance.now() + 1000 };
			// Act / Assert: Reflect deliberately exercises invalid runtime input without an any cast.
			expect(() => Reflect.construct(TraversalByteStream, [options])).toThrow(TypeError);
			expect([channel.subscriptions, channel.disposals]).toEqual([0, 0]);
		},
	);

	it("reports send failure while disposed independently resolves successful cleanup", async () => {
		// Arrange
		const { stream, channel, errors } = setup();
		const failure = new Error("Port send failed");
		channel.sendError = failure;
		const done = vi.fn();
		// Act
		stream.write(Buffer.from([42]), done);
		await expect(stream.disposed).resolves.toBeUndefined();
		await flush();
		// Assert
		expect(done).toHaveBeenCalledExactlyOnceWith(failure);
		expect(errors).toEqual([failure]);
		expect([channel.disposals, channel.listeners]).toEqual([1, 0]);
	});

	it.each(["reject", "timeout"])(
		"exposes transport disposal %s rather than claiming success",
		async (kind) => {
			// Arrange
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const { stream, channel } = setup({ limits: { closeMs: 10 } });
			channel.disposalError = kind === "reject" ? new Error("Disposal failed") : undefined;
			channel.neverDispose = kind === "timeout";
			const result = stream.disposed.then(
				() => undefined,
				(error: unknown) => error,
			);
			// Act
			stream.destroy();
			await vi.advanceTimersByTimeAsync(11);
			// Assert
			expect(await result).toBeInstanceOf(Error);
			expect(channel.state).toBe("open");
			expect([channel.disposals, channel.listeners]).toEqual([1, 0]);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(["message", "drain", "close"] as const)(
		"cleans up partial subscriptions when %s subscription throws",
		async (stage) => {
			// Arrange
			const channel = new MemoryChannel();
			channel.failSubscription = stage;
			// Act
			const { stream, errors } = setup({}, channel);
			await stream.disposed;
			await flush();
			// Assert
			expect(errors).toHaveLength(1);
			expect([channel.listeners, channel.disposals]).toEqual([0, 1]);
		},
	);

	it.each(["deadline", "buffer", "channel", "bytes", "frames", "raised"])(
		"rejects invalid %s before taking ownership",
		(kind) => {
			// Arrange
			const channel = new MemoryChannel();
			const options: TraversalByteStreamOptions = {
				channel,
				side: "source",
				deadlineMs: performance.now() + 1000,
			};
			if (kind === "deadline") options.deadlineMs = Number.NaN;
			if (kind === "buffer") options.limits = { bufferBytes: 0 };
			if (kind === "channel") options.limits = { channelBufferBytes: 2 };
			if (kind === "bytes") options.limits = { receivedBytes: 1 };
			if (kind === "frames") options.limits = { sentFrames: 0 };
			if (kind === "raised")
				options.limits = { bufferBytes: TRAVERSAL_BYTE_STREAM_LIMITS.bufferBytes + 1 };
			// Act / Assert
			expect(() => new TraversalByteStream(options)).toThrow();
			expect([channel.subscriptions, channel.disposals]).toEqual([0, 0]);
		},
	);

	it.each(["delivery", "state", "method", "queue"])(
		"rejects invalid port %s before taking ownership",
		(kind) => {
			// Arrange
			const channel = new MemoryChannel();
			if (kind === "delivery") Object.defineProperty(channel, "delivery", { value: "unordered" });
			if (kind === "state") channel.state = "closed";
			if (kind === "method") Object.defineProperty(channel, "send", { value: undefined });
			if (kind === "queue") channel.bufferedAmount = Infinity;
			// Act / Assert
			expect(
				() =>
					new TraversalByteStream({
						channel,
						side: "source",
						deadlineMs: performance.now() + 1000,
					}),
			).toThrow();
			expect([channel.subscriptions, channel.disposals]).toEqual([0, 0]);
		},
	);
});
