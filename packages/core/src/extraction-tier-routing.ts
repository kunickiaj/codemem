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

export const SIMPLE_TIER_ANTHROPIC_DEFAULTS: Partial<ObserverConfig> = {
	observerProvider: "anthropic",
	observerModel: "claude-haiku-4-5",
	observerTemperature: 0.2,
};

export const RICH_TIER_ANTHROPIC_DEFAULTS: Partial<ObserverConfig> = {
	observerProvider: "anthropic",
	observerModel: "claude-sonnet-4-6",
	observerTemperature: 0.2,
	observerMaxOutputTokens: 12000,
};

type KnownTierProvider = "openai" | "anthropic";

function normalizeKnownProvider(value: string | null | undefined): KnownTierProvider | null {
	if (!value) return null;
	const lowered = value.toLowerCase();
	if (lowered === "openai") return "openai";
	if (lowered === "anthropic") return "anthropic";
	return null;
}

function trimmedProvider(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.toLowerCase() : null;
}

function resolveSimpleTierDefaults(provider: KnownTierProvider): Partial<ObserverConfig> {
	return provider === "anthropic" ? SIMPLE_TIER_ANTHROPIC_DEFAULTS : SIMPLE_TIER_DEFAULTS;
}

function resolveRichTierDefaults(provider: KnownTierProvider): Partial<ObserverConfig> {
	return provider === "anthropic" ? RICH_TIER_ANTHROPIC_DEFAULTS : RICH_TIER_DEFAULTS;
}

export function buildTieredObserverConfig(
	baseConfig: ObserverConfig,
	decision: ExtractionReplayTierRoutingDecision,
): ObserverConfig {
	if (decision.tier === "simple") {
		const knownProvider =
			normalizeKnownProvider(baseConfig.observerSimpleProvider) ??
			normalizeKnownProvider(baseConfig.observerProvider);
		if (knownProvider) {
			const tierDefaults = resolveSimpleTierDefaults(knownProvider);
			return {
				...baseConfig,
				observerProvider: knownProvider,
				observerModel:
					baseConfig.observerSimpleModel ?? tierDefaults.observerModel ?? baseConfig.observerModel,
				observerTemperature:
					baseConfig.observerSimpleTemperature ??
					tierDefaults.observerTemperature ??
					baseConfig.observerTemperature,
				observerOpenAIUseResponses: knownProvider === "openai" ? false : undefined,
				observerReasoningEffort: null,
				observerReasoningSummary: null,
				observerMaxOutputTokens: baseConfig.observerMaxTokens,
			};
		}
		// Unknown/custom provider (e.g. opencode, bespoke gateway): preserve the
		// base provider and only honor user-provided tier overrides. Do not apply
		// OpenAI or Anthropic defaults.
		const preservedProvider =
			trimmedProvider(baseConfig.observerSimpleProvider) ?? baseConfig.observerProvider ?? null;
		return {
			...baseConfig,
			observerProvider: preservedProvider,
			observerModel: baseConfig.observerSimpleModel ?? baseConfig.observerModel,
			observerTemperature: baseConfig.observerSimpleTemperature ?? baseConfig.observerTemperature,
			observerOpenAIUseResponses: undefined,
			observerReasoningEffort: null,
			observerReasoningSummary: null,
			observerMaxOutputTokens: baseConfig.observerMaxTokens,
		};
	}

	const knownProvider =
		normalizeKnownProvider(baseConfig.observerRichProvider) ??
		normalizeKnownProvider(baseConfig.observerProvider);
	if (knownProvider) {
		const tierDefaults = resolveRichTierDefaults(knownProvider);
		const isOpenAI = knownProvider === "openai";
		return {
			...baseConfig,
			observerProvider: knownProvider,
			observerModel:
				baseConfig.observerRichModel ?? tierDefaults.observerModel ?? baseConfig.observerModel,
			observerTemperature:
				baseConfig.observerRichTemperature ??
				tierDefaults.observerTemperature ??
				baseConfig.observerTemperature,
			observerOpenAIUseResponses: isOpenAI
				? baseConfig.observerRichOpenAIUseResponses === true
					? true
					: (tierDefaults.observerOpenAIUseResponses ?? false)
				: undefined,
			observerReasoningEffort: isOpenAI
				? (baseConfig.observerRichReasoningEffort ?? tierDefaults.observerReasoningEffort ?? null)
				: null,
			observerReasoningSummary: isOpenAI
				? (baseConfig.observerRichReasoningSummary ?? tierDefaults.observerReasoningSummary ?? null)
				: null,
			observerMaxOutputTokens:
				baseConfig.observerRichMaxOutputTokens ??
				tierDefaults.observerMaxOutputTokens ??
				baseConfig.observerMaxTokens,
		};
	}
	// Unknown/custom provider: preserve base provider and only honor explicit
	// rich-tier overrides.
	const preservedProvider =
		trimmedProvider(baseConfig.observerRichProvider) ?? baseConfig.observerProvider ?? null;
	return {
		...baseConfig,
		observerProvider: preservedProvider,
		observerModel: baseConfig.observerRichModel ?? baseConfig.observerModel,
		observerTemperature: baseConfig.observerRichTemperature ?? baseConfig.observerTemperature,
		observerOpenAIUseResponses: undefined,
		observerReasoningEffort: null,
		observerReasoningSummary: null,
		observerMaxOutputTokens: baseConfig.observerRichMaxOutputTokens ?? baseConfig.observerMaxTokens,
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
