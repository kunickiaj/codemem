import { describe, expect, it } from "vitest";
import type { ObserverConfig, ObserverStatus } from "../../../packages/core/src/observer-client.js";
import {
	createRealObserverInvoker,
	observerConfigWithManifestOverrides,
} from "./observer-invoker.js";

const BASE_CONFIG: ObserverConfig = {
	observerProvider: "local",
	observerModel: "local-model",
	observerRuntime: "api_http",
	observerApiKey: null,
	observerBaseUrl: "https://inherited.invalid/v1",
	observerMaxChars: 12_000,
	observerMaxTokens: 4_000,
	observerHeaders: { "x-inherited": "must-clear" },
	observerAuthSource: "auto",
	observerAuthFile: null,
	observerAuthCommand: [],
	observerAuthTimeoutMs: 1_500,
	observerAuthCacheTtlS: 300,
};

const CONFIGURATION = {
	provider: "openai",
	transport: "codex_sidecar",
	endpoint_mode: "provider_default" as const,
	model: "gpt-5.6-sol",
	temperature: 0,
	openai_responses: true,
	reasoning_effort: "high",
	reasoning_summary: "auto",
	max_output_tokens: 1_024,
	tier_routing_enabled: false as const,
};

function status(overrides: Partial<ObserverStatus> = {}): ObserverStatus {
	return {
		provider: "openai",
		model: "gpt-5.6-sol",
		runtime: "codex_sidecar",
		auth: { source: "none", type: "codex_sidecar", hasToken: false },
		...overrides,
	};
}

const REQUEST = {
	system: "system",
	user: "user",
	subject: {
		label: "candidate",
		resolvedCommit: "a".repeat(40),
		sanitizedSubject: { kind: "candidate", version: "0.40.0" } as const,
	},
	caseId: "public-case",
	repetition: 1,
	attempt: "initial" as const,
};

describe("release observer invoker", () => {
	it("applies manifest transport settings while preserving only loaded authentication", () => {
		expect(observerConfigWithManifestOverrides(CONFIGURATION, BASE_CONFIG)).toMatchObject({
			observerProvider: "openai",
			observerRuntime: "codex_sidecar",
			observerBaseUrl: null,
			observerHeaders: {},
			observerModel: "gpt-5.6-sol",
			observerTemperature: 0,
			observerOpenAIUseResponses: true,
			observerReasoningEffort: "high",
			observerReasoningSummary: "auto",
			observerMaxOutputTokens: 1_024,
			observerTierRoutingEnabled: false,
		});
	});

	it("retries transient failures with bounded deterministic delays and aggregates usage", async () => {
		let calls = 0;
		const delays: number[] = [];
		const invoker = createRealObserverInvoker(CONFIGURATION, {
			loadConfig: () => BASE_CONFIG,
			nowMs: () => 0,
			sleep: async (delay) => {
				delays.push(delay);
			},
			createClient: () => ({
				observe: async () => {
					calls += 1;
					return {
						raw: calls < 3 ? null : '<skip_summary reason="low-signal" />',
						parsed: null,
						provider: "openai",
						model: "gpt-5.6-sol",
						usage: { inputTokens: 2, outputTokens: 1 },
					};
				},
				getStatus: () =>
					calls < 3 ? status({ lastError: { code: "rate_limited", message: "retry" } }) : status(),
			}),
		});
		const result = await invoker.invoke(REQUEST);
		expect(calls).toBe(3);
		expect(delays).toEqual([1_000, 3_000]);
		expect(result).toMatchObject({
			status: "completed",
			usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
		});
	});

	it("does not retry non-transient failures", async () => {
		let calls = 0;
		const invoker = createRealObserverInvoker(CONFIGURATION, {
			loadConfig: () => BASE_CONFIG,
			nowMs: () => 0,
			createClient: () => ({
				observe: async () => {
					calls += 1;
					throw new Error("authentication failed");
				},
				getStatus: () => status({ lastError: { code: "auth_failed", message: "auth failed" } }),
			}),
		});
		expect(await invoker.invoke(REQUEST)).toMatchObject({
			status: "unavailable",
			error: "auth failed",
		});
		expect(calls).toBe(1);
	});
});
