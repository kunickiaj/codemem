import { commitId, finiteNumber, safeInteger, sha256Digest } from "./json-shape.js";
import { parseSanitizedSubjectIdentifier } from "./manifest.js";
import type {
	DetailedReleaseReportV1,
	ObserverScopeReleaseSummaryV1,
	SanitizedObserverMetric,
} from "./types.js";
import { OBSERVER_METRIC_IDS } from "./types.js";

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

export function buildObserverScopeSummary(
	input: ObserverSummaryInput,
): ObserverScopeReleaseSummaryV1 {
	if (
		input.benchmark_profile !== "release-v1" ||
		input.scope !== "observer" ||
		input.status !== "partial" ||
		input.partial_reason !== "observer_scope_only"
	) {
		throw new TypeError("observer summary must remain explicitly observer-only and partial");
	}
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
		scope: "observer",
		status: "partial",
		partial_reason: "observer_scope_only",
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
		metrics: { observer: metrics },
		execution,
	};
}
