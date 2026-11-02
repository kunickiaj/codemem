import type { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { vi } from "vitest";
import type { OwnedPeerHttpConnection, PeerHttpConnectionFactory } from "./peer-http-client.js";
import {
	acceptTraversalNoiseResponder,
	prepareTraversalNoiseInitiator,
} from "./peer-traversal-noise.js";
import { TraversalByteStream } from "./peer-traversal-stream.js";
import { channelPair } from "./peer-traversal-stream-test-fixtures.js";
import { disposableNoiseIdentity, writeNoiseBytes } from "./relay-noise-test-fixtures.js";

export function deferred<T = void>() {
	const result = Promise.withResolvers<T>();
	void result.promise.catch(() => {});
	return result;
}

export interface PeerReply {
	body?: Buffer;
	head?: string;
	extra?: Buffer;
	late?: boolean;
	truncate?: boolean;
	status?: number;
}

export function jsonBytes(size: number): Buffer {
	const prefix = Buffer.from('{"data":"');
	const suffix = Buffer.from('"}');
	return Buffer.concat([prefix, Buffer.alloc(size - prefix.length - suffix.length, 120), suffix]);
}

async function answer(
	target: Duplex,
	request: Promise<Buffer>,
	eof: Promise<void>,
	reply: PeerReply,
) {
	await request;
	const body = reply.body ?? Buffer.from('{"ok":true}');
	const head =
		reply.head ??
		`HTTP/1.1 ${reply.status ?? 200} OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
	const extra = reply.extra ?? Buffer.alloc(0);
	if (body.length < 32768) {
		await writeNoiseBytes(
			target,
			Buffer.concat([Buffer.from(head), body, reply.late ? Buffer.alloc(0) : extra]),
		);
	} else {
		await writeNoiseBytes(target, Buffer.from(head));
		for (let offset = 0; offset < body.length; offset += 32768) {
			await writeNoiseBytes(target, body.subarray(offset, offset + 32768));
		}
		if (!reply.late && extra.length > 0) {
			await writeNoiseBytes(target, extra);
		}
	}
	if (reply.truncate) {
		target.destroy(new Error("Fixture truncated response"));
		return;
	}
	await eof;
	if (reply.late) {
		await writeNoiseBytes(target, extra);
		// The client must reject the late DATA before any target End enters the channel.
		await new Promise<void>((resolve) => target.once("close", resolve));
		return;
	}
	target.end();
}

function rawPair(deadlineMs: number) {
	const channels = channelPair({ deferredDelivery: true });
	const raw = [
		new TraversalByteStream({ channel: channels[0], side: "source", deadlineMs }),
		new TraversalByteStream({ channel: channels[1], side: "target", deadlineMs }),
	] as const;
	const errors: Error[] = [];
	for (const stream of raw) stream.on("error", (error) => errors.push(error));
	return { channels, raw, errors };
}

async function authenticatePair(
	options: Parameters<PeerHttpConnectionFactory["open"]>[0],
	identities: readonly [
		ReturnType<typeof disposableNoiseIdentity>,
		ReturnType<typeof disposableNoiseIdentity>,
	],
) {
	const pair = rawPair(options.deadlineMs);
	const attempt = prepareTraversalNoiseInitiator({
		localIdentity: identities[0],
		expectedRemotePin: identities[1].expectedPin,
		...options,
	});
	const opening = await attempt.opening;
	const inbound = acceptTraversalNoiseResponder({
		stream: pair.raw[1],
		localIdentity: identities[1],
		expectedRemotePin: identities[0].expectedPin,
		sessionId: attempt.sessionId,
		verifiedMessageADigest: opening.digest,
		...options,
	});
	attempt.attachAndRelease(pair.raw[0]);
	const [{ duplex: source }, { duplex: target }] = await Promise.all([
		attempt.authenticated,
		inbound,
	]);
	for (const stream of [source, target]) stream.on("error", (error) => pair.errors.push(error));
	const io = Promise.all([source, target, ...pair.raw].map((stream) => finished(stream))).then(
		async () => {
			await Promise.all(pair.raw.map((stream) => stream.disposed));
		},
	);
	void io.catch(() => {});
	return { ...pair, source, target, io };
}

function captureRequest(target: Duplex) {
	const request = deferred<Buffer>();
	const eof = deferred();
	const chunks: Buffer[] = [];
	let length = 0;
	target.on("data", (chunk: Buffer) => {
		chunks.push(Buffer.from(chunk));
		length += chunk.length;
		const wire = Buffer.concat(chunks, length);
		const boundary = wire.indexOf("\r\n\r\n");
		if (boundary < 0) return;
		const declared = /\r\ncontent-length: ([0-9]+)\r\n/i.exec(
			wire.subarray(0, boundary + 4).toString("latin1"),
		);
		if (declared && length === boundary + 4 + Number(declared[1])) request.resolve(wire);
	});
	target.once("end", eof.resolve);
	target.once("error", (error) => {
		request.reject(error);
		eof.reject(error);
	});
	return { request: request.promise, eof: eof.promise };
}

function ownedExchange(
	pair: Awaited<ReturnType<typeof authenticatePair>>,
	reply: PeerReply,
	completionGate?: Promise<void>,
) {
	const capture = captureRequest(pair.target);
	const serving = answer(pair.target, capture.request, capture.eof, reply);
	void serving.catch(() => {});
	const dispose = vi.fn(async (error: Error) => {
		for (const stream of [pair.source, pair.target, ...pair.raw]) stream.destroy(error);
		await Promise.allSettled([pair.io, ...pair.raw.map((stream) => stream.disposed)]);
	});
	const completion = pair.io.then(async () => {
		await completionGate;
	});
	void completion.catch(() => {});
	const connection: OwnedPeerHttpConnection = { duplex: pair.source, completion, dispose };
	return { ...pair, connection, request: capture.request, serving };
}

export function peerHttpFactory(reply: PeerReply = {}, completionGate?: Promise<void>) {
	const identities = [disposableNoiseIdentity(), disposableNoiseIdentity()] as const;
	const exchanges: ReturnType<typeof ownedExchange>[] = [];
	const opened = deferred<ReturnType<typeof ownedExchange>>();
	async function open(options: Parameters<PeerHttpConnectionFactory["open"]>[0]) {
		const result = ownedExchange(
			await authenticatePair(options, identities),
			reply,
			completionGate,
		);
		exchanges.push(result);
		opened.resolve(result);
		return result;
	}
	const factory: PeerHttpConnectionFactory = {
		open: vi.fn(async (options) => (await open(options)).connection),
	};
	return {
		factory,
		exchanges,
		opened: opened.promise,
		async close() {
			for (const item of exchanges) {
				for (const stream of [item.source, item.target, ...item.raw])
					stream.destroy(new Error("Test cleanup"));
				await Promise.allSettled([item.io, item.serving]);
			}
		},
	};
}
