import type { ObserverConfig } from "./observer-client.js";

export interface ExtractionReplayTierRoutingInput {
	batchId: number;
	sessionId: number;
	eventSpan: number;
	promptCount: number;
	toolCount: number;
	transcriptLength: number;
}

export interface ExtractionReplayTierRoutingDecision {
	tier: "simple" | "rich";
	reasons: string[];
	observer: Partial<ObserverConfig>;
}

export const SIMPLE_TIER_DEFAULTS: Partial<ObserverConfig> = {
	observerProvider: "openai",
	observerModel: "gpt-5.4-mini",
	observerTemperature: 0.2,
};

export const RICH_TIER_DEFAULTS: Partial<ObserverConfig> = {
	observerProvider: "openai",
	observerModel: "gpt-5.4",
	observerTemperature: 0.2,
	observerOpenAIUseResponses: true,
	observerReasoningEffort: null,
	observerReasoningSummary: null,
	observerMaxOutputTokens: 12000,
};

export function buildTieredObserverConfig(
	baseConfig: ObserverConfig,
	decision: ExtractionReplayTierRoutingDecision,
): ObserverConfig {
	if (decision.tier === "simple") {
		return {
			...baseConfig,
			observerProvider:
				baseConfig.observerProvider ?? SIMPLE_TIER_DEFAULTS.observerProvider ?? null,
			observerModel:
				baseConfig.observerSimpleModel ??
				SIMPLE_TIER_DEFAULTS.observerModel ??
				baseConfig.observerModel,
			observerTemperature:
				baseConfig.observerSimpleTemperature ??
				SIMPLE_TIER_DEFAULTS.observerTemperature ??
				baseConfig.observerTemperature,
			observerOpenAIUseResponses: false,
			observerReasoningEffort: null,
			observerReasoningSummary: null,
			observerMaxOutputTokens: baseConfig.observerMaxTokens,
		};
	}

	return {
		...baseConfig,
		observerProvider: RICH_TIER_DEFAULTS.observerProvider ?? baseConfig.observerProvider,
		observerModel:
			baseConfig.observerRichModel ?? RICH_TIER_DEFAULTS.observerModel ?? baseConfig.observerModel,
		observerTemperature:
			baseConfig.observerRichTemperature ??
			RICH_TIER_DEFAULTS.observerTemperature ??
			baseConfig.observerTemperature,
		observerOpenAIUseResponses:
			baseConfig.observerRichOpenAIUseResponses ??
			RICH_TIER_DEFAULTS.observerOpenAIUseResponses ??
			false,
		observerReasoningEffort:
			baseConfig.observerRichReasoningEffort ?? RICH_TIER_DEFAULTS.observerReasoningEffort ?? null,
		observerReasoningSummary:
			baseConfig.observerRichReasoningSummary ??
			RICH_TIER_DEFAULTS.observerReasoningSummary ??
			null,
		observerMaxOutputTokens:
			baseConfig.observerRichMaxOutputTokens ??
			RICH_TIER_DEFAULTS.observerMaxOutputTokens ??
			baseConfig.observerMaxTokens,
	};
}

export function decideExtractionReplayTier(
	input: ExtractionReplayTierRoutingInput,
): ExtractionReplayTierRoutingDecision {
	const reasons: string[] = [];
	if (input.eventSpan >= 100) reasons.push(`event_span=${input.eventSpan}`);
	if (input.transcriptLength >= 6000) reasons.push(`transcript_length=${input.transcriptLength}`);
	if (input.toolCount >= 25) reasons.push(`tool_count=${input.toolCount}`);
	if (input.toolCount >= 9 && input.transcriptLength >= 2000) {
		reasons.push(`tool_count=${input.toolCount}+transcript_length=${input.transcriptLength}`);
	}
	if (input.promptCount >= 3 && input.toolCount >= 8) {
		reasons.push(`prompt_count=${input.promptCount}+tool_count=${input.toolCount}`);
	}

	if (reasons.length > 0) {
		return {
			tier: "rich",
			reasons,
			observer: { ...RICH_TIER_DEFAULTS },
		};
	}

	return {
		tier: "simple",
		reasons: ["fell below rich-batch thresholds"],
		observer: { ...SIMPLE_TIER_DEFAULTS },
	};
}
