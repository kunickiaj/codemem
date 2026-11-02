import { createHash } from "node:crypto";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupRendezvous,
	rendezvousFixture,
	sourceOffer,
	sourceRelease,
	targetAnswer,
} from "./peer-traversal-rendezvous-test-fixtures.js";
import { TraversalByteStream } from "./peer-traversal-stream.js";
import { channelPair, flush } from "./peer-traversal-stream-test-fixtures.js";
import { readNoiseBytes, streamEvent } from "./relay-noise-test-fixtures.js";

afterEach(cleanupRendezvous);

describe("controlled in-process traversal rendezvous, without RTC or network sockets", () => {
	it("gates the same held A and responder B on both peers' own decisions, authenticates the phase pins and closes causally", async () => {
		const f = await rendezvousFixture();
		try {
			expect(f.store.options.proof.value.sessionId).toBe(
				Buffer.from(f.prepared.sessionId).toString("hex"),
			);
			expect(f.store.options.proof.value.sessionId).toMatch(/^[0-9a-f]{32}$/);
			expect(f.opening.digest).toBe(createHash("sha256").update(f.opening.bytes).digest("hex"));

			await sourceOffer(f);
			await targetAnswer(f);
			expect(f.channels.map((channel) => channel.sent.length)).toEqual([0, 0]);
			const [source, target] = await sourceRelease(f);
			const complete = [...f.raw, source.duplex, target.duplex].map((stream) => finished(stream));
			for (const promise of complete) void promise.catch(() => {});
			const payload = Buffer.alloc(32768);
			for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
			const received = readNoiseBytes(target.duplex, payload.length);
			const sourceEof = streamEvent(target.duplex, "end");
			source.duplex.end(payload);
			const request = await received;
			target.duplex.resume();
			await sourceEof;
			expect(f.channels.map((channel) => channel.disposals)).toEqual([0, 0]);
			const echo = readNoiseBytes(source.duplex, payload.length);
			const targetEof = streamEvent(source.duplex, "end");
			target.duplex.end(request);
			const response = await echo;
			source.duplex.resume();
			await targetEof;
			await Promise.all(complete);
			await Promise.all(f.raw.map((stream) => stream.disposed));
			await flush();

			expect(request).toEqual(payload);
			expect(response).toEqual(payload);
			expect(source.observedPin).toBe(f.targetIdentity.expectedPin);
			expect(target.observedPin).toBe(f.sourceIdentity.expectedPin);
			expect(f.trace.indexOf("target:own:offer-check")).toBeLessThan(
				f.trace.indexOf("target:apply-offer"),
			);
			expect(f.trace.indexOf("target:own:answer")).toBeLessThan(
				f.trace.indexOf("target:accept-noise"),
			);
			expect(f.trace.indexOf("source:own:answer-check")).toBeLessThan(
				f.trace.indexOf("source:apply-answer"),
			);
			expect(f.trace.indexOf("source:apply-answer")).toBeLessThan(f.trace.indexOf("wire:A"));
			expect(f.trace.indexOf("wire:A")).toBeLessThan(f.trace.indexOf("wire:B"));
			expect(f.channels[0].sent[0]?.subarray(2)).toEqual(f.opening.bytes);
			expect(
				f.channels[0].sent.filter((frame) =>
					Buffer.from(frame.subarray(2)).equals(Buffer.from(f.opening.bytes)),
				),
			).toHaveLength(1);
			expect(f.raw.map((stream) => stream.errored)).toEqual([null, null]);
			expect(
				f.channels.map((channel) => [channel.disposals, channel.listeners, channel.dropped]),
			).toEqual([
				[1, 0, 0],
				[1, 0, 0],
			]);
		} finally {
			await cleanupRendezvous();
		}
	}, 15000);
});

describe("rendezvous prefix and own-response denials", () => {
	it.each(["offer", "answer"] as const)(
		"rejects a substituted %s signature at the strict prefix before apply/release",
		async (phase) => {
			const f = await rendezvousFixture();
			try {
				await sourceOffer(f, { substitute: phase === "offer" });
				if (phase === "offer")
					await expect(targetAnswer(f)).rejects.toThrow("invalid offer prefix");
				else {
					await targetAnswer(f, { substitute: true });
					await expect(sourceRelease(f)).rejects.toThrow("invalid answer prefix");
				}

				expect(f.trace).not.toContain(
					phase === "offer" ? "target:send:offer-check" : "source:send:answer-check",
				);
				expect(f.trace).not.toContain(
					phase === "offer" ? "target:apply-offer" : "source:apply-answer",
				);
				expect(f.channels.map((channel) => channel.sent.length)).toEqual([0, 0]);
			} finally {
				await cleanupRendezvous();
			}
		},
	);
	it.each(["offer-check", "answer", "answer-check"] as const)(
		"denies own %s before its corresponding apply/B/A use",
		async (phase) => {
			const f = await rendezvousFixture({ denyPhase: phase });
			try {
				await sourceOffer(f);
				if (phase === "answer-check") {
					await targetAnswer(f);
					await expect(sourceRelease(f)).rejects.toThrow(`own ${phase} denied`);
				} else await expect(targetAnswer(f)).rejects.toThrow(`own ${phase} denied`);

				const blocked = {
					"offer-check": "target:apply-offer",
					answer: "target:accept-noise",
					"answer-check": "source:apply-answer",
				};
				expect(f.trace).not.toContain(blocked[phase]);
				expect(f.channels.map((channel) => channel.sent.length)).toEqual([0, 0]);
			} finally {
				await cleanupRendezvous();
			}
		},
	);
	it("rejects a late own final reply, holds A, and transfers rejected late attachment ownership to cancellation", async () => {
		const f = await rendezvousFixture({ lateOwnReply: true });
		try {
			await sourceOffer(f);
			await targetAnswer(f);
			await expect(sourceRelease(f)).rejects.toThrow("own answer-check denied");
			expect(
				await f.store.db.all("SELECT phase FROM traversal_attempts WHERE session_id=?1", [
					f.store.options.proof.value.sessionId,
				]),
			).toEqual([{ phase: 5 }]);
			expect(f.trace).not.toContain("source:apply-answer");
			expect(f.channels.map((channel) => channel.sent.length)).toEqual([0, 0]);
			f.prepared.cancel();
			await expect(f.prepared.authenticated).rejects.toThrow();
			const lateChannels = channelPair();
			const late = new TraversalByteStream({
				channel: lateChannels[0],
				side: "source",
				deadlineMs: performance.now() + 5000,
			});
			try {
				expect(() => f.prepared.attachAndRelease(late)).toThrow();
				await late.disposed;
				await flush();
				expect(late.destroyed).toBe(true);
				expect([
					lateChannels[0].disposals,
					lateChannels[0].listeners,
					lateChannels[0].sent.length,
				]).toEqual([1, 0, 0]);
			} finally {
				late.destroy();
			}
		} finally {
			await cleanupRendezvous();
		}
	});
});
