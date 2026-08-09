import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { compareCodePoints, digest } from "./canonical.js";
import {
	commitId,
	exactKeys,
	finiteNumber,
	jsonObject,
	jsonValue,
	nonEmptyTrimmedString,
	parseJson,
	safeInteger,
	sha256Digest,
} from "./json-shape.js";
import { parseComponentFileSetManifest, parseSanitizedSubjectIdentifier } from "./manifest.js";
import { digestReleaseComponents } from "./provenance.js";
import {
	type CandidateSemanticRetrievalEvidence,
	type CandidateSemanticRetrievalRunEvidence,
	type ComponentDigests,
	type ComponentFileSetManifestV1,
	type Digest,
	INJECTION_METRIC_IDS,
	OBSERVER_METRIC_IDS,
	RETRIEVAL_METRIC_IDS,
	type SanitizedSubjectIdentifier,
} from "./types.js";

export const RELEASE_ATTESTATION_VERSION = 1 as const;
export const RELEASE_THRESHOLD_PROFILE_VERSION = 1 as const;
export const RELEASE_ATTESTATION_FILE = "release-attestation-v1.json";
export const RELEASE_PROFILE_ROOT = "scripts/eval/baselines/release-threshold-profiles";
export const RELEASE_ATTESTATION_ROOT = "scripts/eval/baselines/releases";
export const MAX_ATTESTATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ATTESTATION_FUTURE_SKEW_MS = 5 * 60 * 1000;
const COMPONENT_MANIFEST_PATH = "scripts/eval/release/component-files.json";
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*-v[1-9][0-9]*$/;
const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

type GateOperator = "gte" | "lte";
type MetricUnit = "ratio" | "rank" | "count" | "milliseconds" | "tokens" | "usd";

export type ReleaseMetricSelector =
	| {
			component: "observer";
			metric: (typeof OBSERVER_METRIC_IDS)[number];
			subject: SanitizedSubjectIdentifier;
			phase: "initial" | "final";
	  }
	| {
			component: "retrieval";
			lane: "historical_keyword";
			metric: (typeof RETRIEVAL_METRIC_IDS)[number];
			observer_subject: SanitizedSubjectIdentifier;
			pack_subject: SanitizedSubjectIdentifier;
	  }
	| {
			component: "retrieval";
			lane: "candidate_semantic";
			metric: (typeof RETRIEVAL_METRIC_IDS)[number];
			subject: SanitizedSubjectIdentifier;
	  }
	| {
			component: "injection";
			metric: (typeof INJECTION_METRIC_IDS)[number];
			subject: SanitizedSubjectIdentifier;
	  };

export interface ReleaseThresholdProfileV1 {
	schema_version: typeof RELEASE_THRESHOLD_PROFILE_VERSION;
	profile_id: string;
	benchmark_profile: "release-v1";
	status: "approved";
	candidate_commit_policy: "equal";
	minimum_repetitions: number;
	required_suites: Record<"observer" | "retrieval" | "injection", number>;
	expected_evidence: {
		evaluator_commit: string;
		configuration_digest: Digest;
		corpus_digests: {
			observer_private: Digest;
			retrieval_private: Digest;
			injection_public: Digest;
		};
		subject_commits: Array<{ subject: SanitizedSubjectIdentifier; resolved_commit: string }>;
	};
	thresholds: Array<{
		gate_id: string;
		selector: ReleaseMetricSelector;
		operator: GateOperator;
		threshold: number;
		unit: MetricUnit;
	}>;
}

export interface ReleaseAttestationV1 {
	schema_version: typeof RELEASE_ATTESTATION_VERSION;
	benchmark_profile: "release-v1";
	status: "pass";
	release_version: string;
	release_tag: string;
	evaluated_at: string;
	candidate_commit: string;
	profile: { id: string; digest: Digest };
	provenance: {
		evaluator_commit: string;
		configuration_digest: Digest;
		corpus_digests: {
			observer_private: Digest;
			retrieval_private: Digest;
			injection_public: Digest;
		};
		component_digests: ComponentDigests;
		subject_commits: Array<{ subject: SanitizedSubjectIdentifier; resolved_commit: string }>;
	};
	completeness: {
		repetitions: number;
		suites: Record<"observer" | "retrieval" | "injection", { completed: number; expected: number }>;
	};
	execution: { fallback: number; unavailable: number; partial: number; failed: number };
	candidate_semantic_retrieval: Extract<CandidateSemanticRetrievalEvidence, { status: "complete" }>;
	metrics: Array<{ selector: ReleaseMetricSelector; value: number; unit: MetricUnit }>;
	gates: Array<{
		gate_id: string;
		selector: ReleaseMetricSelector;
		operator: GateOperator;
		threshold: number;
		actual: number;
		unit: MetricUnit;
		passed: true;
	}>;
}

export interface VerifyReleaseAttestationDependencies {
	readText(path: string): Promise<string>;
	resolveTargetCommit(repositoryRoot: string): Promise<string>;
	digestComponents(
		repositoryRoot: string,
		manifest: ComponentFileSetManifestV1,
	): Promise<ComponentDigests>;
	now(): Date;
}

const DEFAULT_DEPENDENCIES: VerifyReleaseAttestationDependencies = {
	readText: async (path) => await readFile(path, "utf8"),
	resolveTargetCommit: async (repositoryRoot) => {
		const { executeCommand } = await import("./historical-observer.js");
		const result = await executeCommand("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
		if (result.exitCode !== 0)
			throw new TypeError("Could not resolve the checked-out release target");
		return commitId(result.stdout.trim(), "release target commit");
	},
	digestComponents: digestReleaseComponents,
	now: () => new Date(),
};

function member<Value extends string>(
	value: unknown,
	allowed: readonly Value[],
	path: string,
): Value {
	if (typeof value !== "string" || !allowed.includes(value as Value))
		throw new TypeError(`${path} is not supported`);
	return value as Value;
}

function stableVersion(value: unknown, path: string): string {
	if (typeof value !== "string" || !STABLE_VERSION_PATTERN.test(value))
		throw new TypeError(`${path} must be X.Y.Z`);
	return value;
}

function canonicalTimestamp(value: unknown, path: string): string {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
		throw new TypeError(`${path} must be a canonical ISO timestamp`);
	const canonical = new Date(value).toISOString();
	if (canonical !== value) throw new TypeError(`${path} must be a canonical ISO timestamp`);
	return canonical;
}

function profileId(value: unknown, path: string): string {
	const parsed = nonEmptyTrimmedString(value, path);
	if (!PROFILE_ID_PATTERN.test(parsed)) throw new TypeError(`${path} is not canonical`);
	return parsed;
}

function assertUnique(values: readonly string[], path: string): void {
	if (new Set(values).size !== values.length)
		throw new TypeError(`${path} must not contain duplicates`);
}

function selector(value: unknown, path: string): ReleaseMetricSelector {
	const input = jsonObject(value, path);
	if (input.component === "observer") {
		exactKeys(input, ["component", "metric", "subject", "phase"], path);
		return {
			component: "observer",
			metric: member(input.metric, OBSERVER_METRIC_IDS, `${path}.metric`),
			subject: parseSanitizedSubjectIdentifier(input.subject, `${path}.subject`),
			phase: member(input.phase, ["initial", "final"] as const, `${path}.phase`),
		};
	}
	if (input.component === "retrieval" && input.lane === "candidate_semantic") {
		exactKeys(input, ["component", "lane", "metric", "subject"], path);
		const subject = parseSanitizedSubjectIdentifier(input.subject, `${path}.subject`);
		if (subject.kind !== "candidate") throw new TypeError(`${path}.subject must be candidate`);
		return {
			component: "retrieval",
			lane: "candidate_semantic",
			metric: member(input.metric, RETRIEVAL_METRIC_IDS, `${path}.metric`),
			subject,
		};
	}
	if (input.component === "retrieval") {
		exactKeys(input, ["component", "lane", "metric", "observer_subject", "pack_subject"], path);
		return {
			component: "retrieval",
			lane: member(input.lane, ["historical_keyword"] as const, `${path}.lane`),
			metric: member(input.metric, RETRIEVAL_METRIC_IDS, `${path}.metric`),
			observer_subject: parseSanitizedSubjectIdentifier(
				input.observer_subject,
				`${path}.observer_subject`,
			),
			pack_subject: parseSanitizedSubjectIdentifier(input.pack_subject, `${path}.pack_subject`),
		};
	}
	if (input.component === "injection") {
		exactKeys(input, ["component", "metric", "subject"], path);
		return {
			component: "injection",
			metric: member(input.metric, INJECTION_METRIC_IDS, `${path}.metric`),
			subject: parseSanitizedSubjectIdentifier(input.subject, `${path}.subject`),
		};
	}
	throw new TypeError(`${path}.component is not supported`);
}

function expectedUnit(value: ReleaseMetricSelector): MetricUnit {
	if (value.component === "retrieval")
		return value.metric === "mean_relevant_rank" ? "rank" : "ratio";
	if (value.component === "injection") return "ratio";
	if (value.metric === "observation_count") return "count";
	if (value.metric === "latency") return "milliseconds";
	if (value.metric === "input_tokens" || value.metric === "output_tokens") return "tokens";
	if (value.metric === "cost") return "usd";
	return "ratio";
}

function metricUnit(
	value: unknown,
	parsedSelector: ReleaseMetricSelector,
	path: string,
): MetricUnit {
	const unit = member(
		value,
		["ratio", "rank", "count", "milliseconds", "tokens", "usd"] as const,
		path,
	);
	const expected = expectedUnit(parsedSelector);
	if (unit !== expected) throw new TypeError(`${path} must be ${expected} for this metric`);
	return unit;
}

function metricNumber(value: unknown, unit: MetricUnit, path: string): number {
	const parsed = finiteNumber(value, path);
	if (unit === "ratio" && (parsed < 0 || parsed > 1))
		throw new TypeError(`${path} must be in the range 0..1`);
	if (unit !== "ratio" && parsed < 0) throw new TypeError(`${path} must be nonnegative`);
	return parsed;
}

function componentDigests(value: unknown, path: string): ComponentDigests {
	const input = jsonObject(value, path);
	exactKeys(input, ["observer", "retrieval", "injection"], path);
	return {
		observer: sha256Digest(input.observer, `${path}.observer`),
		retrieval: sha256Digest(input.retrieval, `${path}.retrieval`),
		injection: sha256Digest(input.injection, `${path}.injection`),
	};
}

function parseReadiness(
	value: unknown,
	path: string,
): CandidateSemanticRetrievalRunEvidence["readiness"] {
	const input = jsonObject(value, path);
	exactKeys(
		input,
		[
			"state",
			"mode",
			"embedding_model",
			"semantic_search_model",
			"materialized_memory_count",
			"active_memory_count",
			"embeddable_memory_count",
			"indexed_memory_count",
			"pending_memory_count",
			"tagged_memory_count",
			"expected_file_ref_count",
			"file_ref_count",
			"expected_concept_ref_count",
			"concept_ref_count",
			"pending_ref_backfill",
			"blocking_maintenance_job_count",
		],
		path,
	);
	if (input.semantic_search_model !== null && typeof input.semantic_search_model !== "string")
		throw new TypeError(`${path}.semantic_search_model must be text or null`);
	if (typeof input.pending_ref_backfill !== "boolean")
		throw new TypeError(`${path}.pending_ref_backfill must be boolean`);
	return {
		state: nonEmptyTrimmedString(input.state, `${path}.state`),
		mode: nonEmptyTrimmedString(input.mode, `${path}.mode`),
		embedding_model: nonEmptyTrimmedString(input.embedding_model, `${path}.embedding_model`),
		semantic_search_model: input.semantic_search_model,
		materialized_memory_count: safeInteger(
			input.materialized_memory_count,
			`${path}.materialized_memory_count`,
		),
		active_memory_count: safeInteger(input.active_memory_count, `${path}.active_memory_count`),
		embeddable_memory_count: safeInteger(
			input.embeddable_memory_count,
			`${path}.embeddable_memory_count`,
		),
		indexed_memory_count: safeInteger(input.indexed_memory_count, `${path}.indexed_memory_count`),
		pending_memory_count: safeInteger(input.pending_memory_count, `${path}.pending_memory_count`),
		tagged_memory_count: safeInteger(input.tagged_memory_count, `${path}.tagged_memory_count`),
		expected_file_ref_count: safeInteger(
			input.expected_file_ref_count,
			`${path}.expected_file_ref_count`,
		),
		file_ref_count: safeInteger(input.file_ref_count, `${path}.file_ref_count`),
		expected_concept_ref_count: safeInteger(
			input.expected_concept_ref_count,
			`${path}.expected_concept_ref_count`,
		),
		concept_ref_count: safeInteger(input.concept_ref_count, `${path}.concept_ref_count`),
		pending_ref_backfill: input.pending_ref_backfill,
		blocking_maintenance_job_count: safeInteger(
			input.blocking_maintenance_job_count,
			`${path}.blocking_maintenance_job_count`,
		),
	};
}

function retrievalMetrics(value: unknown, path: string) {
	if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
	const metrics = value.map((entry, index) => {
		const metricPath = `${path}[${index}]`;
		const input = jsonObject(entry, metricPath);
		exactKeys(input, ["id", "value", "unit"], metricPath);
		const id = member(input.id, RETRIEVAL_METRIC_IDS, `${metricPath}.id`);
		const unit = member(input.unit, ["ratio", "rank"] as const, `${metricPath}.unit`);
		const expected = id === "mean_relevant_rank" ? "rank" : "ratio";
		if (unit !== expected) throw new TypeError(`${metricPath}.unit must be ${expected}`);
		return { id, value: metricNumber(input.value, unit, `${metricPath}.value`), unit };
	});
	assertUnique(
		metrics.map((entry) => entry.id),
		`${path} IDs`,
	);
	return metrics;
}

function semanticRun(value: unknown, path: string): CandidateSemanticRetrievalRunEvidence {
	const input = jsonObject(value, path);
	exactKeys(
		input,
		[
			"lane",
			"candidate_commit",
			"repetition",
			"probe_suite_digest",
			"source_corpus_digest",
			"retrieval_subject_digest",
			"probe_count",
			"readiness",
			"metrics",
		],
		path,
	);
	if (input.lane !== "candidate_semantic")
		throw new TypeError(`${path}.lane must be candidate_semantic`);
	return {
		lane: "candidate_semantic",
		candidate_commit: commitId(input.candidate_commit, `${path}.candidate_commit`),
		repetition: safeInteger(input.repetition, `${path}.repetition`, 1),
		probe_suite_digest: sha256Digest(input.probe_suite_digest, `${path}.probe_suite_digest`),
		source_corpus_digest: sha256Digest(input.source_corpus_digest, `${path}.source_corpus_digest`),
		retrieval_subject_digest: sha256Digest(
			input.retrieval_subject_digest,
			`${path}.retrieval_subject_digest`,
		),
		probe_count: safeInteger(input.probe_count, `${path}.probe_count`, 1),
		readiness: parseReadiness(input.readiness, `${path}.readiness`),
		metrics: retrievalMetrics(input.metrics, `${path}.metrics`),
	};
}

function semanticEvidence(
	value: unknown,
	path: string,
): Extract<CandidateSemanticRetrievalEvidence, { status: "complete" }> {
	const input = jsonObject(value, path);
	exactKeys(
		input,
		[
			"status",
			"lane",
			"candidate_commit",
			"probe_suite_digest",
			"source_corpus_digest",
			"retrieval_subject_digest",
			"embedding_model",
			"probe_count",
			"repetition_count",
			"aggregate_metrics",
			"runs",
		],
		path,
	);
	if (
		input.status !== "complete" ||
		input.lane !== "candidate_semantic" ||
		!Array.isArray(input.runs)
	)
		throw new TypeError(`${path} must be complete candidate_semantic evidence`);
	return {
		status: "complete",
		lane: "candidate_semantic",
		candidate_commit: commitId(input.candidate_commit, `${path}.candidate_commit`),
		probe_suite_digest: sha256Digest(input.probe_suite_digest, `${path}.probe_suite_digest`),
		source_corpus_digest: sha256Digest(input.source_corpus_digest, `${path}.source_corpus_digest`),
		retrieval_subject_digest: sha256Digest(
			input.retrieval_subject_digest,
			`${path}.retrieval_subject_digest`,
		),
		embedding_model: nonEmptyTrimmedString(input.embedding_model, `${path}.embedding_model`),
		probe_count: safeInteger(input.probe_count, `${path}.probe_count`, 1),
		repetition_count: safeInteger(input.repetition_count, `${path}.repetition_count`, 1),
		aggregate_metrics: retrievalMetrics(input.aggregate_metrics, `${path}.aggregate_metrics`),
		runs: input.runs.map((run, index) => semanticRun(run, `${path}.runs[${index}]`)),
	};
}

function parseSuites(value: unknown, path: string): ReleaseThresholdProfileV1["required_suites"] {
	const input = jsonObject(value, path);
	exactKeys(input, ["observer", "retrieval", "injection"], path);
	return {
		observer: safeInteger(input.observer, `${path}.observer`, 1),
		retrieval: safeInteger(input.retrieval, `${path}.retrieval`, 1),
		injection: safeInteger(input.injection, `${path}.injection`, 1),
	};
}

export function parseReleaseThresholdProfile(value: unknown): ReleaseThresholdProfileV1 {
	const root = jsonObject(value, "threshold profile");
	exactKeys(
		root,
		[
			"schema_version",
			"profile_id",
			"benchmark_profile",
			"status",
			"candidate_commit_policy",
			"minimum_repetitions",
			"required_suites",
			"expected_evidence",
			"thresholds",
		],
		"threshold profile",
	);
	if (root.schema_version !== 1) throw new TypeError("threshold profile.schema_version must be 1");
	if (root.benchmark_profile !== "release-v1")
		throw new TypeError("threshold profile benchmark_profile is not supported");
	if (root.status !== "approved") throw new TypeError("threshold profile must be approved");
	if (root.candidate_commit_policy !== "equal")
		throw new TypeError("threshold profile candidate_commit_policy must be equal");
	if (!Array.isArray(root.thresholds) || root.thresholds.length === 0)
		throw new TypeError("threshold profile.thresholds must be a non-empty array");
	const evidence = jsonObject(root.expected_evidence, "threshold profile.expected_evidence");
	exactKeys(
		evidence,
		["evaluator_commit", "configuration_digest", "corpus_digests", "subject_commits"],
		"threshold profile.expected_evidence",
	);
	const corpora = jsonObject(
		evidence.corpus_digests,
		"threshold profile.expected_evidence.corpus_digests",
	);
	exactKeys(
		corpora,
		["observer_private", "retrieval_private", "injection_public"],
		"threshold profile.expected_evidence.corpus_digests",
	);
	if (!Array.isArray(evidence.subject_commits) || evidence.subject_commits.length === 0)
		throw new TypeError("threshold profile.expected_evidence.subject_commits must be non-empty");
	const subjectCommits = evidence.subject_commits.map((entry, index) => {
		const path = `threshold profile.expected_evidence.subject_commits[${index}]`;
		const input = jsonObject(entry, path);
		exactKeys(input, ["subject", "resolved_commit"], path);
		return {
			subject: parseSanitizedSubjectIdentifier(input.subject, `${path}.subject`),
			resolved_commit: commitId(input.resolved_commit, `${path}.resolved_commit`),
		};
	});
	assertUnique(
		subjectCommits.map((entry) => JSON.stringify(entry.subject)),
		"threshold profile expected subjects",
	);
	const thresholds = root.thresholds.map((entry, index) => {
		const path = `threshold profile.thresholds[${index}]`;
		const input = jsonObject(entry, path);
		exactKeys(input, ["gate_id", "selector", "operator", "threshold", "unit"], path);
		const parsedSelector = selector(input.selector, `${path}.selector`);
		const unit = metricUnit(input.unit, parsedSelector, `${path}.unit`);
		return {
			gate_id: nonEmptyTrimmedString(input.gate_id, `${path}.gate_id`),
			selector: parsedSelector,
			operator: member(input.operator, ["gte", "lte"] as const, `${path}.operator`),
			threshold: metricNumber(input.threshold, unit, `${path}.threshold`),
			unit,
		};
	});
	assertUnique(
		thresholds.map((entry) => entry.gate_id),
		"threshold profile gate IDs",
	);
	assertUnique(
		thresholds.map((entry) => JSON.stringify(entry.selector)),
		"threshold profile metric selectors",
	);
	const requiredDataLoss = thresholds.some(
		(entry) =>
			entry.selector.component === "observer" &&
			entry.selector.subject.kind === "candidate" &&
			entry.selector.phase === "final" &&
			entry.selector.metric === "parser_data_loss_rate" &&
			entry.operator === "lte" &&
			entry.threshold === 0,
	);
	if (!requiredDataLoss)
		throw new TypeError(
			"Threshold profile must require candidate final parser_data_loss_rate <= 0",
		);
	const requiredSchema = thresholds.some(
		(entry) =>
			entry.selector.component === "observer" &&
			entry.selector.subject.kind === "candidate" &&
			entry.selector.phase === "final" &&
			entry.selector.metric === "schema_compliance_rate" &&
			entry.operator === "gte" &&
			entry.threshold > 0,
	);
	if (!requiredSchema)
		throw new TypeError(
			"Threshold profile must require candidate final schema_compliance_rate above zero",
		);
	if (
		!thresholds.some(
			(entry) =>
				entry.selector.component === "retrieval" && entry.selector.lane === "candidate_semantic",
		)
	)
		throw new TypeError("Threshold profile must require candidate semantic retrieval");
	return {
		schema_version: 1,
		profile_id: profileId(root.profile_id, "threshold profile.profile_id"),
		benchmark_profile: "release-v1",
		status: "approved",
		candidate_commit_policy: "equal",
		minimum_repetitions: safeInteger(
			root.minimum_repetitions,
			"threshold profile.minimum_repetitions",
			1,
		),
		required_suites: parseSuites(root.required_suites, "threshold profile.required_suites"),
		expected_evidence: {
			evaluator_commit: commitId(
				evidence.evaluator_commit,
				"threshold profile.expected_evidence.evaluator_commit",
			),
			configuration_digest: sha256Digest(
				evidence.configuration_digest,
				"threshold profile.expected_evidence.configuration_digest",
			),
			corpus_digests: {
				observer_private: sha256Digest(
					corpora.observer_private,
					"threshold profile.expected_evidence.corpus_digests.observer_private",
				),
				retrieval_private: sha256Digest(
					corpora.retrieval_private,
					"threshold profile.expected_evidence.corpus_digests.retrieval_private",
				),
				injection_public: sha256Digest(
					corpora.injection_public,
					"threshold profile.expected_evidence.corpus_digests.injection_public",
				),
			},
			subject_commits: subjectCommits,
		},
		thresholds,
	};
}

export function parseReleaseThresholdProfileDocument(value: unknown): {
	profile: ReleaseThresholdProfileV1;
	digest: Digest;
} {
	const document = jsonValue(value, "release threshold profile");
	const profile = parseReleaseThresholdProfile(document);
	return { profile, digest: digest(document) };
}

function parseCompleteness(value: unknown): ReleaseAttestationV1["completeness"] {
	const root = jsonObject(value, "release attestation.completeness");
	exactKeys(root, ["repetitions", "suites"], "release attestation.completeness");
	const suiteInput = jsonObject(root.suites, "release attestation.completeness.suites");
	exactKeys(
		suiteInput,
		["observer", "retrieval", "injection"],
		"release attestation.completeness.suites",
	);
	const suites = Object.fromEntries(
		(["observer", "retrieval", "injection"] as const).map((name) => {
			const path = `release attestation.completeness.suites.${name}`;
			const input = jsonObject(suiteInput[name], path);
			exactKeys(input, ["completed", "expected"], path);
			return [
				name,
				{
					completed: safeInteger(input.completed, `${path}.completed`),
					expected: safeInteger(input.expected, `${path}.expected`, 1),
				},
			];
		}),
	) as ReleaseAttestationV1["completeness"]["suites"];
	return {
		repetitions: safeInteger(root.repetitions, "release attestation.completeness.repetitions", 1),
		suites,
	};
}

export function parseReleaseAttestation(value: unknown): ReleaseAttestationV1 {
	const root = jsonObject(value, "release attestation");
	exactKeys(
		root,
		[
			"schema_version",
			"benchmark_profile",
			"status",
			"release_version",
			"release_tag",
			"evaluated_at",
			"candidate_commit",
			"profile",
			"provenance",
			"completeness",
			"execution",
			"candidate_semantic_retrieval",
			"metrics",
			"gates",
		],
		"release attestation",
	);
	if (root.schema_version !== 1)
		throw new TypeError("release attestation.schema_version must be 1");
	if (root.benchmark_profile !== "release-v1")
		throw new TypeError("release attestation benchmark_profile is not supported");
	if (root.status !== "pass") throw new TypeError("release attestation status must be pass");
	const releaseVersion = stableVersion(root.release_version, "release attestation.release_version");
	if (root.release_tag !== `v${releaseVersion}`)
		throw new TypeError("release attestation.release_tag must exactly match release_version");
	const profile = jsonObject(root.profile, "release attestation.profile");
	exactKeys(profile, ["id", "digest"], "release attestation.profile");
	const provenance = jsonObject(root.provenance, "release attestation.provenance");
	exactKeys(
		provenance,
		[
			"evaluator_commit",
			"configuration_digest",
			"corpus_digests",
			"component_digests",
			"subject_commits",
		],
		"release attestation.provenance",
	);
	const corpora = jsonObject(
		provenance.corpus_digests,
		"release attestation.provenance.corpus_digests",
	);
	exactKeys(
		corpora,
		["observer_private", "retrieval_private", "injection_public"],
		"release attestation.provenance.corpus_digests",
	);
	if (!Array.isArray(provenance.subject_commits) || provenance.subject_commits.length === 0)
		throw new TypeError("release attestation.provenance.subject_commits must be non-empty");
	const subjectCommits = provenance.subject_commits.map((entry, index) => {
		const path = `release attestation.provenance.subject_commits[${index}]`;
		const input = jsonObject(entry, path);
		exactKeys(input, ["subject", "resolved_commit"], path);
		return {
			subject: parseSanitizedSubjectIdentifier(input.subject, `${path}.subject`),
			resolved_commit: commitId(input.resolved_commit, `${path}.resolved_commit`),
		};
	});
	assertUnique(
		subjectCommits.map((entry) => JSON.stringify(entry.subject)),
		"release attestation subjects",
	);
	const execution = jsonObject(root.execution, "release attestation.execution");
	exactKeys(
		execution,
		["fallback", "unavailable", "partial", "failed"],
		"release attestation.execution",
	);
	if (!Array.isArray(root.metrics) || !Array.isArray(root.gates))
		throw new TypeError("release attestation metrics and gates must be arrays");
	const metrics = root.metrics.map((entry, index) => {
		const path = `release attestation.metrics[${index}]`;
		const input = jsonObject(entry, path);
		exactKeys(input, ["selector", "value", "unit"], path);
		const parsedSelector = selector(input.selector, `${path}.selector`);
		const unit = metricUnit(input.unit, parsedSelector, `${path}.unit`);
		return {
			selector: parsedSelector,
			value: metricNumber(input.value, unit, `${path}.value`),
			unit,
		};
	});
	assertUnique(
		metrics.map((entry) => JSON.stringify(entry.selector)),
		"release attestation metric selectors",
	);
	const gates = root.gates.map((entry, index) => {
		const path = `release attestation.gates[${index}]`;
		const input = jsonObject(entry, path);
		exactKeys(
			input,
			["gate_id", "selector", "operator", "threshold", "actual", "unit", "passed"],
			path,
		);
		if (input.passed !== true) throw new TypeError(`${path}.passed must be true`);
		const parsedSelector = selector(input.selector, `${path}.selector`);
		const unit = metricUnit(input.unit, parsedSelector, `${path}.unit`);
		return {
			gate_id: nonEmptyTrimmedString(input.gate_id, `${path}.gate_id`),
			selector: parsedSelector,
			operator: member(input.operator, ["gte", "lte"] as const, `${path}.operator`),
			threshold: metricNumber(input.threshold, unit, `${path}.threshold`),
			actual: metricNumber(input.actual, unit, `${path}.actual`),
			unit,
			passed: true as const,
		};
	});
	assertUnique(
		gates.map((entry) => entry.gate_id),
		"release attestation gate IDs",
	);
	return {
		schema_version: 1,
		benchmark_profile: "release-v1",
		status: "pass",
		release_version: releaseVersion,
		release_tag: `v${releaseVersion}`,
		evaluated_at: canonicalTimestamp(root.evaluated_at, "release attestation.evaluated_at"),
		candidate_commit: commitId(root.candidate_commit, "release attestation.candidate_commit"),
		profile: {
			id: profileId(profile.id, "release attestation.profile.id"),
			digest: sha256Digest(profile.digest, "release attestation.profile.digest"),
		},
		provenance: {
			evaluator_commit: commitId(
				provenance.evaluator_commit,
				"release attestation.provenance.evaluator_commit",
			),
			configuration_digest: sha256Digest(
				provenance.configuration_digest,
				"release attestation.provenance.configuration_digest",
			),
			corpus_digests: {
				observer_private: sha256Digest(
					corpora.observer_private,
					"release attestation.provenance.corpus_digests.observer_private",
				),
				retrieval_private: sha256Digest(
					corpora.retrieval_private,
					"release attestation.provenance.corpus_digests.retrieval_private",
				),
				injection_public: sha256Digest(
					corpora.injection_public,
					"release attestation.provenance.corpus_digests.injection_public",
				),
			},
			component_digests: componentDigests(
				provenance.component_digests,
				"release attestation.provenance.component_digests",
			),
			subject_commits: subjectCommits,
		},
		completeness: parseCompleteness(root.completeness),
		execution: {
			fallback: safeInteger(execution.fallback, "release attestation.execution.fallback"),
			unavailable: safeInteger(execution.unavailable, "release attestation.execution.unavailable"),
			partial: safeInteger(execution.partial, "release attestation.execution.partial"),
			failed: safeInteger(execution.failed, "release attestation.execution.failed"),
		},
		candidate_semantic_retrieval: semanticEvidence(
			root.candidate_semantic_retrieval,
			"release attestation.candidate_semantic_retrieval",
		),
		metrics,
		gates,
	};
}

export function releaseAttestationPath(version: string): string {
	return `${RELEASE_ATTESTATION_ROOT}/v${stableVersion(version, "release version")}/${RELEASE_ATTESTATION_FILE}`;
}

export function releaseThresholdProfilePath(id: string): string {
	return `${RELEASE_PROFILE_ROOT}/${profileId(id, "threshold profile ID")}.json`;
}

function equal(actual: unknown, expected: unknown, message: string): void {
	if (actual !== expected)
		throw new TypeError(`${message}: expected=${String(expected)} actual=${String(actual)}`);
}

function passes(operator: GateOperator, actual: number, threshold: number): boolean {
	return operator === "gte" ? actual >= threshold : actual <= threshold;
}

function assertEqualCandidatePolicy(value: string): void {
	if (value !== "equal")
		throw new TypeError("Release verification requires candidate_commit_policy equal");
}

function sortedSubjectCommits(
	values: readonly { subject: SanitizedSubjectIdentifier; resolved_commit: string }[],
): Array<{ subject: SanitizedSubjectIdentifier; resolved_commit: string }> {
	return values.toSorted((left, right) =>
		compareCodePoints(JSON.stringify(left), JSON.stringify(right)),
	);
}

function selectorSubjects(value: ReleaseMetricSelector): SanitizedSubjectIdentifier[] {
	if (value.component === "retrieval" && value.lane === "historical_keyword")
		return [value.observer_subject, value.pack_subject];
	return [value.subject];
}

function assertSemanticReady(run: CandidateSemanticRetrievalRunEvidence): void {
	const readiness = run.readiness;
	if (
		readiness.state !== "healthy" ||
		readiness.mode !== "semantic" ||
		readiness.semantic_search_model !== readiness.embedding_model
	)
		throw new TypeError(
			`Candidate semantic repetition ${run.repetition} is not healthy current-model evidence`,
		);
	if (
		readiness.pending_memory_count !== 0 ||
		readiness.pending_ref_backfill ||
		readiness.blocking_maintenance_job_count !== 0
	)
		throw new TypeError(`Candidate semantic repetition ${run.repetition} has pending maintenance`);
	if (
		readiness.active_memory_count !== readiness.materialized_memory_count ||
		readiness.embeddable_memory_count !== readiness.active_memory_count ||
		readiness.indexed_memory_count !== readiness.embeddable_memory_count
	)
		throw new TypeError(
			`Candidate semantic repetition ${run.repetition} has incomplete vector coverage`,
		);
	if (readiness.tagged_memory_count !== readiness.active_memory_count)
		throw new TypeError(
			`Candidate semantic repetition ${run.repetition} has incomplete tag coverage`,
		);
	if (
		readiness.file_ref_count !== readiness.expected_file_ref_count ||
		readiness.concept_ref_count !== readiness.expected_concept_ref_count
	)
		throw new TypeError(
			`Candidate semantic repetition ${run.repetition} has incomplete ref coverage`,
		);
}

export async function verifyReleaseAttestation(input: {
	repositoryRoot: string;
	reportPath: string;
	dependencies?: Partial<VerifyReleaseAttestationDependencies>;
}): Promise<{
	status: "pass";
	release_version: string;
	profile_id: string;
	candidate_commit: string;
}> {
	const deps = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
	const root = resolve(input.repositoryRoot);
	const reportPath = resolve(root, input.reportPath);
	const reportSource = await deps.readText(reportPath).catch(() => {
		throw new TypeError(`Release attestation is missing: ${input.reportPath}`);
	});
	const attestation = parseReleaseAttestation(parseJson(reportSource, "release attestation"));
	const expectedReportPath = releaseAttestationPath(attestation.release_version);
	if (relative(root, reportPath).replaceAll("\\", "/") !== expectedReportPath)
		throw new TypeError(`Release attestation path must be ${expectedReportPath}`);
	const profilePath = releaseThresholdProfilePath(attestation.profile.id);
	const profileSource = await deps.readText(resolve(root, profilePath)).catch(() => {
		throw new TypeError(`Release threshold profile is missing: ${profilePath}`);
	});
	const parsedProfile = parseReleaseThresholdProfileDocument(
		parseJson(profileSource, "release threshold profile"),
	);
	const profile = parsedProfile.profile;
	assertEqualCandidatePolicy(profile.candidate_commit_policy);
	for (const threshold of profile.thresholds) {
		for (const subject of selectorSubjects(threshold.selector)) {
			if (subject.kind === "candidate" && subject.version !== attestation.release_version)
				throw new TypeError(
					`Gate ${threshold.gate_id} candidate version does not match the release`,
				);
		}
	}
	equal(profile.profile_id, attestation.profile.id, "Threshold profile ID mismatch");
	equal(parsedProfile.digest, attestation.profile.digest, "Threshold profile digest mismatch");
	const evaluatedAt = Date.parse(attestation.evaluated_at);
	const now = deps.now().getTime();
	if (evaluatedAt - now > MAX_ATTESTATION_FUTURE_SKEW_MS)
		throw new TypeError("Release attestation evaluation timestamp is in the future");
	if (now - evaluatedAt > MAX_ATTESTATION_AGE_MS)
		throw new TypeError("Release attestation evaluation evidence is stale");
	equal(
		attestation.provenance.evaluator_commit,
		attestation.candidate_commit,
		"Evaluator/candidate commit mismatch",
	);
	equal(
		attestation.provenance.evaluator_commit,
		profile.expected_evidence.evaluator_commit,
		"Evaluator commit mismatch",
	);
	equal(
		attestation.provenance.configuration_digest,
		profile.expected_evidence.configuration_digest,
		"Configuration digest mismatch",
	);
	equal(
		attestation.provenance.corpus_digests.observer_private,
		profile.expected_evidence.corpus_digests.observer_private,
		"Observer private corpus digest mismatch",
	);
	equal(
		attestation.provenance.corpus_digests.retrieval_private,
		profile.expected_evidence.corpus_digests.retrieval_private,
		"Retrieval private corpus digest mismatch",
	);
	equal(
		attestation.provenance.corpus_digests.injection_public,
		profile.expected_evidence.corpus_digests.injection_public,
		"Injection public corpus digest mismatch",
	);
	equal(
		JSON.stringify(sortedSubjectCommits(attestation.provenance.subject_commits)),
		JSON.stringify(sortedSubjectCommits(profile.expected_evidence.subject_commits)),
		"Subject commit set mismatch",
	);
	const candidateSubjects = attestation.provenance.subject_commits.filter(
		(entry) => entry.subject.kind === "candidate",
	);
	if (candidateSubjects.length !== 1)
		throw new TypeError("Release attestation must contain exactly one candidate subject");
	const candidateSubject = candidateSubjects[0];
	if (!candidateSubject)
		throw new TypeError("Release attestation candidate subject invariant failed");
	if (candidateSubject.subject.version !== attestation.release_version)
		throw new TypeError("Candidate subject version does not match the release");
	equal(
		candidateSubject.resolved_commit,
		attestation.candidate_commit,
		"Candidate subject commit mismatch",
	);
	if (attestation.completeness.repetitions < profile.minimum_repetitions)
		throw new TypeError("Release attestation has insufficient repetitions");
	for (const component of ["observer", "retrieval", "injection"] as const) {
		const suite = attestation.completeness.suites[component];
		equal(
			suite.expected,
			profile.required_suites[component],
			`${component} suite expectation mismatch`,
		);
		equal(suite.completed, suite.expected, `${component} suite is incomplete`);
	}
	for (const [name, count] of Object.entries(attestation.execution))
		if (count !== 0) throw new TypeError(`Release attestation has unresolved ${name} executions`);
	const targetCommit = await deps.resolveTargetCommit(root);
	equal(attestation.candidate_commit, targetCommit, "Evaluated candidate commit mismatch");
	const componentManifestSource = await deps
		.readText(resolve(root, COMPONENT_MANIFEST_PATH))
		.catch(() => {
			throw new TypeError(`Component file-set manifest is missing: ${COMPONENT_MANIFEST_PATH}`);
		});
	const componentManifest = parseComponentFileSetManifest(
		parseJson(componentManifestSource, "component file-set manifest"),
	);
	const actualComponents = await deps.digestComponents(root, componentManifest);
	for (const component of ["observer", "retrieval", "injection"] as const)
		equal(
			attestation.provenance.component_digests[component],
			actualComponents[component],
			`${component} component digest mismatch`,
		);
	const semantic = attestation.candidate_semantic_retrieval;
	equal(
		semantic.candidate_commit,
		attestation.candidate_commit,
		"Candidate semantic commit mismatch",
	);
	equal(
		semantic.source_corpus_digest,
		attestation.provenance.corpus_digests.retrieval_private,
		"Candidate semantic source corpus digest mismatch",
	);
	equal(
		semantic.retrieval_subject_digest,
		attestation.provenance.component_digests.retrieval,
		"Candidate semantic retrieval component digest mismatch",
	);
	equal(
		semantic.repetition_count,
		attestation.completeness.repetitions,
		"Candidate semantic repetition count mismatch",
	);
	const semanticRuns = semantic.runs.toSorted((left, right) => left.repetition - right.repetition);
	equal(semanticRuns.length, semantic.repetition_count, "Candidate semantic run count mismatch");
	const repetitions = semanticRuns
		.map((run) => run.repetition)
		.toSorted((left, right) => left - right);
	assertUnique(repetitions.map(String), "candidate semantic repetitions");
	equal(
		JSON.stringify(repetitions),
		JSON.stringify(Array.from({ length: semantic.repetition_count }, (_value, index) => index + 1)),
		"Candidate semantic repetitions are incomplete",
	);
	for (const run of semanticRuns) {
		equal(
			run.candidate_commit,
			attestation.candidate_commit,
			`Candidate semantic repetition ${run.repetition} commit mismatch`,
		);
		equal(
			run.probe_suite_digest,
			semantic.probe_suite_digest,
			`Candidate semantic repetition ${run.repetition} probe identity mismatch`,
		);
		equal(
			run.source_corpus_digest,
			semantic.source_corpus_digest,
			`Candidate semantic repetition ${run.repetition} corpus mismatch`,
		);
		equal(
			run.retrieval_subject_digest,
			semantic.retrieval_subject_digest,
			`Candidate semantic repetition ${run.repetition} component mismatch`,
		);
		equal(
			run.probe_count,
			semantic.probe_count,
			`Candidate semantic repetition ${run.repetition} probe count mismatch`,
		);
		equal(
			run.readiness.embedding_model,
			semantic.embedding_model,
			`Candidate semantic repetition ${run.repetition} model mismatch`,
		);
		assertSemanticReady(run);
	}
	const metrics = new Map(
		attestation.metrics.map((entry) => [JSON.stringify(entry.selector), entry]),
	);
	const gates = new Map(attestation.gates.map((entry) => [entry.gate_id, entry]));
	equal(metrics.size, profile.thresholds.length, "Metric selector count mismatch");
	equal(gates.size, profile.thresholds.length, "Gate count mismatch");
	for (const threshold of profile.thresholds) {
		const metric = metrics.get(JSON.stringify(threshold.selector));
		if (!metric) throw new TypeError(`Missing metric for gate ${threshold.gate_id}`);
		const gate = gates.get(threshold.gate_id);
		if (!gate) throw new TypeError(`Missing gate ${threshold.gate_id}`);
		equal(
			JSON.stringify(gate.selector),
			JSON.stringify(threshold.selector),
			`Gate selector mismatch for ${threshold.gate_id}`,
		);
		equal(metric.unit, threshold.unit, `Metric unit mismatch for ${threshold.gate_id}`);
		equal(gate.unit, threshold.unit, `Gate unit mismatch for ${threshold.gate_id}`);
		equal(gate.operator, threshold.operator, `Gate operator mismatch for ${threshold.gate_id}`);
		equal(gate.threshold, threshold.threshold, `Gate threshold mismatch for ${threshold.gate_id}`);
		equal(gate.actual, metric.value, `Gate actual mismatch for ${threshold.gate_id}`);
		if (!passes(threshold.operator, metric.value, threshold.threshold))
			throw new TypeError(`Gate ${threshold.gate_id} failed when recomputed`);
		if (
			threshold.selector.component === "retrieval" &&
			threshold.selector.lane === "candidate_semantic"
		) {
			const aggregateMetric = semantic.aggregate_metrics.find(
				(entry) => entry.id === threshold.selector.metric,
			);
			if (!aggregateMetric)
				throw new TypeError(`Candidate semantic aggregate is missing ${threshold.selector.metric}`);
			const values = semanticRuns.map((run) => {
				const runMetric = run.metrics.find((entry) => entry.id === threshold.selector.metric);
				if (!runMetric)
					throw new TypeError(
						`Candidate semantic repetition ${run.repetition} is missing ${threshold.selector.metric}`,
					);
				equal(
					runMetric.unit,
					threshold.unit,
					`Candidate semantic repetition ${run.repetition} unit mismatch`,
				);
				return runMetric.value;
			});
			const aggregate = values.reduce((sum, value) => sum + value, 0) / values.length;
			equal(
				aggregateMetric.value,
				aggregate,
				`Candidate semantic aggregate mismatch for ${threshold.gate_id}`,
			);
			equal(
				metric.value,
				aggregate,
				`Candidate semantic attestation metric mismatch for ${threshold.gate_id}`,
			);
		}
	}
	const packageManifest = jsonObject(
		parseJson(
			await deps.readText(resolve(root, "packages/core/package.json")),
			"core package manifest",
		),
		"core package manifest",
	);
	equal(
		attestation.release_version,
		stableVersion(packageManifest.version, "core package version"),
		"Release attestation version mismatch",
	);
	return {
		status: "pass",
		release_version: attestation.release_version,
		profile_id: profile.profile_id,
		candidate_commit: attestation.candidate_commit,
	};
}
