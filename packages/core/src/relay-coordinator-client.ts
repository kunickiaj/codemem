import { decodeRelayCheckPacket } from "./relay-admission-codec.js";
import type { RelayServerOptions } from "./relay-server.js";

export interface RelayCoordinatorClientOptions {
	/** Full configured admission endpoint, including any externally signed mount prefix. */
	readonly url: string;
	/** Disposable localhost fixtures only. Remote cleartext is never accepted. */
	readonly allowLoopbackHttp?: boolean;
	/**
	 * Sends the request instead of global fetch, for example a Workers service binding.
	 * The URL is still validated and sent unchanged, because the route checks its pathname.
	 */
	readonly fetcher?: { fetch(url: string, init: RequestInit): Promise<Response> };
}

function admissionUrl(options: RelayCoordinatorClientOptions): URL {
	const url = new URL(options.url);
	const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && loopback && options.allowLoopbackHttp)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!url.pathname.endsWith("/v1/relay/admission-check")
	)
		throw new Error("Invalid relay coordinator endpoint");
	return url;
}

async function readReply(response: Response): Promise<Uint8Array | null> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const bytes = new Uint8Array(1024);
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return bytes.slice(0, size);
			if (size + value.length > bytes.length) return null;
			bytes.set(value, size);
			size += value.length;
		}
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Each verifier uses its own configured origin. This client neither retries nor follows redirects. */
export function createRelayCoordinatorClient(
	options: RelayCoordinatorClientOptions,
): RelayServerOptions["coordinator"] {
	const url = admissionUrl(options).href;
	const fetcher = options.fetcher;
	const send = fetcher
		? (init: RequestInit) => fetcher.fetch(url, init)
		: (init: RequestInit) => fetch(url, init);
	// Workers throws a TypeError for redirect "error", including on service-binding
	// fetch. A fetcher gets "manual" instead: any 3xx reply is a non-200 denial below.
	const redirect: RequestInit["redirect"] = fetcher ? "manual" : "error";
	return {
		async check({ packet, deviceHeader, signal }) {
			try {
				if (signal.aborted) return null;
				const body = decodeRelayCheckPacket(packet).bodyBytes;
				const response = await send({
					method: "POST",
					redirect,
					signal,
					headers: {
						"content-type": "application/json",
						"accept-encoding": "identity",
						"X-Opencode-Device": deviceHeader,
						"X-Opencode-Timestamp": packet.timestamp,
						"X-Opencode-Nonce": packet.nonce,
						"X-Opencode-Signature": packet.signature,
					},
					body: new Uint8Array(body),
				});
				if (response.status !== 200) {
					void response.body?.cancel().catch(() => {});
					return null;
				}
				const reply = await readReply(response);
				return signal.aborted ? null : reply;
			} catch {
				return null;
			}
		},
	};
}
