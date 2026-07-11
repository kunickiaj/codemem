import { describe, expect, it } from "vitest";
import {
	calculateCostAdjustedScore,
	calculateWeightedQualityCoverage,
	calculateWeightedQualityScore,
	scoreExtractionBenchmarkOutput,
} from "./extraction-benchmark-scoring.js";
import type { ExtractionBenchmarkReview } from "./extraction-benchmarks.js";
import { getExtractionBenchmarkProfile } from "./extraction-benchmarks.js";
import type { ParsedObservation, ParsedOutput } from "./ingest-types.js";
import type { ObserverResponseStructuralDiagnostics } from "./ingest-xml-parser.js";

const CLEAN_DIAGNOSTICS: ObserverResponseStructuralDiagnostics = {
	recognizedOutput: true,
	observationBlocks: 0,
	retainedObservations: 0,
	summaryBlocks: 1,
	retainedSummaries: 1,
	illegalObservationNestingInSummary: 0,
	unknownSummaryFields: [],
	unsupportedObservationKinds: [],
	missingObservationKinds: 0,
	discardedObservationBlocks: 0,
	discardedSummaryBlocks: 0,
	dataLoss: false,
};

function observation(title: string, narrative: string): ParsedObservation {
	return {
		kind: "discovery",
		title,
		narrative,
		subtitle: null,
		facts: [],
		concepts: [],
		filesRead: [],
		filesModified: [],
	};
}

function parsed(observations: ParsedObservation[], learned = ""): ParsedOutput {
	return {
		observations,
		summary: {
			request: "Evaluate extraction quality.",
			investigated: "",
			learned,
			completed: "",
			nextSteps: "",
			notes: "",
			filesRead: [],
			filesModified: [],
		},
		skipSummaryReason: null,
	};
}

function reviewedBatch(batchId: number) {
	const batch = getExtractionBenchmarkProfile("rich-batch-shape-v1")?.batches.find(
		(candidate) => candidate.batchId === batchId,
	);
	if (batch?.review.status !== "reviewed") {
		throw new Error(`expected reviewed benchmark batch ${batchId}`);
	}
	return batch.review;
}

describe("extraction benchmark scoring", () => {
	it("matches all keyword groups and exposes reviewer-readable observation text", () => {
		const result = scoreExtractionBenchmarkOutput({
			parsed: parsed([
				observation(
					"TypeScript stable-session regression",
					"The TS rewrite caused a regression by failing to reuse the stable session.",
				),
				observation("Graphite branch hygiene", "Graphite branch cleanup kept the stack tidy."),
			]),
			diagnostics: CLEAN_DIAGNOSTICS,
			review: reviewedBatch(18503),
		});

		expect(result.requiredRecall).toEqual(
			expect.objectContaining({
				score: 1,
				matchedLabelIds: ["stable-session-reuse-regression"],
				missingLabelIds: [],
			}),
		);
		expect(result.requiredRecall.matches[0]?.observations[0]?.text).toContain(
			"The TS rewrite caused a regression",
		);
		expect(result.forbidden).toEqual(
			expect.objectContaining({
				avoidance: 0,
				matchedLabelIds: ["graphite-branch-hygiene"],
			}),
		);
		expect(result.worthinessPrecision.score).toBe(0.5);
		expect(result.worthinessPrecision.flaggedObservationIndexes).toEqual([1]);
		expect(result.factualGrounding).toEqual(
			expect.objectContaining({ status: "requires_human_review", score: null }),
		);
	});

	it("does not match a label when only some keyword groups are present", () => {
		const result = scoreExtractionBenchmarkOutput({
			parsed: parsed([
				observation(
					"TypeScript regression",
					"A TypeScript bug was fixed, but session behavior was not analyzed.",
				),
			]),
			diagnostics: CLEAN_DIAGNOSTICS,
			review: reviewedBatch(18503),
		});

		expect(result.requiredRecall.score).toBe(0);
		expect(result.requiredRecall.missingLabelIds).toEqual(["stable-session-reuse-regression"]);
	});

	it("scores the two reviewed 18432 lessons as distinct required facts", () => {
		const learned =
			"Transparent startup relinking runs during viewer preparation. Relinking reduces unmapped sessions but does not solve summary dominance.";
		const result = scoreExtractionBenchmarkOutput({
			parsed: parsed(
				[
					observation(
						"Relink repair runs transparently",
						"Internal relinking runs at startup during PrepareViewerDatabase.",
					),
					observation(
						"Relinking has a bounded benefit",
						"Relinking reduces unmapped sessions but does not fix summary dominance.",
					),
				],
				learned,
			),
			diagnostics: CLEAN_DIAGNOSTICS,
			review: reviewedBatch(18432),
		});

		expect(result.requiredRecall.score).toBe(1);
		expect(result.requiredRecall.matchedLabelIds).toEqual([
			"transparent-relink-startup",
			"relinking-does-not-fix-recap-dominance",
		]);
		expect(result.summaryBreadth.score).toBe(1);
		expect(result.observationSignals.segmentation).toBe(1);
	});

	it("reports duplicate observations as a redundancy signal", () => {
		const duplicate = observation(
			"TypeScript stable-session regression",
			"The TS rewrite caused a regression by failing to reuse the stable session.",
		);
		const result = scoreExtractionBenchmarkOutput({
			parsed: parsed([duplicate, { ...duplicate }]),
			diagnostics: CLEAN_DIAGNOSTICS,
			review: reviewedBatch(18503),
		});

		expect(result.observationSignals.redundantPairs).toEqual([[0, 1]]);
		expect(result.observationSignals.redundantObservationIndexes).toEqual([0, 1]);
		expect(result.observationSignals.redundancyAvoidance).toBe(0);
	});

	it("scores optional recall and flags multi-label observation segmentation", () => {
		const review: ExtractionBenchmarkReview = {
			status: "reviewed",
			reviewerNotes: "Focused scoring fixture.",
			labels: [
				{
					id: "required-contract",
					title: "Required contract",
					disposition: "required",
					keywordGroups: [["durable"], ["contract"]],
					reviewerNotes: "Required fixture label.",
					sourceEvidence: "Synthetic test evidence for the durable contract.",
				},
				{
					id: "optional-context",
					title: "Optional context",
					disposition: "optional",
					keywordGroups: [["extra"], ["context"]],
					reviewerNotes: "Optional fixture label.",
					sourceEvidence: "Synthetic test evidence for the optional context.",
				},
			],
		};
		const result = scoreExtractionBenchmarkOutput({
			parsed: parsed([observation("Combined memory", "A durable contract with extra context.")]),
			diagnostics: CLEAN_DIAGNOSTICS,
			review,
		});

		expect(result.optionalRecall.score).toBe(1);
		expect(result.optionalRecall.matchedLabelIds).toEqual(["optional-context"]);
		expect(result.observationSignals.multiLabelObservationIndexes).toEqual([0]);
		expect(result.observationSignals.segmentation).toBe(0);
	});

	it("fails schema compliance when structural diagnostics expose parser loss", () => {
		const result = scoreExtractionBenchmarkOutput({
			parsed: parsed([]),
			diagnostics: {
				...CLEAN_DIAGNOSTICS,
				unknownSummaryFields: ["result"],
				unsupportedObservationKinds: ["telemetry"],
				missingObservationKinds: 1,
				discardedObservationBlocks: 1,
				dataLoss: true,
			},
			review: reviewedBatch(18503),
		});

		expect(result.schemaCompliance.compliant).toBe(false);
		expect(result.schemaCompliance.score).toBe(0);
		expect(result.schemaCompliance.violations).toEqual(
			expect.arrayContaining([
				expect.stringContaining("unknown summary fields"),
				expect.stringContaining("unsupported observation kinds"),
				expect.stringContaining("missing a kind"),
				expect.stringContaining("observation block(s) discarded"),
				expect.stringContaining("data loss"),
			]),
		);
	});

	it("excludes null and human-only dimensions from weighted quality", () => {
		const score = calculateWeightedQualityScore({
			summaryDisposition: null,
			requiredRecall: 1,
			optionalRecall: null,
			worthinessPrecision: null,
			summaryBreadth: null,
			redundancyAvoidance: null,
			segmentation: null,
			schemaCompliance: 0,
			factualGrounding: 1,
		});

		expect(score).toBeCloseTo(0.45 / (0.45 + 0.1));
	});

	it("reports how much of the weighted rubric was actually scored", () => {
		const coverage = calculateWeightedQualityCoverage({
			summaryDisposition: 1,
			requiredRecall: 1,
			optionalRecall: null,
			worthinessPrecision: null,
			summaryBreadth: null,
			redundancyAvoidance: null,
			segmentation: null,
			schemaCompliance: 1,
			factualGrounding: null,
		});

		expect(coverage).toBeGreaterThan(0);
		expect(coverage).toBeLessThan(1);
	});

	it("accepts a valid low-signal skip only when the batch disposition permits it", () => {
		const skipped: ParsedOutput = {
			observations: [],
			summary: null,
			skipSummaryReason: "low-signal",
		};
		const optional = scoreExtractionBenchmarkOutput({
			parsed: skipped,
			diagnostics: { ...CLEAN_DIAGNOSTICS, summaryBlocks: 0, retainedSummaries: 0 },
			review: reviewedBatch(18503),
			expectedSummaryDisposition: "optional",
		});
		const required = scoreExtractionBenchmarkOutput({
			parsed: skipped,
			diagnostics: { ...CLEAN_DIAGNOSTICS, summaryBlocks: 0, retainedSummaries: 0 },
			review: reviewedBatch(18503),
			expectedSummaryDisposition: "required",
		});

		expect(optional.summaryDisposition).toEqual(
			expect.objectContaining({ actual: "skip", score: 1 }),
		);
		expect(required.summaryDisposition).toEqual(
			expect.objectContaining({ actual: "skip", score: 0 }),
		);
	});

	it("normalizes low-signal skip reasons like production ingestion", () => {
		const score = scoreExtractionBenchmarkOutput({
			parsed: {
				observations: [],
				summary: null,
				skipSummaryReason: " Low-Signal ",
			},
			diagnostics: { ...CLEAN_DIAGNOSTICS, summaryBlocks: 0, retainedSummaries: 0 },
			review: reviewedBatch(18503),
			expectedSummaryDisposition: "skip",
		});

		expect(score.summaryDisposition).toEqual(expect.objectContaining({ actual: "skip", score: 1 }));
	});

	it("keeps cost-adjusted quality null until an actual cost is supplied", () => {
		const withoutCost = scoreExtractionBenchmarkOutput({
			parsed: parsed([]),
			diagnostics: CLEAN_DIAGNOSTICS,
			review: reviewedBatch(18503),
		});
		const withCost = scoreExtractionBenchmarkOutput({
			parsed: parsed([]),
			diagnostics: CLEAN_DIAGNOSTICS,
			review: reviewedBatch(18503),
			estimatedCostUsd: 0.25,
		});

		expect(withoutCost.costAdjustedScore).toBeNull();
		expect(withCost.weightedQualityScore).not.toBeNull();
		expect(withCost.costAdjustedScore).toBeCloseTo(
			((withCost.weightedQualityScore ?? 0) * 0.01) / 0.25,
		);
		expect(withCost.costAdjustedScoreUnit).toBe("quality_points_per_cent");
		expect(calculateCostAdjustedScore(0.8, -1)).toBeNull();
		expect(calculateCostAdjustedScore(0.8, 0)).toBeNull();
	});

	it("does not reward an empty observation set for precision or redundancy", () => {
		const result = scoreExtractionBenchmarkOutput({
			parsed: parsed([]),
			diagnostics: CLEAN_DIAGNOSTICS,
			review: reviewedBatch(18503),
		});

		expect(result.requiredRecall.score).toBe(0);
		expect(result.worthinessPrecision.score).toBeNull();
		expect(result.observationSignals.redundancyAvoidance).toBeNull();
		expect(result.weightedQualityScore).toBeLessThanOrEqual(0.3);
	});

	it("scores a reviewed no-output response as zero quality", () => {
		const result = scoreExtractionBenchmarkOutput({
			parsed: parsed([]),
			diagnostics: { ...CLEAN_DIAGNOSTICS, recognizedOutput: false },
			review: reviewedBatch(18503),
		});

		expect(result.schemaCompliance).toEqual(
			expect.objectContaining({
				compliant: false,
				score: 0,
				violations: expect.arrayContaining([expect.stringContaining("no recognized observer XML")]),
			}),
		);
		expect(result.requiredRecall.score).toBe(0);
		expect(result.weightedQualityScore).toBe(0);
	});

	it("does not assign aggregate quality to an unreviewed batch", () => {
		const batch = getExtractionBenchmarkProfile("rich-batch-shape-v1")?.batches.find(
			(candidate) => candidate.batchId === 18502,
		);
		if (!batch) throw new Error("expected unreviewed benchmark batch 18502");
		const result = scoreExtractionBenchmarkOutput({
			parsed: parsed([]),
			diagnostics: CLEAN_DIAGNOSTICS,
			review: batch.review,
			estimatedCostUsd: 0.1,
		});

		expect(result.reviewStatus).toBe("unreviewed");
		expect(result.weightedQualityScore).toBeNull();
		expect(result.costAdjustedScore).toBeNull();
	});
});
