import type { ObserverContext } from "../../../packages/core/src/ingest-types.js";

export const RELEASE_EVAL_MANIFEST_VERSION = 1 as const;
export const PROJECTED_CORPUS_VERSION = 1 as const;
export const COMPONENT_FILE_SET_VERSION = 1 as const;
export const DETAILED_REPORT_VERSION = 1 as const;
export const OBSERVER_SCOPE_SUMMARY_VERSION = 1 as const;
export const HISTORICAL_OBSERVER_PROTOCOL_VERSION = 1 as const;
export const HISTORICAL_PACK_PROTOCOL_VERSION = 1 as const;
export const HISTORICAL_INJECTION_PROTOCOL_VERSION = 1 as const;
export type ReleaseComponent = "observer" | "retrieval" | "injection";
export type RetrievalLane = "historical_keyword" | "candidate_semantic";

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

export interface HistoricalPackMemoryV1 {
	memory_key: string;
	session_key: string;
	kind: string;
	title: string;
	body_text: string;
	confidence: number;
	tags: string[];
	metadata: Record<string, JsonValue>;
}

export interface HistoricalPackRequestV1 {
	schema_version: 1;
	operation: "run_pack_traces";
	store_path: string;
	memories: HistoricalPackMemoryV1[];
	probes: Array<{ probe_id: string; query: string; limit: number }>;
}

export interface HistoricalPackTraceV1 {
	probe_id: string;
	mode: "default" | "task" | "recall";
	retrieval: {
		candidates: Array<{
			id: number;
			rank: number;
			artifact_class?: "session_summary" | "derived_fact" | "telemetry" | "unknown";
		}>;
	};
	assembly: { sections: { summary: number[]; timeline: number[]; observations: number[] } };
}

export interface HistoricalPackSuccessV1 {
	schema_version: 1;
	ok: true;
	result: {
		traces: HistoricalPackTraceV1[];
		materialized_items: Array<{
			id: number;
			memory_key: string;
			kind: string;
			title: string;
			body_text: string;
			metadata: Record<string, JsonValue>;
		}>;
		usage_row_count: number;
	};
}
export interface HistoricalPackFailureV1 {
	schema_version: 1;
	ok: false;
	error: {
		code: "invalid_request" | "unsupported_subject" | "subject_execution_failed";
		message: string;
	};
}
export type HistoricalPackResponseV1 = HistoricalPackSuccessV1 | HistoricalPackFailureV1;

export type InjectionPackOutcome = "success" | "empty" | "malformed" | "exit_error";
export interface HistoricalInjectionRequestV1 {
	schema_version: 1;
	operation: "run_plugin_injection";
	case: {
		first_prompt: string;
		latest_prompt: string;
		project_name: string;
		files_modified: string[];
		disabled: boolean;
		pack: { outcome: InjectionPackOutcome; pack_text: string; memory_ids: string[] };
	};
}
export interface HistoricalInjectionTraceV1 {
	hook: "experimental.chat.system.transform" | "experimental.chat.messages.transform";
	runner: { invoked: boolean; args: string[]; query: string | null; memory_ids: string[] };
	before: { system: string[]; messages: JsonValue[] };
	after: { system: string[]; messages: JsonValue[] };
	session_survived: boolean;
	process_id: number;
}
export interface HistoricalInjectionSuccessV1 {
	schema_version: 1;
	ok: true;
	result: HistoricalInjectionTraceV1;
}
export interface HistoricalInjectionFailureV1 {
	schema_version: 1;
	ok: false;
	error: {
		code: "invalid_request" | "unsupported_subject" | "subject_execution_failed";
		message: string;
	};
}
export type HistoricalInjectionResponseV1 =
	| HistoricalInjectionSuccessV1
	| HistoricalInjectionFailureV1;

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
		components: ReleaseComponent[];
	}>;
	repetitions: number;
}

export interface ProjectedCorpusV1 {
	schema_version: typeof PROJECTED_CORPUS_VERSION;
	rows: Array<{ case_id: string; ordinal: number; row_type: string; value: JsonValue }>;
}

export interface ComponentFileSetManifestV1 {
	schema_version: typeof COMPONENT_FILE_SET_VERSION;
	components: {
		evaluator: string[];
		retrieval?: string[];
		injection?: string[];
	};
}

export const RETRIEVAL_METRIC_IDS = [
	"relevant_placement_rate",
	"mean_relevant_rank",
	"durable_share",
	"summary_share",
	"telemetry_share",
	"routing_accuracy",
	"expected_artifact_top1_rate",
	"explicit_recap_preservation_rate",
] as const;
export type RetrievalMetricId = (typeof RETRIEVAL_METRIC_IDS)[number];
export type RetrievalMetricUnit = "ratio" | "rank";
export const INJECTION_METRIC_IDS = [
	"retrieval_success_rate",
	"exact_delivery_rate",
	"message_placement_rate",
	"deterministic_answer_use_rate",
	"session_survival_rate",
	"correct_no_delivery_rate",
] as const;
export type InjectionMetricId = (typeof INJECTION_METRIC_IDS)[number];

export interface RetrievalMatrixCellIdentifier {
	observer: SanitizedSubjectIdentifier;
	pack: SanitizedSubjectIdentifier;
}
export interface RetrievalCellMetric {
	lane: "historical_keyword";
	cell: RetrievalMatrixCellIdentifier;
	id: RetrievalMetricId;
	value: number;
	unit: RetrievalMetricUnit;
}
export interface RetrievalCellProvenance {
	lane: "historical_keyword";
	cell: RetrievalMatrixCellIdentifier;
	repetition: number;
	source_corpus_digest: Digest;
	materialized_corpus_digest: Digest;
	observer_subject_digest: Digest;
	retrieval_subject_digest: Digest;
}
export interface DetailedRetrievalMatrix {
	lane: "historical_keyword";
	status: "partial";
	cells: Array<
		RetrievalCellProvenance & {
			store_path: string;
			metrics: RetrievalCellMetric[];
			traces: JsonValue[];
		}
	>;
}
export interface InjectionSubjectMetric {
	subject: SanitizedSubjectIdentifier;
	id: InjectionMetricId;
	value: number;
	unit: "ratio";
}
export interface InjectionSubjectProvenance {
	subject: SanitizedSubjectIdentifier;
	resolved_commit: string;
	injection_subject_digest: Digest;
}
export interface DetailedInjectionSuite {
	status: "partial";
	runs: Array<{
		case_id: string;
		scenario_class: "locating" | "decision" | "outcome" | "troubleshooting" | "continuation";
		subject: SanitizedSubjectIdentifier;
		resolved_commit: string;
		repetition: number;
		trace: HistoricalInjectionTraceV1;
		scores: Record<InjectionMetricId, number | null>;
	}>;
}

export type CandidateSemanticRetrievalEvidence =
	| {
			status: "complete";
			lane: "candidate_semantic";
			candidate_commit: string;
			probe_suite_digest: Digest;
			source_corpus_digest: Digest;
			retrieval_subject_digest: Digest;
			readiness: {
				state: string;
				mode: string;
				embedding_model: string;
				active_memory_count: number;
				embeddable_memory_count: number;
				indexed_memory_count: number;
				pending_memory_count: number;
			};
			metrics: Array<{ id: RetrievalMetricId; value: number; unit: RetrievalMetricUnit }>;
	  }
	| { status: "not_applicable"; reason: "not_selected" };

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
	scope: "observer" | "release_layers";
	status: "partial";
	partial_reason: "observer_scope_only" | "thresholds_not_enforced";
	evaluated_at: string;
	provenance: {
		evaluator_commit: string;
		configuration_digest: Digest;
		corpus_digests: Partial<Record<CorpusTier, Digest>>;
		evaluator_component_digest: Digest;
		subject_commits: Array<{ subject: SanitizedSubjectIdentifier; resolved_commit: string }>;
	};
	completeness: { repetitions: number; cases_completed: number; cases_expected: number };
	metrics: {
		observer: SanitizedObserverMetric[];
		retrieval?: RetrievalCellMetric[];
		injection?: InjectionSubjectMetric[];
	};
	retrieval_cells?: RetrievalCellProvenance[];
	candidate_semantic_retrieval?: CandidateSemanticRetrievalEvidence;
	injection_subjects?: InjectionSubjectProvenance[];
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
	retrieval_matrix?: DetailedRetrievalMatrix;
	candidate_semantic_retrieval?: CandidateSemanticRetrievalEvidence;
	injection_suite?: DetailedInjectionSuite;
	local_artifacts: { manifest_path: string; corpus_paths: string[] };
}
