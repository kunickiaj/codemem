import { Duplex } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AbortOptions } from "@libp2p/interface";
import { AbstractMessageStream } from "@libp2p/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relayNoiseOpeningDigest } from "./relay-noise-opening.js";
import { RelayNoiseDuplex, RelayNoiseWire, relayNoiseSilentLog } from "./relay-noise-stream.js";
import {
	orderedNoisePair,
	readNoiseBytes,
	streamEvent,
	writeNoiseBytes,
} from "./relay-noise-test-fixtures.js";

const dispose: (() => void)[] = [];
afterEach(async () => {
	for (const cleanup of dispose.splice(0).reverse()) cleanup();
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

/** Public MessageStream test double with explicit transport congestion, no private fields. */
class ControlledMessageStream extends AbstractMessageStream {
	readonly sent: Buffer[] = [];
	blocked = false;
	readonly reset = vi.fn();
	readonly paused = vi.fn();
	readonly resumed = vi.fn();
	constructor() {
		super({ log: relayNoiseSilentLog, inactivityTimeout: 0 });
	}
	sendData(data: Parameters<AbstractMessageStream["sendData"]>[0]) {
		this.sent.push(Buffer.from(data.subarray()));
		return { sentBytes: data.byteLength, canSendMore: !this.blocked };
	}
	sendReset(error: Error): void {
		this.reset(error);
	}
	sendPause(): void {
		this.paused();
	}
	sendResume(): void {
		this.resumed();
	}
	async close(_options?: AbortOptions): Promise<void> {
		this.writeStatus = "closed";
	}
}

function plaintextFixture(bufferBytes = 256 * 1024) {
	const stream = new ControlledMessageStream();
	const accountSent = vi.fn();
	const accountReceived = vi.fn();
	const duplex = new RelayNoiseDuplex(stream, { bufferBytes, accountSent, accountReceived });
	duplex.on("error", () => {});
	dispose.push(() => duplex.destroy());
	return { stream, duplex, accountSent, accountReceived };
}

function overlappingPlaintextFixture() {
	const f = plaintextFixture(64);
	const bytes = Buffer.from(Array.from({ length: 96 }, (_, index) => index));
	// The first event leaves room in the Node buffer. The next event fits the message cap.
	// No additional event arrives after the adapter pauses the source.
	f.stream.onData(bytes.subarray(0, 32));
	f.stream.onData(bytes.subarray(32));
	return { ...f, bytes };
}

async function readPlaintextSlowly(duplex: Duplex, bytes: number, cap: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let received = 0;
	while (received < bytes) {
		await nextTurn();
		expect(duplex.destroyed).toBe(false);
		expect(duplex.readableLength).toBeLessThanOrEqual(cap);
		const chunk: Buffer | null = duplex.read(Math.min(7, bytes - received));
		expect(chunk).not.toBeNull();
		if (chunk === null) throw new Error("Plaintext reader stalled before all accepted bytes");
		chunks.push(chunk);
		received += chunk.length;
		expect(duplex.readableLength).toBeLessThanOrEqual(cap);
	}
	return Buffer.concat(chunks);
}

function wireFixture(opening?: "hold" | { verifiedDigest: string }, bufferBytes = 256 * 1024) {
	const pair = orderedNoisePair();
	const account = vi.fn();
	const onFailure = vi.fn();
	const onReadEnd = vi.fn();
	const wire = new RelayNoiseWire(pair.raw[0], {
		bufferBytes,
		opening,
		account,
		onFailure,
		onReadEnd,
	});
	dispose.push(() => {
		wire.abort(new Error("Fixture disposed"));
		for (const raw of pair.raw) raw.destroy();
	});
	return { ...pair, wire, account, onFailure, onReadEnd };
}

const opening = Buffer.concat([Buffer.from([0, 32]), Buffer.alloc(32, 3)]);

describe("relay Noise public wire adapter", () => {
	it("holds opening bytes without writing, then releases the identical prefix once", async () => {
		// Arrange
		const f = wireFixture("hold");
		// Act
		f.wire.send(opening);
		const captured = await f.wire.opening;
		// Assert
		expect(Buffer.from(captured)).toEqual(opening);
		expect(f.frames[0]).toEqual([]);
		// Act
		f.wire.releaseOpening();
		// Assert
		expect(f.frames[0]).toEqual([opening]);
		expect(() => f.wire.releaseOpening()).toThrow(/already released/);
	});

	it("checks a segmented verified opening before delivering any message", async () => {
		// Arrange
		const f = wireFixture({ verifiedDigest: relayNoiseOpeningDigest(opening) });
		const delivered: Buffer[] = [];
		f.wire.addEventListener("message", (event) =>
			delivered.push(Buffer.from(event.data.subarray())),
		);
		// Act
		await writeNoiseBytes(f.raw[1], opening.subarray(0, 10));
		// Assert
		expect(delivered).toEqual([]);
		expect(f.frames[0]).toEqual([]);
		// Act
		await writeNoiseBytes(f.raw[1], opening.subarray(10));
		await f.wire.opening;
		f.wire.releaseOpening();
		// Assert
		expect(Buffer.concat(delivered)).toEqual(opening);
		expect(f.onFailure).not.toHaveBeenCalled();
	});

	it.each(["wrong digest", "truncated prefix", "extra bytes", "data before release"] as const)(
		"rejects %s without writing a response",
		async (fault) => {
			// Arrange
			const f = wireFixture(
				fault === "data before release"
					? "hold"
					: {
							verifiedDigest:
								fault === "wrong digest" ? "0".repeat(64) : relayNoiseOpeningDigest(opening),
						},
			);
			// Act
			let bytes = opening;
			if (fault === "truncated prefix") bytes = opening.subarray(0, 12);
			if (fault === "extra bytes") bytes = Buffer.concat([opening, Buffer.from([1])]);
			await writeNoiseBytes(f.raw[1], bytes).catch(() => {});
			if (fault === "truncated prefix") f.raw[1].end();
			// Assert
			await expect(f.wire.opening).rejects.toThrow();
			expect(f.frames[0]).toEqual([]);
			expect(f.onFailure).toHaveBeenCalled();
		},
	);

	it("refuses outbound identity data while responder prefix verification is pending", () => {
		// Arrange
		const f = wireFixture({ verifiedDigest: relayNoiseOpeningDigest(opening) });
		// Act / Assert
		expect(() => f.wire.send(Buffer.from("identity"))).toThrow(/before opening verification/);
		expect(f.frames[0]).toEqual([]);
	});
});

describe("relay Noise wire queue limits and lifecycle", () => {
	it("rejects an oversized wire write before transport emission", () => {
		// Arrange
		const f = wireFixture(undefined, 64);
		// Act / Assert
		expect(() => f.wire.send(Buffer.alloc(65))).toThrow(/write buffer/);
		expect(f.frames[0]).toEqual([]);
		expect(f.onFailure).toHaveBeenCalledOnce();
	});

	it("rejects an oversized inbound wire chunk before message delivery", async () => {
		// Arrange
		const f = wireFixture(undefined, 64);
		const delivered = vi.fn();
		f.wire.addEventListener("message", delivered);
		const closed = streamEvent(f.raw[0], "close");
		// Act
		await writeNoiseBytes(f.raw[1], Buffer.alloc(65)).catch(() => {});
		await closed;
		// Assert
		expect(delivered).not.toHaveBeenCalled();
		expect(f.onFailure).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Noise wire read buffer exceeded" }),
		);
	});

	it("rejects extra queued early data when releasing a verified opening", async () => {
		// Arrange
		const f = wireFixture({ verifiedDigest: relayNoiseOpeningDigest(opening) });
		await writeNoiseBytes(f.raw[1], opening);
		await f.wire.opening;
		await writeNoiseBytes(f.raw[1], Buffer.from([1]));
		// Act / Assert
		expect(() => f.wire.releaseOpening()).toThrow(/Extra early/);
		expect(f.frames[0]).toEqual([]);
	});

	it("propagates remote EOF and removes transport listeners after disposal", async () => {
		// Arrange
		const f = wireFixture();
		const before = f.raw[0].listenerCount("data");
		const ended = new Promise<void>((resolve) =>
			f.wire.addEventListener("end", () => resolve(), { once: true }),
		);
		// Act
		f.raw[1].end();
		await ended;
		const closed = streamEvent(f.raw[0], "close");
		f.raw[0].destroy();
		await closed;
		// Assert
		expect(f.onReadEnd).toHaveBeenCalledOnce();
		expect(f.wire.readableEnded).toBe(true);
		expect(before).toBe(1);
		for (const event of ["data", "drain", "end", "close"])
			expect(f.raw[0].listenerCount(event)).toBe(0);
		expect(f.raw[0].listenerCount("error")).toBe(1); // Fixture's permanent error observer only.
	});

	it("closes pending writes when a stalled raw transport is cancelled", async () => {
		// Arrange
		const transport = new Duplex({ read() {}, write() {} });
		transport.on("error", () => {});
		const wire = new RelayNoiseWire(transport, {
			bufferBytes: 65536,
			account: () => {},
			onFailure: () => {},
			onReadEnd: () => {},
		});
		dispose.push(() => wire.abort(new Error("Fixture disposed")));
		wire.send(Buffer.alloc(32768));
		const controller = new AbortController();
		const closing = wire.close({ signal: controller.signal });
		void closing.catch(() => {});
		// Act
		controller.abort();
		// Assert
		await expect(closing).rejects.toThrow(/cancelled/);
	});
});

describe("relay Noise public plaintext adapter", () => {
	it("chunks a 150 KB write into records no larger than 65,519 plaintext bytes", async () => {
		// Arrange
		const f = plaintextFixture();
		const bytes = Buffer.alloc(150000, 4);
		// Act
		await writeNoiseBytes(f.duplex, bytes);
		// Assert
		expect(f.stream.sent.map((chunk) => chunk.length)).toEqual([65519, 65519, 18962]);
		expect(Buffer.concat(f.stream.sent)).toEqual(bytes);
		expect(f.accountSent).toHaveBeenCalledExactlyOnceWith(bytes.length);
	});

	it.each(["buffer", "uint8array", "string"] as const)(
		"accepts a valid %s and accounts its encoded byte length",
		async (kind) => {
			// Arrange
			const f = plaintextFixture();
			let bytes: Uint8Array | string = Buffer.from([1, 2, 3]);
			if (kind === "uint8array") bytes = Uint8Array.of(1, 2, 3);
			if (kind === "string") bytes = "é!";
			// Act
			await writeNoiseBytes(f.duplex, bytes);
			// Assert
			expect(f.accountSent).toHaveBeenCalledExactlyOnceWith(3);
			const expected = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
			expect(Buffer.concat(f.stream.sent)).toEqual(expected);
		},
	);

	it.each([{ byteLength: Number.NaN }, { byteLength: 1 }, null, [1, 2, 3]])(
		"rejects invalid JavaScript write input %j before budget accounting or emission",
		async (chunk) => {
			// Arrange: runtime callers cannot poison a cumulative budget with NaN.
			const f = plaintextFixture();
			const callback = vi.fn();
			const closed = streamEvent(f.duplex, "close");
			// Act
			const result = Reflect.apply(f.duplex.write, f.duplex, [chunk, callback]);
			await closed;
			// Assert
			expect(result).toBe(false);
			expect(f.duplex.destroyed).toBe(true);
			expect(f.accountSent).not.toHaveBeenCalled();
			expect(f.stream.sent).toEqual([]);
			expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
		},
	);
});

describe("relay Noise repeated backpressure", () => {
	it("waits for independent drain events during two congestion episodes", async () => {
		// Arrange
		const f = plaintextFixture();
		f.stream.blocked = true;
		const first = vi.fn();
		const second = vi.fn();
		const firstDone = Promise.withResolvers<void>();
		const secondDone = Promise.withResolvers<void>();
		// Act
		f.duplex.write("first", (error) => {
			first(error);
			firstDone.resolve();
		});
		await nextTurn();
		// Assert
		expect(first).not.toHaveBeenCalled();
		// Act
		f.stream.onMuxerDrain();
		await firstDone.promise;
		f.duplex.write("second", (error) => {
			second(error);
			secondDone.resolve();
		});
		await nextTurn();
		// Assert
		expect(first).toHaveBeenCalledOnce();
		expect(second).not.toHaveBeenCalled();
		// Act
		f.stream.onMuxerDrain();
		await secondDone.promise;
		// Assert
		expect(second).toHaveBeenCalledOnce();
		expect(Buffer.concat(f.stream.sent).toString()).toBe("firstsecond");
	});

	it("does not send the next record until each congestion episode drains", async () => {
		// Arrange
		const f = plaintextFixture();
		f.stream.blocked = true;
		const callback = vi.fn();
		const completed = Promise.withResolvers<void>();
		// Act
		f.duplex.write(Buffer.alloc(150000), (error) => {
			callback(error);
			completed.resolve();
		});
		for (const records of [1, 2, 3]) {
			await nextTurn();
			// Assert: allow all queued microtasks to finish before checking for premature sends.
			expect(f.stream.sent).toHaveLength(records);
			expect(callback).not.toHaveBeenCalled();
			// Act
			f.stream.onMuxerDrain();
		}
		await completed.promise;
		// Assert
		expect(callback).toHaveBeenCalledOnce();
		expect(Buffer.concat(f.stream.sent)).toHaveLength(150000);
	});
});

describe("relay Noise adapter cancellation and queue limits", () => {
	it("settles a pending write callback exactly once when destroyed during congestion", async () => {
		// Arrange
		const f = plaintextFixture();
		f.stream.blocked = true;
		const callback = vi.fn();
		const closed = streamEvent(f.duplex, "close");
		f.duplex.write("pending", callback);
		// Act
		f.duplex.destroy(new Error("Caller cancelled"));
		await closed;
		f.stream.onMuxerDrain();
		await Promise.resolve();
		// Assert
		expect(callback).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ message: "Caller cancelled" }),
		);
		expect(f.stream.sent.map((chunk) => chunk.toString())).toEqual(["pending"]);
	});

	it("fails pending writes when the remote stream closes instead of draining", async () => {
		// Arrange
		const f = plaintextFixture();
		f.stream.blocked = true;
		const callback = vi.fn();
		const closed = streamEvent(f.duplex, "close");
		f.duplex.write("pending", callback);
		// Act
		f.stream.onTransportClosed(new Error("Peer disappeared"));
		await closed;
		// Assert
		expect(callback).toHaveBeenCalledOnce();
		expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
	});

	it("bounds queued writes even when a caller ignores backpressure", async () => {
		// Arrange
		const f = plaintextFixture(64);
		f.stream.blocked = true;
		const closed = streamEvent(f.duplex, "close");
		// Act
		f.duplex.write(Buffer.alloc(40), () => {});
		f.duplex.write(Buffer.alloc(25), () => {});
		await closed;
		// Assert
		expect(f.duplex.destroyed).toBe(true);
		expect(Buffer.concat(f.stream.sent)).toHaveLength(40);
		expect(f.accountSent).toHaveBeenCalledExactlyOnceWith(40);
	});

	it("rejects a buffer too small for an authenticated record without emitting data", async () => {
		// Arrange
		const f = plaintextFixture(18);
		// Act / Assert
		await expect(writeNoiseBytes(f.duplex, "x")).rejects.toThrow(
			/cannot contain an encrypted record/,
		);
		expect(f.stream.sent).toEqual([]);
	});

	it("rejects an oversized incoming message when upstream ignores pause", async () => {
		// Arrange
		const f = plaintextFixture(64);
		const closed = streamEvent(f.duplex, "close");
		// Act
		f.stream.onData(Buffer.alloc(64));
		f.stream.resume(); // Model an upstream sender that ignores the pause request.
		// A second queue within the cap is valid. A single message larger than the cap is not.
		f.stream.onData(Buffer.alloc(65));
		await closed;
		// Assert
		expect(f.accountReceived).toHaveBeenCalledExactlyOnceWith(64);
		expect(f.duplex.destroyed).toBe(true);
	});

	it("delivers valid input and preserves remote half-close for local writes", async () => {
		// Arrange
		const f = plaintextFixture();
		const received = readNoiseBytes(f.duplex, 5);
		const ended = streamEvent(f.duplex, "end");
		// Act
		f.stream.onData(Buffer.from("hello"));
		f.stream.onRemoteCloseWrite();
		const bytes = await received;
		f.duplex.resume();
		await ended;
		await writeNoiseBytes(f.duplex, "response");
		// Assert
		expect(bytes.toString()).toBe("hello");
		expect(f.accountReceived).toHaveBeenCalledExactlyOnceWith(5);
		expect(Buffer.concat(f.stream.sent).toString()).toBe("response");
		expect(f.duplex.writable).toBe(true);
	});

	it("disposes message listeners so late input is never delivered or accounted", async () => {
		// Arrange
		const f = plaintextFixture();
		const delivered = vi.fn();
		f.duplex.on("data", delivered);
		const closed = streamEvent(f.duplex, "close");
		// Act
		f.duplex.destroy();
		await closed;
		f.stream.onData(Buffer.from("late"));
		// Assert
		expect(delivered).not.toHaveBeenCalled();
		expect(f.accountReceived).not.toHaveBeenCalled();
	});
});

describe("relay Noise pending plaintext delivery", () => {
	it("drains a large incoming message in order without exceeding the Node read cap or recounting bytes", async () => {
		// Arrange: one 64-byte event overlaps 32 bytes already queued, without further upstream input.
		const f = overlappingPlaintextFixture();
		// Assert: admission accounts each event exactly once, regardless of how slowly it is read.
		expect(f.duplex.destroyed).toBe(false);
		expect(f.duplex.readableLength).toBeLessThanOrEqual(64);
		expect(f.stream.paused).toHaveBeenCalled();
		expect(f.accountReceived.mock.calls).toEqual([[32], [64]]);
		// Act
		const actual = await readPlaintextSlowly(f.duplex, f.bytes.length, 64);
		// Assert
		expect(actual).toEqual(f.bytes);
		expect(f.accountReceived.mock.calls).toEqual([[32], [64]]);
	});

	it("delivers all accepted pending plaintext before exposing remote EOF", async () => {
		// Arrange
		const f = overlappingPlaintextFixture();
		const ended = vi.fn();
		f.duplex.on("end", ended);
		const end = streamEvent(f.duplex, "end");
		// Act
		f.stream.onRemoteCloseWrite();
		await nextTurn();
		// Assert: an upstream EOF cannot truncate the locally retained remainder.
		expect(ended).not.toHaveBeenCalled();
		expect(f.duplex.readableEnded).toBe(false);
		// Act
		const actual = await readPlaintextSlowly(f.duplex, f.bytes.length, 64);
		f.duplex.resume();
		await end;
		// Assert
		expect(actual).toEqual(f.bytes);
		expect(f.accountReceived.mock.calls).toEqual([[32], [64]]);
		expect(ended).toHaveBeenCalledOnce();
		expect(f.duplex.readableEnded).toBe(true);
	});

	it.each(["destroy", "cancel", "remote error"] as const)(
		"discards pending plaintext and removes listeners on %s without later delivery or accounting",
		async (reason) => {
			// Arrange
			const f = overlappingPlaintextFixture();
			const events = ["message", "end", "close"] as const;
			const listenerCounts = events.map((event) => f.stream.listenerCount(event));
			const closed = streamEvent(f.duplex, "close");
			const delivered = vi.fn();
			// Act
			if (reason === "destroy") f.duplex.destroy();
			if (reason === "cancel") f.duplex.destroy(new Error("Caller cancelled"));
			if (reason === "remote error") f.stream.onTransportClosed(new Error("Remote read failed"));
			await closed;
			f.duplex.on("data", delivered);
			f.duplex.resume();
			f.stream.onData(Buffer.from("late"));
			await nextTurn();
			// Assert
			expect(f.duplex.destroyed).toBe(true);
			expect(delivered).not.toHaveBeenCalled();
			expect(f.accountReceived.mock.calls).toEqual([[32], [64]]);
			expect(f.accountSent).not.toHaveBeenCalled();
			events.forEach((event, index) => {
				expect(f.stream.listenerCount(event)).toBe(listenerCounts[index] - 1);
			});
		},
	);

	it("rejects another incoming event that exceeds the retained-message cap despite pause", async () => {
		// Arrange: each event fits individually, but the third event exceeds both available queues.
		const f = plaintextFixture(64);
		const closed = streamEvent(f.duplex, "close");
		// Act
		f.stream.onData(Buffer.alloc(64));
		f.stream.resume();
		f.stream.onData(Buffer.alloc(64));
		f.stream.resume();
		f.stream.onData(Buffer.alloc(1));
		await closed;
		// Assert
		expect(f.duplex.destroyed).toBe(true);
		expect(f.accountReceived.mock.calls).toEqual([[64], [64]]);
		expect(f.duplex.readableLength).toBeLessThanOrEqual(64);
	});
});

describe("relay Noise silent logging", () => {
	it("keeps wire, component, and nested logger paths silent with session dumps enabled", () => {
		// Arrange: synthetic text only, never generate or pass session key material to a logger.
		vi.stubEnv("DUMP_SESSION_KEYS", "1");
		const output = [
			vi.spyOn(console, "log"),
			vi.spyOn(console, "error"),
			vi.spyOn(console, "debug"),
			vi.spyOn(console, "trace"),
		];
		const f = wireFixture();
		// Act
		for (const logger of [
			relayNoiseSilentLog,
			f.wire.log,
			relayNoiseSilentLog.newScope("keys"),
			f.wire.log.newScope("keys").newScope("nested"),
		]) {
			logger("synthetic log");
			logger.error("synthetic error");
			logger.trace("synthetic trace");
			// Assert
			expect(logger.enabled).toBe(false);
		}
		expect(output.every((spy) => spy.mock.calls.length === 0)).toBe(true);
	});
});
