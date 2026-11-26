import { describe, expect, it } from "vitest";
import {
	estimateExtractionModelCost,
	getExtractionModelPricing,
	listExtractionModelPricing,
} from "./extraction-model-pricing.js";

describe("extraction model pricing", () => {
	it("lists the published list rates for every priced model", () => {
		expect(
			listExtractionModelPricing().map((pricing) => [
				pricing.model,
				pricing.inputUsdPerMillionTokens,
				pricing.outputUsdPerMillionTokens,
			]),
		).toEqual([
			["gpt-6-luna", 0.1, 0.5],
			["gpt-6.1-terra", 1, 5],
			["gpt-6.2-sol", 2, 10],
			["gpt-6.2-astra", 8, 40],
			["gpt-5.4-mini", 0.75, 4.5],
			["gpt-5.4", 2.5, 15],
			["gpt-5.5", 5, 30],
			["gpt-5.6-luna", 0.2, 1.2],
			["gpt-5.6-terra", 2, 12],
			["gpt-5.6-sol", 4, 20],
			["claude-haiku-4-5", 1, 5],
			["claude-sonnet-4-6", 3, 15],
			["claude-haiku-5-5", 0.1, 0.5],
			["claude-sonnet-5-5", 2, 10],
		]);
	});

	it.each([
		["gpt-6-luna", "gpt-6-luna", 0.1, 0.5],
		["gpt-6.1-terra", "gpt-6.1-terra", 1, 5],
		["gpt-5.6-luna", "gpt-5.6-luna", 0.2, 1.2],
		["Luna", "gpt-5.6-luna", 0.2, 1.2],
		["gpt-5.6-terra", "gpt-5.6-terra", 2, 12],
		["Terra", "gpt-5.6-terra", 2, 12],
		["gpt-5.6-sol", "gpt-5.6-sol", 4, 20],
		["Sol", "gpt-5.6-sol", 4, 20],
		["claude-4.5-haiku", "claude-haiku-4-5", 1, 5],
		["claude-haiku-4-5-20251001", "claude-haiku-4-5", 1, 5],
		["claude-4.6-sonnet", "claude-sonnet-4-6", 3, 15],
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

	it("estimates the default Luna model with its own rates", () => {
		expect(
			estimateExtractionModelCost("gpt-6-luna", {
				inputTokens: 1_000_000,
				outputTokens: 200_000,
			}),
		).toEqual({
			model: "gpt-6-luna",
			usage: { inputTokens: 1_000_000, outputTokens: 200_000 },
			inputCostUsd: 0.1,
			outputCostUsd: 0.1,
			totalCostUsd: 0.2,
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
