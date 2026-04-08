import { describe, expect, it } from "vitest";
import {
	buildTieredObserverConfig,
	decideExtractionReplayTier,
} from "./extraction-tier-routing.js";

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
		const config = buildTieredObserverConfig(
			{
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerTierRoutingEnabled: true,
				observerSimpleModel: "gpt-5.4-mini",
				observerSimpleTemperature: 0.2,
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
			},
			decision,
		);
		expect(config.observerOpenAIUseResponses).toBe(true);
	});
});
