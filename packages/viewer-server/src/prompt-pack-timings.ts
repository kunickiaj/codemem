import {
	PROMPT_PACK_TIMING_STAGES,
	type PromptPackTimingEvent,
	type PromptPackTimingObserver,
} from "@codemem/core";

export const PROMPT_PACK_TIMING_HEADER = "x-codemem-prompt-timing-id";
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = [
	...PROMPT_PACK_TIMING_STAGES,
	"request_body",
	"request_validation",
	"pack_build",
	"artifact_fingerprint",
	"ledger_write",
	"response_encode",
] as const;
export type PromptPackViewerTimingStage = (typeof STAGES)[number];
type Stage = PromptPackViewerTimingStage;
const STAGE_NAMES = new Set<string>(STAGES);
const MAX_MS = 86_400_000;
const PULSE_MS = 25;

export interface PromptPackTimingReport {
	schema_version: 1;
	side: "viewer";
	operation: "pack";
	request_id: string;
	outcome: "completed" | "rejected" | "failed" | "aborted";
	status_class: "2xx" | "3xx" | "4xx" | "5xx" | "none";
	elapsed_ms: number;
	event_loop_lag_ms: number;
	timings_ms: Partial<Record<Stage, number>>;
	incomplete_stages: Stage[];
}

export interface PromptPackTimingOptions {
	enabled?: boolean;
	report?: (entry: PromptPackTimingReport) => void | Promise<void>;
	now?: () => number;
}

export interface PromptPackRequestTiming {
	onTiming: PromptPackTimingObserver;
	start(stage: Stage): () => void;
	finish(status?: number): void;
}

function milliseconds(value: number): number {
	return Math.round(Math.min(MAX_MS, Math.max(0, value)) * 1_000) / 1_000;
}

function clock(read: () => number): () => number {
	return () => {
		try {
			const value = read();
			if (Number.isFinite(value)) return value;
		} catch {
			// A diagnostic clock cannot change request handling.
		}
		return performance.now();
	};
}

function observeEventLoop(now: () => number): () => number {
	let previous = now();
	let maximum = 0;
	const observe = () => {
		const current = now();
		maximum = Math.max(maximum, current - previous - PULSE_MS);
		previous = current;
	};
	const timer = setInterval(observe, PULSE_MS);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		observe();
		return milliseconds(maximum);
	};
}

function responseState(
	status: number | undefined,
): Pick<PromptPackTimingReport, "outcome" | "status_class"> {
	if (status !== undefined && status >= 200 && status < 300)
		return { outcome: "completed", status_class: "2xx" };
	if (status !== undefined && status >= 300 && status < 400)
		return { outcome: "completed", status_class: "3xx" };
	if (status !== undefined && status >= 400 && status < 500)
		return { outcome: "rejected", status_class: "4xx" };
	if (status !== undefined && status >= 500 && status < 600)
		return { outcome: "failed", status_class: "5xx" };
	return { outcome: "failed", status_class: "none" };
}

function emitReport(options: PromptPackTimingOptions, entry: PromptPackTimingReport): void {
	try {
		const pending = options.report
			? options.report(entry)
			: console.warn(`prompt.pack.timing ${JSON.stringify(entry)}`);
		if (pending) void Promise.resolve(pending).catch(() => {});
	} catch {
		// Optional diagnostics must never change pack delivery or error classification.
	}
}

function snapshotStages(
	active: ReadonlyMap<Stage, number>,
	completed: ReadonlyMap<Stage, number>,
	endedAt: number,
): Pick<PromptPackTimingReport, "timings_ms" | "incomplete_stages"> {
	const timings_ms: Partial<Record<Stage, number>> = {};
	const incomplete_stages: Stage[] = [];
	for (const stage of STAGES) {
		let elapsed = completed.get(stage);
		const started = active.get(stage);
		if (started !== undefined) {
			elapsed = (elapsed ?? 0) + Math.max(0, endedAt - started);
			incomplete_stages.push(stage);
		}
		if (elapsed !== undefined) timings_ms[stage] = milliseconds(elapsed);
	}
	return { timings_ms, incomplete_stages };
}

export function createPromptPackRequestTiming(
	requestId: string | undefined,
	signal: AbortSignal,
	options: PromptPackTimingOptions,
): PromptPackRequestTiming | undefined {
	if (!options.enabled || !requestId || !REQUEST_ID.test(requestId)) return undefined;
	const now = clock(options.now ?? (() => performance.now()));
	const startedAt = now();
	const stopEventLoop = observeEventLoop(now);
	const active = new Map<Stage, number>();
	const completed = new Map<Stage, number>();
	let closed = false;
	const begin = (stage: Stage) => {
		if (!closed && !active.has(stage)) active.set(stage, now());
	};
	const end = (stage: Stage, elapsed: number) => {
		if (closed || !Number.isFinite(elapsed) || elapsed < 0) return;
		active.delete(stage);
		completed.set(stage, milliseconds((completed.get(stage) ?? 0) + elapsed));
	};
	const onTiming = (event: PromptPackTimingEvent) => {
		if (closed || !STAGE_NAMES.has(event.stage)) return;
		if (event.state === "start") begin(event.stage);
		else if (event.state === "end") end(event.stage, event.elapsed_ms);
	};
	const finish = (status?: number) => {
		if (closed) return;
		closed = true;
		signal.removeEventListener("abort", abort);
		const endedAt = now();
		const state = responseState(status);
		emitReport(options, {
			schema_version: 1,
			side: "viewer",
			operation: "pack",
			request_id: requestId.toLowerCase(),
			...state,
			...(signal.aborted ? { outcome: "aborted" } : {}),
			elapsed_ms: milliseconds(endedAt - startedAt),
			event_loop_lag_ms: stopEventLoop(),
			...snapshotStages(active, completed, endedAt),
		});
		active.clear();
		completed.clear();
	};
	const abort = () => finish();
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) finish();
	return {
		onTiming,
		start(stage) {
			begin(stage);
			const started = active.get(stage);
			let ended = false;
			return () => {
				if (ended || started === undefined || closed) return;
				ended = true;
				end(stage, Math.max(0, now() - started));
			};
		},
		finish,
	};
}

export function measurePromptPackSync<T>(
	timing: PromptPackRequestTiming | undefined,
	stage: Stage,
	work: () => T,
): T {
	const end = timing?.start(stage);
	try {
		return work();
	} finally {
		end?.();
	}
}

export async function measurePromptPackAsync<T>(
	timing: PromptPackRequestTiming | undefined,
	stage: Stage,
	work: () => Promise<T>,
): Promise<T> {
	if (!timing) return work();
	const end = timing.start(stage);
	try {
		return await work();
	} finally {
		end();
	}
}
