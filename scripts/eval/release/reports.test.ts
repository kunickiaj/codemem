import { describe, expect, it } from "vitest";
import type { ObserverSummaryInput } from "./reports.js";
import { buildObserverScopeSummary } from "./reports.js";

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
});
