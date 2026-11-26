import { Service } from "@opencode/client/service";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const MODEL_READINESS_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;
/** How long a service's model catalog answers variant lookups before it is fetched again. */
const VARIANT_CACHE_TTL_MS = 10 * 60_000;
/** A catalog that lacked the model or the requested variant is fetched again sooner. */
const VARIANT_MISS_TTL_MS = 60_000;

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

type ServiceEndpoint = NonNullable<Awaited<ReturnType<typeof Service.discover>>>;

interface ServiceTarget {
	endpoint: ServiceEndpoint;
	url: URL;
}

/** The discovered local service, or null when none is running at a local address. */
async function discoverService(): Promise<ServiceTarget | null> {
	let endpoint: Awaited<ReturnType<typeof Service.discover>>;
	try {
		endpoint = await Service.discover();
	} catch {
		return null;
	}
	if (!endpoint) return null;
	const url = localServiceUrl(endpoint.url);
	return url ? { endpoint, url } : null;
}

/** The service's model catalog, or null when the catalog is unavailable. */
async function fetchModelCatalog(target: ServiceTarget): Promise<CatalogModel[] | null> {
	try {
		const controller = new AbortController();
		const response = await fetch(new URL("/api/model", target.url), {
			headers: Service.headers(target.endpoint),
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
	const target = await discoverService();
	const catalog = (target && (await fetchModelCatalog(target))) ?? [];
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

interface VariantCatalog {
	fetchedAt: number;
	byModel: Map<string, string[]>;
}

/** Catalogs by service address, so a different service never answers from another's list. */
const variantCatalogs = new Map<string, VariantCatalog>();
/** Catalog fetches in flight by service address, shared by concurrent callers. */
const pendingCatalogs = new Map<string, Promise<VariantCatalog | null>>();

function loadVariantCatalog(target: ServiceTarget): Promise<VariantCatalog | null> {
	const key = target.url.origin;
	const pending = pendingCatalogs.get(key);
	if (pending) return pending;
	const load = fetchModelCatalog(target)
		.then((models) => {
			if (!models) return null;
			const catalog = {
				fetchedAt: Date.now(),
				byModel: new Map(
					models.map((item) => [`${item.providerID}/${item.id}`, variantIds(item.variants)]),
				),
			};
			variantCatalogs.set(key, catalog);
			return catalog;
		})
		.finally(() => pendingCatalogs.delete(key));
	pendingCatalogs.set(key, load);
	return load;
}

/** Variants a service rejected, by service, model and variant, with when to try them again. */
const rejectedVariants = new Map<string, number>();
const rejectedVariantKey = (
	target: ServiceTarget,
	provider: string,
	model: string,
	variant: string,
) => `${target.url.origin} ${provider}/${model} ${variant.toLowerCase()}`;

type VariantSelection =
	| { variant: string; reason: null }
	| { variant: null; reason: Exclude<V2EffortReport["fallbackReason"], null> };

/**
 * The variant this service lists for the requested effort. A model without the
 * variant, or a service whose catalog reports no variants, gets nothing sent.
 */
async function selectVariant(
	target: ServiceTarget,
	provider: string,
	model: string,
	requested: string,
): Promise<VariantSelection> {
	const key = `${provider}/${model}`;
	const find = (catalog: VariantCatalog) =>
		catalog.byModel.get(key)?.find((variant) => variant.toLowerCase() === requested) ?? null;
	let catalog = variantCatalogs.get(target.url.origin) ?? null;
	const age = catalog ? Date.now() - catalog.fetchedAt : Number.POSITIVE_INFINITY;
	const listed = catalog ? find(catalog) : null;
	if (age > (listed ? VARIANT_CACHE_TTL_MS : VARIANT_MISS_TTL_MS)) {
		catalog = await loadVariantCatalog(target);
	}
	if (!catalog) return { variant: null, reason: "variants_unavailable" };
	const variant = find(catalog);
	if (!variant) return { variant: null, reason: "variant_not_listed" };
	// A catalog can keep listing a variant the service rejects; skip it for a while.
	const retryAt = rejectedVariants.get(rejectedVariantKey(target, provider, model, variant)) ?? 0;
	return Date.now() < retryAt
		? { variant: null, reason: "variant_rejected" }
		: { variant, reason: null };
}

/** Forget every cached model catalog, so the next lookup fetches again. */
export function clearOpenCodeV2ModelVariantCache(): void {
	variantCatalogs.clear();
	pendingCatalogs.clear();
	rejectedVariants.clear();
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

/**
 * Why the service refused a request before generating anything: the model, or the
 * variant, is unavailable. The service answers 400 with an InvalidRequestError that
 * names `model.variant` for a variant it cannot resolve.
 */
async function preGenerationRejection(
	response: Response,
	controller: AbortController,
	input: { provider: string; model: string; variant: string | null },
): Promise<"model_unavailable" | "variant_unavailable" | null> {
	let body: unknown;
	try {
		body = await readLimitedJson(response, controller);
	} catch {
		return null;
	}
	if (!body || typeof body !== "object") return null;
	const { _tag, message, field } = body as { _tag?: unknown; message?: unknown; field?: unknown };
	if (_tag !== "InvalidRequestError") return null;
	if (message === `Model unavailable: ${input.provider}/${input.model}`) return "model_unavailable";
	const variantMessage =
		typeof message === "string" &&
		message.startsWith(`Variant unavailable for ${input.provider}/${input.model}:`);
	return input.variant && (field === "model.variant" || variantMessage)
		? "variant_unavailable"
		: null;
}

type AttemptResult = V2GenerationResult | { text: null; error: "variant_unavailable" };

async function requestGeneration(
	target: ServiceTarget,
	input: { provider: string; model: string; prompt: string; variant: string | null },
	controller: AbortController,
): Promise<AttemptResult> {
	const response = await fetch(new URL("/api/experimental/generate", target.url), {
		method: "POST",
		headers: { ...Service.headers(target.endpoint), "content-type": "application/json" },
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
		const rejection = await preGenerationRejection(response, controller, input);
		return { text: null, error: rejection ?? "request_failed" };
	}
	if (!response.ok) return { text: null, error: "request_failed" };
	return readBoundedResponse(response, controller);
}

/** Retry only the exact pre-generation model rejection while the service's catalog warms up. */
async function generateUntilModelReady(
	target: ServiceTarget,
	input: { provider: string; model: string; prompt: string; variant: string | null },
	controller: AbortController,
): Promise<AttemptResult> {
	for (const delay of [...MODEL_READINESS_DELAYS_MS, 0]) {
		const result = await requestGeneration(target, input, controller);
		if (result.error !== "model_unavailable" || !delay) return result;
		await new Promise<void>((resolve) => setTimeout(resolve, delay));
	}
	return { text: null, error: "request_failed" };
}

export interface V2GenerationInput {
	provider: string;
	model: string;
	prompt: string;
	/** The configured effort; sent as a model variant only when the service lists it. */
	reasoningEffort?: string | null;
}

/**
 * What a request did with the requested effort; null when no effort was requested or
 * no request reached the service. An effort counts as applied only when the
 * generation succeeded.
 */
export interface V2EffortReport {
	/** The variant sent on the first attempt, or null when none was. */
	attempted: string | null;
	/** The variant the successful generation used; null at the service default or on failure. */
	applied: string | null;
	/** Whether the request ended with a successful generation. */
	succeeded: boolean;
	/** Why the requested effort was not sent or was dropped, or null. */
	fallbackReason: "variant_not_listed" | "variants_unavailable" | "variant_rejected" | null;
}

export type V2GenerationOutcome = V2GenerationResult & { effort: V2EffortReport | null };

function effortReport(
	attempted: string | null,
	result: V2GenerationResult,
	fallbackReason: V2EffortReport["fallbackReason"],
): V2EffortReport {
	const succeeded = result.error === null;
	return {
		attempted,
		applied: succeeded && fallbackReason === null ? attempted : null,
		succeeded,
		fallbackReason,
	};
}

/**
 * Use the service-owned provider connection; never read or export its credential.
 * The service replies with the text only, without token usage. A variant the service
 * rejects before generating is retried once without it, the cached catalog for that
 * service is dropped, and the variant is skipped for that model for a while; no
 * other failure is retried.
 */
export async function generateWithOpenCodeV2(
	input: V2GenerationInput,
): Promise<V2GenerationOutcome> {
	const target = await discoverService();
	if (!target) return { text: null, error: "service_unavailable", effort: null };
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const requested = input.reasoningEffort?.trim().toLowerCase() || null;
	let selection: VariantSelection | null = null;
	try {
		if (requested) selection = await selectVariant(target, input.provider, input.model, requested);
		const variant = selection?.variant ?? null;
		const first = await generateUntilModelReady(target, { ...input, variant }, controller);
		if (first.error === "variant_unavailable" && variant) {
			variantCatalogs.delete(target.url.origin);
			rejectedVariants.set(
				rejectedVariantKey(target, input.provider, input.model, variant),
				Date.now() + VARIANT_CACHE_TTL_MS,
			);
			const retry = await generateUntilModelReady(target, { ...input, variant: null }, controller);
			const result: V2GenerationResult =
				retry.error === "variant_unavailable" ? { text: null, error: "request_failed" } : retry;
			return { ...result, effort: effortReport(variant, result, "variant_rejected") };
		}
		const result: V2GenerationResult =
			first.error === "variant_unavailable" ? { text: null, error: "request_failed" } : first;
		const effort = selection ? effortReport(variant, result, selection.reason) : null;
		return { ...result, effort };
	} catch {
		const failed = { text: null, error: "request_failed" } as const;
		const effort = selection ? effortReport(selection.variant, failed, selection.reason) : null;
		return { ...failed, effort };
	} finally {
		clearTimeout(timeout);
	}
}
