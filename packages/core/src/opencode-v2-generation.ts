import { Service } from "@opencode/client/service";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

class ResponseTooLargeError extends Error {}

async function readLimitedJson(response: Response, controller: AbortController): Promise<unknown> {
	if (!response.body) throw new Error("Empty OpenCode response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const part = await reader.read();
		if (part.done) break;
		size += part.value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			controller.abort();
			throw new ResponseTooLargeError();
		}
		chunks.push(part.value);
	}
	return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

export interface OpenCodeV2ModelOption {
	provider: "openai" | "anthropic";
	model: string;
}

export async function listOpenCodeV2Models(): Promise<OpenCodeV2ModelOption[]> {
	let endpoint: Awaited<ReturnType<typeof Service.discover>>;
	try {
		endpoint = await Service.discover();
	} catch {
		return [];
	}
	if (!endpoint) return [];
	const url = new URL(endpoint.url);
	if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		return [];
	try {
		const controller = new AbortController();
		const response = await fetch(new URL("/api/model", url), {
			headers: Service.headers(endpoint),
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
		});
		if (!response.ok) return [];
		const envelope = await readLimitedJson(response, controller);
		const data =
			envelope && typeof envelope === "object" && "data" in envelope
				? (envelope as { data: unknown }).data
				: envelope;
		if (!Array.isArray(data)) return [];
		return data
			.filter(
				(item): item is { providerID: string; id: string; enabled?: boolean } =>
					item != null &&
					typeof item === "object" &&
					(item.providerID === "openai" || item.providerID === "anthropic") &&
					typeof item.id === "string" &&
					item.enabled !== false,
			)
			.map((item) => ({ provider: item.providerID as "openai" | "anthropic", model: item.id }));
	} catch {
		return [];
	}
}

export type V2GenerationResult =
	| { text: string; error: null }
	| {
			text: null;
			error:
				| "service_unavailable"
				| "model_unavailable"
				| "auth_failed"
				| "response_too_large"
				| "request_failed";
	  };

async function readBoundedResponse(
	response: Response,
	controller: AbortController,
): Promise<V2GenerationResult> {
	if (!response.body) return { text: null, error: "request_failed" };
	let result: unknown;
	try {
		result = await readLimitedJson(response, controller);
	} catch (error) {
		if (error instanceof ResponseTooLargeError) return { text: null, error: "response_too_large" };
		throw error;
	}
	if (!result || typeof result !== "object") return { text: null, error: "request_failed" };
	const envelope = result as { data?: unknown; text?: unknown };
	const output = envelope.data ?? envelope;
	const text =
		output && typeof output === "object" ? (output as { text?: unknown }).text : undefined;
	return typeof text === "string" ? { text, error: null } : { text: null, error: "request_failed" };
}

/** Use the service-owned provider connection; never read or export its credential. */
export async function generateWithOpenCodeV2(input: {
	provider: string;
	model: string;
	prompt: string;
}): Promise<V2GenerationResult> {
	let endpoint: Awaited<ReturnType<typeof Service.discover>>;
	try {
		endpoint = await Service.discover();
	} catch {
		return { text: null, error: "service_unavailable" };
	}
	if (!endpoint) return { text: null, error: "service_unavailable" };
	const url = new URL(endpoint.url);
	if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
		return { text: null, error: "service_unavailable" };
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(new URL("/api/experimental/generate", url), {
			method: "POST",
			headers: { ...Service.headers(endpoint), "content-type": "application/json" },
			body: JSON.stringify({
				model: { providerID: input.provider, id: input.model },
				prompt: input.prompt,
			}),
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403) {
			return { text: null, error: "auth_failed" };
		}
		if (!response.ok) {
			return {
				text: null,
				error: response.status === 400 ? "model_unavailable" : "request_failed",
			};
		}
		return await readBoundedResponse(response, controller);
	} catch {
		return { text: null, error: "request_failed" };
	} finally {
		clearTimeout(timeout);
	}
}
