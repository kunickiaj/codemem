import { Service } from "@opencode/client/service";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const MODEL_READINESS_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;

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

function localServiceUrl(endpointUrl: string): URL | null {
	let url: URL;
	try {
		url = new URL(endpointUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "http:") return null;
	// Discovery can advertise a listener's wildcard bind address, not a client destination.
	if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
	if (url.hostname === "[::]") url.hostname = "[::1]";
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
	return url;
}

export async function listOpenCodeV2Models(): Promise<OpenCodeV2ModelOption[]> {
	let endpoint: Awaited<ReturnType<typeof Service.discover>>;
	try {
		endpoint = await Service.discover();
	} catch {
		return [];
	}
	if (!endpoint) return [];
	const url = localServiceUrl(endpoint.url);
	if (!url) return [];
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

async function isPreGenerationModelUnavailable(
	response: Response,
	controller: AbortController,
	provider: string,
	model: string,
): Promise<boolean> {
	try {
		const body = await readLimitedJson(response, controller);
		return (
			body != null &&
			typeof body === "object" &&
			"_tag" in body &&
			body._tag === "InvalidRequestError" &&
			"message" in body &&
			body.message === `Model unavailable: ${provider}/${model}`
		);
	} catch {
		return false;
	}
}

async function requestGeneration(
	endpoint: NonNullable<Awaited<ReturnType<typeof Service.discover>>>,
	url: URL,
	input: { provider: string; model: string; prompt: string },
	controller: AbortController,
): Promise<V2GenerationResult> {
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
	if (response.status === 400) {
		return (await isPreGenerationModelUnavailable(
			response,
			controller,
			input.provider,
			input.model,
		))
			? { text: null, error: "model_unavailable" }
			: { text: null, error: "request_failed" };
	}
	if (!response.ok) return { text: null, error: "request_failed" };
	return readBoundedResponse(response, controller);
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
	const url = localServiceUrl(endpoint.url);
	if (!url) {
		return { text: null, error: "service_unavailable" };
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		for (const delay of [...MODEL_READINESS_DELAYS_MS, 0]) {
			const result = await requestGeneration(endpoint, url, input, controller);
			if (result.error !== "model_unavailable" || !delay) return result;
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
		return { text: null, error: "request_failed" };
	} catch {
		return { text: null, error: "request_failed" };
	} finally {
		clearTimeout(timeout);
	}
}
