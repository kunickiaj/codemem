import { validateHeaderName, validateHeaderValue } from "node:http";
import { PEER_HTTP_LIMITS, PeerHttpExchangeError } from "./peer-http-policy.js";
import type { RequestJsonOptions } from "./sync-http-client.js";

const FORBIDDEN = new Set(["transfer-encoding", "trailer", "upgrade", "expect"]);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const tag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const nativeSet = Uint8Array.prototype.set;

export function peerHttpBodyCap(direction: "request" | "response", supplied?: number): number {
	const maximum =
		direction === "request" ? PEER_HTTP_LIMITS.requestBytes : PEER_HTTP_LIMITS.responseBytes;
	const value = supplied === undefined ? maximum : supplied;
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
		throw new PeerHttpExchangeError("framing");
	return value;
}

function validateHeader(name: string, value: string, seen: Set<string>): string {
	validateHeaderName(name);
	validateHeaderValue(name, value);
	const lower = name.toLowerCase();
	if (typeof value !== "string" || seen.has(lower) || FORBIDDEN.has(lower))
		throw new PeerHttpExchangeError("framing");
	seen.add(lower);
	return lower;
}

function declaredLength(rawHeaders: readonly string[]): number {
	if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) throw new Error();
	const seen = new Set<string>();
	let declared: string | undefined;
	for (let index = 0; index < rawHeaders.length; index += 2) {
		const name = rawHeaders[index];
		const value = rawHeaders[index + 1];
		if (typeof name !== "string" || typeof value !== "string") throw new Error();
		if (validateHeader(name, value, seen) === "content-length") declared = value;
	}
	if (declared === undefined || !/^[0-9]+$/.test(declared)) throw new Error();
	return Number(declared);
}

/** Header policy only. The caller separately checks HTTP version, trailers and wire EOF. */
export function readPeerHttpBodyLength(
	rawHeaders: readonly string[],
	options: { direction: "request" | "response"; maxBodyBytes?: number },
): number {
	let captured: { direction: "request" | "response"; cap: number; length: number };
	try {
		const { direction, maxBodyBytes } = options;
		if (direction !== "request" && direction !== "response") throw new Error();
		captured = {
			direction,
			cap: peerHttpBodyCap(direction, maxBodyBytes),
			length: declaredLength(rawHeaders),
		};
	} catch {
		throw new PeerHttpExchangeError("framing");
	}
	if (captured.length > captured.cap && captured.direction === "response")
		throw new PeerHttpExchangeError("response_too_large");
	if (!Number.isSafeInteger(captured.length) || captured.length > captured.cap)
		throw new PeerHttpExchangeError("framing");
	return captured.length;
}

function copyBody(options: RequestJsonOptions): { bytes: Buffer; supplied: boolean } {
	const bytes = options.bodyBytes;
	if (bytes === undefined) {
		if (options.body !== undefined) throw new Error();
		return { bytes: Buffer.alloc(0), supplied: false };
	}
	if (tag?.call(bytes) !== "Uint8Array") throw new Error();
	const length: number = byteLength?.call(bytes);
	if (!Number.isSafeInteger(length) || length > PEER_HTTP_LIMITS.requestBytes) throw new Error();
	const owned = Buffer.alloc(length);
	nativeSet.call(owned, bytes);
	return { bytes: owned, supplied: true };
}

function requestTarget(url: string) {
	if (typeof url !== "string") throw new Error();
	for (const character of url) {
		const code = character.charCodeAt(0);
		if (code <= 32 || code === 127 || character === "\\" || character === "#") throw new Error();
	}
	const parsed = new URL(url);
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username ||
		parsed.password
	)
		throw new Error();
	const match = /^https?:\/\/[^/?#]+(.*)$/.exec(url);
	let path = match?.[1];
	if (path === undefined) throw new Error();
	if (path === "" || path.startsWith("?")) path = `/${path}`;
	if (path !== parsed.pathname + parsed.search) throw new Error();
	return { path, host: parsed.host, hostname: parsed.hostname };
}

function prepareHeaders(
	supplied: Record<string, string> | undefined,
	host: string,
	body: ReturnType<typeof copyBody>,
) {
	const headers: Record<string, string> = Object.create(null);
	const seen = new Set<string>();
	if (supplied !== undefined) {
		if (typeof supplied !== "object" || supplied === null || Array.isArray(supplied))
			throw new Error();
		for (const name of Object.keys(supplied)) {
			const value = supplied[name];
			if (typeof value !== "string") throw new Error();
			headers[validateHeader(name, value, seen)] = value;
		}
	}
	if (headers.host !== undefined && headers.host !== host) throw new Error();
	const length = headers["content-length"];
	if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) !== body.bytes.length))
		throw new Error();
	headers.host = host;
	headers.connection = "close";
	headers["content-length"] ??= String(body.bytes.length);
	headers.accept ??= "application/json";
	if (body.supplied) headers["content-type"] ??= "application/json";
	return headers;
}

/** Captures request inputs and bounds the exact deterministic native header serialization. */
export function preparePeerHttpRequest(method: string, url: string, options: RequestJsonOptions) {
	try {
		if (typeof options !== "object" || options === null || Array.isArray(options))
			throw new Error();
		if (method !== "GET" && method !== "POST") throw new Error();
		const target = requestTarget(url);
		const body = copyBody(options);
		const { headers: supplied, timeoutS, maxResponseBytes } = options;
		if (timeoutS !== undefined && (!Number.isFinite(timeoutS) || timeoutS <= 0 || timeoutS > 60))
			throw new Error();
		const headers = prepareHeaders(supplied, target.host, body);
		let headerBytes = Buffer.byteLength(`${method} ${target.path} HTTP/1.1\r\n\r\n`, "latin1");
		for (const [name, value] of Object.entries(headers))
			headerBytes += Buffer.byteLength(`${name}: ${value}\r\n`, "latin1");
		if (headerBytes > PEER_HTTP_LIMITS.headerBytes) throw new Error();
		return {
			method,
			...target,
			headers,
			body: body.bytes,
			lifetimeMs: timeoutS === undefined ? PEER_HTTP_LIMITS.exchangeMs : timeoutS * 1000,
			maxResponseBytes: peerHttpBodyCap("response", maxResponseBytes),
		};
	} catch {
		throw new PeerHttpExchangeError("framing");
	}
}
