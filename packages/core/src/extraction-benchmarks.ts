export interface ExtractionBenchmarkBatch {
	batchId: number;
	sessionId: number;
	label: string;
	purpose: "shape_quality" | "replay_robustness";
	notes: string;
}

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
	batches: ExtractionBenchmarkBatch[];
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
		batches: [
			{
				batchId: 18503,
				sessionId: 166405,
				label: "Track 3 / release / qd7h under-extraction batch",
				purpose: "shape_quality",
				notes:
					"Flagship hard case: historically under-extracted batch with multiple meaningful subthreads.",
			},
			{
				batchId: 18502,
				sessionId: 166405,
				label: "Same session prelude rich batch",
				purpose: "shape_quality",
				notes:
					"Useful adjacent batch from the same long session; helps avoid overfitting to 18503 alone.",
			},
			{
				batchId: 18506,
				sessionId: 166405,
				label: "Same session later rich batch",
				purpose: "shape_quality",
				notes:
					"Later large batch from the same session; currently passes on stronger models and validates generalization within the stream.",
			},
			{
				batchId: 18432,
				sessionId: 166392,
				label: "Large snapshot batch with mixed success",
				purpose: "shape_quality",
				notes:
					"High-volume snapshot batch used to compare budget and model sensitivity outside the Track 3 stream.",
			},
			{
				batchId: 18446,
				sessionId: 166392,
				label: "Hard failing snapshot batch",
				purpose: "shape_quality",
				notes:
					"Useful stubborn case: some models return summary-only or nothing; stronger models plus repair can recover it.",
			},
			{
				batchId: 18476,
				sessionId: 166405,
				label: "Replay no-output robustness case",
				purpose: "replay_robustness",
				notes:
					"Stored extraction passes shape, but replay may return no raw output at all. Track separately as observer/replay robustness, not shape quality.",
			},
		],
	},
];

export function getExtractionBenchmarkProfile(id: string): ExtractionBenchmarkProfile | null {
	const normalized = id.trim().toLowerCase();
	return EXTRACTION_BENCHMARK_PROFILES.find((profile) => profile.id === normalized) ?? null;
}

export function listExtractionBenchmarkProfiles(): ExtractionBenchmarkProfile[] {
	return EXTRACTION_BENCHMARK_PROFILES.map((profile) => ({
		...profile,
		batches: profile.batches.map((batch) => ({ ...batch })),
	}));
}
