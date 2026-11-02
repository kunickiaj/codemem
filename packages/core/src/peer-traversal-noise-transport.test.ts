import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeferredTraversalTransport } from "./peer-traversal-noise-transport.js";
import { TraversalByteStream } from "./peer-traversal-stream.js";
import { channelPair, flush } from "./peer-traversal-stream-test-fixtures.js";
import { readNoiseBytes, streamEvent, writeNoiseBytes } from "./relay-noise-test-fixtures.js";

const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.spyOn(performance, "now").mockReturnValue(1000);
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function deferred(limit = 262144) {
	const wrapper = new DeferredTraversalTransport(limit);
	wrapper.on("error", () => {});
	cleanups.push(async () => {
		wrapper.destroy(new Error("Test cleanup"));
		await Promise.allSettled([finished(wrapper)]);
	});
	return wrapper;
}

function fixture(limit = 262144, channels = channelPair({ deferredDelivery: true })) {
	const raw = [
		new TraversalByteStream({
			channel: channels[0],
			side: "source",
			deadlineMs: 11000,
			limits: { bufferBytes: limit },
		}),
		new TraversalByteStream({ channel: channels[1], side: "target", deadlineMs: 11000 }),
	] as const;
	cleanups.push(async () => {
		for (const stream of raw) stream.destroy(new Error("Test cleanup"));
		await Promise.allSettled(raw.map((s) => finished(s)));
	});
	const wrapper = deferred(limit);
	wrapper.attach(raw[0]);
	return { channels, raw, wrapper };
}

describe("deferred traversal transport boundaries", () => {
	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 262145])(
		"rejects invalid buffer cap %s",
		(limit) => {
			const construct = () => new DeferredTraversalTransport(limit);

			expect(construct).toThrow();
		},
	);

	it("allows byte reads to wait without attaching or manufacturing EOF", () => {
		const wrapper = deferred(64);
		const ended = vi.fn();
		wrapper.on("end", ended);

		const bytes = wrapper.read();

		expect(bytes).toBeNull();
		expect(wrapper.destroyed).toBe(false);
		expect(ended).not.toHaveBeenCalled();
		expect(() => wrapper.setEncoding("utf8")).toThrow();
	});

	it.each(["write", "end"] as const)("rejects %s before attachment", async (operation) => {
		const wrapper = deferred();
		const completion = finished(wrapper);
		const rejected = expect(completion).rejects.toThrow();

		if (operation === "write") wrapper.write(Buffer.from("early"), () => {});
		else wrapper.end();

		await rejected;
		expect(wrapper.destroyed).toBe(true);
	});

	it.each(["read", "write"] as const)("fails closed at the reduced %s cap", async (operation) => {
		const f = fixture(4);
		const completion = finished(f.wrapper);
		const rejected = expect(completion).rejects.toThrow();

		if (operation === "write") f.wrapper.write(Buffer.alloc(5), () => {});
		else await writeNoiseBytes(f.raw[1], Buffer.alloc(5));

		await rejected;
		await Promise.allSettled(f.raw.map((s) => finished(s)));
		expect(f.channels.map((c) => [c.disposals, c.listeners])).toEqual([
			[1, 0],
			[1, 0],
		]);
	});
});

describe("deferred traversal transport byte ownership and closure", () => {
	it("retains unread reply bytes and EOF after the inner transport closes cleanly", async () => {
		const f = fixture(64);
		const reply = Buffer.from("reply retained after close");
		const sourceClosed = streamEvent(f.raw[0], "close");
		const requestEnd = streamEvent(f.raw[1], "end");
		f.wrapper.pause();
		f.wrapper.read(0);
		f.raw[1].resume();

		f.wrapper.end();
		await requestEnd;
		f.raw[1].end(reply);
		await sourceClosed;

		expect(f.wrapper.readableLength).toBeGreaterThan(0);
		expect(f.wrapper.destroyed).toBe(false);
		const actual: Buffer | null = f.wrapper.read(reply.length);
		const responseEnd = streamEvent(f.wrapper, "end");
		f.wrapper.resume();
		await responseEnd;
		await Promise.all([f.wrapper, ...f.raw].map((s) => finished(s)));
		expect(actual).toEqual(reply);
		expect(f.wrapper.readableEnded).toBe(true);
		expect([f.wrapper, ...f.raw].map((s) => s.errored)).toEqual([null, null, null]);
		expect(f.channels.map((c) => [c.disposals, c.dropped, c.listeners])).toEqual([
			[1, 0, 0],
			[1, 0, 0],
		]);
	});

	it("copies caller bytes and forwards an ordered reply with causal clean close", async () => {
		const f = fixture(64);
		const payload = Buffer.from("owned");
		const request = readNoiseBytes(f.raw[1], payload.length);
		const requestEnd = streamEvent(f.raw[1], "end");

		const written = writeNoiseBytes(f.wrapper, payload);
		payload.fill(255);
		await written;
		const actual = await request;
		f.wrapper.end();
		f.raw[1].resume();
		await requestEnd;
		const response = readNoiseBytes(f.wrapper, 5);
		const responseEnd = streamEvent(f.wrapper, "end");
		f.raw[1].end(actual);
		const reply = await response;
		f.wrapper.resume();
		await responseEnd;
		await Promise.all([f.wrapper, ...f.raw].map((s) => finished(s)));

		expect(actual.toString()).toBe("owned");
		expect(reply).toEqual(actual);
		expect([f.wrapper, ...f.raw].map((s) => s.errored)).toEqual([null, null, null]);
		expect(f.channels.map((c) => [c.disposals, c.dropped, c.listeners])).toEqual([
			[1, 0, 0],
			[1, 0, 0],
		]);
	});

	it("waits for inner close and propagates its premature clean-destroy error", async () => {
		const channels = channelPair({ deferredDelivery: true });
		const disposal = Promise.withResolvers<void>();
		const original = channels[0].dispose.bind(channels[0]);
		vi.spyOn(channels[0], "dispose").mockImplementation(async () => {
			await disposal.promise;
			await original();
		});
		const f = fixture(262144, channels);
		const closed = vi.fn();
		f.wrapper.on("close", closed);
		const completion = finished(f.wrapper).catch((error: unknown) => error);

		f.wrapper.destroy();
		await flush();

		try {
			expect(closed).not.toHaveBeenCalled();
			expect(f.raw[0].closed).toBe(false);
		} finally {
			disposal.resolve();
		}
		const failure = await completion;
		expect(failure).toBeInstanceOf(Error);
		expect(f.wrapper.errored).toBe(f.raw[0].errored);
		expect(f.wrapper.errored).toBe(failure);
		expect(f.raw[0].closed).toBe(true);
	});

	it("retains the exact transport failure through wrapper shutdown", async () => {
		const f = fixture();
		const reason = new Error("Injected transport failure");
		const completion = finished(f.wrapper).catch((error: unknown) => error);

		f.raw[0].destroy(reason);
		const failure = await completion;

		expect(failure).toBe(reason);
		expect(f.wrapper.errored).toBe(reason);
		expect(f.raw[0].closed).toBe(true);
	});
});
