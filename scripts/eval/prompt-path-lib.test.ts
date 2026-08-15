import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classifyFailure,
	emptyFailureCounts,
	evaluatePromptPathGate,
	nearestRank,
	parseSubprocessLog,
	PromptPathBenchmarkError,
	subprocessActivitySettled,
	summarizeTimings,
	type GatePath,
} from "./prompt-path-lib.js";

function gatePath(overrides: Partial<GatePath> = {}): GatePath {
	return {
		attempted: 30,
		succeeded: 30,
		median_ms: 100,
		p95_ms: 120,
		failures: emptyFailureCounts(),
		subprocesses: { pack: 0, ledger: 0, other: 0, failed: 0 },
		...overrides,
	};
}

describe("prompt-path benchmark summaries", () => {
	it("uses nearest-rank p95 and reports a sorted unlabelled sample list", () => {
		const values = Array.from({ length: 30 }, (_, index) => 30 - index);
		const summary = summarizeTimings(values, 30, emptyFailureCounts());

		assert.equal(summary.median_ms, 15.5);
		assert.equal(summary.p95_ms, 29);
		assert.deepEqual(summary.sorted_ms, Array.from({ length: 30 }, (_, index) => index + 1));
	});

	it("keeps failed attempts explicit", () => {
		const failures = emptyFailureCounts();
		failures.terminal_contract = 1;
		const summary = summarizeTimings([4.12345, 2], 3, failures);

		assert.equal(summary.attempted, 3);
		assert.equal(summary.succeeded, 2);
		assert.deepEqual(summary.sorted_ms, [2, 4.123]);
		assert.equal(summary.failures.terminal_contract, 1);
	});

	it("rejects invalid percentiles", () => {
		assert.throws(() => nearestRank([1], 0), RangeError);
		assert.throws(() => nearestRank([1], 1.1), RangeError);
	});

	it("classifies known benchmark errors and unknown harness errors", () => {
		assert.equal(
			classifyFailure(new PromptPathBenchmarkError("retryable_transport_protocol", "fallback")),
			"retryable_transport_protocol",
		);
		assert.equal(classifyFailure(new Error("unexpected")), "harness");
	});

	it("counts subprocess starts so in-flight work cannot pass the zero-subprocess gate", () => {
		const complete = parseSubprocessLog("start pack\nstart ledger\nend pack 0\nend ledger 1\n");
		const inFlight = parseSubprocessLog("start pack\n");

		assert.deepEqual(complete, {
			counts: { pack: 1, ledger: 1, other: 0, failed: 1 },
			started: 2,
			ended: 2,
		});
		assert.equal(subprocessActivitySettled(complete), true);
		assert.equal(subprocessActivitySettled(inFlight), false);
		assert.equal(subprocessActivitySettled({ started: 0, ended: 0 }), true);
	});

	it("passes only an eligible 30-run improvement with exact subprocess contracts", () => {
		const direct = gatePath({
			median_ms: 900,
			p95_ms: 950,
			subprocesses: { pack: 30, ledger: 0, other: 0, failed: 0 },
		});
		const healthy = gatePath({ median_ms: 10, p95_ms: 13 });
		const fallback = gatePath({
			median_ms: 1500,
			p95_ms: 1600,
			subprocesses: { pack: 30, ledger: 30, other: 0, failed: 0 },
		});

		assert.equal(evaluatePromptPathGate(30, direct, healthy, fallback).passed, true);
		assert.equal(evaluatePromptPathGate(1, direct, healthy, fallback).passed, false);
	});

	it("fails on a p95 regression, median tie, failed subprocess, or unexpected healthy command", () => {
		const direct = gatePath({
			median_ms: 900,
			p95_ms: 950,
			subprocesses: { pack: 30, ledger: 0, other: 0, failed: 0 },
		});
		const fallback = gatePath({
			subprocesses: { pack: 30, ledger: 30, other: 0, failed: 0 },
		});

		assert.equal(
			evaluatePromptPathGate(30, direct, gatePath({ median_ms: 10, p95_ms: 951 }), fallback)
				.passed,
			false,
		);
		assert.equal(
			evaluatePromptPathGate(30, direct, gatePath({ median_ms: 900, p95_ms: 10 }), fallback)
				.passed,
			false,
		);
		assert.equal(
			evaluatePromptPathGate(
				30,
				direct,
				gatePath({
					median_ms: 10,
					p95_ms: 10,
					subprocesses: { pack: 0, ledger: 0, other: 0, failed: 1 },
				}),
				fallback,
			).runValid,
			false,
		);
		assert.equal(
			evaluatePromptPathGate(
				30,
				direct,
				gatePath({
					median_ms: 10,
					p95_ms: 10,
					subprocesses: { pack: 0, ledger: 0, other: 1, failed: 0 },
				}),
				fallback,
			).runValid,
			false,
		);
	});
});
