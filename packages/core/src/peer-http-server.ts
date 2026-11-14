import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import type { OwnedPeerHttpConnection } from "./peer-http-client.js";
import { adoptPeerHttpConnection, PeerHttpLifetime } from "./peer-http-client-lifecycle.js";
import { readPeerHttpBodyLength } from "./peer-http-headers.js";
import { PEER_HTTP_LIMITS, PeerHttpExchangeError } from "./peer-http-policy.js";
import { capturePeerHttpResponse } from "./peer-http-server-response.js";
import { PeerHttpWireAudit } from "./peer-http-wire-audit.js";
import { readAuthenticatedRelayNoisePeerPin } from "./relay-noise.js";
import { RelayNoiseDuplex } from "./relay-noise-stream.js";

export interface PeerHttpServerRequest {
	readonly method: "GET" | "POST";
	readonly target: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly bodyBytes: Uint8Array;
	readonly peerPin: string;
	readonly signal: AbortSignal;
}

export interface PeerHttpServerResponse {
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly bodyBytes: Uint8Array;
}

export interface PeerHttpServerOptions {
	readonly origin: string;
	readonly dispatch: (request: PeerHttpServerRequest) => Promise<PeerHttpServerResponse>;
	readonly deadlineMs?: number;
	readonly signal?: AbortSignal;
}

function captureOptions(options: PeerHttpServerOptions, startedAt: number) {
	try {
		const { origin, dispatch, deadlineMs, signal } = options;
		const parsed = new URL(origin);
		if (
			typeof origin !== "string" ||
			!/^https?:\/\/[^/?#]+\/?$/.test(origin) ||
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			parsed.username ||
			parsed.password ||
			parsed.pathname !== "/" ||
			parsed.search ||
			parsed.hash ||
			typeof dispatch !== "function" ||
			(deadlineMs !== undefined && !Number.isFinite(deadlineMs)) ||
			(signal !== undefined && !(signal instanceof AbortSignal))
		)
			throw new Error();
		return {
			origin: parsed.origin,
			host: parsed.host,
			dispatch,
			signal,
			deadline: Math.min(startedAt + PEER_HTTP_LIMITS.exchangeMs, deadlineMs ?? Infinity),
		};
	} catch {
		throw new PeerHttpExchangeError("framing");
	}
}

function requireFreshConnection(duplex: Duplex): string {
	if (
		!(duplex instanceof RelayNoiseDuplex) ||
		duplex.destroyed ||
		duplex.errored ||
		duplex.readableEnded ||
		duplex.writableEnded ||
		duplex.writableLength !== 0 ||
		duplex.readableFlowing === true
	)
		throw new PeerHttpExchangeError("transport");
	const peerPin = readAuthenticatedRelayNoisePeerPin(duplex);
	if (peerPin === null) throw new PeerHttpExchangeError("transport");
	if (!duplex.claimFreshPlaintext()) throw new PeerHttpExchangeError("transport");
	return peerPin;
}

function validateTargetCharacters(target: string): void {
	for (const character of target) {
		const code = character.charCodeAt(0);
		if (code <= 32 || code === 127 || character === "\\" || character === "#")
			throw new PeerHttpExchangeError("framing");
	}
}

interface CapturedRequest {
	readonly method: "GET" | "POST";
	readonly target: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly length: number;
}

function captureRequest(
	incoming: IncomingMessage,
	options: ReturnType<typeof captureOptions>,
): CapturedRequest {
	const method = incoming.method;
	const target = incoming.url;
	if (
		(method !== "GET" && method !== "POST") ||
		incoming.httpVersion !== "1.1" ||
		target === undefined ||
		!target.startsWith("/") ||
		target.startsWith("//")
	)
		throw new PeerHttpExchangeError("framing");
	validateTargetCharacters(target);
	const url = options.origin + target;
	const parsed = new URL(url);
	if (parsed.pathname + parsed.search !== target) throw new PeerHttpExchangeError("framing");
	const length = readPeerHttpBodyLength(incoming.rawHeaders, { direction: "request" });
	const headers: Record<string, string> = Object.create(null);
	for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
		const name = incoming.rawHeaders[index];
		const value = incoming.rawHeaders[index + 1];
		if (typeof name !== "string" || typeof value !== "string")
			throw new PeerHttpExchangeError("framing");
		headers[name.toLowerCase()] = value;
	}
	if (headers.host !== options.host) throw new PeerHttpExchangeError("framing");
	return { method, target, url, headers: Object.freeze(headers), length };
}

function receiveBody(incoming: IncomingMessage, length: number, lifetime: PeerHttpLifetime) {
	return new Promise<Buffer>((resolve, reject) => {
		const bytes = Buffer.alloc(length);
		let received = 0;
		incoming.once("error", () => reject(lifetime.fail("transport")));
		incoming.once("aborted", () => reject(lifetime.fail("framing")));
		incoming.on("data", (chunk: Buffer) => {
			if (!Buffer.isBuffer(chunk) || received + chunk.length > length) {
				reject(lifetime.fail("framing"));
				return;
			}
			chunk.copy(bytes, received);
			received += chunk.length;
		});
		incoming.once("end", () => {
			if (!incoming.complete || received !== length || incoming.rawTrailers.length !== 0)
				reject(lifetime.fail("framing"));
			else resolve(bytes);
		});
	});
}

function observeRequest(duplex: Duplex, lifetime: PeerHttpLifetime) {
	const audit = new PeerHttpWireAudit({ direction: "request" });
	const eof = Promise.withResolvers<void>();
	void eof.promise.catch(() => {});
	const data = (chunk: unknown): void => {
		try {
			audit.observe(chunk);
		} catch {
			lifetime.fail("framing");
		}
	};
	const end = (): void => {
		try {
			audit.finish();
			eof.resolve();
		} catch {
			eof.reject(lifetime.fail("framing"));
		}
	};
	const error = (): void => {
		lifetime.fail("transport");
	};
	duplex.on("data", data);
	duplex.once("end", end);
	duplex.on("error", error);
	return {
		audit,
		eof: eof.promise,
		remove: () => {
			duplex.off("data", data);
			duplex.off("end", end);
			duplex.off("error", error);
		},
	};
}

async function writeResponse(
	response: ServerResponse,
	captured: ReturnType<typeof capturePeerHttpResponse>,
	lifetime: PeerHttpLifetime,
): Promise<void> {
	lifetime.check();
	response.sendDate = false;
	response.writeHead(captured.status, captured.message, captured.headers);
	for (let offset = 0; offset < captured.body.length; offset += 16384) {
		lifetime.check();
		let drained = false;
		let written = false;
		let resume = (): void => {};
		const onDrain = (): void => {
			drained = true;
			resume();
		};
		try {
			await lifetime.wait(
				new Promise<void>((resolve, reject) => {
					resume = () => {
						if (drained && written) resolve();
					};
					response.once("drain", onDrain);
					drained = response.write(captured.body.subarray(offset, offset + 16384), (error) => {
						if (error) reject(lifetime.fail("transport"));
						else {
							written = true;
							resume();
						}
					});
					resume();
				}),
			);
		} finally {
			response.off("drain", onDrain);
		}
	}
	lifetime.check();
	await lifetime.wait(new Promise<void>((resolve) => response.end(resolve)));
}

async function dispatchRequest(
	incoming: IncomingMessage,
	response: ServerResponse,
	options: ReturnType<typeof captureOptions>,
	audit: PeerHttpWireAudit,
	lifetime: PeerHttpLifetime,
	peerPin: string,
): Promise<void> {
	response.on("error", () => lifetime.fail("transport"));
	lifetime.check();
	let request: ReturnType<typeof captureRequest>;
	try {
		request = captureRequest(incoming, options);
		audit.expectBodyBytes(request.length);
	} catch {
		throw lifetime.fail("framing");
	}
	const bodyBytes = await lifetime.wait(receiveBody(incoming, request.length, lifetime));
	lifetime.check();
	const dto: PeerHttpServerRequest = Object.freeze({
		method: request.method,
		target: request.target,
		url: request.url,
		headers: request.headers,
		bodyBytes,
		peerPin,
		signal: lifetime.controller.signal,
	});
	const result = await lifetime.wait(options.dispatch(dto));
	lifetime.check();
	let captured: ReturnType<typeof capturePeerHttpResponse>;
	try {
		captured = capturePeerHttpResponse(result);
	} catch (error) {
		throw lifetime.fail(error instanceof PeerHttpExchangeError ? error.code : "framing");
	}
	lifetime.check();
	await writeResponse(response, captured, lifetime);
}

async function exchange(
	duplex: Duplex,
	completion: Promise<void>,
	options: ReturnType<typeof captureOptions>,
	lifetime: PeerHttpLifetime,
): Promise<void> {
	const peerPin = requireFreshConnection(duplex);
	duplex.pause();
	const observer = observeRequest(duplex, lifetime);
	const plaintext = finished(duplex, { cleanup: true });
	void plaintext.catch(() => {});
	const response = Promise.withResolvers<void>();
	void response.promise.catch(() => {});
	let requested = false;
	const server = createServer({
		// captureRequest requires the logical Host before dispatch. Avoid Node's implicit 400 bypass.
		requireHostHeader: false,
		maxHeaderSize: PEER_HTTP_LIMITS.headerBytes,
		requestTimeout: 0,
		headersTimeout: 0,
		keepAliveTimeout: 0,
	});
	// Preserve a pending response when request EOF arrives before asynchronous dispatch finishes.
	Object.assign(server, { httpAllowHalfOpen: true });
	server.maxHeadersCount = 0;
	server.on("request", (incoming, outgoing) => {
		if (requested) {
			lifetime.fail("framing");
			return;
		}
		requested = true;
		void dispatchRequest(incoming, outgoing, options, observer.audit, lifetime, peerPin).then(
			response.resolve,
			() => response.reject(lifetime.fail("transport")),
		);
	});
	for (const event of ["checkContinue", "checkExpectation", "upgrade", "connect", "clientError"])
		server.on(event, () => lifetime.fail("framing"));
	try {
		// The independent audit precedes Node's synchronous pure-JS socket parser attachment.
		server.emit("connection", duplex);
		duplex.resume();
		await lifetime.wait(Promise.all([response.promise, observer.eof, plaintext, completion]));
	} finally {
		observer.remove();
	}
}

/** Inert one-exchange adapter. The caller's dispatcher must enforce channel-bound authorization. */
export async function servePeerHttpConnection(
	connection: OwnedPeerHttpConnection,
	options: PeerHttpServerOptions,
): Promise<void> {
	const startedAt = performance.now();
	let owner: ReturnType<typeof adoptPeerHttpConnection> | undefined;
	let lifetime: PeerHttpLifetime | undefined;
	let stop: (() => void) | undefined;
	try {
		owner = adoptPeerHttpConnection(connection);
		if (!owner.valid) throw new PeerHttpExchangeError("transport");
		const captured = captureOptions(options, startedAt);
		lifetime = new PeerHttpLifetime(captured.deadline, captured.signal);
		const active = lifetime;
		const duplex = owner.duplex;
		stop = () => {
			duplex.destroy(active.fail("transport"));
		};
		active.controller.signal.addEventListener("abort", stop, { once: true });
		void owner.completion.catch(() => active.fail("transport"));
		active.check();
		await exchange(duplex, owner.completion, captured, active);
	} catch (error) {
		const code = error instanceof PeerHttpExchangeError ? error.code : "transport";
		const failure = lifetime?.fail(code) ?? new PeerHttpExchangeError(code);
		if (owner?.valid) owner.duplex.destroy(failure);
		if (owner) await owner.dispose(failure);
		throw failure;
	} finally {
		if (stop) lifetime?.controller.signal.removeEventListener("abort", stop);
		lifetime?.close();
	}
}
