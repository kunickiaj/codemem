import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPromptPackTimingScope,
	PROMPT_PACK_TIMING_STAGES,
	recordPromptPackTiming,
	startPromptPackTiming,
} from "./prompt-pack-timing.js";

afterEach(() => vi.restoreAllMocks());

describe("prompt pack timing helpers", () => {
	it("reports the frozen stage vocabulary and an idempotent measured interval", () => {
		// Arrange
		const clock = vi
			.spyOn(performance, "now")
			.mockReturnValueOnce(10)
			.mockReturnValueOnce(12.34567);
		const observer = vi.fn();
		// Act
		const end = startPromptPackTiming(observer, "pack_assembly");
		end();
		end(99);
		// Assert
		expect(PROMPT_PACK_TIMING_STAGES).toEqual([
			"semantic_queue_wait",
			"semantic_worker_readiness",
			"embedding_client_init",
			"embedding_inference",
			"semantic_worker_roundtrip",
			"semantic_worker_rank",
			"pack_assembly",
			"usage_write",
		]);
		expect(observer.mock.calls.map(([event]) => event)).toEqual([
			{ stage: "pack_assembly", state: "start" },
			{ stage: "pack_assembly", state: "end", elapsed_ms: 2.346 },
		]);
		expect(clock).toHaveBeenCalledTimes(2);
	});

	it("records end-only overrides with rounding, zero, and the one-day ceiling", () => {
		// Arrange
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		const observer = vi.fn();
		// Act
		startPromptPackTiming(observer, "semantic_worker_rank")(1.23456);
		recordPromptPackTiming(observer, "semantic_worker_rank", 0);
		recordPromptPackTiming(observer, "semantic_worker_rank", 86_400_001);
		// Assert
		expect(observer.mock.calls.map(([event]) => event)).toEqual([
			{ stage: "semantic_worker_rank", state: "start" },
			{ stage: "semantic_worker_rank", state: "end", elapsed_ms: 1.235 },
			{ stage: "semantic_worker_rank", state: "end", elapsed_ms: 0 },
			{ stage: "semantic_worker_rank", state: "end", elapsed_ms: 86_400_000 },
		]);
		expect(clock).toHaveBeenCalledTimes(1);
	});

	it("omits invalid supplied durations and clamps a backwards clock to zero", () => {
		// Arrange
		vi.spyOn(performance, "now").mockReturnValueOnce(20).mockReturnValueOnce(10);
		const observer = vi.fn();
		// Act
		for (const value of [NaN, Infinity, -Infinity, -1]) {
			recordPromptPackTiming(observer, "semantic_worker_rank", value);
		}
		startPromptPackTiming(observer, "usage_write")();
		// Assert
		expect(observer.mock.calls.map(([event]) => event)).toEqual([
			{ stage: "usage_write", state: "start" },
			{ stage: "usage_write", state: "end", elapsed_ms: 0 },
		]);
	});

	it.each(["throw", "reject", "pending"] as const)(
		"isolates an observer that can %s without awaiting it",
		async (behavior) => {
			// Arrange
			const observer = vi.fn(() => {
				if (behavior === "throw") throw new Error("diagnostic failed");
				if (behavior === "reject") return Promise.reject(new Error("diagnostic failed"));
				return new Promise<void>(() => {});
			});
			// Act
			const end = startPromptPackTiming(observer, "pack_assembly");
			end(2);
			recordPromptPackTiming(observer, "usage_write", 3);
			await Promise.resolve();
			// Assert: rejected promises must not become unhandled Vitest errors.
			expect(observer).toHaveBeenCalledTimes(3);
		},
	);

	it.each(["close", "abort", "already-aborted"] as const)(
		"stops observations after %s without affecting another request",
		(mode) => {
			// Arrange
			const observer = vi.fn();
			const otherObserver = vi.fn();
			const controller = new AbortController();
			if (mode === "already-aborted") controller.abort();
			const scope = createPromptPackTimingScope(observer, controller.signal);
			const other = createPromptPackTimingScope(otherObserver);
			// Act
			const end = startPromptPackTiming(scope.onTiming, "embedding_inference");
			if (mode === "close") scope.close();
			else controller.abort();
			end(4);
			recordPromptPackTiming(scope.onTiming, "semantic_worker_rank", 5);
			scope.close();
			recordPromptPackTiming(other.onTiming, "semantic_worker_rank", 6);
			// Assert
			expect(observer.mock.calls.map(([event]) => event)).toEqual(
				mode === "already-aborted" ? [] : [{ stage: "embedding_inference", state: "start" }],
			);
			expect(otherObserver).toHaveBeenCalledExactlyOnceWith({
				stage: "semantic_worker_rank",
				state: "end",
				elapsed_ms: 6,
			});
		},
	);

	it("does not read the clock or allocate timers without an observer", () => {
		// Arrange
		const clock = vi.spyOn(performance, "now");
		const timer = vi.spyOn(globalThis, "setTimeout");
		const scope = createPromptPackTimingScope(undefined);
		// Act
		startPromptPackTiming(undefined, "pack_assembly")();
		recordPromptPackTiming(undefined, "usage_write", 1);
		scope.close();
		// Assert
		expect(scope.onTiming).toBeUndefined();
		expect(clock).not.toHaveBeenCalled();
		expect(timer).not.toHaveBeenCalled();
	});

	it("does not emit an invalid explicit override or retry an already-ended interval", () => {
		// Arrange
		const observer = vi.fn();
		// Act
		const end = startPromptPackTiming(observer, "semantic_worker_rank");
		end(NaN);
		end(1);
		// Assert
		expect(observer).toHaveBeenCalledExactlyOnceWith({
			stage: "semantic_worker_rank",
			state: "start",
		});
	});
});
