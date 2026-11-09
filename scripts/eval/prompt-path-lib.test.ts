import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classifyFailure,
	emptyFailureCounts,
	evaluatePromptPathGate,
	type GatePath,
	nearestRank,
	PromptPathBenchmarkError,
	parseSubprocessLog,
	subprocessActivitySettled,
	summarizeTimings,
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
		assert.deepEqual(
			summary.sorted_ms,
			Array.from({ length: 30 }, (_, index) => index + 1),
		);
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
});

describe("prompt-path timing serialization", () => {
	for (const timings of [
		[1.0001, 2.0006],
		[...Array<number>(14).fill(0), 1.0001, 2.0006, ...Array<number>(14).fill(10)],
	]) {
		it(`reproduces the summary from ${timings.length} serialized fractional samples`, () => {
			const summary = summarizeTimings(timings, timings.length, emptyFailureCounts());
			const serializedSamples: number[] = JSON.parse(JSON.stringify(summary.sorted_ms));

			const recomputed = summarizeTimings(serializedSamples, timings.length, summary.failures);

			assert.deepEqual(recomputed, summary);
			assert.equal(summary.median_ms, 1.501);
		});
	}

	it("preserves null timing metrics when there are no successful samples", () => {
		const failures = { ...emptyFailureCounts(), harness: 1 };

		const summary = summarizeTimings([], 1, failures);

		assert.deepEqual(summary, {
			attempted: 1,
			succeeded: 0,
			median_ms: null,
			p95_ms: null,
			sorted_ms: [],
			failures,
		});
	});
});

describe("prompt-path gate eligibility", () => {
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

	it("keeps a successful short run valid but ineligible for release", () => {
		const direct = gatePath({
			attempted: 1,
			succeeded: 1,
			subprocesses: { pack: 1, ledger: 0, other: 0, failed: 0 },
		});
		const healthy = gatePath({ attempted: 1, succeeded: 1, median_ms: 10, p95_ms: 10 });
		const fallback = gatePath({
			attempted: 1,
			succeeded: 1,
			subprocesses: { pack: 1, ledger: 1, other: 0, failed: 0 },
		});

		const result = evaluatePromptPathGate(1, direct, healthy, fallback);

		assert.equal(result.runValid, true);
		assert.equal(result.passed, false);
	});
});

for (const pathIndex of [0, 1, 2] as const) {
	describe(`prompt-path gate contracts for path ${pathIndex}`, () => {
		const invalidCounts = [
			{ other: 1 },
			{ failed: 1 },
			{ pack: pathIndex === 1 ? 1 : 29 },
			{ pack: pathIndex === 1 ? 2 : 31 },
			{ ledger: pathIndex === 2 ? 29 : 1 },
			{ ledger: pathIndex === 2 ? 31 : 2 },
		];
		if (pathIndex !== 1) invalidCounts.push({ pack: 0 });
		if (pathIndex === 2) invalidCounts.push({ ledger: 0 });
		for (const counts of invalidCounts) {
			it(`rejects path ${pathIndex} subprocess counts ${JSON.stringify(counts)}`, () => {
				const paths: [GatePath, GatePath, GatePath] = [
					gatePath({ subprocesses: { pack: 30, ledger: 0, other: 0, failed: 0 } }),
					gatePath({ median_ms: 10, p95_ms: 10 }),
					gatePath({ subprocesses: { pack: 30, ledger: 30, other: 0, failed: 0 } }),
				];
				const path = paths[pathIndex];
				path.subprocesses = { ...path.subprocesses, ...counts };

				const result = evaluatePromptPathGate(30, ...paths);

				assert.equal(result.runValid, false);
				assert.equal(result.passed, false);
			});
		}
		for (const attempts of [{ attempted: 29, succeeded: 29 }, { succeeded: 29 }]) {
			it(`rejects path ${pathIndex} incomplete repetitions ${JSON.stringify(attempts)}`, () => {
				const paths: [GatePath, GatePath, GatePath] = [
					gatePath({ subprocesses: { pack: 30, ledger: 0, other: 0, failed: 0 } }),
					gatePath({ median_ms: 10, p95_ms: 10 }),
					gatePath({ subprocesses: { pack: 30, ledger: 30, other: 0, failed: 0 } }),
				];
				Object.assign(paths[pathIndex], attempts);

				const result = evaluatePromptPathGate(30, ...paths);

				assert.equal(result.runValid, false);
				assert.equal(result.passed, false);
			});
		}
	});
}

describe("prompt-path gate rejection", () => {
	it("rejects late healthy activity including an unknown command still in flight", () => {
		const direct = gatePath({ subprocesses: { pack: 30, ledger: 0, other: 0, failed: 0 } });
		const fallback = gatePath({ subprocesses: { pack: 30, ledger: 30, other: 0, failed: 0 } });
		const activity = parseSubprocessLog("start other\n");
		const healthy = gatePath({ median_ms: 10, p95_ms: 10, subprocesses: activity.counts });

		const result = evaluatePromptPathGate(30, direct, healthy, fallback);

		assert.equal(subprocessActivitySettled(activity), false);
		assert.equal(result.healthyZeroSubprocesses, false);
		assert.equal(result.runValid, false);
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
			evaluatePromptPathGate(30, direct, gatePath({ median_ms: 10, p95_ms: 951 }), fallback).passed,
			false,
		);
		assert.equal(
			evaluatePromptPathGate(30, direct, gatePath({ median_ms: 900, p95_ms: 10 }), fallback).passed,
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
