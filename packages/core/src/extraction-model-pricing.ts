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

// Evaluation pricing snapshot supplied for the 2026-07-10 model-selection run.
// Cost estimates intentionally use provider-reported input/output totals without
// applying cache discounts because cache billing fields are not consistent
// across the supported HTTP and sidecar transports.
const EXTRACTION_MODEL_PRICING: readonly ExtractionModelPricing[] = [
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
		model: "gpt-5.6-terra",
		aliases: ["gpt-5.6-terra", "terra"],
		inputUsdPerMillionTokens: 2.5,
		outputUsdPerMillionTokens: 15,
	},
	{
		model: "gpt-5.6-sol",
		aliases: ["gpt-5.6-sol", "sol"],
		inputUsdPerMillionTokens: 5,
		outputUsdPerMillionTokens: 30,
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
