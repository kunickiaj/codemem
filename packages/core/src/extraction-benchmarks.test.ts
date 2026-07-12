import { describe, expect, it } from "vitest";
import {
	getExtractionBenchmarkProfile,
	listExtractionBenchmarkProfiles,
} from "./extraction-benchmarks.js";

describe("extraction benchmarks", () => {
	it("exposes a balanced fully reviewed 18-case quality profile", () => {
		const profile = getExtractionBenchmarkProfile("balanced-observer-quality-v1");
		expect(profile).not.toBeNull();
		const shapeBatches =
			profile?.batches.filter((batch) => batch.purpose === "shape_quality") ?? [];
		expect(shapeBatches).toHaveLength(18);
		for (const complexity of ["simple", "working", "rich"] as const) {
			expect(shapeBatches.filter((batch) => batch.complexity === complexity)).toHaveLength(6);
		}
		expect(shapeBatches.every((batch) => batch.review?.status === "reviewed")).toBe(true);
		expect(profile?.batches.filter((batch) => batch.purpose === "replay_robustness")).toEqual([
			expect.objectContaining({ batchId: 18476 }),
		]);
	});

	it("routes all balanced zero-observation controls through the routine scenario", () => {
		const profile = getExtractionBenchmarkProfile("balanced-observer-quality-v1");
		const zeroObservationBatchIds = new Set([18530, 28350, 28344, 28262, 28301, 18446]);
		const zeroObservationControls =
			profile?.batches.filter((batch) => zeroObservationBatchIds.has(batch.batchId)) ?? [];

		expect(zeroObservationControls.map((batch) => batch.batchId)).toEqual([
			18530, 28350, 28344, 28262, 28301, 18446,
		]);
		expect(zeroObservationControls.every((batch) => batch.observationPolicy === "zero")).toBe(true);
		expect(
			zeroObservationControls.every((batch) => batch.scenarioId === "routine-batch-shape"),
		).toBe(true);
	});

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
		expect(profile?.modelCandidates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ model: "gpt-5.4", role: "rich_baseline" }),
				expect.objectContaining({ model: "gpt-5.5", role: "quality_ceiling" }),
				expect.objectContaining({
					model: "gpt-5.6-terra",
					role: "cost_matched_challenger",
				}),
			]),
		);
		expect(profile?.batches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ batchId: 18503, purpose: "shape_quality" }),
				expect.objectContaining({
					batchId: 18446,
					scenarioId: "routine-batch-shape",
					observationPolicy: "zero",
				}),
				expect.objectContaining({ batchId: 18476, purpose: "replay_robustness" }),
			]),
		);
	});

	it("exposes the mixed-complexity routing benchmark profile", () => {
		const profile = getExtractionBenchmarkProfile("mixed-batch-routing-v1");
		expect(profile).not.toBeNull();
		expect(profile?.batches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					batchId: 18530,
					complexity: "simple",
					expectedTier: "simple",
					scenarioId: "routine-batch-shape",
					observationPolicy: "zero",
				}),
				expect.objectContaining({ batchId: 18524, complexity: "working", expectedTier: "simple" }),
				expect.objectContaining({ batchId: 18503, complexity: "rich", expectedTier: "rich" }),
			]),
		);
	});

	it("carries the known durable-fact review for batches 18503 and 18432", () => {
		const profile = getExtractionBenchmarkProfile("rich-batch-shape-v1");
		const batch18503 = profile?.batches.find((batch) => batch.batchId === 18503);
		const batch18432 = profile?.batches.find((batch) => batch.batchId === 18432);
		expect(batch18503?.review).toEqual(
			expect.objectContaining({
				status: "reviewed",
				labels: expect.arrayContaining([
					expect.objectContaining({
						id: "stable-session-reuse-regression",
						disposition: "required",
					}),
					expect.objectContaining({
						id: "graphite-branch-hygiene",
						disposition: "forbidden",
					}),
				]),
			}),
		);
		expect(batch18432?.review).toEqual(
			expect.objectContaining({
				status: "reviewed",
				labels: expect.arrayContaining([
					expect.objectContaining({
						id: "transparent-relink-startup",
						disposition: "required",
					}),
					expect.objectContaining({
						id: "relinking-does-not-fix-recap-dominance",
						disposition: "required",
					}),
				]),
			}),
		);
	});

	it("records summary disposition and source evidence for every reviewed label", () => {
		for (const profile of listExtractionBenchmarkProfiles()) {
			for (const batch of profile.batches) {
				expect(["required", "optional", "skip"]).toContain(batch.expectedSummaryDisposition);
				if (batch.review.status !== "reviewed") continue;
				for (const label of batch.review.labels) {
					expect(label.sourceEvidence.trim().length).toBeGreaterThan(0);
				}
			}
		}
	});

	it("marks only robustness batches without known review as explicitly unreviewed", () => {
		const profile = getExtractionBenchmarkProfile("rich-batch-shape-v1");
		expect(profile?.batches.find((batch) => batch.batchId === 18476)?.review).toEqual({
			status: "unreviewed",
			reviewerNotes: "No durable-fact review has been recorded for this batch.",
		});
	});

	it("returns defensive copies from the benchmark listing", () => {
		const profiles = listExtractionBenchmarkProfiles();
		expect(profiles.length).toBeGreaterThan(0);
		const firstProfile = profiles[0];
		if (!firstProfile) throw new Error("expected at least one profile");
		const firstBatch = firstProfile.batches[0];
		if (!firstBatch) throw new Error("expected at least one batch in the first profile");
		firstBatch.label = "mutated";
		const firstCandidate = firstProfile.modelCandidates[0];
		if (!firstCandidate) throw new Error("expected at least one model candidate");
		firstCandidate.model = "mutated-model";
		if (firstBatch.review?.status === "reviewed") {
			const firstLabel = firstBatch.review.labels[0];
			if (!firstLabel) throw new Error("expected reviewed batch to have a label");
			firstLabel.keywordGroups[0]?.push("mutated keyword");
		}
		const fresh = getExtractionBenchmarkProfile("rich-batch-shape-v1");
		expect(fresh?.batches[0]?.label).not.toBe("mutated");
		expect(fresh?.modelCandidates[0]?.model).not.toBe("mutated-model");
		const freshReview = fresh?.batches[0]?.review;
		expect(
			freshReview?.status === "reviewed" ? freshReview.labels[0]?.keywordGroups[0] : [],
		).not.toContain("mutated keyword");
	});
});
