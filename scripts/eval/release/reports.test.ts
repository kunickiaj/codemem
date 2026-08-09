import { describe, expect, it } from "vitest";
import type { ObserverSummaryInput } from "./reports.js";
import { buildObserverScopeSummary } from "./reports.js";
import type { CandidateSemanticRetrievalEvidence } from "./types.js";

const SHA = `sha256:${"a".repeat(64)}` as const;
const COMMIT = "b".repeat(40);

function input(): ObserverSummaryInput {
	return {
		benchmark_profile: "release-v1",
		scope: "observer",
		status: "partial",
		partial_reason: "observer_scope_only",
		evaluated_at: "2026-08-08T00:00:00.000Z",
		provenance: {
			evaluator_commit: COMMIT,
			configuration_digest: SHA,
			corpus_digests: { private: SHA },
			evaluator_component_digest: SHA,
			subject_commits: [
				{ subject: { kind: "candidate", version: "0.40.0" }, resolved_commit: COMMIT },
			],
		},
		completeness: { repetitions: 3, cases_completed: 3, cases_expected: 3 },
		metrics: {
			observer: [
				{
					subject: { kind: "candidate", version: "0.40.0" },
					phase: "final",
					id: "required_fact_recall",
					value: 1,
					unit: "ratio",
				},
			],
		},
		execution: [
			{
				subject: { kind: "candidate", version: "0.40.0" },
				completed: 3,
				unavailable: 0,
				partial: 0,
				failed: 0,
			},
		],
	};
}

describe("sanitized observer summary", () => {
	it("allowlists aggregates without private diagnostics", () => {
		const value = input() as ObserverSummaryInput & Record<string, unknown>;
		value.raw_output = "private output";
		value.local_path = "/private/path";
		const json = JSON.stringify(buildObserverScopeSummary(value));
		expect(json).not.toContain("private output");
		expect(json).not.toContain("/private/path");
		expect(json).toContain('"version":"0.40.0"');
	});

	it("rejects duplicate aggregate identities", () => {
		const value = input();
		const metric = value.metrics.observer[0];
		if (!metric) throw new Error("fixture metric missing");
		value.metrics.observer.push({ ...metric });
		expect(() => buildObserverScopeSummary(value)).toThrow("duplicate subject/phase/metric");
	});

	it("rejects overlapping or incomplete execution buckets", () => {
		const completedMismatch = input();
		const execution = completedMismatch.execution[0];
		if (!execution) throw new Error("fixture execution missing");
		completedMismatch.execution[0] = { ...execution, completed: 2 };
		expect(() => buildObserverScopeSummary(completedMismatch)).toThrow(
			"completed count does not match",
		);

		const expectedMismatch = input();
		expectedMismatch.completeness.cases_expected = 4;
		expect(() => buildObserverScopeSummary(expectedMismatch)).toThrow(
			"expected count does not match",
		);
	});

	it("reconstructs PR3 provenance and strips unknown detailed fields", () => {
		const value = input();
		value.scope = "release_layers";
		value.partial_reason = "thresholds_not_enforced";
		value.metrics.retrieval = [
			{
				lane: "historical_keyword",
				cell: {
					observer: { kind: "release", version: "0.37.1" },
					pack: { kind: "release", version: "0.38.0" },
				},
				id: "relevant_placement_rate",
				value: 1,
				unit: "ratio",
			},
		];
		value.metrics.injection = [
			{
				subject: { kind: "release", version: "0.38.0" },
				id: "session_survival_rate",
				value: 1,
				unit: "ratio",
				raw_trace: "private injection trace",
			} as NonNullable<typeof value.metrics.injection>[number],
		];
		value.retrieval_cells = [
			{
				lane: "historical_keyword",
				cell: {
					observer: { kind: "release", version: "0.37.1" },
					pack: { kind: "release", version: "0.38.0" },
				},
				repetition: 1,
				source_corpus_digest: SHA,
				materialized_corpus_digest: SHA,
				observer_subject_digest: SHA,
				retrieval_subject_digest: SHA,
				store_path: "/private/store.sqlite",
			} as NonNullable<typeof value.retrieval_cells>[number],
		];
		value.candidate_semantic_retrieval = {
			status: "complete",
			lane: "candidate_semantic",
			candidate_commit: COMMIT,
			probe_suite_digest: SHA,
			source_corpus_digest: SHA,
			retrieval_subject_digest: SHA,
			embedding_model: "fixture-model",
			probe_count: 1,
			repetition_count: 1,
			aggregate_metrics: [
				{ id: "relevant_placement_rate", value: 1, unit: "ratio", raw_probe: "private" },
			],
			runs: [
				{
					lane: "candidate_semantic",
					candidate_commit: COMMIT,
					repetition: 1,
					probe_suite_digest: SHA,
					source_corpus_digest: SHA,
					retrieval_subject_digest: SHA,
					probe_count: 1,
					readiness: {
						state: "healthy",
						mode: "semantic",
						embedding_model: "fixture-model",
						semantic_search_model: "fixture-model",
						materialized_memory_count: 1,
						active_memory_count: 1,
						embeddable_memory_count: 1,
						indexed_memory_count: 1,
						pending_memory_count: 0,
						tagged_memory_count: 1,
						expected_file_ref_count: 0,
						file_ref_count: 0,
						expected_concept_ref_count: 0,
						concept_ref_count: 0,
						pending_ref_backfill: false,
						blocking_maintenance_job_count: 0,
						private_path: "/private/vector",
					},
					metrics: [
						{ id: "relevant_placement_rate", value: 1, unit: "ratio", raw_probe: "private" },
					],
				},
			],
		} as unknown as CandidateSemanticRetrievalEvidence;
		const summary = buildObserverScopeSummary(value);
		const json = JSON.stringify(summary);
		expect(summary.candidate_semantic_retrieval).toMatchObject({
			source_corpus_digest: SHA,
			retrieval_subject_digest: SHA,
		});
		expect(json).not.toContain("/private/store.sqlite");
		expect(json).not.toContain("/private/vector");
		expect(json).not.toContain("raw_probe");
		expect(json).not.toContain("private injection trace");
	});
});
