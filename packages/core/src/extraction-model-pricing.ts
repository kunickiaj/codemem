export interface ExtractionModelPricing {
	model: string;
	aliases: string[];
	inputUsdPerMillionTokens: number;
	outputUsdPerMillionTokens: number;
}

export interface NormalizedExtractionTokenUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface ExtractionModelCostEstimate {
	model: string;
	usage: NormalizedExtractionTokenUsage;
	inputCostUsd: number;
	outputCostUsd: number;
	totalCostUsd: number;
}

// Pricing snapshot recorded 2026-11-26.
// Cost estimates intentionally use provider-reported input/output totals without
// applying cache discounts because cache billing fields are not consistent
// across the supported HTTP and sidecar transports.
const EXTRACTION_MODEL_PRICING: readonly ExtractionModelPricing[] = [
	// OpenAI standard short-context rates (prompts up to 272K input tokens),
	// verified 2026-11-26: https://developers.openai.com/api/docs/pricing
	// Usage totals do not identify the context pricing band.
	{
		model: "gpt-6-luna",
		aliases: ["gpt-6-luna"],
		inputUsdPerMillionTokens: 0.1,
		outputUsdPerMillionTokens: 0.5,
	},
	{
		model: "gpt-6.1-terra",
		aliases: ["gpt-6.1-terra"],
		inputUsdPerMillionTokens: 1,
		outputUsdPerMillionTokens: 5,
	},
	{
		model: "gpt-6.2-sol",
		aliases: ["gpt-6.2-sol"],
		inputUsdPerMillionTokens: 2,
		outputUsdPerMillionTokens: 10,
	},
	{
		model: "gpt-6.2-astra",
		aliases: ["gpt-6.2-astra"],
		inputUsdPerMillionTokens: 8,
		outputUsdPerMillionTokens: 40,
	},
	{
		model: "gpt-5.4-mini",
		aliases: ["gpt-5.4-mini"],
		inputUsdPerMillionTokens: 0.75,
		outputUsdPerMillionTokens: 4.5,
	},
	{
		model: "gpt-5.4",
		aliases: ["gpt-5.4"],
		inputUsdPerMillionTokens: 2.5,
		outputUsdPerMillionTokens: 15,
	},
	{
		model: "gpt-5.5",
		aliases: ["gpt-5.5"],
		inputUsdPerMillionTokens: 5,
		outputUsdPerMillionTokens: 30,
	},
	{
		model: "gpt-5.6-luna",
		aliases: ["gpt-5.6-luna", "luna"],
		inputUsdPerMillionTokens: 0.2,
		outputUsdPerMillionTokens: 1.2,
	},
	{
		model: "gpt-5.6-terra",
		aliases: ["gpt-5.6-terra", "terra"],
		inputUsdPerMillionTokens: 2,
		outputUsdPerMillionTokens: 12,
	},
	// The pricing page lists this rate as promotional until 2026-11-30.
	{
		model: "gpt-5.6-sol",
		aliases: ["gpt-5.6-sol", "sol"],
		inputUsdPerMillionTokens: 4,
		outputUsdPerMillionTokens: 20,
	},
	// Anthropic base input and output rates, verified 2026-11-26:
	// https://platform.claude.com/docs/en/about-claude/pricing
	{
		model: "claude-haiku-4-5",
		aliases: ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-4.5-haiku"],
		inputUsdPerMillionTokens: 1,
		outputUsdPerMillionTokens: 5,
	},
	{
		model: "claude-sonnet-4-6",
		aliases: ["claude-sonnet-4-6", "claude-4.6-sonnet"],
		inputUsdPerMillionTokens: 3,
		outputUsdPerMillionTokens: 15,
	},
	// Prompts up to 100,000 tokens; longer prompts cost more and are not modeled.
	{
		model: "claude-haiku-5-5",
		aliases: ["claude-haiku-5-5"],
		inputUsdPerMillionTokens: 0.1,
		outputUsdPerMillionTokens: 0.5,
	},
	{
		model: "claude-sonnet-5-5",
		aliases: ["claude-sonnet-5-5"],
		inputUsdPerMillionTokens: 2,
		outputUsdPerMillionTokens: 10,
	},
];

function normalizeModel(model: string): string {
	return model.trim().toLowerCase();
}

function clonePricing(pricing: ExtractionModelPricing): ExtractionModelPricing {
	return { ...pricing, aliases: [...pricing.aliases] };
}

function isActualUsage(
	usage: NormalizedExtractionTokenUsage | null | undefined,
): usage is NormalizedExtractionTokenUsage {
	return Boolean(
		usage &&
			Number.isFinite(usage.inputTokens) &&
			usage.inputTokens >= 0 &&
			Number.isFinite(usage.outputTokens) &&
			usage.outputTokens >= 0,
	);
}

export function listExtractionModelPricing(): ExtractionModelPricing[] {
	return EXTRACTION_MODEL_PRICING.map(clonePricing);
}

export function getExtractionModelPricing(model: string): ExtractionModelPricing | null {
	const normalized = normalizeModel(model);
	const pricing = EXTRACTION_MODEL_PRICING.find((candidate) =>
		candidate.aliases.some((alias) => normalizeModel(alias) === normalized),
	);
	return pricing ? clonePricing(pricing) : null;
}

export function estimateExtractionModelCost(
	model: string,
	usage: NormalizedExtractionTokenUsage | null | undefined,
): ExtractionModelCostEstimate | null {
	if (!isActualUsage(usage)) return null;
	const pricing = getExtractionModelPricing(model);
	if (!pricing) return null;
	const inputCostUsd = (usage.inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens;
	const outputCostUsd = (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens;
	return {
		model: pricing.model,
		usage: { ...usage },
		inputCostUsd,
		outputCostUsd,
		totalCostUsd: inputCostUsd + outputCostUsd,
	};
}
