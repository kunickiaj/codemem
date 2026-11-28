import type { MemoryStore } from "@codemem/core";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";
import { createSyncApp } from "./sync-app.js";
import type { NoiseChannelPeer, SyncServerMode } from "./sync-server-mode.js";

export interface SyncChannelRequest {
	readonly method: "GET" | "POST";
	readonly target: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly bodyBytes: Uint8Array;
	readonly peerPin: string;
	/** The device a direct Noise channel admitted. Relay channels bind the key only. */
	readonly peerDeviceId?: string;
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
	const isOps = parsed.pathname === "/v1/ops";
	const isRead = method === "GET" && ["/v1/status", "/v1/snapshot"].includes(parsed.pathname);
	if (!isOps && !isRead) return errorResponse(404, "not found");
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

function channelMode(
	kind: "relay" | "noise-direct",
	peers: WeakMap<Request, NoiseChannelPeer>,
	maxEntryBytes: number | undefined,
): SyncServerMode {
	if (kind === "relay")
		return { kind, maxEntryBytes, peerPin: (request) => peers.get(request)?.pin ?? null };
	return { kind, maxEntryBytes, peer: (request) => peers.get(request) ?? null };
}

export function createSyncChannelDispatcher(options: {
	readonly storeFactory: () => MemoryStore;
	/** Defaults to relay. noise-direct also binds each request to the admitted device. */
	readonly mode?: "relay" | "noise-direct";
	/** Share a listener's limiter so a channel adds no separate request budget. */
	readonly limiter?: InMemoryRequestRateLimiter;
	/** Largest single pull entry to send. Defaults to what a channel response can carry. */
	readonly maxEntryBytes?: number;
}): (request: SyncChannelRequest) => Promise<SyncChannelResponse> {
	const storeFactory = options.storeFactory.bind(options);
	const peers = new WeakMap<Request, NoiseChannelPeer>();
	const app = createSyncApp({
		storeFactory,
		mode: channelMode(options.mode ?? "relay", peers, options.maxEntryBytes),
		syncRequestRateLimit: options.limiter ? { limiter: options.limiter } : undefined,
	});
	return async (input) => {
		const prepared = prepareChannelRequest(input);
		if (!("request" in prepared)) return prepared;
		const { request, peerPin } = prepared;
		const signal = request.signal;
		peers.set(request, { pin: peerPin, deviceId: input.peerDeviceId ?? "" });
		try {
			checkCancellation(signal);
			const response = await app.fetch(request);
			const bodyBytes = await collectResponse(response, signal);
			return { status: response.status, headers: Object.fromEntries(response.headers), bodyBytes };
		} finally {
			peers.delete(request);
		}
	};
}
