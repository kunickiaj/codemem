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
import { createExtractionDiagnosticsCommand } from "./memory.js";

function command(name: string) {
	const canonical = name.replace("extraction-", "");
	const selected = createExtractionDiagnosticsCommand().commands.find(
		(candidate) => candidate.name() === canonical,
	);
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

function twoBatchBenchmark() {
	const batch = (batchId: number) => ({
		batchId,
		sessionId: batchId,
		label: `Batch ${batchId}`,
		purpose: "shape_quality",
		complexity: "simple",
		expectedTier: "simple",
		expectedSummaryDisposition: "required",
	});
	return {
		id: "call-failure-fixture",
		title: "Call failure fixture",
		description: "Fixture with two batches",
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

describe("extraction benchmark call failures", () => {
	it("records a failed observer call, finishes the other batches and exits non-zero", async () => {
		// Arrange: the first batch's call fails; the second still runs.
		coreMocks.getExtractionBenchmarkProfile.mockReturnValue(twoBatchBenchmark());
		coreMocks.replayBatchExtraction.mockImplementation(async (_db, _observer, options) => {
			if (options.batchId === 41) throw new Error("observer request timed out after 120000ms");
			throw new ContextOnlyReplayError(options.batchId);
		});

		// Act
		const result = await captureJson(() =>
			command("extraction-benchmark").parseAsync(
				["--benchmark", "call-failure-fixture", "--json"],
				{ from: "user" },
			),
		);

		// Assert
		expect(coreMocks.replayBatchExtraction.mock.calls.map((call) => call[2].batchId)).toEqual([
			41, 42,
		]);
		expect(result.exitCode).toBe(1);
		expect(result.body).not.toHaveProperty("error");
		expect(result.body).toMatchObject({
			summary: {
				scheduledTotal: 2,
				contextOnlySkipped: 1,
				callFailed: 1,
				callFailures: [
					{
						batchId: 41,
						iteration: 1,
						status: "call_failure",
						error: "Error",
						message: "observer request timed out after 120000ms",
					},
				],
			},
		});
	});

	it("exits zero when every observer call completes", async () => {
		// Arrange
		coreMocks.getExtractionBenchmarkProfile.mockReturnValue(twoBatchBenchmark());
		coreMocks.replayBatchExtraction.mockImplementation(async (_db, _observer, options) => {
			throw new ContextOnlyReplayError(options.batchId);
		});

		// Act
		const result = await captureJson(() =>
			command("extraction-benchmark").parseAsync(
				["--benchmark", "call-failure-fixture", "--json"],
				{ from: "user" },
			),
		);

		// Assert
		expect(result.exitCode).toBeUndefined();
		expect(result.body).toMatchObject({ summary: { callFailed: 0, callFailures: [] } });
	});
});
