import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { vi } from "vitest";
import type { OwnedPeerHttpConnection } from "./peer-http-client.js";
import { deferred } from "./peer-http-test-fixtures.js";
import {
	acceptTraversalNoiseResponder,
	prepareTraversalNoiseInitiator,
} from "./peer-traversal-noise.js";
import { TraversalByteStream } from "./peer-traversal-stream.js";
import { channelPair } from "./peer-traversal-stream-test-fixtures.js";
import { disposableNoiseIdentity, writeNoiseBytes } from "./relay-noise-test-fixtures.js";

function localOwner(duplex: Duplex, raw: TraversalByteStream): OwnedPeerHttpConnection {
	const completion = Promise.all([
		finished(duplex, { cleanup: true }),
		finished(raw, { cleanup: true }),
		raw.disposed,
	]).then(() => {});
	void completion.catch(() => {});
	const dispose = vi.fn(async (error: Error) => {
		duplex.destroy(error);
		raw.destroy(error);
		await Promise.allSettled([completion, raw.disposed]);
	});
	return { duplex, completion, dispose };
}

/** Actual Label 3 traversal and Noise I/O over controlled application queues, with no sockets. */
export async function serverNoisePair() {
	const channels = channelPair({ deferredDelivery: true });
	const deadlineMs = performance.now() + 60000;
	const sourceRaw = new TraversalByteStream({ channel: channels[0], side: "source", deadlineMs });
	const targetRaw = new TraversalByteStream({ channel: channels[1], side: "target", deadlineMs });
	const raw = [sourceRaw, targetRaw] as const;
	const errors: Error[] = [];
	for (const stream of raw) {
		stream.on("error", (error) => errors.push(error));
		void stream.disposed.catch(() => {});
	}
	const sourceIdentity = disposableNoiseIdentity();
	const targetIdentity = disposableNoiseIdentity();
	const attempt = prepareTraversalNoiseInitiator({
		localIdentity: sourceIdentity,
		expectedRemotePin: targetIdentity.expectedPin,
		deadlineMs,
	});
	const opening = await attempt.opening;
	const inbound = acceptTraversalNoiseResponder({
		stream: targetRaw,
		localIdentity: targetIdentity,
		expectedRemotePin: sourceIdentity.expectedPin,
		sessionId: attempt.sessionId,
		verifiedMessageADigest: opening.digest,
		deadlineMs,
	});
	attempt.attachAndRelease(sourceRaw);
	const [source, target] = await Promise.all([attempt.authenticated, inbound]);
	for (const stream of [source.duplex, target.duplex])
		stream.on("error", (error) => errors.push(error));
	const sourceOwner = localOwner(source.duplex, sourceRaw);
	const targetOwner = localOwner(target.duplex, targetRaw);
	return {
		channels,
		raw,
		errors,
		source: source.duplex,
		target: target.duplex,
		sourceOwner,
		targetOwner,
		async close() {
			for (const stream of [source.duplex, target.duplex, ...raw]) stream.destroy();
			await Promise.allSettled([sourceOwner.completion, targetOwner.completion]);
		},
	};
}

export const ORIGIN = "https://peer.invalid";
export const TARGET = "/a%2fb?z=2&x=%2f&z=1";

export function requestWire(
	options: {
		method?: string;
		target?: string;
		version?: string;
		headers?: string;
		body?: Uint8Array;
	} = {},
): Buffer {
	const body = options.body ?? Buffer.alloc(0);
	const head = `${options.method ?? "GET"} ${options.target ?? TARGET} HTTP/${options.version ?? "1.1"}\r\n${options.headers ?? `Host: peer.invalid\r\nContent-Length: ${body.length}\r\nConnection: close\r\n`}\r\n`;
	return Buffer.concat([Buffer.from(head, "latin1"), body]);
}

/** Source-side observation only. Attaching this makes that source unsuitable for the native client. */
export function captureServerWire(source: Duplex) {
	const complete = deferred<Buffer>();
	const chunks: Buffer[] = [];
	const bytes = () => Buffer.concat(chunks);
	source.on("data", (chunk: Buffer) => {
		chunks.push(Buffer.from(chunk));
		const wire = bytes();
		const boundary = wire.indexOf("\r\n\r\n");
		if (boundary < 0) return;
		const length = /\r\ncontent-length: ([0-9]+)\r\n/i.exec(
			wire.subarray(0, boundary + 4).toString("latin1"),
		);
		if (length && wire.length >= boundary + 4 + Number(length[1])) complete.resolve(wire);
	});
	source.once("error", complete.reject);
	source.once("close", () => complete.reject(new Error("Fixture source closed")));
	return { bytes, complete: complete.promise };
}

export async function writeServerRequest(source: Duplex, wire: Uint8Array): Promise<void> {
	for (let offset = 0; offset < wire.length; offset += 16384)
		await writeNoiseBytes(source, wire.subarray(offset, offset + 16384));
}
