import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObserverClient } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observerStatusRoutes } from "./observer-status";

const previousRawEvents = process.env.CODEMEM_RAW_EVENTS;

afterEach(() => {
	if (previousRawEvents == null) delete process.env.CODEMEM_RAW_EVENTS;
	else process.env.CODEMEM_RAW_EVENTS = previousRawEvents;
});

describe("observer status capture evidence", () => {
	it.each(["0", "false", "off"])("reports %s as paused raw-event capture", async (value) => {
		process.env.CODEMEM_RAW_EVENTS = value;
		const app = observerStatusRoutes({
			getObserver: () => null,
			getStore: () => null as never,
			getSweeper: () => null,
		});

		const response = await app.request("/api/observer-status");
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.capture_enabled).toBe(false);
	});

	it("reports other explicit values as enabled like the capture runtime", async () => {
		process.env.CODEMEM_RAW_EVENTS = "on";
		const app = observerStatusRoutes({
			getObserver: () => null,
			getStore: () => null as never,
			getSweeper: () => null,
		});

		const response = await app.request("/api/observer-status");
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.capture_enabled).toBe(true);
	});

	it("does not infer enabled capture when the viewer has no explicit evidence", async () => {
		delete process.env.CODEMEM_RAW_EVENTS;
		const app = observerStatusRoutes({
			getObserver: () => null,
			getStore: () => null as never,
			getSweeper: () => null,
		});

		const response = await app.request("/api/observer-status");
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.capture_enabled).toBeNull();
	});
});

describe("observer status reasoning effort", () => {
	it("reports what each tier's last request did with the effort", async () => {
		const home = mkdtempSync(join(tmpdir(), "codemem-observer-status-"));
		vi.stubEnv("HOME", home);
		const simple = {
			requestedReasoningEffort: "high",
			attemptedReasoningEffort: "high",
			actualReasoningEffort: null,
			reasoningEffortRequestSucceeded: true,
			reasoningEffortFallbackApplied: true,
			reasoningEffortFallbackReason: "variant_rejected",
		};
		const observer = {
			getStatus: () => ({
				provider: "openai",
				model: "gpt-5.6",
				runtime: "opencode_v2",
				auth: { source: "opencode_service", type: "opencode_v2", hasToken: false },
				requestedReasoningEffort: "high",
				attemptedReasoningEffort: null,
				actualReasoningEffort: null,
				reasoningEffortRequestSucceeded: null,
				reasoningEffortFallbackApplied: false,
				reasoningEffortFallbackReason: null,
				tierReasoningEfforts: { simple },
			}),
		} as unknown as ObserverClient;
		const store = {
			rawEventBacklogTotals: () => ({ pending: 0, sessions: 0 }),
			latestRawEventFlushFailure: () => null,
		};
		try {
			const app = observerStatusRoutes({
				getObserver: () => observer,
				getStore: () => store as never,
				getSweeper: () => null,
			});

			const response = await app.request("/api/observer-status");
			const body = (await response.json()) as { active: Record<string, unknown> };

			expect(body.active.tierReasoningEfforts).toEqual({ simple });
			expect(body.active.reasoningEffortRequestSucceeded).toBeNull();
		} finally {
			vi.unstubAllEnvs();
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("observer status prompt budget", () => {
	it("reports the active observer's last prompt lengths", async () => {
		const home = mkdtempSync(join(tmpdir(), "codemem-observer-status-"));
		vi.stubEnv("HOME", home);
		const promptBudget = {
			maxChars: 12_000,
			instructionChars: 10_419,
			contentBudgetChars: 3_000,
			contentChars: 9_000,
			sentContentChars: 3_000,
			contentClipped: true,
			instructionsOverBudget: false,
			sections: null,
		};
		const observer = {
			getStatus: () => ({
				provider: "openai",
				model: "gpt-5.6",
				runtime: "opencode_v2",
				auth: { source: "opencode_service", type: "opencode_v2", hasToken: false },
				promptBudget,
			}),
		} as unknown as ObserverClient;
		const store = {
			rawEventBacklogTotals: () => ({ pending: 0, sessions: 0 }),
			latestRawEventFlushFailure: () => null,
		};
		try {
			const app = observerStatusRoutes({
				getObserver: () => observer,
				getStore: () => store as never,
				getSweeper: () => null,
			});

			const response = await app.request("/api/observer-status");
			const body = (await response.json()) as { active: { promptBudget: unknown } };

			expect(body.active.promptBudget).toEqual(promptBudget);
		} finally {
			vi.unstubAllEnvs();
			rmSync(home, { recursive: true, force: true });
		}
	});
});
