import type { ObserverContext } from "../../../packages/core/src/ingest-types.js";

export const RELEASE_EVAL_MANIFEST_VERSION = 1 as const;
export const PROJECTED_CORPUS_VERSION = 1 as const;
export const COMPONENT_FILE_SET_VERSION = 1 as const;
export const DETAILED_REPORT_VERSION = 1 as const;
export const OBSERVER_SCOPE_SUMMARY_VERSION = 1 as const;
export const HISTORICAL_OBSERVER_PROTOCOL_VERSION = 1 as const;

export type Digest = `sha256:${string}`;
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type CorpusTier = "public" | "private";

export interface HistoricalObserverRequestV1 {
	schema_version: typeof HISTORICAL_OBSERVER_PROTOCOL_VERSION;
	operation: "build_observer_prompt";
	observer_context_schema_version: 1;
	context: ObserverContext;
}

export type HistoricalObserverResponseV1 =
	| { schema_version: 1; ok: true; result: { system: string; user: string } }
	| {
			schema_version: 1;
			ok: false;
			error: {
				code: "invalid_request" | "unsupported_subject" | "subject_execution_failed";
				message: string;
			};
	  };

export type HistoricalObserverFailureV1 = Extract<HistoricalObserverResponseV1, { ok: false }>;

export type SanitizedSubjectIdentifier =
	| { kind: "candidate"; version: string }
	| { kind: "approved_stable"; version: string }
	| { kind: "release"; version: string };

export interface ReleaseEvalManifestV1 {
	schema_version: typeof RELEASE_EVAL_MANIFEST_VERSION;
	benchmark_profile: "release-v1";
	corpora: Array<{
		tier: CorpusTier;
		schema_version: typeof PROJECTED_CORPUS_VERSION;
		source_path: string;
		expected_digest: Digest;
	}>;
	evaluator: {
		commit: string;
		configuration: {
			provider: string;
			transport: string;
			endpoint_mode: "provider_default";
			model: string;
			temperature: number;
			openai_responses: boolean;
			reasoning_effort: string | null;
			reasoning_summary: string | null;
			max_output_tokens: number;
			tier_routing_enabled: false;
		};
	};
	subjects: Array<{
		label: string;
		requested_ref: string;
		observer_context_schema_version: 1;
		subject: SanitizedSubjectIdentifier;
		components: ["observer"];
	}>;
	repetitions: number;
}

export interface ProjectedCorpusV1 {
	schema_version: typeof PROJECTED_CORPUS_VERSION;
	rows: Array<{ case_id: string; ordinal: number; row_type: string; value: JsonValue }>;
}

export interface ComponentFileSetManifestV1 {
	schema_version: typeof COMPONENT_FILE_SET_VERSION;
	components: { evaluator: string[] };
}

export const OBSERVER_METRIC_IDS = [
	"required_fact_recall",
	"forbidden_noise_avoidance",
	"correct_silence_rate",
	"summary_disposition_accuracy",
	"schema_compliance_rate",
	"parser_data_loss_rate",
	"fallback_rate",
	"observation_count",
	"latency",
	"input_tokens",
	"output_tokens",
	"cost",
] as const;

export interface ObserverMetric {
	id: (typeof OBSERVER_METRIC_IDS)[number];
	value: number;
	unit: "ratio" | "count" | "milliseconds" | "tokens" | "usd";
}

export interface SanitizedObserverMetric extends ObserverMetric {
	subject: SanitizedSubjectIdentifier;
	phase: "initial" | "final";
}

export interface ObserverScopeReleaseSummaryV1 {
	schema_version: typeof OBSERVER_SCOPE_SUMMARY_VERSION;
	benchmark_profile: "release-v1";
	scope: "observer";
	status: "partial";
	partial_reason: "observer_scope_only";
	evaluated_at: string;
	provenance: {
		evaluator_commit: string;
		configuration_digest: Digest;
		corpus_digests: Partial<Record<CorpusTier, Digest>>;
		evaluator_component_digest: Digest;
		subject_commits: Array<{ subject: SanitizedSubjectIdentifier; resolved_commit: string }>;
	};
	completeness: { repetitions: number; cases_completed: number; cases_expected: number };
	metrics: { observer: SanitizedObserverMetric[] };
	execution: Array<{
		subject: SanitizedSubjectIdentifier;
		completed: number;
		unavailable: number;
		partial: number;
		failed: number;
	}>;
}

export interface DetailedReleaseReportV1 {
	schema_version: typeof DETAILED_REPORT_VERSION;
	benchmark_profile: "release-v1";
	run_id: string;
	created_at: string;
	status: "partial";
	provenance: {
		evaluator_commit: string;
		configuration_digest: Digest;
		corpus_digests: Partial<Record<CorpusTier, Digest>>;
		evaluator_component_digest: Digest;
		subject_commits: Array<{
			label: string;
			requested_ref: string;
			resolved_commit: string;
		}>;
	};
	metrics: SanitizedObserverMetric[];
	case_results: JsonValue[];
	local_artifacts: { manifest_path: string; corpus_paths: string[] };
}
