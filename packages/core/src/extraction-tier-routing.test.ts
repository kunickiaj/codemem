import { describe, expect, it } from "vitest";
import {
	buildTieredObserverConfig,
	decideExtractionReplayTier,
} from "./extraction-tier-routing.js";
import type { ObserverConfig } from "./observer-client.js";

function baseConfig(overrides: Partial<ObserverConfig> = {}): ObserverConfig {
	return {
		observerProvider: "openai",
		observerModel: "gpt-5.4-mini",
		observerRuntime: null,
		observerApiKey: null,
		observerBaseUrl: null,
		observerTemperature: 0.2,
		observerTierRoutingEnabled: true,
		observerSimpleProvider: null,
		observerSimpleModel: "gpt-5.4-mini",
		observerSimpleTemperature: 0.2,
		observerRichProvider: null,
		observerRichModel: "gpt-5.4",
		observerRichTemperature: 0.2,
		observerRichOpenAIUseResponses: undefined,
		observerRichReasoningEffort: null,
		observerRichReasoningSummary: null,
		observerRichMaxOutputTokens: 12000,
		observerOpenAIUseResponses: false,
		observerReasoningEffort: null,
		observerReasoningSummary: null,
		observerMaxOutputTokens: 4000,
		observerMaxChars: 12000,
		observerMaxTokens: 4000,
		observerHeaders: {},
		observerAuthSource: "none",
		observerAuthFile: null,
		observerAuthCommand: [],
		observerAuthTimeoutMs: 1500,
		observerAuthCacheTtlS: 300,
		...overrides,
	};
}

describe("extraction tier routing", () => {
	it("routes rich batches to the rich tier when thresholds are exceeded", () => {
		const decision = decideExtractionReplayTier({
			batchId: 18503,
			sessionId: 166405,
			eventSpan: 153,
			promptCount: 4,
			toolCount: 12,
			transcriptLength: 2800,
		});

		expect(decision.tier).toBe("rich");
		expect(decision.observer.observerModel).toBe("gpt-5.4");
		expect(decision.observer.observerOpenAIUseResponses).toBe(true);
		expect(decision.reasons.length).toBeGreaterThan(0);
	});

	it("routes smaller batches to the simple tier when rich thresholds are not met", () => {
		const decision = decideExtractionReplayTier({
			batchId: 19001,
			sessionId: 200001,
			eventSpan: 12,
			promptCount: 1,
			toolCount: 1,
			transcriptLength: 320,
		});

		expect(decision.tier).toBe("simple");
		expect(decision.observer.observerModel).toBe("gpt-5.4-mini");
		expect(decision.observer.observerTemperature).toBe(0.2);
	});

	it("uses rich Responses defaults when rich-specific flag is unset", () => {
		const decision = decideExtractionReplayTier({
			batchId: 18503,
			sessionId: 166405,
			eventSpan: 153,
			promptCount: 4,
			toolCount: 12,
			transcriptLength: 2800,
		});
		const config = buildTieredObserverConfig(baseConfig(), decision);
		expect(config.observerOpenAIUseResponses).toBe(true);
	});

	it("picks Claude rich defaults when base provider is anthropic", () => {
		const decision = decideExtractionReplayTier({
			batchId: 18503,
			sessionId: 166405,
			eventSpan: 153,
			promptCount: 4,
			toolCount: 12,
			transcriptLength: 2800,
		});
		const config = buildTieredObserverConfig(
			baseConfig({
				observerProvider: "anthropic",
				observerModel: "claude-haiku-4-5",
				observerSimpleModel: null,
				observerRichModel: null,
			}),
			decision,
		);
		expect(config.observerProvider).toBe("anthropic");
		expect(config.observerModel).toBe("claude-sonnet-4-6");
		expect(config.observerOpenAIUseResponses).toBeUndefined();
		expect(config.observerReasoningEffort).toBeNull();
		expect(config.observerMaxOutputTokens).toBe(12000);
	});

	it("picks Claude simple defaults when base provider is anthropic", () => {
		const decision = decideExtractionReplayTier({
			batchId: 19001,
			sessionId: 200001,
			eventSpan: 12,
			promptCount: 1,
			toolCount: 1,
			transcriptLength: 320,
		});
		const config = buildTieredObserverConfig(
			baseConfig({
				observerProvider: "anthropic",
				observerModel: "claude-haiku-4-5",
				observerSimpleModel: null,
				observerRichModel: null,
			}),
			decision,
		);
		expect(config.observerProvider).toBe("anthropic");
		expect(config.observerModel).toBe("claude-haiku-4-5");
		expect(config.observerOpenAIUseResponses).toBeUndefined();
	});

	it("respects observerRichProvider override even when base provider is openai", () => {
		const decision = decideExtractionReplayTier({
			batchId: 18503,
			sessionId: 166405,
			eventSpan: 153,
			promptCount: 4,
			toolCount: 12,
			transcriptLength: 2800,
		});
		const config = buildTieredObserverConfig(
			baseConfig({
				observerRichProvider: "anthropic",
				observerRichModel: null,
			}),
			decision,
		);
		expect(config.observerProvider).toBe("anthropic");
		expect(config.observerModel).toBe("claude-sonnet-4-6");
		expect(config.observerOpenAIUseResponses).toBeUndefined();
	});

	it("respects observerSimpleProvider override for simple tier only", () => {
		const decision = decideExtractionReplayTier({
			batchId: 19001,
			sessionId: 200001,
			eventSpan: 12,
			promptCount: 1,
			toolCount: 1,
			transcriptLength: 320,
		});
		const config = buildTieredObserverConfig(
			baseConfig({
				observerSimpleProvider: "anthropic",
				observerSimpleModel: null,
			}),
			decision,
		);
		expect(config.observerProvider).toBe("anthropic");
		expect(config.observerModel).toBe("claude-haiku-4-5");
	});

	it("preserves unknown/custom provider and skips OpenAI/Claude defaults", () => {
		const decision = decideExtractionReplayTier({
			batchId: 18503,
			sessionId: 166405,
			eventSpan: 153,
			promptCount: 4,
			toolCount: 12,
			transcriptLength: 2800,
		});
		const config = buildTieredObserverConfig(
			baseConfig({
				observerProvider: "opencode",
				observerModel: "custom-sonnet",
				observerSimpleModel: null,
				observerRichModel: null,
			}),
			decision,
		);
		expect(config.observerProvider).toBe("opencode");
		expect(config.observerModel).toBe("custom-sonnet");
		expect(config.observerOpenAIUseResponses).toBeUndefined();
	});

	it("honors rich tier override model under a custom provider", () => {
		const decision = decideExtractionReplayTier({
			batchId: 18503,
			sessionId: 166405,
			eventSpan: 153,
			promptCount: 4,
			toolCount: 12,
			transcriptLength: 2800,
		});
		const config = buildTieredObserverConfig(
			baseConfig({
				observerProvider: "opencode",
				observerModel: "fallback-model",
				observerRichModel: "rich-override",
			}),
			decision,
		);
		expect(config.observerProvider).toBe("opencode");
		expect(config.observerModel).toBe("rich-override");
	});

	it("still honors explicit per-tier model overrides under anthropic provider", () => {
		const decision = decideExtractionReplayTier({
			batchId: 18503,
			sessionId: 166405,
			eventSpan: 153,
			promptCount: 4,
			toolCount: 12,
			transcriptLength: 2800,
		});
		const config = buildTieredObserverConfig(
			baseConfig({
				observerProvider: "anthropic",
				observerRichModel: "claude-opus-4-6",
			}),
			decision,
		);
		expect(config.observerProvider).toBe("anthropic");
		expect(config.observerModel).toBe("claude-opus-4-6");
	});
});
