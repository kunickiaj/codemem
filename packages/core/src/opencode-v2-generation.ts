import { Service } from "@opencode/client/service";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const MODEL_READINESS_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;
/** How long a fetched model catalog answers variant lookups before it is fetched again. */
const VARIANT_CACHE_TTL_MS = 10 * 60_000;

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

interface CatalogModel {
	providerID: string;
	id: string;
	enabled?: boolean;
	variants?: unknown;
}

/** The service's model catalog, or null when the service or catalog is unavailable. */
async function fetchModelCatalog(): Promise<CatalogModel[] | null> {
	let endpoint: Awaited<ReturnType<typeof Service.discover>>;
	try {
		endpoint = await Service.discover();
	} catch {
		return null;
	}
	if (!endpoint) return null;
	const url = localServiceUrl(endpoint.url);
	if (!url) return null;
	try {
		const controller = new AbortController();
		const response = await fetch(new URL("/api/model", url), {
			headers: Service.headers(endpoint),
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
		});
		if (!response.ok) return null;
		const envelope = await readLimitedJson(response, controller);
		const data =
			envelope && typeof envelope === "object" && "data" in envelope
				? (envelope as { data: unknown }).data
				: envelope;
		if (!Array.isArray(data)) return null;
		return data.filter(
			(item): item is CatalogModel =>
				item != null &&
				typeof item === "object" &&
				typeof item.providerID === "string" &&
				typeof item.id === "string",
		);
	} catch {
		return null;
	}
}

export async function listOpenCodeV2Models(): Promise<OpenCodeV2ModelOption[]> {
	const catalog = (await fetchModelCatalog()) ?? [];
	return catalog
		.filter(
			(item) =>
				(item.providerID === "openai" || item.providerID === "anthropic") && item.enabled !== false,
		)
		.map((item) => ({ provider: item.providerID as "openai" | "anthropic", model: item.id }));
}

function variantIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((variant) =>
			variant && typeof variant === "object" ? (variant as { id?: unknown }).id : undefined,
		)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
}

let variantCache: { fetchedAt: number; byModel: Map<string, string[]> } | null = null;

/**
 * The variant IDs the service lists for a model, which is how it selects reasoning effort.
 * One catalog fetch answers every model for a while; a failed fetch is not cached.
 * Returns null when the catalog is unavailable and an empty list for an unlisted model.
 */
export async function listOpenCodeV2ModelVariants(
	provider: string,
	model: string,
): Promise<string[] | null> {
	if (!variantCache || Date.now() - variantCache.fetchedAt > VARIANT_CACHE_TTL_MS) {
		const catalog = await fetchModelCatalog();
		if (!catalog) return null;
		variantCache = {
			fetchedAt: Date.now(),
			byModel: new Map(
				catalog.map((item) => [`${item.providerID}/${item.id}`, variantIds(item.variants)]),
			),
		};
	}
	return variantCache.byModel.get(`${provider}/${model}`) ?? [];
}

/** Forget the cached model variants, so the next lookup fetches the catalog again. */
export function clearOpenCodeV2ModelVariantCache(): void {
	variantCache = null;
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
	input: V2GenerationInput,
	controller: AbortController,
): Promise<V2GenerationResult> {
	const response = await fetch(new URL("/api/experimental/generate", url), {
		method: "POST",
		headers: { ...Service.headers(endpoint), "content-type": "application/json" },
		body: JSON.stringify({
			model: {
				providerID: input.provider,
				id: input.model,
				...(input.variant ? { variant: input.variant } : {}),
			},
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

export interface V2GenerationInput {
	provider: string;
	model: string;
	prompt: string;
	/** A variant the model lists; it selects reasoning effort. Omitted uses the service default. */
	variant?: string;
}

/**
 * Use the service-owned provider connection; never read or export its credential.
 * The service replies with the text only, without token usage.
 */
export async function generateWithOpenCodeV2(
	input: V2GenerationInput,
): Promise<V2GenerationResult> {
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
