export const FAILURE_CLASSES = [
	"terminal_contract",
	"retryable_transport_protocol",
	"harness",
] as const;

export const RELEASE_REPETITIONS = 30;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type FailureCounts = Record<FailureClass, number>;

export interface TimingSummary {
	attempted: number;
	succeeded: number;
	median_ms: number | null;
	p95_ms: number | null;
	sorted_ms: number[];
	failures: FailureCounts;
}

export interface SubprocessCounts {
	pack: number;
	ledger: number;
	other: number;
	failed: number;
}

export interface SubprocessLogSummary {
	counts: SubprocessCounts;
	started: number;
	ended: number;
}

export function subprocessActivitySettled(
	activity: Pick<SubprocessLogSummary, "started" | "ended">,
): boolean {
	return activity.started === activity.ended;
}

export interface GatePath {
	attempted: number;
	succeeded: number;
	median_ms: number | null;
	p95_ms: number | null;
	failures: FailureCounts;
	subprocesses: SubprocessCounts;
}

export interface PromptPathGate {
	runValid: boolean;
	passed: boolean;
	healthyMedianImproved: boolean;
	healthyP95NotRegressed: boolean;
	healthyZeroSubprocesses: boolean;
	allSucceeded: boolean;
}

export class PromptPathBenchmarkError extends Error {
	constructor(
		readonly failureClass: FailureClass,
		message: string,
	) {
		super(message);
		this.name = "PromptPathBenchmarkError";
	}
}

export function emptyFailureCounts(): FailureCounts {
	return {
		terminal_contract: 0,
		retryable_transport_protocol: 0,
		harness: 0,
	};
}

export function classifyFailure(error: unknown): FailureClass {
	return error instanceof PromptPathBenchmarkError ? error.failureClass : "harness";
}

export function nearestRank(values: readonly number[], percentile: number): number | null {
	if (values.length === 0) return null;
	if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
		throw new RangeError("percentile must be greater than 0 and at most 1");
	}
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(percentile * sorted.length) - 1] ?? null;
}

function roundMilliseconds(value: number): number {
	return Math.round(value * 1000) / 1000;
}

export function summarizeTimings(
	timings: readonly number[],
	attempted: number,
	failures: FailureCounts,
): TimingSummary {
	const sorted = [...timings].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length === 0
			? null
			: sorted.length % 2 === 0
				? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
				: (sorted[middle] ?? null);
	const p95 = nearestRank(sorted, 0.95);
	return {
		attempted,
		succeeded: sorted.length,
		median_ms: median == null ? null : roundMilliseconds(median),
		p95_ms: p95 == null ? null : roundMilliseconds(p95),
		sorted_ms: sorted.map(roundMilliseconds),
		failures: { ...failures },
	};
}

export function hasFailures(summary: Pick<TimingSummary, "failures">): boolean {
	return Object.values(summary.failures).some((count) => count > 0);
}

export function parseSubprocessLog(log: string): SubprocessLogSummary {
	const counts: SubprocessCounts = { pack: 0, ledger: 0, other: 0, failed: 0 };
	let startedCount = 0;
	let endedCount = 0;
	for (const line of log.split("\n")) {
		const started = /^start (pack|ledger|other)$/.exec(line);
		if (started) {
			const kind = started[1] as "pack" | "ledger" | "other";
			counts[kind] += 1;
			startedCount += 1;
			continue;
		}
		const ended = /^end (pack|ledger|other) (\d+)$/.exec(line);
		if (ended?.[2]) {
			endedCount += 1;
			if (ended[2] !== "0") counts.failed += 1;
		}
	}
	return { counts, started: startedCount, ended: endedCount };
}

export function evaluatePromptPathGate(
	repetitions: number,
	direct: GatePath,
	healthy: GatePath,
	fallback: GatePath,
): PromptPathGate {
	const healthyMedianImproved =
		direct.median_ms != null && healthy.median_ms != null && healthy.median_ms < direct.median_ms;
	const healthyP95NotRegressed =
		direct.p95_ms != null && healthy.p95_ms != null && healthy.p95_ms <= direct.p95_ms;
	const healthyZeroSubprocesses =
		healthy.subprocesses.pack === 0 &&
		healthy.subprocesses.ledger === 0 &&
		healthy.subprocesses.other === 0;
	const allSucceeded =
		![direct, healthy, fallback].some(hasFailures) &&
		[direct, healthy, fallback].every(
			(path) => path.succeeded === path.attempted && path.subprocesses.failed === 0,
		);
	const subprocessContractsMet =
		direct.subprocesses.pack === repetitions &&
		direct.subprocesses.ledger === 0 &&
		healthyZeroSubprocesses &&
		fallback.subprocesses.pack === repetitions &&
		fallback.subprocesses.ledger === repetitions;
	const runValid = allSucceeded && subprocessContractsMet;
	return {
		runValid,
		passed:
			repetitions === RELEASE_REPETITIONS &&
			healthyMedianImproved &&
			healthyP95NotRegressed &&
			healthyZeroSubprocesses &&
			runValid,
		healthyMedianImproved,
		healthyP95NotRegressed,
		healthyZeroSubprocesses,
		allSucceeded,
	};
}
