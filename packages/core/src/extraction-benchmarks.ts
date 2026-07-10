export interface ExtractionBenchmarkBatch {
	batchId: number;
	sessionId: number;
	label: string;
	purpose: "shape_quality" | "replay_robustness";
	complexity: "simple" | "working" | "rich" | "robustness";
	scenarioId?: string;
	expectedTier?: "simple" | "rich";
	notes: string;
	/** Human-reviewed durable-fact labels; omitted profiles are treated as unreviewed. */
	review?: ExtractionBenchmarkReview;
}

export type ExtractionBenchmarkLabelDisposition = "required" | "optional" | "forbidden";

export interface ExtractionBenchmarkLabel {
	id: string;
	title: string;
	disposition: ExtractionBenchmarkLabelDisposition;
	keywordGroups: string[][];
	reviewerNotes: string;
}

export type ExtractionBenchmarkReview =
	| {
			status: "reviewed";
			reviewerNotes: string;
			labels: ExtractionBenchmarkLabel[];
	  }
	| {
			status: "unreviewed";
			reviewerNotes: string;
	  };

export interface ExtractionBenchmarkProfile {
	id: string;
	title: string;
	description: string;
	scenarioId: string;
	recommendedTruthModel: {
		provider: string;
		model: string;
		notes: string;
	};
	cheapCandidate: {
		provider: string;
		model: string;
		temperature: number;
		notes: string;
	};
	modelCandidates: ExtractionBenchmarkModelCandidate[];
	batches: ExtractionBenchmarkBatch[];
}

export interface ExtractionBenchmarkModelCandidate {
	provider: string;
	model: string;
	role: "simple_baseline" | "rich_baseline" | "quality_ceiling" | "cost_matched_challenger";
	reasoningEffort: "none";
	notes: string;
}

const UNREVIEWED_BATCH: ExtractionBenchmarkReview = {
	status: "unreviewed",
	reviewerNotes: "No durable-fact review has been recorded for this batch.",
};

const REVIEWED_BATCHES: Readonly<Record<number, ExtractionBenchmarkReview>> = {
	18503: {
		status: "reviewed",
		reviewerNotes:
			"Known review identified one durable TypeScript regression lesson and one routine Graphite workflow topic that must not become durable memory.",
		labels: [
			{
				id: "stable-session-reuse-regression",
				title: "TypeScript must preserve stable session reuse",
				disposition: "required",
				keywordGroups: [
					["typescript", "ts implementation", "ts rewrite"],
					["stable session", "stable-session"],
					["reuse", "reused", "reusing"],
					["regression", "failure mode", "bug"],
				],
				reviewerNotes:
					"Capture the reusable regression lesson: the TypeScript path must retain stable-session reuse rather than creating a fresh session for each event or flush.",
			},
			{
				id: "graphite-branch-hygiene",
				title: "Graphite branch hygiene is routine workflow",
				disposition: "forbidden",
				keywordGroups: [
					["graphite", "graphite stack"],
					["branch hygiene", "branch cleanup", "stack hygiene"],
				],
				reviewerNotes:
					"Branch cleanup and stack-management narration is routine workflow telemetry, not a durable project fact.",
			},
		],
	},
	18432: {
		status: "reviewed",
		reviewerNotes:
			"Known review identified the transparent repair implementation and a separate limitation of relinking as required durable lessons.",
		labels: [
			{
				id: "transparent-repair-implementation",
				title: "Repair behavior must remain transparent",
				disposition: "required",
				keywordGroups: [
					["repair", "repair pass", "repair call"],
					["transparent", "reported separately", "visible separately"],
					["initial output", "original output", "pre-repair output"],
				],
				reviewerNotes:
					"Capture the implementation contract that initial model output remains visible and repair is reported as a separate recovery step.",
			},
			{
				id: "relinking-does-not-fix-recap-dominance",
				title: "Relinking reduces unmapped burden but not recap dominance",
				disposition: "required",
				keywordGroups: [
					["relink", "relinking"],
					["unmapped burden", "unmapped sessions", "unmapped rows"],
					["recap dominance", "summary dominance", "recap-heavy retrieval"],
				],
				reviewerNotes:
					"Keep this distinct from transparent repair: relinking reduces the unmapped-session burden, but retrieval can still be dominated by recap/summary artifacts.",
			},
		],
	},
};

function benchmarkReview(batchId: number): ExtractionBenchmarkReview {
	return REVIEWED_BATCHES[batchId] ?? UNREVIEWED_BATCH;
}

const EXTRACTION_BENCHMARK_PROFILES: ExtractionBenchmarkProfile[] = [
	{
		id: "rich-batch-shape-v1",
		title: "Rich batch shape benchmark v1",
		description:
			"Benchmark set for comparing observer models on rich-batch extraction shape. Shape-quality batches are used for observation/summary output quality. Replay-robustness batches are tracked separately and should not be counted as shape failures when the observer returns no output.",
		scenarioId: "rich-batch-shape",
		recommendedTruthModel: {
			provider: "openai",
			model: "gpt-5.4",
			notes:
				"Current best-performing benchmark model across the rich-batch set; use as the acceptance baseline for cheaper candidates.",
		},
		cheapCandidate: {
			provider: "openai",
			model: "gpt-5.4-mini",
			temperature: 0.2,
			notes:
				"Current cheapest promising candidate. It can pass some hard batches at temperature 0.2, but remains less reliable than full gpt-5.4.",
		},
		modelCandidates: [
			{
				provider: "openai",
				model: "gpt-5.4-mini",
				role: "simple_baseline",
				reasoningEffort: "none",
				notes: "Retain as the frequent/simple-tier cost baseline.",
			},
			{
				provider: "openai",
				model: "gpt-5.4",
				role: "rich_baseline",
				reasoningEffort: "none",
				notes: "Current rich-tier production baseline and primary comparison for Terra.",
			},
			{
				provider: "openai",
				model: "gpt-5.5",
				role: "quality_ceiling",
				reasoningEffort: "none",
				notes: "Higher-cost reference for quality headroom, not the default candidate.",
			},
			{
				provider: "openai",
				model: "gpt-5.6-terra",
				role: "cost_matched_challenger",
				reasoningEffort: "none",
				notes: "Leading rich-tier challenger because it is price-matched with GPT-5.4.",
			},
		],
		batches: [
			{
				batchId: 18503,
				sessionId: 166405,
				label: "Track 3 / release / qd7h under-extraction batch",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				notes:
					"Flagship hard case: historically under-extracted batch with multiple meaningful subthreads.",
				review: benchmarkReview(18503),
			},
			{
				batchId: 18502,
				sessionId: 166405,
				label: "Same session prelude rich batch",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				notes:
					"Useful adjacent batch from the same long session; helps avoid overfitting to 18503 alone.",
				review: benchmarkReview(18502),
			},
			{
				batchId: 18506,
				sessionId: 166405,
				label: "Same session later rich batch",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				notes:
					"Later large batch from the same session; currently passes on stronger models and validates generalization within the stream.",
				review: benchmarkReview(18506),
			},
			{
				batchId: 18432,
				sessionId: 166392,
				label: "Large snapshot batch with mixed success",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				notes:
					"High-volume snapshot batch used to compare budget and model sensitivity outside the Track 3 stream.",
				review: benchmarkReview(18432),
			},
			{
				batchId: 18446,
				sessionId: 166392,
				label: "Hard failing snapshot batch",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				notes:
					"Useful stubborn case: some models return summary-only or nothing; stronger models plus repair can recover it.",
				review: benchmarkReview(18446),
			},
			{
				batchId: 18476,
				sessionId: 166405,
				label: "Replay no-output robustness case",
				purpose: "replay_robustness",
				complexity: "robustness",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				notes:
					"Stored extraction passes shape, but replay may return no raw output at all. Track separately as observer/replay robustness, not shape quality.",
				review: benchmarkReview(18476),
			},
		],
	},
	{
		id: "mixed-batch-routing-v1",
		title: "Mixed-complexity routing benchmark v1",
		description:
			"Benchmark set for validating whether replay-only tier routing stays cheap on simpler batches while still escalating richer batches to the stronger observer path.",
		scenarioId: "working-batch-shape",
		recommendedTruthModel: {
			provider: "openai",
			model: "gpt-5.4",
			notes:
				"Use the stronger model as the truth baseline when validating that richer batches genuinely benefit from escalation.",
		},
		cheapCandidate: {
			provider: "openai",
			model: "gpt-5.4-mini",
			temperature: 0.2,
			notes:
				"Cheaper path that should remain selected for simpler batches unless routing thresholds are too aggressive.",
		},
		modelCandidates: [
			{
				provider: "openai",
				model: "gpt-5.4-mini",
				role: "simple_baseline",
				reasoningEffort: "none",
				notes: "Simple-tier routing baseline.",
			},
			{
				provider: "openai",
				model: "gpt-5.4",
				role: "rich_baseline",
				reasoningEffort: "none",
				notes: "Rich-tier routing baseline.",
			},
		],
		batches: [
			{
				batchId: 18530,
				sessionId: 166430,
				label: "Tiny prompt-only batch",
				purpose: "shape_quality",
				complexity: "simple",
				scenarioId: "simple-batch-shape",
				expectedTier: "simple",
				notes: "Very small batch that should clearly remain on the cheap/simple tier.",
				review: benchmarkReview(18530),
			},
			{
				batchId: 18490,
				sessionId: 166412,
				label: "Compact low-tool batch",
				purpose: "shape_quality",
				complexity: "simple",
				scenarioId: "simple-batch-shape",
				expectedTier: "simple",
				notes: "Small batch with low tool count that should not trigger the rich tier.",
				review: benchmarkReview(18490),
			},
			{
				batchId: 18494,
				sessionId: 166413,
				label: "Compact short-session batch",
				purpose: "shape_quality",
				complexity: "simple",
				scenarioId: "simple-batch-shape",
				expectedTier: "simple",
				notes: "Short-session compact batch chosen for genuinely low-complexity characteristics.",
				review: benchmarkReview(18494),
			},
			{
				batchId: 18524,
				sessionId: 166429,
				label: "Moderate small-tool working batch",
				purpose: "shape_quality",
				complexity: "working",
				scenarioId: "working-batch-shape",
				expectedTier: "simple",
				notes: "Moderate batch that should remain cheap unless thresholds are too aggressive.",
				review: benchmarkReview(18524),
			},
			{
				batchId: 18525,
				sessionId: 166430,
				label: "Moderate prompt-heavy batch",
				purpose: "shape_quality",
				complexity: "working",
				scenarioId: "working-batch-shape",
				expectedTier: "simple",
				notes: "Moderate batch with some prompt/tool activity but still below rich-batch scale.",
				review: benchmarkReview(18525),
			},
			{
				batchId: 18460,
				sessionId: 166400,
				label: "Cross-session moderate batch",
				purpose: "shape_quality",
				complexity: "working",
				scenarioId: "working-batch-shape",
				expectedTier: "simple",
				notes:
					"Cross-session moderate batch to verify the simple tier remains viable outside the main stream.",
				review: benchmarkReview(18460),
			},
			{
				batchId: 18503,
				sessionId: 166405,
				label: "Track 3 / release / qd7h under-extraction batch",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				notes: "Flagship hard case that should still escalate to the rich tier.",
				review: benchmarkReview(18503),
			},
			{
				batchId: 18432,
				sessionId: 166392,
				label: "Large snapshot rich batch",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				notes: "High-volume snapshot batch that should continue escalating.",
				review: benchmarkReview(18432),
			},
			{
				batchId: 18476,
				sessionId: 166405,
				label: "Replay no-output robustness case",
				purpose: "replay_robustness",
				complexity: "robustness",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				notes:
					"Known no-output replay robustness case retained to make sure routing does not hide robustness failures.",
				review: benchmarkReview(18476),
			},
		],
	},
];

export function getExtractionBenchmarkProfile(id: string): ExtractionBenchmarkProfile | null {
	const normalized = id.trim().toLowerCase();
	const profile = EXTRACTION_BENCHMARK_PROFILES.find((candidate) => candidate.id === normalized);
	return profile ? cloneProfile(profile) : null;
}

export function listExtractionBenchmarkProfiles(): ExtractionBenchmarkProfile[] {
	return EXTRACTION_BENCHMARK_PROFILES.map(cloneProfile);
}

function cloneReview(review: ExtractionBenchmarkReview): ExtractionBenchmarkReview {
	if (review.status === "unreviewed") return { ...review };
	return {
		...review,
		labels: review.labels.map((label) => ({
			...label,
			keywordGroups: label.keywordGroups.map((group) => [...group]),
		})),
	};
}

function cloneProfile(profile: ExtractionBenchmarkProfile): ExtractionBenchmarkProfile {
	return {
		...profile,
		recommendedTruthModel: { ...profile.recommendedTruthModel },
		cheapCandidate: { ...profile.cheapCandidate },
		modelCandidates: profile.modelCandidates.map((candidate) => ({ ...candidate })),
		batches: profile.batches.map((batch) => ({
			...batch,
			...(batch.review ? { review: cloneReview(batch.review) } : {}),
		})),
	};
}
