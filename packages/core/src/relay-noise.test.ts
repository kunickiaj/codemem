import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acceptRelayNoiseResponder,
	prepareRelayNoiseInitiator,
	RELAY_NOISE_LIMITS,
	type RelayNoiseLimits,
	type RelayNoiseOptions,
	restrictedRelayNoiseUpgrader,
} from "./relay-noise.js";
import type { RelayNoiseContext } from "./relay-noise-identity.js";
import { relayNoiseExpectedPeer } from "./relay-noise-identity.js";
import {
	disposableNoiseIdentity,
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
	vi.useRealTimers();
});

function fixture(
	limits?: Partial<RelayNoiseLimits>,
	identities = [disposableNoiseIdentity(), disposableNoiseIdentity()] as const,
	segmentBytes = 4096,
) {
	const pair = orderedNoisePair(segmentBytes);
	const context: RelayNoiseContext = { transportLabel: 1, sessionId: Buffer.alloc(16, 7) };
	const options = (side: 0 | 1): RelayNoiseOptions => ({
		transport: pair.raw[side],
		localIdentity: identities[side],
		expectedRemotePin: identities[1 - side].expectedPin,
		context,
		deadlineMs: performance.now() + 2000,
		limits,
	});
	dispose.push(() => {
		for (const raw of pair.raw) raw.destroy();
	});
	const prepare = (overrides: Partial<RelayNoiseOptions> = {}) => {
		const attempt = prepareRelayNoiseInitiator({ ...options(0), ...overrides });
		dispose.push(() => attempt.cancel());
		return attempt;
	};
	const accept = (digest: string, overrides: Partial<RelayNoiseOptions> = {}) => {
		const result = acceptRelayNoiseResponder({
			...options(1),
			...overrides,
			verifiedMessageADigest: digest,
			acceptedAtMs: performance.now(),
		});
		void result.catch(() => {});
		return result;
	};
	const connect = async () => {
		const attempt = prepare();
		const opening = await attempt.opening;
		const inbound = accept(opening.digest);
		attempt.release(performance.now());
		const results = await Promise.all([attempt.authenticated, inbound]);
		for (const result of results) {
			result.duplex.on("error", () => {});
			dispose.push(() => result.duplex.destroy());
		}
		return results;
	};
	return { ...pair, identities, context, options, prepare, accept, connect };
}

describe("relay Noise authentication and admission byte gate", () => {
	it("holds exactly Message A locally and exposes pinned peers only after release", async () => {
		// Arrange: digest binding is supplied only after caller-owned admission checks.
		const f = fixture();
		const attempt = f.prepare();
		const exposed = vi.fn();
		void attempt.authenticated.then(exposed, () => {});
		// Act
		const opening = await attempt.opening;
		const inbound = f.accept(opening.digest);
		await Promise.resolve();
		// Assert: neither endpoint emits on the ordered wire before release.
		expect(opening.bytes).toHaveLength(34);
		expect(Buffer.from(opening.bytes).readUInt16BE()).toBe(32);
		expect(f.frames).toEqual([[], []]);
		expect(exposed).not.toHaveBeenCalled();
		// Act
		attempt.release(performance.now());
		const [left, right] = await Promise.all([attempt.authenticated, inbound]);
		// Assert
		expect(left.observedPin).toBe(f.identities[1].expectedPin);
		expect(right.observedPin).toBe(f.identities[0].expectedPin);
		expect(left.observedPeerId).toBe(
			relayNoiseExpectedPeer(f.identities[1].expectedPin).peerId.toString(),
		);
		expect(Buffer.from(left.observedPublicKey)).toEqual(
			relayNoiseExpectedPeer(f.identities[1].expectedPin).rawKey,
		);
		expect(f.frames[0][0]).toEqual(Buffer.from(opening.bytes));
	});

	it.each(["initiator", "responder"] as const)(
		"rejects the wrong expected pin at the %s before exposure",
		async (role) => {
			// Arrange
			const f = fixture();
			const wrong = disposableNoiseIdentity().expectedPin;
			const attempt = f.prepare(role === "initiator" ? { expectedRemotePin: wrong } : {});
			const opening = await attempt.opening;
			const inbound = f.accept(
				opening.digest,
				role === "responder" ? { expectedRemotePin: wrong } : {},
			);
			const exposed = vi.fn();
			const rejected = role === "initiator" ? attempt.authenticated : inbound;
			void rejected.then(exposed, () => {});
			// Act
			attempt.release(performance.now());
			const outcomes = await Promise.allSettled([attempt.authenticated, inbound]);
			// Assert
			expect(outcomes[role === "initiator" ? 0 : 1].status).toBe("rejected");
			expect(exposed).not.toHaveBeenCalled();
		},
	);

	it("rejects an incorrect verified digest without emitting responder identity bytes", async () => {
		// Arrange
		const f = fixture();
		const attempt = f.prepare();
		await attempt.opening;
		const inbound = f.accept("0".repeat(64));
		// Act
		attempt.release(performance.now());
		// Assert
		await expect(inbound).rejects.toThrow(/digest mismatch/);
		expect(f.frames[1]).toEqual([]);
		await expect(attempt.authenticated).rejects.toThrow();
	});

	it.each(["label", "session"] as const)(
		"rejects a changed prologue %s before application exposure",
		async (field) => {
			// Arrange
			const f = fixture();
			const attempt = f.prepare();
			const opening = await attempt.opening;
			const context: RelayNoiseContext = { ...f.context };
			const changed =
				field === "label"
					? { ...context, transportLabel: 2 as const }
					: { ...context, sessionId: Buffer.alloc(16, 8) };
			const inbound = f.accept(opening.digest, { context: changed });
			const exposed = vi.fn();
			void attempt.authenticated.then(exposed, () => {});
			void inbound.then(exposed, () => {});
			// Act
			attempt.release(performance.now());
			const outcomes = await Promise.allSettled([attempt.authenticated, inbound]);
			// Assert
			expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
			expect(exposed).not.toHaveBeenCalled();
		},
	);

	it.each(["tamper", "truncate"] as const)(
		"rejects %s of Message B before exposing either application stream",
		async (damage) => {
			// Arrange
			const f = fixture();
			f.control.transform = (direction, bytes) => {
				if (direction !== 1) return bytes;
				if (damage === "truncate") return bytes.subarray(0, bytes.length - 1);
				bytes[bytes.length - 1] ^= 1;
				return bytes;
			};
			const attempt = f.prepare();
			const opening = await attempt.opening;
			const inbound = f.accept(opening.digest);
			const exposed = vi.fn();
			void attempt.authenticated.then(exposed, () => {});
			void inbound.then(exposed, () => {});
			const responseWritten = new Promise<void>((resolve) =>
				f.raw[0].once("data", () => resolve()),
			);
			// Act
			attempt.release(performance.now());
			if (damage === "truncate") {
				await responseWritten;
				f.raw[1].end();
			}
			const outcomes = await Promise.allSettled([attempt.authenticated, inbound]);
			// Assert
			expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
			expect(exposed).not.toHaveBeenCalled();
		},
	);
});

describe("relay Noise authenticated application records", () => {
	it("preserves segmented 150 KB requests and 170 KB responses across multiple records", async () => {
		// Arrange
		const f = fixture();
		const [left, right] = await f.connect();
		f.frames[0].length = 0;
		const request = Buffer.concat([
			Buffer.from("POST /sync HTTP/1.1\r\nContent-Length: 150000\r\n\r\n"),
			Buffer.alloc(150000, 97),
		]);
		const response = Buffer.concat([
			Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 170000\r\n\r\n"),
			Buffer.alloc(170000, 98),
		]);
		const requestRead = readNoiseBytes(right.duplex, request.length);
		const responseRead = readNoiseBytes(left.duplex, response.length);
		// Act
		await Promise.all([
			writeNoiseBytes(left.duplex, request),
			writeNoiseBytes(right.duplex, response),
		]);
		const actual = await Promise.all([requestRead, responseRead]);
		const wire = Buffer.concat(f.frames[0]);
		const sizes: number[] = [];
		let offset = 0;
		while (offset < wire.length) {
			const length = wire.readUInt16BE(offset);
			sizes.push(length);
			offset += length + 2;
		}
		// Assert: real record lengths, not transport segmentation counts.
		expect(actual).toEqual([request, response]);
		expect(offset).toBe(wire.length);
		expect(sizes.length).toBeGreaterThanOrEqual(3);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(65535);
		expect(wire.includes(Buffer.from("POST /sync"))).toBe(false);
	});

	it("propagates request EOF while leaving the response direction writable", async () => {
		// Arrange
		const f = fixture();
		const [left, right] = await f.connect();
		const request = readNoiseBytes(right.duplex, 7);
		const requestEnd = streamEvent(right.duplex, "end");
		// Act
		left.duplex.end("request");
		await request;
		right.duplex.resume();
		await requestEnd;
		const response = readNoiseBytes(left.duplex, 8);
		const responseEnd = streamEvent(left.duplex, "end");
		right.duplex.end("response");
		const actual = await response;
		left.duplex.resume();
		await responseEnd;
		// Assert
		expect(actual.toString()).toBe("response");
		expect(right.duplex.readableEnded).toBe(true);
		expect(left.duplex.readableEnded).toBe(true);
	});

	it.each(["tamper", "truncate", "duplicate", "old-session"] as const)(
		"does not deliver application bytes from %s ciphertext",
		async (damage) => {
			// Arrange
			const first = fixture();
			const [sender, receiver] = await first.connect();
			first.frames[0].length = 0;
			const initial = readNoiseBytes(receiver.duplex, 5);
			await writeNoiseBytes(sender.duplex, "first");
			await initial;
			const captured = Buffer.concat(first.frames[0]);
			let target = receiver.duplex;
			let rawSender = first.raw[0];
			if (damage === "old-session") {
				// Keep long-lived signing identities and context identical. New attempt keys must suffice.
				const second = fixture(undefined, first.identities);
				const peers = await second.connect();
				target = peers[1].duplex;
				rawSender = second.raw[0];
			}
			const delivered = vi.fn();
			target.on("data", delivered);
			const terminal = streamEvent(target, damage === "truncate" ? "end" : "close");
			const bytes = Buffer.from(captured);
			if (damage === "tamper") bytes[bytes.length - 1] ^= 1;
			// Act: replay bypasses plaintext send to inject an actual captured wire record.
			rawSender.write(damage === "truncate" ? bytes.subarray(0, bytes.length - 1) : bytes);
			if (damage === "truncate") rawSender.end();
			await terminal;
			// Assert
			expect(delivered).not.toHaveBeenCalled();
		},
	);
});

describe("relay Noise lifecycle and budgets", () => {
	it.each(["before", "during", "after"] as const)(
		"cancels %s authentication without leaving a live transport",
		async (phase) => {
			// Arrange
			const f = fixture();
			const controller = new AbortController();
			if (phase === "before") controller.abort();
			const attempt = f.prepare({ signal: controller.signal });
			let application: Duplex | undefined;
			if (phase !== "before") {
				const opening = await attempt.opening;
				if (phase === "after") {
					const inbound = f.accept(opening.digest);
					attempt.release(performance.now());
					const [left] = await Promise.all([attempt.authenticated, inbound]);
					application = left.duplex;
				}
			}
			// Act
			controller.abort();
			// Assert
			if (phase === "after") expect(application?.destroyed).toBe(true);
			else await expect(attempt.authenticated).rejects.toThrow();
			expect(f.raw[0].destroyed).toBe(true);
		},
	);

	it("rejects an already-expired preparation deadline", () => {
		// Arrange
		const f = fixture();
		// Act / Assert
		expect(() => f.prepare({ deadlineMs: performance.now() - 1 })).toThrow(/deadline/);
		expect(f.raw[0].destroyed).toBe(true);
	});

	it("starts the handshake deadline at release rather than held preparation", async () => {
		// Arrange: virtual monotonic time advances without sleeps or crypto mocks.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const now = vi.spyOn(performance, "now").mockReturnValue(1000);
		const f = fixture({ handshakeMs: 20 });
		const attempt = f.prepare();
		await attempt.opening;
		// Act
		now.mockReturnValue(1100);
		await vi.advanceTimersByTimeAsync(100);
		// Assert
		expect(f.raw[0].destroyed).toBe(false);
		// Act
		attempt.release(1100);
		now.mockReturnValue(1119);
		await vi.advanceTimersByTimeAsync(19);
		// Assert
		expect(f.raw[0].destroyed).toBe(false);
		// Act
		now.mockReturnValue(1120);
		await vi.advanceTimersByTimeAsync(1);
		// Assert
		await expect(attempt.authenticated).rejects.toThrow(/deadline/);
	});

	it("expires held preparation at the caller deadline without releasing Message A", async () => {
		// Arrange
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const now = vi.spyOn(performance, "now").mockReturnValue(1000);
		const f = fixture();
		const attempt = f.prepare({ deadlineMs: 1020 });
		await attempt.opening;
		// Act
		now.mockReturnValue(1020);
		await vi.advanceTimersByTimeAsync(20);
		// Assert
		await expect(attempt.authenticated).rejects.toThrow();
		expect(() => attempt.release(1020)).toThrow(/deadline/);
		expect(f.frames[0]).toEqual([]);
	});

	it("rejects reuse of acceptance without sending Message A twice", async () => {
		// Arrange
		const f = fixture();
		const attempt = f.prepare();
		await attempt.opening;
		// Act
		attempt.release(performance.now());
		// Assert
		expect(() => attempt.release(performance.now())).toThrow(/reused/);
		expect(f.frames[0]).toHaveLength(1);
		await expect(attempt.authenticated).rejects.toThrow();
	});
});

describe("relay Noise byte budgets and restricted configuration", () => {
	it("rejects a handshake byte beyond the exact held-opening budget", async () => {
		// Arrange
		const f = fixture({ handshakeBytes: 34 });
		const attempt = f.prepare();
		const opening = await attempt.opening;
		const inbound = f.accept(opening.digest);
		// Act
		attempt.release(performance.now());
		// Assert
		await expect(attempt.authenticated).rejects.toThrow(/budget/);
		await expect(inbound).rejects.toThrow();
	});

	it.each(["sentBytes", "receivedBytes"] as const)(
		"admits the exact %s cap and rejects the next byte before delivery",
		async (limit) => {
			// Arrange
			const f = fixture({ [limit]: 4 });
			const [left, right] = await f.connect();
			const allowed = readNoiseBytes(right.duplex, 4);
			await writeNoiseBytes(left.duplex, "1234");
			expect((await allowed).toString()).toBe("1234");
			const delivered = vi.fn();
			right.duplex.on("data", delivered);
			const closed = streamEvent(limit === "sentBytes" ? left.duplex : right.duplex, "close");
			// Act
			left.duplex.write("5", () => {});
			await closed;
			// Assert
			expect(delivered).not.toHaveBeenCalled();
			expect((limit === "sentBytes" ? left : right).duplex.destroyed).toBe(true);
		},
	);

	it("applies the send budget to end(chunk) before emitting ciphertext", async () => {
		// Arrange
		const f = fixture({ sentBytes: 4 });
		const [left, right] = await f.connect();
		const delivered = vi.fn();
		right.duplex.on("data", delivered);
		const closed = streamEvent(left.duplex, "close");
		f.frames[0].length = 0;
		// Act
		left.duplex.end("12345");
		await closed;
		// Assert
		expect(f.frames[0]).toEqual([]);
		expect(delivered).not.toHaveBeenCalled();
	});

	it("closes an authenticated session at its lowered monotonic timeout", async () => {
		// Arrange
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const now = vi.spyOn(performance, "now").mockReturnValue(1000);
		const f = fixture({ sessionMs: 20 });
		const [left] = await f.connect();
		// Act
		now.mockReturnValue(1019);
		await vi.advanceTimersByTimeAsync(19);
		// Assert
		expect(left.duplex.destroyed).toBe(false);
		// Act
		now.mockReturnValue(1020);
		await vi.advanceTimersByTimeAsync(1);
		// Assert
		expect(left.duplex.destroyed).toBe(true);
	});

	it.each(Object.keys(RELAY_NOISE_LIMITS) as (keyof RelayNoiseLimits)[])(
		"rejects raising the production %s ceiling",
		(name) => {
			// Arrange
			const f = fixture();
			// Act / Assert
			expect(() => f.prepare({ limits: { [name]: RELAY_NOISE_LIMITS[name] + 1 } })).toThrow(
				/Invalid Noise limit/,
			);
		},
	);

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid lowered limits %s",
		(value) => {
			// Arrange
			const f = fixture();
			// Act / Assert
			expect(() => f.prepare({ limits: { handshakeMs: value } })).toThrow(/Invalid Noise limit/);
		},
	);

	it("returns fresh mutable empty upgrader maps and rejects every network operation", () => {
		// Arrange
		const upgrader = restrictedRelayNoiseUpgrader();
		// Act
		const muxers = upgrader.getStreamMuxers();
		const encrypters = upgrader.getConnectionEncrypters();
		Reflect.apply(muxers.set, muxers, ["synthetic", {}]);
		Reflect.apply(encrypters.set, encrypters, ["synthetic", {}]);
		// Assert
		expect(muxers.size).toBe(1);
		expect(encrypters.size).toBe(1);
		expect(upgrader.getStreamMuxers().size).toBe(0);
		expect(upgrader.getConnectionEncrypters().size).toBe(0);
		expect(upgrader.getStreamMuxers()).not.toBe(muxers);
		expect(upgrader.getConnectionEncrypters()).not.toBe(encrypters);
		expect(Object.isFrozen(muxers)).toBe(false);
		// Calling with no arguments still exercises each public fail-closed operation.
		expect(() => Reflect.apply(upgrader.upgradeInbound, upgrader, [])).toThrow(
			/do not support networking/,
		);
		expect(() => Reflect.apply(upgrader.upgradeOutbound, upgrader, [])).toThrow(
			/do not support networking/,
		);
		expect(() => Reflect.apply(upgrader.createInboundAbortSignal, upgrader, [])).toThrow(
			/do not support networking/,
		);
	});
});

describe("relay Noise timer and shutdown regressions", () => {
	it("keeps an authenticated session open after an early handshake timer rearms", async () => {
		// Arrange: noise-stale-rearmed-handshake-timer. No responder exists until the early tick.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const now = vi.spyOn(performance, "now").mockReturnValue(1000);
		const f = fixture({ handshakeMs: 20, sessionMs: 100 });
		const attempt = f.prepare();
		const opening = await attempt.opening;
		attempt.release(1000);
		// Act: the scheduled tick runs while monotonic time is still 1 ms short of expiry.
		now.mockReturnValue(1019);
		await vi.advanceTimersByTimeAsync(20);
		const inbound = f.accept(opening.digest);
		const [left, right] = await Promise.all([attempt.authenticated, inbound]);
		// Assert
		expect(left.duplex.destroyed).toBe(false);
		expect(right.duplex.destroyed).toBe(false);
		// Act: cross the old handshake deadline, staying below both live session deadlines.
		now.mockReturnValue(1021);
		await vi.advanceTimersByTimeAsync(1);
		// Assert
		expect(left.duplex.destroyed).toBe(false);
		expect(right.duplex.destroyed).toBe(false);
		const received = readNoiseBytes(right.duplex, 5);
		await writeNoiseBytes(left.duplex, "alive");
		expect((await received).toString()).toBe("alive");
	});

	it("closes completed request and response transports without manufacturing errors", async () => {
		// Arrange: noise-clean-close-destroys-transport-with-error.
		const f = fixture();
		const [left, right] = await f.connect();
		const rawErrors = [vi.fn(), vi.fn()];
		const appErrors = [vi.fn(), vi.fn()];
		f.raw.forEach((raw, index) => {
			raw.on("error", rawErrors[index]);
		});
		[left, right].forEach((peer, index) => {
			peer.duplex.on("error", appErrors[index]);
		});
		const allClosed = Promise.all([
			...f.raw.map((raw) => streamEvent(raw, "close")),
			...[left, right].map((peer) => streamEvent(peer.duplex, "close")),
		]);
		const request = readNoiseBytes(right.duplex, 7);
		const requestEnded = streamEvent(right.duplex, "end");
		// Act
		left.duplex.end("request");
		expect((await request).toString()).toBe("request");
		right.duplex.resume();
		await requestEnded;
		const response = readNoiseBytes(left.duplex, 8);
		const responseEnded = streamEvent(left.duplex, "end");
		right.duplex.end("response");
		expect((await response).toString()).toBe("response");
		left.duplex.resume();
		await responseEnded;
		await allClosed;
		// Assert: successful EOF in both directions must not become an authentication failure.
		for (const raw of f.raw) {
			expect(raw.destroyed).toBe(true);
			expect(raw.errored).toBeNull();
		}
		for (const errors of [...rawErrors, ...appErrors]) expect(errors).not.toHaveBeenCalled();
	});
});

describe("relay Noise large ordered transport chunks", () => {
	it("preserves a slow reader across a near-cap chunk containing multiple encrypted records", async () => {
		// Arrange: noise-plaintext-read-cap-vs-large-transport-chunks.
		const cap = RELAY_NOISE_LIMITS.bufferBytes;
		const f = fixture(undefined, undefined, cap);
		const [left, right] = await f.connect();
		const chunks: number[] = [];
		f.raw[1].on("data", (bytes: Buffer) => chunks.push(bytes.length));
		let first = true;
		const pending: Buffer[] = [];
		let pendingBytes = 0;
		f.control.transform = (direction, bytes) => {
			if (direction !== 0) return bytes;
			if (first) {
				first = false;
				pending.push(bytes.subarray(65536));
				pendingBytes = bytes.length - 65536;
				return bytes.subarray(0, 65536);
			}
			pending.push(bytes);
			pendingBytes += bytes.length;
			if (pendingBytes < cap) return Buffer.alloc(0);
			return Buffer.concat(pending);
		};
		const failures: string[] = [];
		right.duplex.on("error", (error: Error) => failures.push(error.message));
		const payload = Buffer.alloc(327590, 97); // Five records produce exactly 327,680 wire bytes.
		// Act: each write respects Writable backpressure. Only two raw deliveries occur, both <= cap.
		await writeNoiseBytes(left.duplex, payload.subarray(0, 262076));
		await writeNoiseBytes(left.duplex, payload.subarray(262076));
		await nextTurn();
		const queuedBeforeRead = right.duplex.readableLength;
		const prefix: Buffer | null = right.duplex.read(49136);
		await nextTurn();
		// Assert before attaching the remainder reader, so a closed stream cannot leave a pending read.
		expect(chunks).toEqual([65536, cap]);
		expect(f.raw[1].readableLength).toBeLessThanOrEqual(cap);
		expect(right.duplex.destroyed, JSON.stringify({ chunks, queuedBeforeRead, failures })).toBe(
			false,
		);
		expect(prefix).not.toBeNull();
		if (prefix === null) throw new Error("Slow reader did not receive its prefix");
		// Act
		const remainder = await readNoiseBytes(right.duplex, payload.length - prefix.length);
		// Assert
		expect(Buffer.concat([prefix, remainder])).toEqual(payload);
		expect(failures).toEqual([]);
	});
});

describe("relay Noise configured debug output", () => {
	it("keeps the real pinned handshake and wire silent with key dumps and debug enabled", async () => {
		// Arrange: output is suppressed even if this regression fails. Assertions never print arguments.
		vi.stubEnv("DUMP_SESSION_KEYS", "1");
		vi.stubEnv("DEBUG", "*");
		const output = [
			vi.spyOn(console, "log").mockImplementation(() => {}),
			vi.spyOn(console, "error").mockImplementation(() => {}),
			vi.spyOn(console, "debug").mockImplementation(() => {}),
			vi.spyOn(console, "trace").mockImplementation(() => {}),
			vi.spyOn(process.stderr, "write").mockImplementation(() => true),
		];
		const f = fixture();
		// Act
		const [left, right] = await f.connect();
		const received = readNoiseBytes(right.duplex, 5);
		await writeNoiseBytes(left.duplex, "quiet");
		await received;
		// Assert
		for (const spy of output) expect(spy.mock.calls.length).toBe(0);
	});
});
