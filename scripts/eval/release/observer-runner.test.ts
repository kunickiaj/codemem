import { describe, expect, it } from "vitest";
import type { HistoricalObserverSubject } from "./historical-observer.js";
import type { ObserverInvocationResult, ObserverInvoker } from "./observer-runner.js";
import { observerExecutionBucket, runCurrentEvaluatorObserver } from "./observer-runner.js";
import type { JsonValue, ProjectedCorpusV1 } from "./types.js";

function corpus(): ProjectedCorpusV1 {
	const context: JsonValue = {
		project: "fixture",
		user_prompt: "remember",
		prompt_number: 1,
		transcript: "durable fact",
		tool_events: [],
		last_assistant_message: null,
		include_summary: true,
		diff_summary: "",
		recent_files: "",
	};
	return {
		schema_version: 1,
		rows: [
			{
				case_id: "recall",
				ordinal: 0,
				row_type: "observer_case",
				value: {
					observer_context: context,
					review: {
						reviewer_notes: "public fixture",
						required: [
							{
								label_id: "durable",
								title: "durable",
								keyword_groups: [["durable"], ["fact"]],
								reviewer_notes: "required",
								evidence_notes: "fixture",
							},
						],
						optional: [],
						forbidden: [],
					},
					expected_summary_disposition: "required",
					expected_observation_policy: "quality",
				},
			},
		],
	};
}

function subject(
	kind: "approved_stable" | "candidate",
	version: string,
	commit: string,
): HistoricalObserverSubject {
	return {
		label: kind,
		requestedRef: commit,
		observerContextSchemaVersion: 1,
		sanitizedSubject: { kind, version },
		productVersion: version,
		resolvedCommit: commit,
		worktreePath: "/ignored",
		buildObserverPrompt: async () => ({ system: "system", user: "user" }),
	};
}

function response(raw: string): ObserverInvocationResult {
	return {
		status: "completed",
		raw,
		provider: "fake",
		requestedModel: "fake",
		resolvedModel: "fake",
		modelFallbackApplied: false,
		fallbackReason: null,
		elapsedMs: 1,
		usage: { inputTokens: 1, outputTokens: 1 },
		estimatedCostUsd: null,
		error: null,
	};
}

describe("current evaluator observer runner", () => {
	it.each([
		["pass", "completed"],
		["fallback", "completed"],
		["shape_failure", "failed"],
		["no_output", "failed"],
		["malformed", "failed"],
		["unavailable", "unavailable"],
		["partial", "partial"],
	] as const)("maps %s to only the %s execution bucket", (status, bucket) => {
		expect(observerExecutionBucket(status)).toBe(bucket);
	});

	it("scores historical and candidate prompt subjects with the same current parser and scorer", async () => {
		const xml =
			"<observation><type>discovery</type><title>Durable fact</title><narrative>durable fact</narrative><facts><fact>durable fact</fact></facts><concepts></concepts><files_read></files_read><files_modified></files_modified></observation><summary><request>remember</request><learned>durable fact</learned></summary>";
		const invoker: ObserverInvoker = { invoke: async () => response(xml) };
		const result = await runCurrentEvaluatorObserver({
			corpus: corpus(),
			subjects: [
				subject("approved_stable", "0.39.1", "a".repeat(40)),
				subject("candidate", "0.40.0", "b".repeat(40)),
			],
			repetitions: 1,
			invoker,
		});
		expect(result.runs).toHaveLength(2);
		expect(
			result.sanitizedMetrics.filter(
				(metric) => metric.phase === "final" && metric.id === "required_fact_recall",
			),
		).toEqual([
			{
				subject: { kind: "approved_stable", version: "0.39.1" },
				phase: "final",
				id: "required_fact_recall",
				value: 1,
				unit: "ratio",
			},
			{
				subject: { kind: "candidate", version: "0.40.0" },
				phase: "final",
				id: "required_fact_recall",
				value: 1,
				unit: "ratio",
			},
		]);
	});

	it("keeps malformed initial output separate from repaired output", async () => {
		const repaired =
			"<summary><request>remember</request><learned>durable fact</learned></summary>";
		const invoker: ObserverInvoker = {
			invoke: async (request) => response(request.attempt === "initial" ? "not xml" : repaired),
		};
		const result = await runCurrentEvaluatorObserver({
			corpus: corpus(),
			subjects: [subject("candidate", "0.40.0", "b".repeat(40))],
			repetitions: 1,
			invoker,
		});
		expect(result.runs[0]).toMatchObject({
			repairApplied: true,
			initial: { raw: "not xml", caseStatus: "malformed" },
			repaired: { raw: repaired },
		});
		expect(JSON.stringify(result.caseResults)).toContain("not xml");
	});
});
