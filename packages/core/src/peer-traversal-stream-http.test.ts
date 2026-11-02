import { Buffer } from "node:buffer";
import { once } from "node:events";
import {
	type ClientRequest,
	createServer,
	type IncomingMessage,
	request,
	type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TraversalByteStream } from "./peer-traversal-stream.js";
import { channelPair, flush } from "./peer-traversal-stream-test-fixtures.js";
import {
	acceptRelayNoiseResponder,
	prepareRelayNoiseInitiator,
	type RelayNoiseOptions,
} from "./relay-noise.js";
import { disposableNoiseIdentity } from "./relay-noise-test-fixtures.js";

const DATA_EXCHANGE_MS = 10000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function noiseFixture(signal?: AbortSignal) {
	const channels = channelPair({ deferredDelivery: true });
	const deadlineMs = performance.now() + DATA_EXCHANGE_MS;
	const make = (i: 0 | 1) =>
		new TraversalByteStream({
			channel: channels[i],
			side: i === 0 ? "source" : "target",
			deadlineMs,
			signal,
		});
	const raw = [make(0), make(1)] as const;
	const errors: Error[] = [];
	for (const stream of raw) stream.on("error", (error) => errors.push(error));
	const plain: Duplex[] = [];
	cleanups.push(async () => {
		for (const stream of [...plain, ...raw]) stream.destroy(new Error("Test cleanup"));
		await Promise.allSettled(raw.map((stream) => stream.disposed));
	});
	const identities = [disposableNoiseIdentity(), disposableNoiseIdentity()] as const;
	const options = (i: 0 | 1): RelayNoiseOptions => ({
		transport: raw[i],
		localIdentity: identities[i],
		expectedRemotePin: identities[i === 0 ? 1 : 0].expectedPin,
		context: { transportLabel: 1, sessionId: Buffer.alloc(16, 7) },
		deadlineMs,
		signal,
	});
	const initiator = prepareRelayNoiseInitiator(options(0));
	const opening = await initiator.opening;
	const responder = acceptRelayNoiseResponder({
		...options(1),
		verifiedMessageADigest: opening.digest,
		acceptedAtMs: performance.now(),
	});
	initiator.release(performance.now());
	const secured = await Promise.all([initiator.authenticated, responder]);
	for (const result of secured) {
		plain.push(result.duplex);
		result.duplex.on("error", (error) => errors.push(error));
	}
	return { channels, raw, source: secured[0].duplex, target: secured[1].duplex, errors };
}

/** This harness requires HTTP framing so source EOF never depends on raw transport EOF. */
function framed(response: IncomingMessage, method: string): boolean {
	return (
		method === "HEAD" ||
		response.statusCode === 204 ||
		response.headers["content-length"] !== undefined ||
		response.headers["transfer-encoding"] === "chunked"
	);
}

function httpExchange(
	source: Duplex,
	target: Duplex,
	handler: (response: ServerResponse, incoming: IncomingMessage) => Promise<void>,
	options: {
		method?: string;
		signal?: AbortSignal;
		onHeaders?: () => void;
		requestBody?: Buffer;
		requestFraming?: "content-length" | "chunked";
	} = {},
) {
	const server = createServer({
		requestTimeout: 0,
		headersTimeout: 0,
		keepAliveTimeout: 0,
		maxHeaderSize: 32768,
	});
	const serving = Promise.withResolvers<void>();
	void serving.promise.catch(() => {});
	server.on(
		"request",
		(incoming, response) => void handler(response, incoming).then(serving.resolve, serving.reject),
	);
	server.on("clientError", serving.reject);
	const method = options.method ?? "GET";
	const lookup = vi.fn(() => {
		throw new Error("Unexpected DNS/TCP fallback");
	});
	const connect = vi.fn(() => source);
	let headers = false;
	let complete = false;
	const parserEnd = vi.fn(() => source.end());
	const requestHeaders: Record<string, string | number> = { Connection: "close" };
	if (options.requestBody !== undefined) {
		if (options.requestFraming === "chunked") requestHeaders["Transfer-Encoding"] = "chunked";
		else requestHeaders["Content-Length"] = options.requestBody.length;
	}
	const result = new Promise<Buffer>((resolve, reject) => {
		const req = request(
			{
				host: "in-memory.invalid",
				path: "/",
				method,
				headers: requestHeaders,
				createConnection: connect,
				lookup,
				signal: options.signal,
			},
			(response) => {
				headers = true;
				response.on("error", reject);
				if (!framed(response, method)) {
					const failure = new Error("Self-framed HTTP response required");
					reject(failure);
					req.destroy(failure);
					return;
				}
				options.onHeaders?.();
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					complete = response.complete;
					// HTTP message completion, rather than raw EOF, starts source shutdown.
					parserEnd();
					resolve(Buffer.concat(chunks));
				});
			},
		);
		req.on("error", reject);
		expect(Reflect.get(req, "agent")).toBeUndefined();
		void writeRequest(req, options.requestBody).catch(reject);
	});
	server.emit("connection", target);
	return {
		result,
		serving: serving.promise,
		lookup,
		connect,
		parserEnd,
		state: () => ({ headers, complete }),
		close: () => server.close(),
	};
}

async function writeRequest(req: ClientRequest, body?: Buffer): Promise<void> {
	if (body !== undefined) {
		for (let offset = 0; offset < body.length; offset += 16384) {
			if (!req.write(body.subarray(offset, offset + 16384))) await once(req, "drain");
		}
	}
	req.end();
}

async function writeBody(response: ServerResponse, body: Buffer): Promise<void> {
	for (let offset = 0; offset < body.length; offset += 32768) {
		if (!response.write(body.subarray(offset, offset + 32768))) await once(response, "drain");
	}
	response.end();
}

describe("native HTTP over Noise over traversal without network sockets", () => {
	it("models SDK acceptance separately from peer delivery and drops in-flight frames on disposal", async () => {
		// Arrange
		const [source, target] = channelPair({ deferredDelivery: true });
		const received = vi.fn();
		const unsubscribe = source.onMessage(received);
		// Act
		target.send(Uint8Array.of(1, 0, 42));
		expect(target.bufferedAmount).toBe(0);
		expect(received).not.toHaveBeenCalled();
		await target.dispose();
		await flush();
		unsubscribe();
		// Assert: premature disposal really destroys an accepted frame in this fixture.
		expect(received).not.toHaveBeenCalled();
		expect(target.dropped).toBe(1);
	});

	it.each(["content-length", "chunked", "HEAD", "204"])(
		"completes %s responses before source-initiated physical close",
		async (mode) => {
			// Arrange: SDK-visible buffer is zero while one-frame-per-turn delivery remains pending.
			const f = await noiseFixture();
			const bodyless = mode === "HEAD" || mode === "204";
			const body = Buffer.alloc(bodyless ? 0 : 2 * 1024 * 1024, 37);
			for (let index = 0; index < body.length; index++) body[index] = index % 251;
			const exchange = httpExchange(
				f.source,
				f.target,
				async (response) => {
					if (mode === "content-length") response.setHeader("Content-Length", body.length);
					if (mode === "HEAD") response.setHeader("Content-Length", 2 * 1024 * 1024);
					if (mode === "204") response.statusCode = 204;
					await writeBody(response, body);
				},
				{ method: mode === "HEAD" ? "HEAD" : "GET" },
			);
			// Act
			const received = await exchange.result;
			await exchange.serving;
			await Promise.all(f.raw.map((stream) => stream.disposed));
			await flush();
			exchange.close();
			// Assert
			expect(received).toEqual(body);
			expect(exchange.state()).toEqual({ headers: true, complete: true });
			expect(exchange.connect).toHaveBeenCalledTimes(1);
			expect(exchange.lookup).not.toHaveBeenCalled();
			expect(f.errors).toEqual([]);
			expect(
				f.channels.map((channel) => [channel.disposals, channel.dropped, channel.listeners]),
			).toEqual([
				[1, 0, 0],
				[1, 0, 0],
			]);
		},
		// The runner must outlast the 10-second data deadline plus disposal and teardown.
		DATA_EXCHANGE_MS + 5000,
	);
});

describe("native POST request bodies over Noise over traversal", () => {
	it.each(["content-length", "chunked"] as const)(
		"parses exact %s request bytes before replying and physically closing",
		async (requestFraming) => {
			// Arrange
			const f = await noiseFixture();
			const body = Buffer.from(' \t{"text":"héllo 🌲"}\r\n'.repeat(1000));
			const reply = Buffer.concat([Buffer.from("received:\n"), body, Buffer.from("\t done\r\n")]);
			const requests: IncomingMessage[] = [];
			const receivedBodies: Buffer[] = [];
			const exchange = httpExchange(
				f.source,
				f.target,
				async (response, incoming) => {
					requests.push(incoming);
					const chunks: Buffer[] = [];
					for await (const chunk of incoming) {
						if (!Buffer.isBuffer(chunk)) throw new TypeError("Native HTTP body must contain bytes");
						chunks.push(chunk);
					}
					receivedBodies.push(Buffer.concat(chunks));
					expect(f.channels.map((channel) => channel.disposals)).toEqual([0, 0]);
					response.setHeader("Content-Length", reply.length);
					await writeBody(response, reply);
				},
				{ method: "POST", requestBody: body, requestFraming },
			);
			// Act
			const received = await exchange.result;
			await exchange.serving;
			await Promise.all(f.raw.map((stream) => stream.disposed));
			await flush();
			exchange.close();
			// Assert: Native HTTP parses both request framing variants, including all UTF-8 bytes.
			expect(receivedBodies).toEqual([body]);
			expect(received).toEqual(reply);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.method).toBe("POST");
			expect(requests[0]?.complete).toBe(true);
			if (requestFraming === "content-length")
				expect(requests[0]?.headers["content-length"]).toBe(String(body.length));
			else expect(requests[0]?.headers["transfer-encoding"]).toBe("chunked");
			expect(exchange.state()).toEqual({ headers: true, complete: true });
			expect(exchange.parserEnd).toHaveBeenCalledTimes(1);
			expect(f.source.writableEnded).toBe(true);
			expect(exchange.connect).toHaveBeenCalledTimes(1);
			expect(exchange.lookup).not.toHaveBeenCalled();
			expect(f.errors).toEqual([]);
			expect(
				f.channels.map((channel) => [channel.disposals, channel.dropped, channel.listeners]),
			).toEqual([
				[1, 0, 0],
				[1, 0, 0],
			]);
		},
	);
});

describe("native HTTP framing and cancellation failures", () => {
	it("rejects a close-delimited response at headers without waiting for transport EOF", async () => {
		// Arrange
		const f = await noiseFixture();
		const exchange = httpExchange(f.source, f.target, async (response) => {
			response.useChunkedEncodingByDefault = false;
			response.writeHead(200, { Connection: "close" });
			response.flushHeaders();
		});
		// Act / Assert
		await expect(exchange.result).rejects.toThrow("Self-framed HTTP response required");
		expect(exchange.state()).toEqual({ headers: true, complete: false });
		for (const stream of f.raw) stream.destroy(new Error("Rejected HTTP framing"));
		await Promise.all(f.raw.map((stream) => stream.disposed));
		exchange.close();
		expect(exchange.lookup).not.toHaveBeenCalled();
	});

	it("cancels the HTTP/Noise/traversal pipeline by signal after response headers", async () => {
		// Arrange
		const controller = new AbortController();
		const f = await noiseFixture(controller.signal);
		const reason = new Error("Explicit test cancellation");
		const aborted = vi.spyOn(controller, "abort");
		const exchange = httpExchange(
			f.source,
			f.target,
			async (response) => {
				response.writeHead(200, { "Content-Length": 1024 });
				response.flushHeaders();
			},
			{ signal: controller.signal, onHeaders: () => controller.abort(reason) },
		);
		// Act
		const failure: unknown = await exchange.result.catch((error: unknown) => error);
		await Promise.all(f.raw.map((stream) => stream.disposed));
		await flush();
		exchange.close();
		// Assert: the expected failure is explicit cancellation, never the fixture deadline.
		expect(failure).toBeInstanceOf(Error);
		expect(f.errors).toContain(failure);
		expect(aborted).toHaveBeenCalledExactlyOnceWith(reason);
		expect(controller.signal.reason).toBe(reason);
		expect(exchange.state()).toEqual({ headers: true, complete: false });
		expect(f.channels.map((channel) => [channel.disposals, channel.listeners])).toEqual([
			[1, 0],
			[1, 0],
		]);
		expect(exchange.lookup).not.toHaveBeenCalled();
	});
});
