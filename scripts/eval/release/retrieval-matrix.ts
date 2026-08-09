import { dirname, resolve } from "node:path";
import { compareCodePoints, digest } from "./canonical.js";
import { parseProjectedCorpus } from "./corpus.js";
import type { HistoricalObserverSubject } from "./historical-observer.js";
import { exactKeys, jsonObject } from "./json-shape.js";
import type { ObserverCaseRunResult } from "./observer-runner.js";
import { projectObserverRunsForRetrieval, scoreRetrievalProbes } from "./retrieval-scoring.js";
import type {
	DetailedRetrievalMatrix,
	Digest,
	JsonValue,
	ProjectedCorpusV1,
	RetrievalCellMetric,
	RetrievalCellProvenance,
} from "./types.js";

export const RETRIEVAL_MATRIX_RELEASES = ["0.37.1", "0.38.0"] as const;

export interface ProjectedRetrievalProbe {
	probeId: string;
	query: string;
	expectedMode: "default" | "task" | "recall";
	relevantCaseIds: string[];
	expectedArtifact: "durable" | "session_summary";
	explicitRecap: boolean;
	topN: number;
}

export function adaptProjectedRetrievalProbes(input: unknown): ProjectedRetrievalProbe[] {
	const rows = parseProjectedCorpus(input).rows.filter((row) => row.row_type === "retrieval_probe");
	const probes = rows.map((row, index): ProjectedRetrievalProbe => {
		const path = `projected corpus retrieval row[${index}]`;
		const value = jsonObject(row.value, `${path}.value`);
		exactKeys(
			value,
			[
				"query",
				"expected_mode",
				"relevant_case_ids",
				"expected_artifact",
				"explicit_recap",
				"top_n",
			],
			`${path}.value`,
		);
		if (typeof value.query !== "string" || !value.query.trim())
			throw new TypeError(`${path}.query must be non-empty`);
		if (
			value.expected_mode !== "default" &&
			value.expected_mode !== "task" &&
			value.expected_mode !== "recall"
		)
			throw new TypeError(`${path}.expected_mode is invalid`);
		if (value.expected_artifact !== "durable" && value.expected_artifact !== "session_summary")
			throw new TypeError(`${path}.expected_artifact is invalid`);
		if (
			!Array.isArray(value.relevant_case_ids) ||
			value.relevant_case_ids.length === 0 ||
			value.relevant_case_ids.some((id) => typeof id !== "string" || !id)
		)
			throw new TypeError(`${path}.relevant_case_ids is invalid`);
		if (
			typeof value.explicit_recap !== "boolean" ||
			!Number.isSafeInteger(value.top_n) ||
			Number(value.top_n) < 1
		)
			throw new TypeError(`${path} flags are invalid`);
		return {
			probeId: row.case_id,
			query: value.query,
			expectedMode: value.expected_mode,
			relevantCaseIds: value.relevant_case_ids as string[],
			expectedArtifact: value.expected_artifact,
			explicitRecap: value.explicit_recap,
			topN: Number(value.top_n),
		};
	});
	if (probes.length === 0) throw new TypeError("projected retrieval corpus must contain probes");
	if (new Set(probes.map((probe) => probe.probeId)).size !== probes.length)
		throw new TypeError("projected retrieval probe IDs must be unique");
	return probes;
}

export function retrievalProbeSuiteDigest(probes: readonly ProjectedRetrievalProbe[]): Digest {
	return digest(
		probes.map((probe) => ({
			probe_id: probe.probeId,
			query: probe.query,
			expected_mode: probe.expectedMode,
			relevant_case_ids: [...probe.relevantCaseIds].toSorted(compareCodePoints),
			expected_artifact: probe.expectedArtifact,
			explicit_recap: probe.explicitRecap,
			top_n: probe.topN,
		})) as unknown as JsonValue,
	);
}

type RetrievalSubject = HistoricalObserverSubject & {
	runPack: NonNullable<HistoricalObserverSubject["runPack"]>;
	componentDigest: NonNullable<HistoricalObserverSubject["componentDigest"]>;
};

function subjectsForMatrix(subjects: HistoricalObserverSubject[]): RetrievalSubject[] {
	return RETRIEVAL_MATRIX_RELEASES.map((version) => {
		const subject = subjects.find(
			(entry) =>
				entry.sanitizedSubject.kind === "release" && entry.sanitizedSubject.version === version,
		);
		if (!subject) throw new TypeError(`retrieval matrix requires keyword pack subject ${version}`);
		const runPack = subject.runPack;
		const componentDigest = subject.componentDigest;
		if (!runPack || !componentDigest)
			throw new TypeError(`retrieval matrix requires keyword pack subject ${version}`);
		return { ...subject, runPack, componentDigest };
	});
}

function mean(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
}

export async function runRetrievalMatrix(input: {
	corpus: ProjectedCorpusV1;
	observerRuns: ObserverCaseRunResult[];
	subjects: HistoricalObserverSubject[];
	repetitions: number;
	sourceCorpusDigest: Digest;
	storeRoot: string;
	mkdir(path: string): Promise<void>;
}): Promise<{
	detailed: DetailedRetrievalMatrix;
	metrics: RetrievalCellMetric[];
	provenance: RetrievalCellProvenance[];
	probeSuiteDigest: Digest;
}> {
	const probes = adaptProjectedRetrievalProbes(input.corpus);
	const subjects = subjectsForMatrix(input.subjects);
	const cells: DetailedRetrievalMatrix["cells"] = [];
	for (const [observerIndex, observer] of subjects.entries())
		for (const [packIndex, pack] of subjects.entries())
			for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
				const storePath = resolve(
					input.storeRoot,
					`observer-${observerIndex + 1}-pack-${packIndex + 1}`,
					`repetition-${repetition}`,
					"store.sqlite",
				);
				await input.mkdir(dirname(storePath));
				const sourceRuns = input.observerRuns.filter(
					(run) =>
						run.subject.resolvedCommit === observer.resolvedCommit && run.repetition === repetition,
				);
				if (!sourceRuns.length)
					throw new TypeError("retrieval matrix is missing an observer repetition");
				const projected = projectObserverRunsForRetrieval(sourceRuns);
				const memories = projected.map(({ artifact: _artifact, ...memory }) => memory);
				const result = await pack.runPack({
					schema_version: 1,
					operation: "run_pack_traces",
					store_path: storePath,
					memories,
					probes: probes.map((probe) => ({
						probe_id: probe.probeId,
						query: probe.query,
						limit: Math.max(probe.topN, 10),
					})),
				});
				if (result.usage_row_count !== 0 || result.materialized_items.length !== memories.length)
					throw new TypeError("historical keyword lane was not read-only or complete");
				const cell = { observer: observer.sanitizedSubject, pack: pack.sanitizedSubject };
				const traces = probes.map((probe) => {
					const trace = result.traces.find((entry) => entry.probe_id === probe.probeId);
					if (!trace)
						throw new TypeError(`historical pack response omitted probe ${probe.probeId}`);
					return trace;
				});
				const cellMetrics = scoreRetrievalProbes({
					probes,
					traces,
					items: result.materialized_items.map((item) => ({
						id: item.id,
						memoryKey: item.memory_key,
						kind: item.kind,
						title: item.title,
						bodyText: item.body_text,
						metadata: item.metadata,
					})),
				}).map((metric) => ({ lane: "historical_keyword" as const, cell, ...metric }));
				const source = {
					lane: "historical_keyword" as const,
					cell,
					repetition,
					source_corpus_digest: input.sourceCorpusDigest,
					materialized_corpus_digest: digest(
						result.materialized_items
							.map(({ id: _id, ...item }) => item)
							.toSorted((a, b) =>
								compareCodePoints(a.memory_key, b.memory_key),
							) as unknown as JsonValue,
					),
					observer_subject_digest: await observer.componentDigest("observer"),
					retrieval_subject_digest: await pack.componentDigest("retrieval"),
				};
				cells.push({
					...source,
					store_path: storePath,
					metrics: cellMetrics,
					traces: result.traces as unknown as JsonValue[],
				});
			}
	const aggregated = subjects.flatMap((observer) =>
		subjects.flatMap((pack) => {
			const cell = { observer: observer.sanitizedSubject, pack: pack.sanitizedSubject };
			const matching = cells.filter((entry) => JSON.stringify(entry.cell) === JSON.stringify(cell));
			const ids = [
				...new Set(matching.flatMap((entry) => entry.metrics.map((metric) => metric.id))),
			];
			return ids.map((id): RetrievalCellMetric => {
				const values = matching.flatMap((entry) =>
					entry.metrics.filter((metric) => metric.id === id).map((metric) => metric.value),
				);
				return {
					lane: "historical_keyword",
					cell,
					id,
					value: mean(values),
					unit: id === "mean_relevant_rank" ? "rank" : "ratio",
				};
			});
		}),
	);
	return {
		detailed: { lane: "historical_keyword", status: "partial", cells },
		metrics: aggregated,
		provenance: cells.map(
			({ store_path: _path, metrics: _metrics, traces: _traces, ...value }) => value,
		),
		probeSuiteDigest: retrievalProbeSuiteDigest(probes),
	};
}
