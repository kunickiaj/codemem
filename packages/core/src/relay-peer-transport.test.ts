import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeerHttpExchangeError } from "./peer-http-policy.js";
import type { RelayControl } from "./relay-control-codec.js";
import { decodeRelayDataFrame } from "./relay-data-frame.js";
import { RelayFailure } from "./relay-failure-reason.js";
import { RelayPeerTransport } from "./relay-peer-transport.js";

const transports: RelayPeerTransport[] = [];
afterEach(async () => {
	for (const stream of transports.splice(0)) {
		stream.destroy();
		await stream.completion.catch(() => {});
	}
	vi.useRealTimers();
});
function fixture(side: "source" | "target" = "source", lifetimeMs = 8000) {
	const abort = new AbortController();
	const send = vi.fn(async (_message: RelayControl | Uint8Array) => {});
	const remove = vi.fn(),
		terminate = vi.fn(),
		validate = vi.fn();
	const stream = new RelayPeerTransport({
		sessionId: "a".repeat(32),
		side,
		deadlineMs: performance.now() + lifetimeMs,
		signal: abort.signal,
		send,
		remove,
		terminate,
		validate,
	});
	transports.push(stream);
	return { stream, send, remove, terminate, validate, abort };
}
const write = (stream: RelayPeerTransport, bytes: Uint8Array) =>
	new Promise<void>((resolve, reject) =>
		stream.write(bytes, (error) => (error ? reject(error) : resolve())),
	);

describe("relay route transport ownership", () => {
	it("copies caller bytes and splits large writes into finite DATA frames", async () => {
		// Arrange.
		const f = fixture();
		const bytes = Buffer.alloc(100000, 17);
		// Act.
		const pending = write(f.stream, bytes);
		bytes.fill(99);
		await pending;
		// Assert.
		const frames = f.send.mock.calls.map(([message]) => {
			if (!(message instanceof Uint8Array)) throw new Error("Expected DATA frame");
			return decodeRelayDataFrame(message);
		});
		expect(frames.map((frame) => frame.payload.length)).toEqual([65536, 34464]);
		expect(Buffer.concat(frames.map((frame) => Buffer.from(frame.payload)))).toEqual(
			Buffer.alloc(100000, 17),
		);
		expect(f.remove).not.toHaveBeenCalled();
	});

	it("completes cleanly only after both directional End messages", async () => {
		// Arrange.
		const f = fixture();
		f.stream.resume();
		// Act.
		await new Promise<void>((resolve) => f.stream.end(resolve));
		f.stream.receiveEnd();
		await f.stream.completion;
		// Assert.
		expect(f.send).toHaveBeenCalledWith({
			v: 1,
			type: "CLOSE",
			session: "a".repeat(32),
			body: { mode: "end" },
		});
		expect(f.remove).toHaveBeenCalledExactlyOnceWith({ clean: true });
		expect(f.terminate).not.toHaveBeenCalled();
	});

	it("rejects a response End before the source has submitted request End", async () => {
		// Arrange.
		const f = fixture();
		// Act.
		f.stream.receiveEnd();
		// Assert.
		await expect(f.stream.completion).rejects.toThrow("End out of order");
		expect(f.remove).toHaveBeenCalledExactlyOnceWith({ clean: false });
	});

	it.each(["read", "write"])("rejects overflowing the finite %s buffer", async (direction) => {
		// Arrange.
		const f = fixture();
		// Act.
		if (direction === "read") f.stream.receive(Buffer.alloc(256 * 1024 + 1));
		else await write(f.stream, Buffer.alloc(256 * 1024)).catch(() => {});
		// Assert.
		await expect(f.stream.completion).rejects.toThrow(`Relay route ${direction} buffer exceeded`);
		expect(f.remove).toHaveBeenCalledExactlyOnceWith({ clean: false });
	});

	it("delivers accepted bytes without draining them before a consumer reads", () => {
		// Arrange.
		const f = fixture();
		// Act.
		f.stream.receive(Buffer.from("opaque bytes"));
		// Assert.
		expect(f.stream.readableLength).toBe(12);
		expect(f.stream.read()).toEqual(Buffer.from("opaque bytes"));
	});

	it("rejects bytes after remote End", async () => {
		// Arrange.
		const f = fixture("target");
		f.stream.receiveEnd();
		// Act.
		f.stream.receive(Buffer.from("late"));
		// Assert.
		await expect(f.stream.completion).rejects.toThrow("DATA after End");
	});

	it("cancels an owned route without terminating a healthy outer socket", async () => {
		// Arrange.
		const f = fixture();
		// Act.
		f.abort.abort();
		// Assert.
		await expect(f.stream.completion).rejects.toThrow("cancelled");
		expect(f.remove).toHaveBeenCalledExactlyOnceWith({ clean: false });
		expect(f.terminate).not.toHaveBeenCalled();
	});

	it("terminates the outer socket when a native write cannot be released within cleanup grace", async () => {
		// Arrange.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const f = fixture();
		const gate = Promise.withResolvers<void>();
		f.send.mockImplementation(() => gate.promise);
		const pending = write(f.stream, Buffer.from("held"));
		const failure = expect(pending).rejects.toThrow("cancelled");
		// Act.
		f.abort.abort();
		await vi.advanceTimersByTimeAsync(1500);
		// Assert.
		await failure;
		await expect(f.stream.completion).rejects.toThrow("cancelled");
		expect(f.terminate).toHaveBeenCalledTimes(1);
		expect(f.remove).toHaveBeenCalledExactlyOnceWith({ clean: false });
		gate.resolve();
	});
});

describe("relay transport idle and lease deadlines", () => {
	it("suspends receive-idle expiry after the complete request reaches dispatch", async () => {
		// Arrange.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const f = fixture("target", 60000);
		f.stream.setReceivingPartial({ active: true });
		// Act.
		f.stream.setReceivingPartial({ active: false });
		await vi.advanceTimersByTimeAsync(10000);
		f.stream.receive(Buffer.from("still active"));
		// Assert.
		expect(f.stream.destroyed).toBe(false);
		expect(f.stream.read()).toEqual(Buffer.from("still active"));
	});

	it("rejects a partial request that stops delivering bytes for ten seconds", async () => {
		// Arrange.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const f = fixture("target", 60000);
		f.stream.setReceivingPartial({ active: true });
		// Act.
		await vi.advanceTimersByTimeAsync(10000);
		// Assert.
		await expect(f.stream.completion).rejects.toThrow("Relay receive idle");
		expect(f.remove).toHaveBeenCalledExactlyOnceWith({ clean: false });
	});

	it("expires the finite route lease even when receive-idle detection is suspended", async () => {
		// Arrange.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const f = fixture();
		f.stream.setReceivingPartial({ active: false });
		// Act.
		await vi.advanceTimersByTimeAsync(8000);
		// Assert.
		await expect(f.stream.completion).rejects.toThrow("Relay route expired");
		expect(f.remove).toHaveBeenCalledExactlyOnceWith({ clean: false });
	});
});

describe("relay transport failure reasons", () => {
	it("keeps the first terminal reason when later faults arrive", async () => {
		// Arrange.
		const f = fixture();
		// Act: a rejection, then a late abort, late DATA, and a cancellation.
		f.stream.destroy(new RelayFailure("relay_rejected", "rejected"));
		f.stream.destroy(new RelayFailure("relay_aborted", "aborted"));
		f.stream.receive(Buffer.from("late"));
		f.abort.abort();
		// Assert.
		await expect(f.stream.completion).rejects.toThrow("rejected");
		expect(f.stream.failureReason).toBe("relay_rejected");
	});

	it.each([
		["before", "relay_handshake_failed"],
		["after", "relay_record_invalid"],
	] as const)(
		"classifies an untagged Noise failure %s authentication as %s",
		async (phase, reason) => {
			// Arrange.
			const f = fixture();
			if (phase === "after") f.stream.markSecured();
			// Act.
			f.stream.destroy(new Error("Noise decrypt failed"));
			// Assert.
			await expect(f.stream.completion).rejects.toThrow("Noise decrypt failed");
			expect(f.stream.failureReason).toBe(reason);
		},
	);

	it.each([
		["framing", { secured: true }, "relay_record_invalid"],
		["response_too_large", { secured: true }, "relay_record_invalid"],
		["framing", { secured: false }, "relay_handshake_failed"],
		["deadline", { secured: true }, "relay_expired"],
		["cancelled", { secured: true }, "relay_expired"],
	] as const)("maps an executor %s abort with %o to %s", async (code, { secured }, reason) => {
		// Arrange.
		const f = fixture();
		if (secured) f.stream.markSecured();
		// Act: the executor aborts the route signal with its own failure as the reason.
		f.abort.abort(new PeerHttpExchangeError(code));
		// Assert.
		await expect(f.stream.completion).rejects.toThrow("Relay route cancelled");
		expect(f.stream.failureReason).toBe(reason);
	});

	it("maps an abort without an executor reason to relay_expired", async () => {
		// Arrange.
		const f = fixture();
		f.stream.markSecured();
		// Act.
		f.abort.abort();
		// Assert.
		await expect(f.stream.completion).rejects.toThrow("Relay route cancelled");
		expect(f.stream.failureReason).toBe("relay_expired");
	});

	it("tags its own route faults at their origin", async () => {
		// Arrange.
		const f = fixture("target");
		f.stream.receiveEnd();
		// Act.
		f.stream.receive(Buffer.from("late"));
		// Assert.
		await expect(f.stream.completion).rejects.toThrow("DATA after End");
		expect(f.stream.failureReason).toBe("relay_frame_invalid");
	});

	it("records relay_expired when the route lease ends", async () => {
		// Arrange.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const f = fixture();
		// Act.
		await vi.advanceTimersByTimeAsync(8000);
		// Assert.
		await expect(f.stream.completion).rejects.toThrow("Relay route expired");
		expect(f.stream.failureReason).toBe("relay_expired");
	});

	it("records no reason after a clean completion", async () => {
		// Arrange.
		const f = fixture();
		f.stream.resume();
		// Act.
		await new Promise<void>((resolve) => f.stream.end(resolve));
		f.stream.receiveEnd();
		await f.stream.completion;
		// Assert.
		expect(f.stream.failureReason).toBeUndefined();
	});
});
