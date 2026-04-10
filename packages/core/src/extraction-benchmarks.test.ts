import { describe, expect, it } from "vitest";
import {
	getExtractionBenchmarkProfile,
	listExtractionBenchmarkProfiles,
} from "./extraction-benchmarks.js";

describe("extraction benchmarks", () => {
	it("exposes the rich-batch benchmark profile", () => {
		const profile = getExtractionBenchmarkProfile("rich-batch-shape-v1");
		expect(profile).not.toBeNull();
		expect(profile?.scenarioId).toBe("rich-batch-shape");
		expect(profile?.recommendedTruthModel).toEqual(
			expect.objectContaining({ provider: "openai", model: "gpt-5.4" }),
		);
		expect(profile?.cheapCandidate).toEqual(
			expect.objectContaining({
				provider: "openai",
				model: "gpt-5.4-mini",
				temperature: 0.2,
			}),
		);
		expect(profile?.batches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ batchId: 18503, purpose: "shape_quality" }),
				expect.objectContaining({ batchId: 18476, purpose: "replay_robustness" }),
			]),
		);
	});

	it("exposes the mixed-complexity routing benchmark profile", () => {
		const profile = getExtractionBenchmarkProfile("mixed-batch-routing-v1");
		expect(profile).not.toBeNull();
		expect(profile?.batches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ batchId: 18530, complexity: "simple", expectedTier: "simple" }),
				expect.objectContaining({ batchId: 18524, complexity: "working", expectedTier: "simple" }),
				expect.objectContaining({ batchId: 18503, complexity: "rich", expectedTier: "rich" }),
			]),
		);
	});

	it("returns defensive copies from the benchmark listing", () => {
		const profiles = listExtractionBenchmarkProfiles();
		expect(profiles.length).toBeGreaterThan(0);
		const firstProfile = profiles[0];
		if (!firstProfile) throw new Error("expected at least one profile");
		const firstBatch = firstProfile.batches[0];
		if (!firstBatch) throw new Error("expected at least one batch in the first profile");
		firstBatch.label = "mutated";
		const fresh = getExtractionBenchmarkProfile("rich-batch-shape-v1");
		expect(fresh?.batches[0]?.label).not.toBe("mutated");
	});
});
