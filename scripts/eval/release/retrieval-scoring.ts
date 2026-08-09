import { type ArtifactBucket, bucketItem, finalPackOrder } from "../lib.js";
import type { ObserverCaseRunResult } from "./observer-runner.js";
import type { ProjectedRetrievalProbe } from "./retrieval-matrix.js";
import type { HistoricalPackMemoryV1, RetrievalMetricId, RetrievalMetricUnit } from "./types.js";

const ALLOWED_OBSERVATION_KINDS = new Set([
	"discovery",
	"change",
	"feature",
	"bugfix",
	"refactor",
	"decision",
	"exploration",
]);

export interface RetrievalMaterializedMemory extends HistoricalPackMemoryV1 {
	artifact: "durable" | "session_summary";
}

export interface RetrievalScoringItem {
	id: number;
	memoryKey: string;
	kind: string;
	title: string;
	bodyText: string;
	metadata: Record<string, unknown>;
}

export interface RetrievalScoringTrace {
	mode: "default" | "task" | "recall";
	assembly: { sections: { summary: number[]; timeline: number[]; observations: number[] } };
}

export interface RetrievalAggregateMetric {
	id: RetrievalMetricId;
	value: number;
	unit: RetrievalMetricUnit;
}

function summaryBody(
	summary: NonNullable<ObserverCaseRunResult["final"]["parsed"]["summary"]>,
): string {
	return [
		["Request", summary.request],
		["Completed", summary.completed],
		["Learned", summary.learned],
		["Investigated", summary.investigated],
		["Next steps", summary.nextSteps],
		["Notes", summary.notes],
	]
		.filter((entry) => entry[1])
		.map(([heading, value]) => `## ${heading}\n${value}`)
		.join("\n\n");
}

export function projectObserverRunsForRetrieval(
	runs: readonly ObserverCaseRunResult[],
): RetrievalMaterializedMemory[] {
	return runs.flatMap((run) => {
		if (run.status === "unavailable" || run.status === "partial") return [];
		const observations = run.final.parsed.observations.flatMap(
			(observation, index): RetrievalMaterializedMemory[] => {
				const kind = observation.kind.trim().toLowerCase();
				if (
					!ALLOWED_OBSERVATION_KINDS.has(kind) ||
					(!observation.title && !observation.narrative)
				) {
					return [];
				}
				return [
					{
						memory_key: `${run.caseId}:observation:${index}`,
						session_key: run.caseId,
						kind,
						title: observation.title || observation.narrative,
						body_text: [
							observation.narrative,
							observation.facts.map((fact) => `- ${fact}`).join("\n"),
						]
							.filter(Boolean)
							.join("\n\n"),
						confidence: 0.8,
						tags: observation.concepts,
						metadata: {
							source_case_id: run.caseId,
							files_read: observation.filesRead,
							files_modified: observation.filesModified,
							concepts: observation.concepts,
							facts: observation.facts,
						},
						artifact: "durable",
					},
				];
			},
		);
		const summary = run.final.parsed.summary;
		if (!summary) return observations;
		return [
			...observations,
			{
				memory_key: `${run.caseId}:summary`,
				session_key: run.caseId,
				kind: "session_summary",
				title: summary.request || "Session summary",
				body_text: summaryBody(summary),
				confidence: 0.8,
				tags: [],
				metadata: {
					source_case_id: run.caseId,
					is_summary: true,
					source: "observer_summary",
					derivation: { artifact_class: "session_summary" },
					files_read: summary.filesRead,
					files_modified: summary.filesModified,
				},
				artifact: "session_summary",
			},
		];
	});
}

function mean(values: readonly number[], metric: string): number {
	if (values.length === 0) throw new TypeError(`${metric} has no applicable probes`);
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function scoreRetrievalProbes(input: {
	probes: readonly ProjectedRetrievalProbe[];
	traces: readonly RetrievalScoringTrace[];
	items: readonly RetrievalScoringItem[];
}): RetrievalAggregateMetric[] {
	const byId = new Map(input.items.map((item) => [item.id, item]));
	const scored = input.probes.map((probe, index) => {
		const trace = input.traces[index];
		if (!trace) throw new TypeError(`retrieval result omitted probe ${probe.probeId}`);
		const top = finalPackOrder(trace)
			.slice(0, probe.topN)
			.flatMap((id) => {
				const item = byId.get(id);
				return item
					? [
							{
								...item,
								bucket: bucketItem({
									kind: item.kind,
									title: item.title,
									body_text: item.bodyText,
									metadata: item.metadata,
								}),
							},
						]
					: [];
			});
		const relevantIndex = top.findIndex((item) =>
			probe.relevantCaseIds.some((caseId) => item.memoryKey.startsWith(`${caseId}:`)),
		);
		const count = (buckets: readonly ArtifactBucket[]) =>
			top.filter((item) => buckets.includes(item.bucket)).length / (top.length || 1);
		const topBucket = top[0]?.bucket;
		return {
			relevantPlacement: Number(relevantIndex >= 0),
			relevantRank: relevantIndex >= 0 ? relevantIndex + 1 : probe.topN + 1,
			durableShare: count(["derived_fact", "durable_other"]),
			summaryShare: count(["session_summary"]),
			telemetryShare: count(["telemetry"]),
			routing: Number(trace.mode === probe.expectedMode),
			expectedArtifactTop1:
				probe.expectedArtifact === "durable"
					? Number(topBucket === "derived_fact" || topBucket === "durable_other")
					: Number(topBucket === "session_summary"),
			explicitRecapPreserved: probe.explicitRecap ? Number(topBucket === "session_summary") : null,
		};
	});
	const recap = scored.flatMap((value) =>
		value.explicitRecapPreserved == null ? [] : [value.explicitRecapPreserved],
	);
	const metrics: RetrievalAggregateMetric[] = [
		{
			id: "relevant_placement_rate",
			value: mean(
				scored.map((value) => value.relevantPlacement),
				"relevant_placement_rate",
			),
			unit: "ratio",
		},
		{
			id: "mean_relevant_rank",
			value: mean(
				scored.map((value) => value.relevantRank),
				"mean_relevant_rank",
			),
			unit: "rank",
		},
		{
			id: "durable_share",
			value: mean(
				scored.map((value) => value.durableShare),
				"durable_share",
			),
			unit: "ratio",
		},
		{
			id: "summary_share",
			value: mean(
				scored.map((value) => value.summaryShare),
				"summary_share",
			),
			unit: "ratio",
		},
		{
			id: "telemetry_share",
			value: mean(
				scored.map((value) => value.telemetryShare),
				"telemetry_share",
			),
			unit: "ratio",
		},
		{
			id: "routing_accuracy",
			value: mean(
				scored.map((value) => value.routing),
				"routing_accuracy",
			),
			unit: "ratio",
		},
		{
			id: "expected_artifact_top1_rate",
			value: mean(
				scored.map((value) => value.expectedArtifactTop1),
				"expected_artifact_top1_rate",
			),
			unit: "ratio",
		},
	];
	if (recap.length > 0) {
		metrics.push({
			id: "explicit_recap_preservation_rate",
			value: mean(recap, "explicit_recap_preservation_rate"),
			unit: "ratio",
		});
	}
	return metrics;
}
