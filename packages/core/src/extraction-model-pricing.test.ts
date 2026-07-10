import { describe, expect, it } from "vitest";
import {
	estimateExtractionModelCost,
	getExtractionModelPricing,
	listExtractionModelPricing,
} from "./extraction-model-pricing.js";

describe("extraction model pricing", () => {
	it("lists the explicit benchmark model prices", () => {
		expect(listExtractionModelPricing()).toEqual([
			expect.objectContaining({
				model: "gpt-5.4-mini",
				inputUsdPerMillionTokens: 0.75,
				outputUsdPerMillionTokens: 4.5,
			}),
			expect.objectContaining({
				model: "gpt-5.4",
				inputUsdPerMillionTokens: 2.5,
				outputUsdPerMillionTokens: 15,
			}),
			expect.objectContaining({
				model: "gpt-5.5",
				inputUsdPerMillionTokens: 5,
				outputUsdPerMillionTokens: 30,
			}),
			expect.objectContaining({ model: "gpt-5.6-terra" }),
			expect.objectContaining({ model: "gpt-5.6-sol" }),
		]);
	});

	it.each([
		["gpt-5.6-terra", "gpt-5.6-terra", 2.5, 15],
		["Terra", "gpt-5.6-terra", 2.5, 15],
		["gpt-5.6-sol", "gpt-5.6-sol", 5, 30],
		["Sol", "gpt-5.6-sol", 5, 30],
	] as const)("resolves the %s alias", (alias, model, inputRate, outputRate) => {
		expect(getExtractionModelPricing(alias)).toEqual(
			expect.objectContaining({
				model,
				inputUsdPerMillionTokens: inputRate,
				outputUsdPerMillionTokens: outputRate,
			}),
		);
	});

	it("estimates cost only from normalized input and output token usage", () => {
		const estimate = estimateExtractionModelCost("gpt-5.4-mini", {
			inputTokens: 1_000_000,
			outputTokens: 200_000,
		});

		expect(estimate).toEqual({
			model: "gpt-5.4-mini",
			usage: { inputTokens: 1_000_000, outputTokens: 200_000 },
			inputCostUsd: 0.75,
			outputCostUsd: 0.9,
			totalCostUsd: 1.65,
		});
	});

	it.each([null, undefined])("returns null when normalized usage is %s", (usage) => {
		expect(estimateExtractionModelCost("gpt-5.4", usage)).toBeNull();
	});

	it("returns null for unknown pricing or invalid usage", () => {
		expect(
			estimateExtractionModelCost("unknown-model", { inputTokens: 10, outputTokens: 5 }),
		).toBeNull();
		expect(estimateExtractionModelCost("gpt-5.4", { inputTokens: -1, outputTokens: 5 })).toBeNull();
	});

	it("returns defensive pricing and usage copies", () => {
		const prices = listExtractionModelPricing();
		const first = prices[0];
		if (!first) throw new Error("expected pricing entry");
		first.aliases.push("mutated");
		const fresh = getExtractionModelPricing("gpt-5.4-mini");
		expect(fresh?.aliases).not.toContain("mutated");

		const usage = { inputTokens: 100, outputTokens: 50 };
		const estimate = estimateExtractionModelCost("Sol", usage);
		usage.inputTokens = 999;
		expect(estimate?.usage.inputTokens).toBe(100);
	});
});
