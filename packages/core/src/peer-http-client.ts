import { type ClientRequest, type IncomingMessage, request } from "node:http";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { adoptPeerHttpConnection, PeerHttpLifetime } from "./peer-http-client-lifecycle.js";
import { preparePeerHttpRequest, readPeerHttpBodyLength } from "./peer-http-headers.js";
import { PeerHttpExchangeError } from "./peer-http-policy.js";
import { PeerHttpWireAudit } from "./peer-http-wire-audit.js";
import { RelayNoiseDuplex } from "./relay-noise-stream.js";
import type { RequestJsonExecutor } from "./sync-http-client.js";

export interface OwnedPeerHttpConnection {
	readonly duplex: Duplex;
	/** Resolves only after clean underlying raw I/O AND resource disposal. */
	readonly completion: Promise<void>;
	/** Idempotently owns the entire channel and settles within the cleanup grace. */
	dispose(error: Error): Promise<void>;
}

export interface PeerHttpConnectionFactory {
	open(options: { signal: AbortSignal; deadlineMs: number }): Promise<OwnedPeerHttpConnection>;
}

type Owner = ReturnType<typeof adoptPeerHttpConnection>;
type ValidOwner = Extract<Owner, { valid: true }>;
type Prepared = ReturnType<typeof preparePeerHttpRequest>;

function requireFreshConnection(duplex: Duplex): void {
	if (
		!(duplex instanceof RelayNoiseDuplex) ||
		duplex.destroyed ||
		duplex.errored ||
		duplex.readableEnded ||
		duplex.writableEnded ||
		duplex.readableLength !== 0 ||
		duplex.writableLength !== 0 ||
		duplex.readableFlowing === true
	)
		throw new PeerHttpExchangeError("transport");
}

function decodeResponse(bytes: Buffer): Record<string, unknown> | null {
	if (bytes.length === 0) return null;
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		if (typeof value === "object" && value !== null && !Array.isArray(value))
			return value as Record<string, unknown>;
		return { error: "unexpected_json_type" };
	} catch {
		return { error: "non_json_response" };
	}
}

function receiveResponse(
	response: IncomingMessage,
	audit: PeerHttpWireAudit,
	lifetime: PeerHttpLifetime,
	maxBodyBytes: number,
) {
	return new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
		response.once("error", () => reject(lifetime.fail("transport")));
		response.once("aborted", () => reject(lifetime.fail("framing")));
		try {
			const status = response.statusCode;
			if (response.httpVersion !== "1.1" || status === undefined || status < 200 || status > 599)
				throw new PeerHttpExchangeError("framing");
			const length = readPeerHttpBodyLength(response.rawHeaders, {
				direction: "response",
				maxBodyBytes,
			});
			audit.expectBodyBytes(length);
			const bytes = Buffer.alloc(length);
			let received = 0;
			response.on("data", (chunk: Buffer) => {
				if (!Buffer.isBuffer(chunk) || received + chunk.length > length) {
					reject(lifetime.fail("framing"));
					return;
				}
				chunk.copy(bytes, received);
				received += chunk.length;
			});
			response.once("end", () => {
				if (!response.complete || received !== length || response.rawTrailers.length !== 0)
					reject(lifetime.fail("framing"));
				else resolve({ status, bytes });
			});
		} catch (error) {
			const code = error instanceof PeerHttpExchangeError ? error.code : "framing";
			reject(lifetime.fail(code));
		}
	});
}

async function writeRequest(
	req: ClientRequest,
	body: Buffer,
	lifetime: PeerHttpLifetime,
): Promise<void> {
	for (let offset = 0; offset < body.length; offset += 16384) {
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
					req.once("drain", onDrain);
					drained = req.write(body.subarray(offset, offset + 16384), (error) => {
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
			req.off("drain", onDrain);
		}
	}
	await lifetime.wait(new Promise<void>((resolve) => req.end(resolve)));
}

function observePlaintext(duplex: Duplex, lifetime: PeerHttpLifetime) {
	// Native headers classify a declared excess before the audit binds the validated length.
	const audit = new PeerHttpWireAudit({ direction: "response" });
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

function startRequest(
	duplex: Duplex,
	prepared: Prepared,
	audit: PeerHttpWireAudit,
	lifetime: PeerHttpLifetime,
) {
	const response = Promise.withResolvers<{ status: number; bytes: Buffer }>();
	void response.promise.catch(() => {});
	const req = request(
		{
			method: prepared.method,
			hostname: prepared.hostname,
			path: prepared.path,
			headers: prepared.headers,
			setHost: false,
			maxHeaderSize: 16384,
			createConnection: () => duplex,
			lookup: () => {
				throw new PeerHttpExchangeError("transport");
			},
			signal: lifetime.controller.signal,
		},
		(incoming) => {
			void receiveResponse(incoming, audit, lifetime, prepared.maxResponseBytes).then((result) => {
				try {
					duplex.end();
					response.resolve(result);
				} catch {
					response.reject(lifetime.fail("transport"));
				}
			}, response.reject);
		},
	);
	// Preserve every field for policy validation. The independent byte cap still applies.
	req.maxHeadersCount = 0;
	req.once("socket", () => duplex.resume());
	req.on("error", () => lifetime.fail("transport"));
	for (const event of ["information", "continue", "upgrade", "connect"])
		req.on(event, () => lifetime.fail("framing"));
	return { req, response: response.promise };
}

async function exchange(owner: ValidOwner, prepared: Prepared, lifetime: PeerHttpLifetime) {
	requireFreshConnection(owner.duplex);
	// Node installs its parser on the next tick. Resume only after its socket event.
	owner.duplex.pause();
	const observer = observePlaintext(owner.duplex, lifetime);
	const plaintextCompletion = finished(owner.duplex, { cleanup: true });
	void plaintextCompletion.catch(() => {});
	try {
		const { req, response } = startRequest(owner.duplex, prepared, observer.audit, lifetime);
		const [result] = await lifetime.wait(
			Promise.all([
				response,
				observer.eof,
				plaintextCompletion,
				owner.completion,
				writeRequest(req, prepared.body, lifetime),
			]),
		);
		lifetime.check();
		const payload = decodeResponse(result.bytes);
		lifetime.check();
		return [result.status, payload] as [number, Record<string, unknown> | null];
	} finally {
		observer.remove();
	}
}

interface ExecutorOptions {
	factory: PeerHttpConnectionFactory;
	signal?: AbortSignal;
	deadlineMs?: number;
}

function captureExecutorOptions(options: ExecutorOptions) {
	try {
		const { factory, signal, deadlineMs } = options;
		const open = factory.open.bind(factory);
		if (
			(deadlineMs !== undefined && !Number.isFinite(deadlineMs)) ||
			(signal !== undefined && !(signal instanceof AbortSignal))
		)
			throw new Error();
		return { open, signal, deadlineMs };
	} catch {
		throw new PeerHttpExchangeError("framing");
	}
}

/** Inert injected executor. One fresh owned Noise connection per call, with no retry or fallback. */
export function createPeerHttpExecutor(options: ExecutorOptions): RequestJsonExecutor {
	const { open, signal, deadlineMs } = captureExecutorOptions(options);
	return async (method, url, requestOptions = {}) => {
		const startedAt = performance.now();
		const prepared = preparePeerHttpRequest(method, url, requestOptions);
		const deadline = Math.min(startedAt + prepared.lifetimeMs, deadlineMs ?? Infinity);
		const lifetime = new PeerHttpLifetime(deadline, signal);
		let owner: Owner | undefined;
		try {
			lifetime.check();
			const opening = Promise.resolve(
				open({ signal: lifetime.controller.signal, deadlineMs: deadline }),
			).then((connection) => {
				owner = adoptPeerHttpConnection(connection);
				if (owner.valid) void owner.completion.catch(() => lifetime.fail("transport"));
				if (lifetime.failed) void owner.dispose(lifetime.fail("transport")).catch(() => {});
				return owner;
			});
			const acquired = await lifetime.wait(opening);
			if (!acquired.valid) throw lifetime.fail("transport");
			return await exchange(acquired, prepared, lifetime);
		} catch {
			const failure = lifetime.fail("transport");
			if (owner) await owner.dispose(failure);
			throw failure;
		} finally {
			lifetime.close();
		}
	};
}
