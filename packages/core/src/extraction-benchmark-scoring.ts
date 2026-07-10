import type {
	ExtractionBenchmarkLabel,
	ExtractionBenchmarkLabelDisposition,
	ExtractionBenchmarkReview,
} from "./extraction-benchmarks.js";
import type { ParsedObservation, ParsedOutput, ParsedSummary } from "./ingest-types.js";
import type { ObserverResponseStructuralDiagnostics } from "./ingest-xml-parser.js";

export interface ExtractionBenchmarkObservationText {
	index: number;
	kind: string;
	text: string;
}

export interface ExtractionBenchmarkLabelMatch {
	labelId: string;
	labelTitle: string;
	reviewerNotes: string;
	observations: ExtractionBenchmarkObservationText[];
}

export interface ExtractionBenchmarkRecallScore {
	score: number | null;
	matchedLabelIds: string[];
	missingLabelIds: string[];
	matches: ExtractionBenchmarkLabelMatch[];
}

export interface ExtractionBenchmarkForbiddenScore {
	avoidance: number | null;
	matchedLabelIds: string[];
	matches: ExtractionBenchmarkLabelMatch[];
}

export interface ExtractionBenchmarkSummaryBreadthScore {
	score: number | null;
	matchedLabelIds: string[];
	missingLabelIds: string[];
}

export interface ExtractionBenchmarkObservationSignals {
	observationCount: number;
	redundantPairs: Array<[number, number]>;
	redundantObservationIndexes: number[];
	redundancyAvoidance: number | null;
	multiLabelObservationIndexes: number[];
	segmentation: number | null;
}

export interface ExtractionBenchmarkSchemaScore {
	compliant: boolean;
	score: 0 | 1;
	violations: string[];
}

export interface ExtractionBenchmarkSummaryDispositionScore {
	expected: "required" | "optional" | "skip";
	actual: "summary" | "skip" | "invalid_skip" | "none";
	skipReason: string | null;
	score: 0 | 1;
}

export interface ExtractionBenchmarkScore {
	reviewStatus: ExtractionBenchmarkReview["status"];
	matchingPolicy: {
		mode: "all_keyword_groups_in_one_observation";
		notes: string;
	};
	summaryDisposition: ExtractionBenchmarkSummaryDispositionScore;
	requiredRecall: ExtractionBenchmarkRecallScore;
	optionalRecall: ExtractionBenchmarkRecallScore;
	forbidden: ExtractionBenchmarkForbiddenScore;
	worthinessPrecision: {
		score: number | null;
		flaggedObservationIndexes: number[];
		notes: string;
	};
	summaryBreadth: ExtractionBenchmarkSummaryBreadthScore;
	observationSignals: ExtractionBenchmarkObservationSignals;
	schemaCompliance: ExtractionBenchmarkSchemaScore;
	factualGrounding: {
		status: "requires_human_review";
		score: null;
		notes: string;
	};
	weightedQualityScore: number | null;
	weightedQualityCoverage: number | null;
	costAdjustedScore: number | null;
	costAdjustedScoreUnit: "quality_points_per_cent";
}

export interface ExtractionBenchmarkQualityDimensions {
	summaryDisposition: number | null;
	requiredRecall: number | null;
	optionalRecall: number | null;
	worthinessPrecision: number | null;
	summaryBreadth: number | null;
	redundancyAvoidance: number | null;
	segmentation: number | null;
	schemaCompliance: number | null;
	factualGrounding: number | null;
}

const QUALITY_WEIGHTS: Readonly<Record<keyof ExtractionBenchmarkQualityDimensions, number>> = {
	summaryDisposition: 0.1,
	requiredRecall: 0.45,
	optionalRecall: 0.05,
	worthinessPrecision: 0.15,
	summaryBreadth: 0.05,
	redundancyAvoidance: 0.1,
	segmentation: 0.1,
	schemaCompliance: 0.1,
	factualGrounding: 0,
};

const TOTAL_AUTOMATED_QUALITY_WEIGHT = Object.values(QUALITY_WEIGHTS).reduce(
	(sum, weight) => sum + weight,
	0,
);

const REDUNDANCY_THRESHOLD = 0.8;

function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function observationText(
	observation: ParsedObservation,
	index: number,
): ExtractionBenchmarkObservationText {
	return {
		index,
		kind: observation.kind,
		text: [observation.title, observation.subtitle, observation.narrative, ...observation.facts]
			.filter((value): value is string => Boolean(value?.trim()))
			.join("\n"),
	};
}

function summaryText(summary: ParsedSummary | null): string {
	if (!summary) return "";
	return normalizeText(
		[
			summary.request,
			summary.investigated,
			summary.learned,
			summary.completed,
			summary.nextSteps,
			summary.notes,
		].join("\n"),
	);
}

function matchesLabel(text: string, label: ExtractionBenchmarkLabel): boolean {
	const normalized = normalizeText(text);
	return label.keywordGroups.every((group) =>
		group.some((keyword) => normalized.includes(normalizeText(keyword))),
	);
}

function labelsFor(
	review: ExtractionBenchmarkReview,
	disposition: ExtractionBenchmarkLabelDisposition,
): ExtractionBenchmarkLabel[] {
	return review.status === "reviewed"
		? review.labels.filter((label) => label.disposition === disposition)
		: [];
}

function labelMatches(
	labels: ExtractionBenchmarkLabel[],
	observations: ExtractionBenchmarkObservationText[],
): ExtractionBenchmarkLabelMatch[] {
	return labels.flatMap((label) => {
		const matchedObservations = observations.filter((observation) =>
			matchesLabel(observation.text, label),
		);
		return matchedObservations.length === 0
			? []
			: [
					{
						labelId: label.id,
						labelTitle: label.title,
						reviewerNotes: label.reviewerNotes,
						observations: matchedObservations,
					},
				];
	});
}

function recallScore(
	review: ExtractionBenchmarkReview,
	labels: ExtractionBenchmarkLabel[],
	observations: ExtractionBenchmarkObservationText[],
): ExtractionBenchmarkRecallScore {
	const matches = labelMatches(labels, observations);
	const matchedLabelIds = matches.map((match) => match.labelId);
	return {
		score:
			review.status === "reviewed" && labels.length > 0 ? matches.length / labels.length : null,
		matchedLabelIds,
		missingLabelIds: labels
			.filter((label) => !matchedLabelIds.includes(label.id))
			.map((label) => label.id),
		matches,
	};
}

function jaccardSimilarity(left: string, right: string): number {
	const leftWords = new Set(normalizeText(left).split(" ").filter(Boolean));
	const rightWords = new Set(normalizeText(right).split(" ").filter(Boolean));
	const union = new Set([...leftWords, ...rightWords]);
	if (union.size === 0) return 1;
	const intersectionSize = [...leftWords].filter((word) => rightWords.has(word)).length;
	return intersectionSize / union.size;
}

function observationSignals(
	observations: ExtractionBenchmarkObservationText[],
	positiveLabels: ExtractionBenchmarkLabel[],
): ExtractionBenchmarkObservationSignals {
	const redundantPairs: Array<[number, number]> = [];
	for (let left = 0; left < observations.length; left += 1) {
		for (let right = left + 1; right < observations.length; right += 1) {
			const leftObservation = observations[left];
			const rightObservation = observations[right];
			if (
				leftObservation &&
				rightObservation &&
				jaccardSimilarity(leftObservation.text, rightObservation.text) >= REDUNDANCY_THRESHOLD
			) {
				redundantPairs.push([leftObservation.index, rightObservation.index]);
			}
		}
	}
	const totalPairs = (observations.length * (observations.length - 1)) / 2;
	const matchedObservationLabelCounts = observations.map((observation) => ({
		index: observation.index,
		count: positiveLabels.filter((label) => matchesLabel(observation.text, label)).length,
	}));
	const labelMatchedObservations = matchedObservationLabelCounts.filter(({ count }) => count > 0);
	const multiLabelObservationIndexes = labelMatchedObservations
		.filter(({ count }) => count > 1)
		.map(({ index }) => index);
	return {
		observationCount: observations.length,
		redundantPairs,
		redundantObservationIndexes: [...new Set(redundantPairs.flat())].sort((a, b) => a - b),
		redundancyAvoidance:
			observations.length === 0
				? null
				: totalPairs === 0
					? 1
					: 1 - redundantPairs.length / totalPairs,
		multiLabelObservationIndexes,
		segmentation:
			labelMatchedObservations.length === 0
				? null
				: 1 - multiLabelObservationIndexes.length / labelMatchedObservations.length,
	};
}

function schemaScore(
	diagnostics: ObserverResponseStructuralDiagnostics,
): ExtractionBenchmarkSchemaScore {
	const violations = [
		!diagnostics.recognizedOutput ? "response contained no recognized observer XML" : null,
		diagnostics.illegalObservationNestingInSummary > 0
			? `${diagnostics.illegalObservationNestingInSummary} observation block(s) nested inside summary`
			: null,
		diagnostics.unknownSummaryFields.length > 0
			? `unknown summary fields: ${diagnostics.unknownSummaryFields.join(", ")}`
			: null,
		diagnostics.unsupportedObservationKinds.length > 0
			? `unsupported observation kinds: ${diagnostics.unsupportedObservationKinds.join(", ")}`
			: null,
		diagnostics.missingObservationKinds > 0
			? `${diagnostics.missingObservationKinds} observation block(s) missing a kind`
			: null,
		diagnostics.discardedObservationBlocks > 0
			? `${diagnostics.discardedObservationBlocks} observation block(s) discarded`
			: null,
		diagnostics.discardedSummaryBlocks > 0
			? `${diagnostics.discardedSummaryBlocks} summary block(s) discarded`
			: null,
		diagnostics.dataLoss ? "parser diagnostics report data loss" : null,
	].filter((violation): violation is string => violation !== null);
	return { compliant: violations.length === 0, score: violations.length === 0 ? 1 : 0, violations };
}

function summaryDispositionScore(
	parsed: ParsedOutput,
	expected: ExtractionBenchmarkSummaryDispositionScore["expected"],
	recognizedOutput: boolean,
): ExtractionBenchmarkSummaryDispositionScore {
	if (!recognizedOutput) {
		return {
			expected,
			actual: "none",
			skipReason: parsed.skipSummaryReason,
			score: 0,
		};
	}
	const hasSummary = parsed.summary !== null && parsed.skipSummaryReason === null;
	const normalizedSkipReason = parsed.skipSummaryReason?.trim().toLowerCase() ?? null;
	const validSkip = parsed.summary === null && normalizedSkipReason === "low-signal";
	const actual: ExtractionBenchmarkSummaryDispositionScore["actual"] = hasSummary
		? "summary"
		: validSkip
			? "skip"
			: parsed.skipSummaryReason
				? "invalid_skip"
				: "none";
	const matches =
		expected === "required"
			? hasSummary
			: expected === "skip"
				? validSkip
				: hasSummary || validSkip;
	return {
		expected,
		actual,
		skipReason: parsed.skipSummaryReason,
		score: matches ? 1 : 0,
	};
}

export function calculateWeightedQualityCoverage(
	dimensions: ExtractionBenchmarkQualityDimensions,
): number {
	const scoredWeight = (Object.keys(QUALITY_WEIGHTS) as Array<keyof typeof QUALITY_WEIGHTS>)
		.filter((key) => dimensions[key] !== null && QUALITY_WEIGHTS[key] > 0)
		.reduce((sum, key) => sum + QUALITY_WEIGHTS[key], 0);
	return TOTAL_AUTOMATED_QUALITY_WEIGHT === 0 ? 0 : scoredWeight / TOTAL_AUTOMATED_QUALITY_WEIGHT;
}

export function calculateWeightedQualityScore(
	dimensions: ExtractionBenchmarkQualityDimensions,
): number {
	const scoredDimensions = (Object.keys(QUALITY_WEIGHTS) as Array<keyof typeof QUALITY_WEIGHTS>)
		.map((key) => ({ score: dimensions[key], weight: QUALITY_WEIGHTS[key] }))
		.filter(
			(dimension): dimension is { score: number; weight: number } =>
				dimension.score !== null && dimension.weight > 0,
		);
	const totalWeight = scoredDimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
	if (totalWeight === 0) return 0;
	return (
		scoredDimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0) /
		totalWeight
	);
}

export function calculateCostAdjustedScore(
	qualityScore: number | null,
	estimatedCostUsd: number | null,
): number | null {
	return qualityScore === null ||
		estimatedCostUsd === null ||
		!Number.isFinite(estimatedCostUsd) ||
		estimatedCostUsd <= 0
		? null
		: (qualityScore * 0.01) / estimatedCostUsd;
}

export function scoreExtractionBenchmarkOutput(input: {
	parsed: ParsedOutput;
	diagnostics: ObserverResponseStructuralDiagnostics;
	review: ExtractionBenchmarkReview;
	expectedSummaryDisposition?: "required" | "optional" | "skip";
	estimatedCostUsd?: number | null;
}): ExtractionBenchmarkScore {
	const observations = input.parsed.observations.map(observationText);
	const summaryDisposition = summaryDispositionScore(
		input.parsed,
		input.expectedSummaryDisposition ?? "required",
		input.diagnostics.recognizedOutput,
	);
	const requiredLabels = labelsFor(input.review, "required");
	const optionalLabels = labelsFor(input.review, "optional");
	const forbiddenLabels = labelsFor(input.review, "forbidden");
	const requiredRecall = recallScore(input.review, requiredLabels, observations);
	const optionalRecall = recallScore(input.review, optionalLabels, observations);
	const forbiddenMatches = labelMatches(forbiddenLabels, observations);
	const forbidden = {
		avoidance:
			input.review.status === "reviewed" && forbiddenLabels.length > 0
				? 1 - forbiddenMatches.length / forbiddenLabels.length
				: null,
		matchedLabelIds: forbiddenMatches.map((match) => match.labelId),
		matches: forbiddenMatches,
	};
	const flaggedObservationIndexes = [
		...new Set(
			forbiddenMatches.flatMap((match) =>
				match.observations.map((observation) => observation.index),
			),
		),
	].sort((left, right) => left - right);
	const worthinessPrecision = {
		score:
			input.review.status === "reviewed" && forbiddenLabels.length > 0
				? observations.length === 0
					? null
					: 1 - flaggedObservationIndexes.length / observations.length
				: null,
		flaggedObservationIndexes,
		notes:
			"Precision is the share of emitted observations not matched by a reviewed forbidden/noise label; unlabelled claims still require human review.",
	};
	const positiveLabels = [...requiredLabels, ...optionalLabels];
	const normalizedSummary = summaryText(input.parsed.summary);
	const summaryMatchedLabelIds = positiveLabels
		.filter((label) => matchesLabel(normalizedSummary, label))
		.map((label) => label.id);
	const summaryBreadth = {
		score:
			input.review.status === "reviewed" && positiveLabels.length > 0
				? summaryMatchedLabelIds.length / positiveLabels.length
				: null,
		matchedLabelIds: summaryMatchedLabelIds,
		missingLabelIds: positiveLabels
			.filter((label) => !summaryMatchedLabelIds.includes(label.id))
			.map((label) => label.id),
	};
	const signals = observationSignals(observations, positiveLabels);
	const schemaCompliance = schemaScore(input.diagnostics);
	const weightedQualityScore =
		input.review.status === "reviewed"
			? calculateWeightedQualityScore({
					summaryDisposition: summaryDisposition.score,
					requiredRecall: requiredRecall.score,
					optionalRecall: optionalRecall.score,
					worthinessPrecision: worthinessPrecision.score,
					summaryBreadth: summaryBreadth.score,
					redundancyAvoidance: signals.redundancyAvoidance,
					segmentation: signals.segmentation,
					schemaCompliance: schemaCompliance.score,
					factualGrounding: null,
				})
			: null;
	const weightedQualityCoverage =
		input.review.status === "reviewed"
			? calculateWeightedQualityCoverage({
					summaryDisposition: summaryDisposition.score,
					requiredRecall: requiredRecall.score,
					optionalRecall: optionalRecall.score,
					worthinessPrecision: worthinessPrecision.score,
					summaryBreadth: summaryBreadth.score,
					redundancyAvoidance: signals.redundancyAvoidance,
					segmentation: signals.segmentation,
					schemaCompliance: schemaCompliance.score,
					factualGrounding: null,
				})
			: null;
	return {
		reviewStatus: input.review.status,
		matchingPolicy: {
			mode: "all_keyword_groups_in_one_observation",
			notes:
				"Deterministic matching is intentionally recall-conservative; inspect matched and missing labels plus raw output before selecting a model.",
		},
		summaryDisposition,
		requiredRecall,
		optionalRecall,
		forbidden,
		worthinessPrecision,
		summaryBreadth,
		observationSignals: signals,
		schemaCompliance,
		factualGrounding: {
			status: "requires_human_review",
			score: null,
			notes:
				"Keyword matching measures repeatable label coverage, not whether claims are factually grounded in the source transcript.",
		},
		weightedQualityScore,
		weightedQualityCoverage,
		costAdjustedScore: calculateCostAdjustedScore(
			weightedQualityScore,
			input.estimatedCostUsd ?? null,
		),
		costAdjustedScoreUnit: "quality_points_per_cent",
	};
}
