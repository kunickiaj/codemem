import { describe, expect, it } from "vitest";
import {
	buildTieredObserverConfig,
	buildTieredObserverSelection,
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

	it("uses Responses defaults for the simple OpenAI tier when transport is not explicitly set", () => {
		const decision = decideExtractionReplayTier({
			batchId: 19001,
			sessionId: 200001,
			eventSpan: 12,
			promptCount: 1,
			toolCount: 1,
			transcriptLength: 320,
		});
		const config = buildTieredObserverConfig(baseConfig(), decision);
		expect(config.observerOpenAIUseResponses).toBe(true);
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

	it("maps claude_sidecar simple tier routing onto Claude defaults", () => {
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
				observerProvider: "openai",
				observerRuntime: "claude_sidecar",
				observerSimpleModel: null,
			}),
			decision,
		);
		expect(config.observerProvider).toBe("anthropic");
		expect(config.observerModel).toBe("claude-haiku-4-5");
		expect(config.observerRuntime).toBe("claude_sidecar");
	});

	it("maps claude_sidecar rich tier routing onto Claude defaults", () => {
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
				observerProvider: "openai",
				observerRuntime: "claude_sidecar",
				observerRichModel: null,
			}),
			decision,
		);
		expect(config.observerProvider).toBe("anthropic");
		expect(config.observerModel).toBe("claude-sonnet-4-6");
		expect(config.observerRuntime).toBe("claude_sidecar");
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

	it("records requested routing metadata for a rich tier selection", () => {
		const decision = decideExtractionReplayTier({
			batchId: 18503,
			sessionId: 166405,
			eventSpan: 153,
			promptCount: 4,
			toolCount: 12,
			transcriptLength: 2800,
		});
		const selection = buildTieredObserverSelection(baseConfig(), decision);
		expect(selection.metadata).toEqual(
			expect.objectContaining({
				requestedTier: "rich",
				requestedProvider: "openai",
				requestedModel: "gpt-5.4",
				requestedRuntime: "api_http",
				requestedOpenAIResponses: true,
				fallbackApplied: false,
				fallbackReason: null,
			}),
		);
	});

	it("keeps rich OpenAI routing on Responses even when base transport is explicitly false", () => {
		const decision = decideExtractionReplayTier({
			batchId: 18503,
			sessionId: 166405,
			eventSpan: 153,
			promptCount: 4,
			toolCount: 12,
			transcriptLength: 2800,
		});
		const selection = buildTieredObserverSelection(
			baseConfig({
				observerOpenAIUseResponses: false,
				observerExplicitConfigKeys: ["observerOpenAIUseResponses"],
			}),
			decision,
		);
		expect(selection.observer.observerOpenAIUseResponses).toBe(true);
		expect(selection.metadata.fallbackApplied).toBe(false);
	});

	it("honors explicit false for simple OpenAI Responses usage", () => {
		const decision = decideExtractionReplayTier({
			batchId: 19001,
			sessionId: 200001,
			eventSpan: 12,
			promptCount: 1,
			toolCount: 1,
			transcriptLength: 320,
		});
		const selection = buildTieredObserverSelection(
			baseConfig({
				observerOpenAIUseResponses: false,
				observerExplicitConfigKeys: ["observerOpenAIUseResponses"],
			}),
			decision,
		);
		expect(selection.observer.observerOpenAIUseResponses).toBe(false);
	});

	it("does not record fallback on claude_sidecar when provider was not explicitly requested", () => {
		const decision = decideExtractionReplayTier({
			batchId: 18503,
			sessionId: 166405,
			eventSpan: 153,
			promptCount: 4,
			toolCount: 12,
			transcriptLength: 2800,
		});
		const selection = buildTieredObserverSelection(
			baseConfig({
				observerProvider: "openai",
				observerRuntime: "claude_sidecar",
			}),
			decision,
		);
		expect(selection.metadata.fallbackApplied).toBe(false);
		expect(selection.metadata.fallbackReason).toBeNull();
		expect(selection.observer.observerProvider).toBe("anthropic");
	});

	it("records a visible fallback when an incompatible provider is requested on claude_sidecar", () => {
		const decision = decideExtractionReplayTier({
			batchId: 18503,
			sessionId: 166405,
			eventSpan: 153,
			promptCount: 4,
			toolCount: 12,
			transcriptLength: 2800,
		});
		const selection = buildTieredObserverSelection(
			baseConfig({
				observerProvider: "openai",
				observerRuntime: "claude_sidecar",
				observerExplicitConfigKeys: ["observerProvider"],
			}),
			decision,
		);
		expect(selection.metadata.requestedProvider).toBe("openai");
		expect(selection.metadata.fallbackApplied).toBe(true);
		expect(selection.metadata.fallbackReason).toBe("unsupported tier override for runtime");
		expect(selection.observer.observerProvider).toBe("anthropic");
	});
});
