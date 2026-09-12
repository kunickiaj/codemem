import { afterEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
	getExtractionBenchmarkProfile: vi.fn(),
	replayBatchExtraction: vi.fn(),
	replayBatchExtractionWithTierRouting: vi.fn(),
}));

vi.mock("@codemem/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@codemem/core")>();
	class ObserverClientStub {
		provider = "test";
		model = "fixture";
		requestedModel = "fixture";
		openaiUseResponses = false;
		reasoningEffort = null;
		reasoningSummary = null;
		maxOutputTokens = null;
		temperature = null;
		maxChars = 12_000;

		getStatus() {
			return {
				provider: "test",
				model: "fixture",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
				actualModel: "fixture",
				modelFallbackApplied: false,
				modelFallbackReason: null,
			};
		}
	}
	return {
		...actual,
		getExtractionBenchmarkProfile: coreMocks.getExtractionBenchmarkProfile,
		loadObserverConfig: vi.fn(() => ({})),
		ObserverClient: ObserverClientStub,
		replayBatchExtraction: coreMocks.replayBatchExtraction,
		replayBatchExtractionWithTierRouting: coreMocks.replayBatchExtractionWithTierRouting,
	};
});

import { ContextOnlyReplayError } from "@codemem/core";
import { memoryCommand } from "./memory.js";

function command(name: string) {
	const selected = memoryCommand.commands.find((candidate) => candidate.name() === name);
	if (!selected) throw new Error(`expected ${name} command`);
	return selected;
}

async function captureJson(run: () => Promise<unknown>) {
	const originalExitCode = process.exitCode;
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	process.exitCode = undefined;
	try {
		await run();
		const output = log.mock.calls.at(-1)?.[0];
		return {
			body: JSON.parse(String(output)) as Record<string, unknown>,
			exitCode: process.exitCode,
		};
	} finally {
		process.exitCode = originalExitCode;
		log.mockRestore();
	}
}

function contextOnlyBenchmark() {
	const batch = (batchId: number) => ({
		batchId,
		sessionId: batchId,
		label: `Context-only ${batchId}`,
		purpose: "shape_quality",
		complexity: "simple",
		expectedTier: "simple",
		expectedSummaryDisposition: "required",
	});
	return {
		id: "context-only-fixture",
		title: "Context-only fixture",
		description: "Fixture with only delegated instruction batches",
		scenarioId: "simple-batch-shape",
		modelCandidates: [],
		batches: [batch(41), batch(42)],
	};
}

afterEach(() => {
	coreMocks.getExtractionBenchmarkProfile.mockReset();
	coreMocks.replayBatchExtraction.mockReset();
	coreMocks.replayBatchExtractionWithTierRouting.mockReset();
});

describe("memory context-only extraction replay", () => {
	it("returns a non-error replay outcome with exit code zero", async () => {
		// Arrange
		coreMocks.replayBatchExtraction.mockRejectedValueOnce(new ContextOnlyReplayError(41));

		// Act
		const result = await captureJson(() =>
			command("extraction-replay").parseAsync(
				["--batch-id", "41", "--scenario", "simple-batch-shape", "--json"],
				{ from: "user" },
			),
		);

		// Assert
		expect(result).toMatchObject({
			exitCode: 0,
			body: {
				status: "context_only",
				code: "delegated_brief_context_only",
				evaluated: false,
				batchId: 41,
				scenarioId: "simple-batch-shape",
			},
		});
		expect(result.body).not.toHaveProperty("error");
	});
});

describe("memory context-only extraction benchmark", () => {
	it("skips every context-only benchmark iteration without counting an evaluation", async () => {
		// Arrange
		coreMocks.getExtractionBenchmarkProfile.mockReturnValue(contextOnlyBenchmark());
		coreMocks.replayBatchExtraction.mockImplementation(async (_db, _observer, options) => {
			throw new ContextOnlyReplayError(options.batchId);
		});

		// Act
		const result = await captureJson(() =>
			command("extraction-benchmark").parseAsync(
				["--benchmark", "context-only-fixture", "--json"],
				{ from: "user" },
			),
		);

		// Assert
		expect(coreMocks.replayBatchExtraction).toHaveBeenCalledTimes(2);
		expect(coreMocks.replayBatchExtraction.mock.calls.map((call) => call[2].batchId)).toEqual([
			41, 42,
		]);
		expect(result.body).toMatchObject({
			runs: [],
			summary: {
				scheduledTotal: 2,
				contextOnlySkipped: 2,
				contextOnlySkips: [
					{ batchId: 41, iteration: 1, evaluated: false },
					{ batchId: 42, iteration: 1, evaluated: false },
				],
				total: 0,
				shapeQualityPasses: 0,
				shapeQualityFails: 0,
			},
		});
	});
});
