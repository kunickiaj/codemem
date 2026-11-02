import type { MemoryStore } from "@codemem/core";
import { createSyncApp } from "./index.js";

export interface SyncChannelRequest {
	readonly method: "GET" | "POST";
	readonly target: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly bodyBytes: Uint8Array;
	readonly peerPin: string;
	readonly signal: AbortSignal;
}

export interface SyncChannelResponse {
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly bodyBytes: Uint8Array;
}

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function errorResponse(status: number, error: string): SyncChannelResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		bodyBytes: new TextEncoder().encode(JSON.stringify({ error })),
	};
}

function hasForbiddenUrlCharacters(value: string): boolean {
	return Array.from(value).some(
		(char) =>
			char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === "\\" || char === "#",
	);
}

function validLogicalUrl(url: string, target: string): URL | null {
	if (!target.startsWith("/") || target.startsWith("//") || hasForbiddenUrlCharacters(target))
		return null;
	if (hasForbiddenUrlCharacters(url) || !/^https?:\/\//.test(url)) return null;
	try {
		const parsed = new URL(url);
		if (parsed.username || parsed.password || parsed.hash) return null;
		if (parsed.pathname + parsed.search !== target) return null;
		// Parsing must not normalize the signed origin-form target.
		const authorityEnd = url.indexOf("/", url.indexOf("://") + 3);
		return authorityEnd >= 0 && url.slice(authorityEnd) === target ? parsed : null;
	} catch {
		return null;
	}
}

function checkCancellation(signal: AbortSignal): void {
	if (signal.aborted) throw new Error("Sync channel dispatch cancelled");
}

function invalidGetBody(method: string, body: Uint8Array): boolean {
	return method === "GET" && body.byteLength > 0;
}

async function collectResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) {
		checkCancellation(signal);
		return new Uint8Array(0);
	}
	let cancelled = false;
	const cancel = () => {
		if (cancelled) return;
		cancelled = true;
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			checkCancellation(signal);
			const chunk = await reader.read();
			checkCancellation(signal);
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > MAX_RESPONSE_BYTES) throw new Error("Sync channel response too large");
			chunks.push(chunk.value.slice());
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	} catch {
		cancel();
		throw new Error("Sync channel response collection failed");
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

function prepareChannelRequest(
	input: SyncChannelRequest,
): { request: Request; peerPin: string } | SyncChannelResponse {
	const { method, target, url, peerPin, signal } = input;
	checkCancellation(signal);
	if (method !== "GET" && method !== "POST") return errorResponse(404, "not found");
	const parsed = validLogicalUrl(url, target);
	if (!parsed) return errorResponse(400, "invalid_request");
	if (parsed.pathname !== "/v1/ops") return errorResponse(404, "not found");
	const source = input.bodyBytes;
	if (source.byteLength > MAX_REQUEST_BYTES) return errorResponse(413, "payload_too_large");
	if (invalidGetBody(method, source)) return errorResponse(400, "invalid_request");
	const body = new Uint8Array(source);
	const headers = new Headers(input.headers);
	for (const name of ["host", "content-length", "connection"]) headers.delete(name);
	const request = new Request(url, {
		method,
		headers,
		signal,
		body: method === "POST" ? body : undefined,
	});
	return { request, peerPin };
}

export function createSyncChannelDispatcher(options: {
	readonly storeFactory: () => MemoryStore;
}): (request: SyncChannelRequest) => Promise<SyncChannelResponse> {
	const storeFactory = options.storeFactory.bind(options);
	const pins = new WeakMap<Request, string>();
	const app = createSyncApp({
		storeFactory,
		syncChannelPeerPin: (request) => pins.get(request) ?? null,
	});
	return async (input) => {
		const prepared = prepareChannelRequest(input);
		if (!("request" in prepared)) return prepared;
		const { request, peerPin } = prepared;
		const signal = request.signal;
		pins.set(request, peerPin);
		try {
			checkCancellation(signal);
			const response = await app.fetch(request);
			const bodyBytes = await collectResponse(response, signal);
			return { status: response.status, headers: Object.fromEntries(response.headers), bodyBytes };
		} finally {
			pins.delete(request);
		}
	};
}
