import { request } from "node:http";
import type { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";
import { PeerHttpExchangeError } from "./peer-http-policy.js";
import { PeerHttpWireAudit } from "./peer-http-wire-audit.js";
import {
	acceptTraversalNoiseResponder,
	prepareTraversalNoiseInitiator,
} from "./peer-traversal-noise.js";
import { TraversalByteStream } from "./peer-traversal-stream.js";
import { channelPair } from "./peer-traversal-stream-test-fixtures.js";
import { RelayNoiseDuplex } from "./relay-noise-stream.js";
import { disposableNoiseIdentity, writeNoiseBytes } from "./relay-noise-test-fixtures.js";

const DATA_EXCHANGE_MS = 10000;
function barrier() {
	const result = Promise.withResolvers<void>();
	void result.promise.catch(() => {});
	return result;
}
function responseHeader(length: number, headerBytes?: number) {
	const base = `HTTP/1.1 200 OK\r\nContent-Length: ${length}\r\nConnection: close\r\n`;
	if (headerBytes === undefined) return Buffer.from(`${base}\r\n`);
	const padding = headerBytes - Buffer.byteLength(`${base}X-Pad: \r\n\r\n`, "latin1");
	return Buffer.from(`${base}X-Pad: ${"x".repeat(padding)}\r\n\r\n`, "latin1");
}

function nativeRequest(options: {
	source: Duplex;
	audit: PeerHttpWireAudit;
	signal: AbortSignal;
	errors: Error[];
	onAudit: (action: () => void) => void;
	onEnd: () => void;
}) {
	const { source, audit, signal, errors, onAudit, onEnd } = options;
	let parserComplete = false;
	let parserEnd = false;
	let stateAtParserEnd: string | undefined;
	const received: Buffer[] = [];
	const lookup = vi.fn(() => {
		throw new Error("Unexpected network fallback");
	});
	const parsed = Promise.allSettled([
		new Promise<void>((resolve, reject) => {
			const req = request(
				{
					host: "in-memory.invalid",
					path: "/",
					method: "GET",
					headers: { Connection: "close" },
					maxHeaderSize: 16384,
					createConnection: () => source,
					lookup,
					signal,
				},
				(res) => {
					res.on("error", (error) => {
						errors.push(error);
						reject(error);
					});
					onAudit(() => {
						const lengths = res.rawHeaders.flatMap((value, index, headers) =>
							index % 2 === 0 && value.toLowerCase() === "content-length"
								? [headers[index + 1]]
								: [],
						);
						if (
							lengths.length !== 1 ||
							typeof lengths[0] !== "string" ||
							!/^(0|[1-9][0-9]*)$/.test(lengths[0]) ||
							res.headers["transfer-encoding"] !== undefined
						)
							throw new Error("Fixture requires a single native-validated Content-Length");
						audit.expectBodyBytes(Number(lengths[0]));
					});
					res.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));
					res.on("end", () => {
						parserComplete = res.complete;
						parserEnd = true;
						stateAtParserEnd = audit.state;
						source.end();
						onEnd();
						resolve();
					});
				},
			);
			expect(Reflect.get(req, "agent")).toBeUndefined();
			req.on("error", (error) => {
				errors.push(error);
				reject(error);
			});
			req.end();
		}),
	]);
	return {
		parsed,
		lookup,
		view: () => ({
			parserComplete,
			parserEnd,
			stateAtParserEnd,
			received: Buffer.concat(received),
		}),
	};
}

type ExchangeOptions = {
	extra?: "X" | "response";
	late?: boolean;
	body?: Buffer;
	headerBytes?: number;
};

async function writeResponse(input: {
	target: Duplex;
	options: ExchangeOptions;
	responseEnded: Promise<void>;
	sourceEnded: Promise<void>;
	auditFailed: Promise<void>;
}) {
	const { target, options, responseEnded, sourceEnded, auditFailed } = input;
	const body = options.body ?? Buffer.from("{}");
	const complete = Buffer.concat([responseHeader(body.length, options.headerBytes), body]);
	let extra = Buffer.alloc(0);
	if (options.extra === "X") extra = Buffer.from("X");
	if (options.extra === "response") extra = Buffer.concat([responseHeader(2), Buffer.from("{}")]);
	if (options.body === undefined) {
		await writeNoiseBytes(target, options.late ? complete : Buffer.concat([complete, extra]));
	} else {
		await writeNoiseBytes(target, responseHeader(body.length));
		for (let offset = 0; offset < body.length; offset += 32768) {
			await writeNoiseBytes(target, body.subarray(offset, offset + 32768));
		}
	}
	if (options.late) {
		await responseEnded;
		await sourceEnded;
		await writeNoiseBytes(target, extra);
		// Do not queue target End before the audit observes the bad late DATA frame.
		await auditFailed;
		return;
	}
	await sourceEnded;
	target.end();
}

async function exchange(options: ExchangeOptions = {}) {
	const channels = channelPair({ deferredDelivery: true });
	const controller = new AbortController();
	const deadlineMs = performance.now() + DATA_EXCHANGE_MS;
	const raw = [
		new TraversalByteStream({ channel: channels[0], side: "source", deadlineMs }),
		new TraversalByteStream({ channel: channels[1], side: "target", deadlineMs }),
	] as const;
	const plain: Duplex[] = [];
	const errors: Error[] = [];
	for (const stream of raw) stream.on("error", (error) => errors.push(error));
	const audit = new PeerHttpWireAudit({ direction: "response" });
	const auditFailures: unknown[] = [];
	const auditFailed = barrier();
	const responseEnded = barrier();
	const sourceEnded = barrier();
	try {
		const sourceIdentity = disposableNoiseIdentity();
		const targetIdentity = disposableNoiseIdentity();
		const initiator = prepareTraversalNoiseInitiator({
			localIdentity: sourceIdentity,
			expectedRemotePin: targetIdentity.expectedPin,
			deadlineMs,
			signal: controller.signal,
		});
		const opening = await initiator.opening;
		const inbound = acceptTraversalNoiseResponder({
			stream: raw[1],
			localIdentity: targetIdentity,
			expectedRemotePin: sourceIdentity.expectedPin,
			sessionId: initiator.sessionId,
			verifiedMessageADigest: opening.digest,
			deadlineMs,
			signal: controller.signal,
		});
		initiator.attachAndRelease(raw[0]);
		const [{ duplex: source }, { duplex: target }] = await Promise.all([
			initiator.authenticated,
			inbound,
		]);
		plain.push(source, target);
		for (const stream of plain) stream.on("error", (error) => errors.push(error));
		const guarded = (action: () => void) => {
			try {
				action();
			} catch (error) {
				auditFailures.push(error);
				auditFailed.resolve();
				const failure = error instanceof Error ? error : new Error("Unexpected audit failure");
				for (const stream of [...plain, ...raw]) stream.destroy(failure);
			}
		};
		// These observers precede Node's parser and stay installed through plaintext EOF.
		source.on("data", (bytes: unknown) => guarded(() => audit.observe(bytes)));
		source.on("end", () => guarded(() => audit.finish()));
		const streams = Promise.allSettled([...plain, ...raw].map((stream) => finished(stream)));
		target.on("data", () => {});
		target.once("end", sourceEnded.resolve);
		target.once("error", sourceEnded.reject);
		source.once("error", responseEnded.reject);
		const native = nativeRequest({
			source,
			audit,
			signal: controller.signal,
			errors,
			onAudit: guarded,
			onEnd: responseEnded.resolve,
		});
		const writing = Promise.allSettled([
			writeResponse({
				target,
				options,
				responseEnded: responseEnded.promise,
				sourceEnded: sourceEnded.promise,
				auditFailed: auditFailed.promise,
			}),
		]);
		const [parserResults, writerResults, streamResults] = await Promise.all([
			native.parsed,
			writing,
			streams,
		]);
		await Promise.allSettled(raw.map((stream) => stream.disposed));
		return {
			audit,
			auditFailures,
			...native.view(),
			errors,
			channels,
			lookup: native.lookup,
			parserResults,
			writerResults,
			streamResults,
			realNoise: source instanceof RelayNoiseDuplex && target instanceof RelayNoiseDuplex,
		};
	} finally {
		controller.abort();
		for (const stream of [...plain, ...raw]) stream.destroy(new Error("Test cleanup"));
		await Promise.allSettled(raw.map((stream) => finished(stream)));
	}
}

describe("native HTTP framing audit over real Noise and traversal", () => {
	it.each([2, 2 * 1024 * 1024])(
		"completes an exact %i-byte body and causal clean shutdown",
		async (size) => {
			const body = size === 2 ? undefined : Buffer.alloc(size, 37);
			const expectedBody = body ?? Buffer.from("{}");

			const result = await exchange({ body });

			expect(result.realNoise).toBe(true);
			expect(result.received.byteLength).toBe(expectedBody.byteLength);
			expect(result.received.equals(expectedBody)).toBe(true);
			expect(result.parserComplete).toBe(true);
			expect(result.parserEnd).toBe(true);
			expect(result.stateAtParserEnd).toBe("body");
			expect(result.audit.state).toBe("ended");
			expect(result.auditFailures).toEqual([]);
			expect(result.errors).toEqual([]);
			expect(
				[...result.parserResults, ...result.writerResults, ...result.streamResults].map(
					(r) => r.status,
				),
			).toEqual(new Array(6).fill("fulfilled"));
			expect(result.lookup).not.toHaveBeenCalled();
			expect(result.channels.map((c) => [c.disposals, c.dropped, c.listeners])).toEqual([
				[1, 0, 0],
				[1, 0, 0],
			]);
		},
		DATA_EXCHANGE_MS + 5000,
	);

	it.each([
		["X", false],
		["X", true],
		["response", false],
		["response", true],
	] as const)(
		"rejects surplus %s with late frame=%s",
		async (extra, late) => {
			const result = await exchange({ extra, late });

			expect(result.realNoise).toBe(true);
			expect(result.audit.state).toBe("failed");
			expect(result.auditFailures[0]).toBeInstanceOf(PeerHttpExchangeError);
			expect(result.auditFailures[0]).toHaveProperty("code", "framing");
			expect(result.streamResults.some((r) => r.status === "rejected")).toBe(true);
			if (late) {
				expect(result.parserComplete).toBe(true);
				expect(result.parserEnd).toBe(true);
				expect(result.received).toEqual(Buffer.from("{}"));
				expect(result.stateAtParserEnd).toBe("body");
			}
			expect(result.lookup).not.toHaveBeenCalled();
			expect(result.channels.map((c) => [c.disposals, c.listeners])).toEqual([
				[1, 0],
				[1, 0],
			]);
		},
		DATA_EXCHANGE_MS + 5000,
	);

	it.each([16384, 16385])(
		"audits actual native response header wire size %i",
		async (headerBytes) => {
			const result = await exchange({ headerBytes });

			if (headerBytes === 16384) {
				expect(result.audit.state).toBe("ended");
				expect(result.received).toEqual(Buffer.from("{}"));
				expect(result.errors).toEqual([]);
				expect(result.channels.map((c) => c.dropped)).toEqual([0, 0]);
			} else {
				expect(result.audit.state).toBe("failed");
				expect(result.auditFailures[0]).toHaveProperty("code", "framing");
			}
			expect(result.channels.map((c) => [c.disposals, c.listeners])).toEqual([
				[1, 0],
				[1, 0],
			]);
		},
		DATA_EXCHANGE_MS + 5000,
	);
});
