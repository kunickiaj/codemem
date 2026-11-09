export const PROMPT_PACK_TIMING_STAGES = [
	"semantic_queue_wait",
	"semantic_worker_readiness",
	"embedding_client_init",
	"embedding_inference",
	"semantic_worker_roundtrip",
	"semantic_worker_rank",
	"pack_assembly",
	"usage_write",
] as const;

export type PromptPackTimingStage = (typeof PROMPT_PACK_TIMING_STAGES)[number];
export type PromptPackTimingEvent =
	| { stage: PromptPackTimingStage; state: "start" }
	| { stage: PromptPackTimingStage; state: "end"; elapsed_ms: number };
export type PromptPackTimingObserver = (event: PromptPackTimingEvent) => void | Promise<void>;

function emit(observer: PromptPackTimingObserver, event: PromptPackTimingEvent): void {
	try {
		const result = observer(event);
		if (result) void Promise.resolve(result).catch(() => {});
	} catch {
		// Optional diagnostics cannot affect retrieval or caller settlement.
	}
}

export function recordPromptPackTiming(
	observer: PromptPackTimingObserver | undefined,
	stage: PromptPackTimingStage,
	elapsedMs: number,
): void {
	if (!observer || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
	const elapsed_ms = Math.round(Math.min(elapsedMs, 86_400_000) * 1_000) / 1_000;
	emit(observer, { stage, state: "end", elapsed_ms });
}

export function startPromptPackTiming(
	observer: PromptPackTimingObserver | undefined,
	stage: PromptPackTimingStage,
): (elapsedOverrideMs?: number) => void {
	if (!observer) return () => {};
	const startedAt = performance.now();
	emit(observer, { stage, state: "start" });
	let ended = false;
	return (elapsedOverrideMs) => {
		if (ended) return;
		ended = true;
		recordPromptPackTiming(
			observer,
			stage,
			elapsedOverrideMs ?? Math.max(0, performance.now() - startedAt),
		);
	};
}

export function createPromptPackTimingScope(
	observer: PromptPackTimingObserver | undefined,
	signal?: AbortSignal,
): { onTiming: PromptPackTimingObserver | undefined; close(): void } {
	let closed = false;
	return {
		onTiming: observer
			? (event) => {
					if (!closed && !signal?.aborted) emit(observer, event);
				}
			: undefined,
		close() {
			closed = true;
		},
	};
}
