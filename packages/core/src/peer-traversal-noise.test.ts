import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acceptTraversalNoiseResponder,
	prepareTraversalNoiseInitiator,
} from "./peer-traversal-noise.js";
import { TraversalByteStream } from "./peer-traversal-stream.js";
import { channelPair, flush } from "./peer-traversal-stream-test-fixtures.js";
import {
	disposableNoiseIdentity,
	readNoiseBytes,
	streamEvent,
	writeNoiseBytes,
} from "./relay-noise-test-fixtures.js";

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.spyOn(performance, "now").mockReturnValue(1000);
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function prepare(signal?: AbortSignal, limits?: { bufferBytes: number }) {
	const localIdentity = disposableNoiseIdentity();
	const remoteIdentity = disposableNoiseIdentity();
	const attempt = prepareTraversalNoiseInitiator({
		localIdentity,
		expectedRemotePin: remoteIdentity.expectedPin,
		deadlineMs: 11000,
		signal,
		limits,
	});
	cleanups.push(() => attempt.cancel());
	return { attempt, localIdentity, remoteIdentity };
}

function transport(side: "source" | "target" = "source", options: { deadlineMs?: number } = {}) {
	const channels = channelPair({ deferredDelivery: true });
	const deadlineMs = options.deadlineMs ?? 11000;
	const raw = [
		new TraversalByteStream({ channel: channels[0], side, deadlineMs }),
		new TraversalByteStream({ channel: channels[1], side: "target", deadlineMs }),
	] as const;
	cleanups.push(async () => {
		for (const stream of raw) stream.destroy(new Error("Test cleanup"));
		await Promise.allSettled(raw.map((stream) => finished(stream)));
	});
	return { channels, raw };
}

describe("offline traversal Noise preparation", () => {
	it("prepares independent sessions and held openings without a transport", async () => {
		const first = prepare().attempt;
		const second = prepare().attempt;

		const openings = await Promise.all([first.opening, second.opening]);

		expect(first.sessionId).toHaveLength(16);
		expect(second.sessionId).toHaveLength(16);
		expect(first.sessionId).not.toEqual(second.sessionId);
		expect(openings[0].bytes).not.toEqual(openings[1].bytes);
		for (const opening of openings) {
			expect(opening.bytes).toHaveLength(34);
			expect(Buffer.from(opening.bytes).readUInt16BE()).toBe(32);
			expect(opening.digest).toBe(createHash("sha256").update(opening.bytes).digest("hex"));
		}
	});

	it("owns session and Message A bytes through pinned authentication and clean echo shutdown", async () => {
		const f = prepare();
		const t = transport();
		const sessionId = f.attempt.sessionId;
		const opening = await f.attempt.opening;
		const held = Uint8Array.from(opening.bytes);
		const inbound = acceptTraversalNoiseResponder({
			stream: t.raw[1],
			sessionId,
			verifiedMessageADigest: opening.digest,
			localIdentity: f.remoteIdentity,
			expectedRemotePin: f.localIdentity.expectedPin,
			deadlineMs: 11000,
		});
		const ownedSession = f.attempt.sessionId;

		ownedSession.fill(255);
		opening.bytes.fill(255);
		f.attempt.attachAndRelease(t.raw[0]);
		const peers = await Promise.all([f.attempt.authenticated, inbound]);
		const [source, target] = peers;
		for (const peer of peers) {
			peer.duplex.on("error", () => {});
			cleanups.push(() => {
				peer.duplex.destroy();
			});
		}
		const request = readNoiseBytes(target.duplex, 4);
		const requestEnd = streamEvent(target.duplex, "end");
		source.duplex.end(Buffer.from("echo"));
		const bytes = await request;
		target.duplex.resume();
		await requestEnd;
		const response = readNoiseBytes(source.duplex, 4);
		const responseEnd = streamEvent(source.duplex, "end");
		target.duplex.end(bytes);
		const echo = await response;
		source.duplex.resume();
		await responseEnd;
		await Promise.all([...t.raw, ...peers.map((peer) => peer.duplex)].map((s) => finished(s)));

		expect(f.attempt.sessionId).toEqual(sessionId);
		expect(source.observedPin).toBe(f.remoteIdentity.expectedPin);
		expect(target.observedPin).toBe(f.localIdentity.expectedPin);
		expect(echo.toString()).toBe("echo");
		expect(t.channels[0].sent[0]?.subarray(2)).toEqual(held);
		expect(
			t.channels[0].sent.filter((frame) => Buffer.from(frame.subarray(2)).equals(held)),
		).toHaveLength(1);
		expect(t.raw.map((s) => s.errored)).toEqual([null, null]);
		expect(t.channels.map((c) => [c.disposals, c.dropped, c.listeners])).toEqual([
			[1, 0, 0],
			[1, 0, 0],
		]);
	});
});

describe("traversal Noise target opening gate", () => {
	it.each(["digest", "extra-same-write", "truncated", "prefix"] as const)(
		"rejects %s before emitting Message B",
		async (damage) => {
			const f = prepare();
			const t = transport();
			const opening = await f.attempt.opening;
			const bytes = Buffer.from(opening.bytes);
			if (damage === "prefix") bytes.writeUInt16BE(31);
			const inbound = acceptTraversalNoiseResponder({
				stream: t.raw[1],
				sessionId: f.attempt.sessionId,
				verifiedMessageADigest: damage === "digest" ? "0".repeat(64) : opening.digest,
				localIdentity: f.remoteIdentity,
				expectedRemotePin: f.localIdentity.expectedPin,
				deadlineMs: 11000,
			});
			const rejected = expect(inbound).rejects.toThrow();

			const payload =
				damage === "extra-same-write" ? Buffer.concat([bytes, Buffer.from([255])]) : bytes;
			await writeNoiseBytes(t.raw[0], damage === "truncated" ? payload.subarray(0, 33) : payload);
			if (damage === "truncated") t.raw[0].end();
			await rejected;
			await Promise.allSettled(t.raw.map((s) => finished(s)));

			expect(t.channels[1].sent).toEqual([]);
			expect(t.channels.map((c) => [c.disposals, c.listeners])).toEqual([
				[1, 0],
				[1, 0],
			]);
		},
	);
	it("rejects extra early data buffered in a separate frame before admission", async () => {
		const f = prepare();
		const t = transport();
		const opening = await f.attempt.opening;
		await writeNoiseBytes(t.raw[0], opening.bytes);
		await writeNoiseBytes(t.raw[0], Uint8Array.of(255));
		await flush();
		await flush();

		const inbound = acceptTraversalNoiseResponder({
			stream: t.raw[1],
			sessionId: f.attempt.sessionId,
			verifiedMessageADigest: opening.digest,
			localIdentity: f.remoteIdentity,
			expectedRemotePin: f.localIdentity.expectedPin,
			deadlineMs: 11000,
		});

		await expect(inbound).rejects.toThrow();
		expect(t.channels[1].sent).toEqual([]);
	});
});

describe("traversal Noise attachment and cancellation", () => {
	it.each(["cancel", "deadline", "target", "buffered", "closed"] as const)(
		"rejects %s attachment and releases the offered transport",
		async (kind) => {
			const f = prepare();
			const t = transport(kind === "target" ? "target" : "source", {
				deadlineMs: kind === "deadline" ? 20000 : 11000,
			});
			await f.attempt.opening;
			const offered = t.raw[0];
			if (kind === "cancel") f.attempt.cancel();
			if (kind === "deadline") {
				vi.mocked(performance.now).mockReturnValue(11000);
				await vi.advanceTimersByTimeAsync(10000);
			}
			if (kind === "closed") {
				t.raw[0].destroy();
				await Promise.allSettled([finished(t.raw[0])]);
			}
			if (kind === "buffered") {
				await writeNoiseBytes(t.raw[1], Uint8Array.of(1));
				await flush();
			}

			const attach = () => Reflect.apply(f.attempt.attachAndRelease, f.attempt, [offered]);

			if (kind === "deadline") expect(offered.destroyed).toBe(false);
			expect(attach).toThrow();
			await expect(f.attempt.authenticated).rejects.toThrow();
			await Promise.allSettled(t.raw.map((s) => finished(s)));
			expect(offered.destroyed).toBe(true);
			expect(t.channels.map((c) => c.disposals)).toEqual([1, 1]);
		},
	);
	it("disposes both transports on a second attachment", async () => {
		const f = prepare();
		const first = transport();
		const second = transport();
		await f.attempt.opening;
		f.attempt.attachAndRelease(first.raw[0]);

		const attach = () => f.attempt.attachAndRelease(second.raw[0]);

		expect(attach).toThrow();
		await expect(f.attempt.authenticated).rejects.toThrow();
		await Promise.allSettled([...first.raw, ...second.raw].map((s) => finished(s)));
		expect([...first.channels, ...second.channels].map((c) => c.disposals)).toEqual([1, 1, 1, 1]);
	});
	it("rejects and destroys a plain Duplex offered as traversal", async () => {
		const f = prepare();
		const offered = new Duplex({
			read() {},
			write(_chunk, _encoding, done) {
				done();
			},
		});
		offered.on("error", () => {});
		await f.attempt.opening;

		const attach = () => Reflect.apply(f.attempt.attachAndRelease, f.attempt, [offered]);

		expect(attach).toThrow();
		await expect(f.attempt.authenticated).rejects.toThrow();
		await Promise.allSettled([finished(offered)]);
		expect(offered.destroyed).toBe(true);
	});

	it("rejects opening and authentication when the buffer cannot hold Message A", async () => {
		const f = prepare(undefined, { bufferBytes: 33 });

		const outcomes = await Promise.allSettled([f.attempt.opening, f.attempt.authenticated]);

		expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
		for (const outcome of outcomes) {
			if (outcome.status === "rejected") {
				expect(outcome.reason).toBeInstanceOf(Error);
				expect(outcome.reason.message).toMatch(/buffer exceeded/);
			}
		}
	});

	it.each(["signal", "premature-close"] as const)(
		"fails closed during handshake on %s",
		async (kind) => {
			const controller = new AbortController();
			const f = prepare(controller.signal);
			const t = transport();
			await f.attempt.opening;

			f.attempt.attachAndRelease(t.raw[0]);
			if (kind === "signal") controller.abort(new Error("Caller cancelled"));
			if (kind === "premature-close") t.channels[0].close();

			await expect(f.attempt.authenticated).rejects.toThrow();
			await Promise.allSettled(t.raw.map((s) => finished(s)));
			expect(t.channels.map((c) => [c.disposals, c.listeners])).toEqual([
				[1, 0],
				[1, 0],
			]);
		},
	);
});
