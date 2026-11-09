import type { PromptPackTimingEvent } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPromptPackRequestTiming,
	PROMPT_PACK_TIMING_HEADER,
	type PromptPackTimingReport,
} from "./prompt-pack-timings.js";

const id = "A1234567-1234-4567-89AB-123456789ABC";
const otherId = "b1234567-1234-4567-89ab-123456789abc";

function activeTiming(...args: Parameters<typeof createPromptPackRequestTiming>) {
	const timing = createPromptPackRequestTiming(...args);
	if (!timing) throw new Error("expected an active timing collector");
	return timing;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("prompt pack request timing", () => {
	it("requires explicit opt-in and a UUIDv4 without reading clocks or scheduling work", () => {
		// Arrange: even plausible non-v4 identifiers must not activate diagnostics.
		const now = vi.fn(() => 0);
		const report = vi.fn();
		const signal = new AbortController().signal;
		const cases = [
			{ enabled: undefined, token: id },
			{ enabled: false, token: id },
			{ enabled: true, token: undefined },
			{ enabled: true, token: "private-token-canary" },
			{ enabled: true, token: "018f2db4-f9d3-7a22-8d18-000000000001" },
			{ enabled: true, token: ` ${id}` },
		];
		// Act
		const results = cases.map(({ enabled, token }) =>
			createPromptPackRequestTiming(token, signal, { enabled, now, report }),
		);
		// Assert
		expect(results).toEqual(cases.map(() => undefined));
		expect(now).not.toHaveBeenCalled();
		expect(report).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(PROMPT_PACK_TIMING_HEADER).toBe("x-codemem-prompt-timing-id");
	});

	it("reports only fixed keys and stage names and contains no event payload canaries", () => {
		// Arrange
		const report = vi.fn();
		const timing = activeTiming(id, new AbortController().signal, {
			enabled: true,
			now: () => 10,
			report,
		});
		// Act
		timing.onTiming({ stage: "pack_assembly", state: "end", elapsed_ms: 1.23456 });
		timing.onTiming({
			stage: "private-stage-canary",
			state: "end",
			elapsed_ms: 4,
			body: "private-body-canary",
			error: "private-error-canary",
		} as unknown as PromptPackTimingEvent);
		for (const elapsed_ms of [NaN, Infinity, -1]) {
			timing.onTiming({ stage: "usage_write", state: "end", elapsed_ms });
		}
		timing.finish(200);
		// Assert: exact shape is also the privacy boundary.
		expect(report).toHaveBeenCalledExactlyOnceWith({
			schema_version: 1,
			side: "viewer",
			operation: "pack",
			request_id: id.toLowerCase(),
			outcome: "completed",
			status_class: "2xx",
			elapsed_ms: 0,
			event_loop_lag_ms: 0,
			timings_ms: { pack_assembly: 1.235 },
			incomplete_stages: [],
		});
		expect(JSON.stringify(report.mock.calls)).not.toContain("canary");
	});

	it.each([
		[201, "completed", "2xx"],
		[302, "completed", "3xx"],
		[400, "rejected", "4xx"],
		[503, "failed", "5xx"],
		[undefined, "failed", "none"],
	])("classifies status %s without including raw errors", (status, outcome, status_class) => {
		// Arrange
		const report = vi.fn();
		const timing = activeTiming(id, new AbortController().signal, {
			enabled: true,
			report,
		});
		// Act
		timing.finish(status);
		// Assert
		expect(report).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ outcome, status_class }),
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps overlapping requests isolated and ends spans only once", () => {
		// Arrange
		let now = 0;
		const reports: PromptPackTimingReport[] = [];
		const options = {
			enabled: true,
			now: () => now,
			report: (entry: PromptPackTimingReport) => {
				reports.push(entry);
			},
		};
		const first = activeTiming(id, new AbortController().signal, options);
		const second = activeTiming(otherId, new AbortController().signal, options);
		// Act
		const end = first.start("pack_build");
		now = 4;
		end();
		end();
		second.start("ledger_write");
		now = 9;
		first.finish(200);
		second.finish(500);
		first.finish(400);
		// Assert
		expect(
			reports.map(({ request_id, timings_ms, incomplete_stages }) => ({
				request_id,
				timings_ms,
				incomplete_stages,
			})),
		).toEqual([
			{ request_id: id.toLowerCase(), timings_ms: { pack_build: 4 }, incomplete_stages: [] },
			{ request_id: otherId, timings_ms: { ledger_write: 5 }, incomplete_stages: ["ledger_write"] },
		]);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("prompt pack timing lifecycle and clocks", () => {
	it.each([false, true])(
		"aborts immediately and ignores late work (pre-aborted: %s)",
		(preAborted) => {
			// Arrange
			const controller = new AbortController();
			const remove = vi.spyOn(controller.signal, "removeEventListener");
			const report = vi.fn();
			if (preAborted) controller.abort(new Error("private-abort-canary"));
			const timing = activeTiming(id, controller.signal, {
				enabled: true,
				report,
			});
			const end = timing.start("pack_build");
			// Act
			controller.abort(new Error("private-abort-canary"));
			end();
			timing.onTiming({ stage: "usage_write", state: "end", elapsed_ms: 100 });
			timing.finish(200);
			vi.advanceTimersByTime(100);
			// Assert
			expect(report).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ outcome: "aborted", status_class: "none" }),
			);
			expect(JSON.stringify(report.mock.calls)).not.toContain("private-abort-canary");
			expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(["throw", "reject", "pending"])(
		"contains a %s reporter without delaying cleanup",
		async (mode) => {
			// Arrange
			const report = vi.fn(() => {
				if (mode === "throw") throw new Error("private-reporter-canary");
				if (mode === "reject") return Promise.reject(new Error("private-reporter-canary"));
				return new Promise<void>(() => {});
			});
			const timing = activeTiming(id, new AbortController().signal, {
				enabled: true,
				report,
			});
			// Act
			expect(() => timing.finish(200)).not.toThrow();
			await Promise.resolve();
			// Assert
			expect(report).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("bounds durations and detects synchronous lag before the first timer pulse", () => {
		// Arrange
		let now = 0;
		const report = vi.fn();
		const timing = activeTiming(id, new AbortController().signal, {
			enabled: true,
			now: () => now,
			report,
		});
		// Act
		timing.onTiming({ stage: "embedding_inference", state: "end", elapsed_ms: 1e20 });
		now = 1e20;
		timing.finish(200);
		// Assert
		expect(report).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				elapsed_ms: 86_400_000,
				event_loop_lag_ms: 86_400_000,
				timings_ms: { embedding_inference: 86_400_000 },
			}),
		);
	});

	it("samples timer lag, clamps backward clocks, and uses the default structured writer", () => {
		// Arrange
		let now = 100;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const timing = activeTiming(id, new AbortController().signal, {
			enabled: true,
			now: () => now,
		});
		const end = timing.start("request_body");
		// Act
		now = 150;
		vi.advanceTimersByTime(25);
		now = 50;
		end();
		timing.finish(200);
		// Assert
		expect(warn).toHaveBeenCalledTimes(1);
		const line = warn.mock.calls[0]?.[0] as string;
		expect(line.startsWith("prompt.pack.timing ")).toBe(true);
		expect(JSON.parse(line.slice("prompt.pack.timing ".length))).toMatchObject({
			elapsed_ms: 0,
			event_loop_lag_ms: 25,
			timings_ms: { request_body: 0 },
		});
		expect(vi.getTimerCount()).toBe(0);
	});
});
