import { commitId, finiteNumber, safeInteger, sha256Digest } from "./json-shape.js";
import { parseSanitizedSubjectIdentifier } from "./manifest.js";
import type {
	CandidateSemanticRetrievalEvidence,
	DetailedReleaseReportV1,
	InjectionSubjectProvenance,
	ObserverScopeReleaseSummaryV1,
	RetrievalCellProvenance,
	SanitizedObserverMetric,
} from "./types.js";
import { INJECTION_METRIC_IDS, OBSERVER_METRIC_IDS, RETRIEVAL_METRIC_IDS } from "./types.js";

export type DetailedReportInput = Omit<DetailedReleaseReportV1, "schema_version">;
export type ObserverSummaryInput = Omit<ObserverScopeReleaseSummaryV1, "schema_version">;

export function buildDetailedReport(input: DetailedReportInput): DetailedReleaseReportV1 {
	return { ...input, schema_version: 1 };
}

function timestamp(value: string): string {
	if (Number.isNaN(Date.parse(value)))
		throw new TypeError("observer summary.evaluated_at must be a canonical ISO timestamp");
	const parsed = new Date(value).toISOString();
	if (parsed !== value)
		throw new TypeError("observer summary.evaluated_at must be a canonical ISO timestamp");
	return parsed;
}

function metric(value: SanitizedObserverMetric, path: string): SanitizedObserverMetric {
	if (value.phase !== "initial" && value.phase !== "final")
		throw new TypeError(`${path}.phase is not supported`);
	if (!OBSERVER_METRIC_IDS.includes(value.id)) throw new TypeError(`${path}.id is not supported`);
	if (!["ratio", "count", "milliseconds", "tokens", "usd"].includes(value.unit))
		throw new TypeError(`${path}.unit is not supported`);
	return {
		subject: parseSanitizedSubjectIdentifier(value.subject, `${path}.subject`),
		phase: value.phase,
		id: value.id,
		value: finiteNumber(value.value, `${path}.value`),
		unit: value.unit,
	};
}

function retrievalProvenance(
	value: RetrievalCellProvenance,
	path: string,
): RetrievalCellProvenance {
	return {
		lane: "historical_keyword",
		cell: {
			observer: parseSanitizedSubjectIdentifier(value.cell.observer, `${path}.cell.observer`),
			pack: parseSanitizedSubjectIdentifier(value.cell.pack, `${path}.cell.pack`),
		},
		repetition: safeInteger(value.repetition, `${path}.repetition`, 1),
		source_corpus_digest: sha256Digest(value.source_corpus_digest, `${path}.source_corpus_digest`),
		materialized_corpus_digest: sha256Digest(
			value.materialized_corpus_digest,
			`${path}.materialized_corpus_digest`,
		),
		observer_subject_digest: sha256Digest(
			value.observer_subject_digest,
			`${path}.observer_subject_digest`,
		),
		retrieval_subject_digest: sha256Digest(
			value.retrieval_subject_digest,
			`${path}.retrieval_subject_digest`,
		),
	};
}

function injectionProvenance(
	value: InjectionSubjectProvenance,
	path: string,
): InjectionSubjectProvenance {
	return {
		subject: parseSanitizedSubjectIdentifier(value.subject, `${path}.subject`),
		resolved_commit: commitId(value.resolved_commit, `${path}.resolved_commit`),
		injection_subject_digest: sha256Digest(
			value.injection_subject_digest,
			`${path}.injection_subject_digest`,
		),
	};
}

function semanticEvidence(
	value: CandidateSemanticRetrievalEvidence,
	path: string,
): CandidateSemanticRetrievalEvidence {
	if (value.status === "not_applicable") {
		if (value.reason !== "not_selected") throw new TypeError(`${path}.reason is not supported`);
		return { status: "not_applicable", reason: "not_selected" };
	}
	if (value.lane !== "candidate_semantic") throw new TypeError(`${path}.lane is not supported`);
	const readiness = value.readiness;
	if (!readiness.state || !readiness.mode || !readiness.embedding_model)
		throw new TypeError(`${path}.readiness identity must be non-empty`);
	const metrics = value.metrics.map((entry, index) => {
		if (!RETRIEVAL_METRIC_IDS.includes(entry.id))
			throw new TypeError(`${path}.metrics[${index}].id is unsupported`);
		if (entry.unit !== "ratio" && entry.unit !== "rank")
			throw new TypeError(`${path}.metrics[${index}].unit is unsupported`);
		return {
			id: entry.id,
			value: finiteNumber(entry.value, `${path}.metrics[${index}].value`),
			unit: entry.unit,
		};
	});
	if (new Set(metrics.map((entry) => entry.id)).size !== metrics.length)
		throw new TypeError(`${path}.metrics contains duplicate IDs`);
	return {
		status: "complete",
		lane: "candidate_semantic",
		candidate_commit: commitId(value.candidate_commit, `${path}.candidate_commit`),
		probe_suite_digest: sha256Digest(value.probe_suite_digest, `${path}.probe_suite_digest`),
		source_corpus_digest: sha256Digest(value.source_corpus_digest, `${path}.source_corpus_digest`),
		retrieval_subject_digest: sha256Digest(
			value.retrieval_subject_digest,
			`${path}.retrieval_subject_digest`,
		),
		readiness: {
			state: readiness.state,
			mode: readiness.mode,
			embedding_model: readiness.embedding_model,
			active_memory_count: safeInteger(
				readiness.active_memory_count,
				`${path}.readiness.active_memory_count`,
			),
			embeddable_memory_count: safeInteger(
				readiness.embeddable_memory_count,
				`${path}.readiness.embeddable_memory_count`,
			),
			indexed_memory_count: safeInteger(
				readiness.indexed_memory_count,
				`${path}.readiness.indexed_memory_count`,
			),
			pending_memory_count: safeInteger(
				readiness.pending_memory_count,
				`${path}.readiness.pending_memory_count`,
			),
		},
		metrics,
	};
}

export function buildObserverScopeSummary(
	input: ObserverSummaryInput,
): ObserverScopeReleaseSummaryV1 {
	const observerOnly = input.scope === "observer" && input.partial_reason === "observer_scope_only";
	const releaseLayers =
		input.scope === "release_layers" && input.partial_reason === "thresholds_not_enforced";
	if (
		input.benchmark_profile !== "release-v1" ||
		input.status !== "partial" ||
		(!observerOnly && !releaseLayers)
	)
		throw new TypeError("release summary scope and partial reason are inconsistent");
	const metrics = input.metrics.observer.map((value, index) =>
		metric(value, `observer summary.metrics.observer[${index}]`),
	);
	const keys = metrics.map(
		(value) => `${JSON.stringify(value.subject)}:${value.phase}:${value.id}`,
	);
	if (new Set(keys).size !== keys.length)
		throw new TypeError("observer summary metrics contain duplicate subject/phase/metric entries");
	const execution = input.execution.map((entry, index) => ({
		subject: parseSanitizedSubjectIdentifier(
			entry.subject,
			`observer summary.execution[${index}].subject`,
		),
		completed: safeInteger(entry.completed, `observer summary.execution[${index}].completed`),
		unavailable: safeInteger(entry.unavailable, `observer summary.execution[${index}].unavailable`),
		partial: safeInteger(entry.partial, `observer summary.execution[${index}].partial`),
		failed: safeInteger(entry.failed, `observer summary.execution[${index}].failed`),
	}));
	const executionKeys = execution.map((entry) => JSON.stringify(entry.subject));
	if (new Set(executionKeys).size !== executionKeys.length)
		throw new TypeError("observer summary execution contains duplicate subjects");
	const casesCompleted = safeInteger(
		input.completeness.cases_completed,
		"observer summary.completeness.cases_completed",
	);
	const casesExpected = safeInteger(
		input.completeness.cases_expected,
		"observer summary.completeness.cases_expected",
	);
	const completedTotal = execution.reduce((total, entry) => total + entry.completed, 0);
	const bucketTotal = execution.reduce(
		(total, entry) => total + entry.completed + entry.unavailable + entry.partial + entry.failed,
		0,
	);
	if (completedTotal !== casesCompleted)
		throw new TypeError("observer summary completed count does not match execution buckets");
	if (bucketTotal !== casesExpected)
		throw new TypeError("observer summary expected count does not match execution buckets");
	return {
		schema_version: 1,
		benchmark_profile: "release-v1",
		scope: input.scope,
		status: "partial",
		partial_reason: input.partial_reason,
		evaluated_at: timestamp(input.evaluated_at),
		provenance: {
			evaluator_commit: commitId(
				input.provenance.evaluator_commit,
				"observer summary.provenance.evaluator_commit",
			),
			configuration_digest: sha256Digest(
				input.provenance.configuration_digest,
				"observer summary.provenance.configuration_digest",
			),
			corpus_digests: {
				...(input.provenance.corpus_digests.public
					? {
							public: sha256Digest(
								input.provenance.corpus_digests.public,
								"observer summary public corpus digest",
							),
						}
					: {}),
				...(input.provenance.corpus_digests.private
					? {
							private: sha256Digest(
								input.provenance.corpus_digests.private,
								"observer summary private corpus digest",
							),
						}
					: {}),
			},
			evaluator_component_digest: sha256Digest(
				input.provenance.evaluator_component_digest,
				"observer summary evaluator component digest",
			),
			subject_commits: input.provenance.subject_commits.map((entry, index) => ({
				subject: parseSanitizedSubjectIdentifier(
					entry.subject,
					`observer summary subject[${index}]`,
				),
				resolved_commit: commitId(
					entry.resolved_commit,
					`observer summary subject[${index}].resolved_commit`,
				),
			})),
		},
		completeness: {
			repetitions: safeInteger(
				input.completeness.repetitions,
				"observer summary.completeness.repetitions",
			),
			cases_completed: casesCompleted,
			cases_expected: casesExpected,
		},
		metrics: {
			observer: metrics,
			...(input.metrics.retrieval
				? {
						retrieval: input.metrics.retrieval.map((value, index) => {
							if (value.lane !== "historical_keyword")
								throw new TypeError(
									`observer summary.metrics.retrieval[${index}].lane is unsupported`,
								);
							if (!RETRIEVAL_METRIC_IDS.includes(value.id))
								throw new TypeError(
									`observer summary.metrics.retrieval[${index}].id is unsupported`,
								);
							if (value.unit !== "ratio" && value.unit !== "rank")
								throw new TypeError(
									`observer summary.metrics.retrieval[${index}].unit is unsupported`,
								);
							return {
								lane: "historical_keyword" as const,
								cell: {
									observer: parseSanitizedSubjectIdentifier(
										value.cell.observer,
										`retrieval metric ${index} observer`,
									),
									pack: parseSanitizedSubjectIdentifier(
										value.cell.pack,
										`retrieval metric ${index} pack`,
									),
								},
								id: value.id,
								value: finiteNumber(value.value, `retrieval metric ${index} value`),
								unit: value.unit,
							};
						}),
					}
				: {}),
			...(input.metrics.injection
				? {
						injection: input.metrics.injection.map((value, index) => {
							if (!INJECTION_METRIC_IDS.includes(value.id))
								throw new TypeError(
									`observer summary.metrics.injection[${index}].id is unsupported`,
								);
							if (value.unit !== "ratio")
								throw new TypeError(
									`observer summary.metrics.injection[${index}].unit is unsupported`,
								);
							return {
								subject: parseSanitizedSubjectIdentifier(
									value.subject,
									`injection metric ${index} subject`,
								),
								id: value.id,
								value: finiteNumber(value.value, `injection metric ${index} value`),
								unit: "ratio" as const,
							};
						}),
					}
				: {}),
		},
		...(input.retrieval_cells
			? {
					retrieval_cells: input.retrieval_cells.map((value, index) =>
						retrievalProvenance(value, `observer summary.retrieval_cells[${index}]`),
					),
				}
			: {}),
		...(input.candidate_semantic_retrieval
			? {
					candidate_semantic_retrieval: semanticEvidence(
						input.candidate_semantic_retrieval,
						"observer summary.candidate_semantic_retrieval",
					),
				}
			: {}),
		...(input.injection_subjects
			? {
					injection_subjects: input.injection_subjects.map((value, index) =>
						injectionProvenance(value, `observer summary.injection_subjects[${index}]`),
					),
				}
			: {}),
		execution,
	};
}
