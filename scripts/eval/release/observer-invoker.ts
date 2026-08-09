import { estimateExtractionModelCost } from "../../../packages/core/src/extraction-model-pricing.js";
import type {
	ObserverConfig,
	ObserverResponse,
	ObserverStatus,
	ObserverTokenUsage,
} from "../../../packages/core/src/observer-client.js";
import { loadObserverConfig, ObserverClient } from "../../../packages/core/src/observer-client.js";
import type {
	ObserverInvocationRequest,
	ObserverInvocationResult,
	ObserverInvoker,
} from "./observer-runner.js";
import { addObserverUsage } from "./observer-runner.js";
import type { ReleaseEvalManifestV1 } from "./types.js";

export interface ObserverClientLike {
	observe(system: string, user: string): Promise<ObserverResponse>;
	getStatus(): ObserverStatus;
}

export interface ObserverInvokerDependencies {
	loadConfig(): ObserverConfig;
	createClient(config: ObserverConfig): ObserverClientLike;
	nowMs(): number;
	sleep(ms: number): Promise<void>;
}

const TRANSIENT_ERROR_CODES = new Set([
	"empty_response",
	"observer_call_failed",
	"provider_request_failed",
	"rate_limited",
	"stream_error",
]);
const RETRY_DELAYS_MS = [1_000, 3_000] as const;

const DEFAULT_DEPENDENCIES: ObserverInvokerDependencies = {
	loadConfig: loadObserverConfig,
	createClient: (config) => new ObserverClient(config),
	nowMs: () => Date.now(),
	sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
};

export function observerConfigWithManifestOverrides(
	configuration: ReleaseEvalManifestV1["evaluator"]["configuration"],
	base: ObserverConfig = loadObserverConfig(),
): ObserverConfig {
	return {
		...base,
		observerProvider: configuration.provider,
		observerRuntime: configuration.transport,
		observerBaseUrl: null,
		observerHeaders: {},
		observerModel: configuration.model,
		observerTemperature: configuration.temperature,
		observerOpenAIUseResponses: configuration.openai_responses,
		observerReasoningEffort: configuration.reasoning_effort,
		observerReasoningSummary: configuration.reasoning_summary,
		observerMaxOutputTokens: configuration.max_output_tokens,
		observerTierRoutingEnabled: false,
		observerExplicitConfigKeys: [
			...new Set([
				...(base.observerExplicitConfigKeys ?? []),
				"observerProvider",
				"observerRuntime",
				"observerBaseUrl",
				"observerHeaders",
				"observerModel",
				"observerTemperature",
				"observerOpenAIUseResponses",
				"observerReasoningEffort",
				"observerReasoningSummary",
				"observerMaxOutputTokens",
				"observerTierRoutingEnabled",
			]),
		],
	};
}

export function createRealObserverInvoker(
	configuration: ReleaseEvalManifestV1["evaluator"]["configuration"],
	dependencies: Partial<ObserverInvokerDependencies> = {},
): ObserverInvoker {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const client = deps.createClient(
		observerConfigWithManifestOverrides(configuration, deps.loadConfig()),
	);
	return {
		async invoke(request: ObserverInvocationRequest): Promise<ObserverInvocationResult> {
			const startedAt = deps.nowMs();
			let usage: ObserverTokenUsage | null = null;
			let estimatedCostUsd = 0;
			let hasCost = false;
			for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
				try {
					const response = await client.observe(request.system, request.user);
					const status = client.getStatus();
					const fallback = status.modelFallbackApplied === true;
					const resolvedModel = status.actualModel ?? response.model ?? null;
					usage = addObserverUsage(usage, response.usage);
					const estimate = resolvedModel
						? estimateExtractionModelCost(resolvedModel, response.usage ?? null)
						: null;
					if (estimate) {
						hasCost = true;
						estimatedCostUsd += estimate.totalCostUsd;
					}
					if (
						!response.raw &&
						TRANSIENT_ERROR_CODES.has(status.lastError?.code ?? "") &&
						attempt < RETRY_DELAYS_MS.length
					) {
						await deps.sleep(RETRY_DELAYS_MS[attempt] ?? 0);
						continue;
					}
					const partialError = response.raw ? (status.lastError?.message ?? null) : null;
					return {
						status: response.raw ? (partialError ? "partial" : "completed") : "unavailable",
						raw: response.raw,
						provider: response.provider || status.provider,
						requestedModel: configuration.model,
						resolvedModel,
						modelFallbackApplied: fallback,
						fallbackReason: status.modelFallbackReason ?? null,
						elapsedMs: Math.max(0, deps.nowMs() - startedAt),
						usage,
						estimatedCostUsd: hasCost ? estimatedCostUsd : null,
						error: response.raw
							? partialError
							: (status.lastError?.message ?? "observer returned no output"),
					};
				} catch (error) {
					const status = client.getStatus();
					if (
						TRANSIENT_ERROR_CODES.has(status.lastError?.code ?? "") &&
						attempt < RETRY_DELAYS_MS.length
					) {
						await deps.sleep(RETRY_DELAYS_MS[attempt] ?? 0);
						continue;
					}
					return {
						status: "unavailable",
						raw: null,
						provider: status.provider,
						requestedModel: configuration.model,
						resolvedModel: status.actualModel ?? status.model,
						modelFallbackApplied: status.modelFallbackApplied === true,
						fallbackReason: status.modelFallbackReason ?? null,
						elapsedMs: Math.max(0, deps.nowMs() - startedAt),
						usage,
						estimatedCostUsd: hasCost ? estimatedCostUsd : null,
						error:
							status.lastError?.message ?? (error instanceof Error ? error.message : String(error)),
					};
				}
			}
			throw new Error("observer retry loop exhausted");
		},
	};
}
