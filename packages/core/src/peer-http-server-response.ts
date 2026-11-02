import { STATUS_CODES } from "node:http";
import { readPeerHttpBodyLength } from "./peer-http-headers.js";
import { PEER_HTTP_LIMITS, PeerHttpExchangeError } from "./peer-http-policy.js";
import type { PeerHttpServerResponse } from "./peer-http-server.js";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const tag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const nativeSet = Uint8Array.prototype.set;

function copyResponseBody(bytes: Uint8Array): Buffer {
	if (tag?.call(bytes) !== "Uint8Array") throw new PeerHttpExchangeError("framing");
	const length: number = byteLength?.call(bytes);
	if (length > PEER_HTTP_LIMITS.responseBytes)
		throw new PeerHttpExchangeError("response_too_large");
	if (!Number.isSafeInteger(length) || length < 0) throw new PeerHttpExchangeError("framing");
	const owned = Buffer.alloc(length);
	nativeSet.call(owned, bytes);
	return owned;
}

function captureHeaders(supplied: PeerHttpServerResponse["headers"], length: number) {
	const headers: Record<string, string> = Object.create(null);
	const rawHeaders: string[] = [];
	if (supplied !== undefined) {
		if (typeof supplied !== "object" || supplied === null || Array.isArray(supplied))
			throw new PeerHttpExchangeError("framing");
		for (const name of Object.keys(supplied)) {
			const value = supplied[name];
			if (typeof value !== "string") throw new PeerHttpExchangeError("framing");
			rawHeaders.push(name, value);
			headers[name.toLowerCase()] = value;
		}
	}
	if (headers["content-length"] === undefined) rawHeaders.push("content-length", String(length));
	if (readPeerHttpBodyLength(rawHeaders, { direction: "response" }) !== length)
		throw new PeerHttpExchangeError("framing");
	headers["content-length"] = String(length);
	headers.connection = "close";
	return headers;
}

/** Capture and account for every byte before allowing native HTTP to write anything. */
export function capturePeerHttpResponse(response: PeerHttpServerResponse) {
	try {
		const { status, headers: supplied, bodyBytes } = response;
		if (!Number.isSafeInteger(status) || status < 200 || status > 599)
			throw new PeerHttpExchangeError("framing");
		const body = copyResponseBody(bodyBytes);
		if ((status === 204 || status === 304) && body.length !== 0)
			throw new PeerHttpExchangeError("framing");
		const headers = captureHeaders(supplied, body.length);
		const message = STATUS_CODES[status] ?? "unknown";
		let size = Buffer.byteLength(`HTTP/1.1 ${status} ${message}\r\n\r\n`, "latin1");
		for (const [name, value] of Object.entries(headers))
			size += Buffer.byteLength(`${name}: ${value}\r\n`, "latin1");
		if (size > PEER_HTTP_LIMITS.headerBytes) throw new PeerHttpExchangeError("framing");
		return { status, message, headers, body };
	} catch (error) {
		if (error instanceof PeerHttpExchangeError) throw error;
		throw new PeerHttpExchangeError("framing");
	}
}
