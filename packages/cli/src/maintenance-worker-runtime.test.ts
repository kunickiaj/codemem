import {
	connect,
	type Database,
	startMaintenanceJob,
	updateMaintenanceJob,
	VectorModelMigrationRunner,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSequentialBackfillCoordinator,
	type MaintenanceWorkerLogger,
	startMaintenanceWorkerRuntime,
} from "./maintenance-worker-runtime.js";

describe("maintenance worker runtime", () => {
	let db: Database;

	beforeEach(() => {
		vi.useFakeTimers();
		db = connect(":memory:");
	});

	afterEach(() => {
		db.close();
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("stops a failed active backfill even when its pending predicate remains true", async () => {
		const logger: MaintenanceWorkerLogger = {
			step: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};
		const runner = {
			start: vi.fn(() => {
				updateMaintenanceJob(db, "test_backfill", { status: "failed" });
			}),
			stop: vi.fn(async () => {}),
		};
		startMaintenanceJob(db, {
			kind: "test_backfill",
			title: "Test backfill",
			status: "running",
		});

		const coordinator = createSequentialBackfillCoordinator(
			{ db } as never,
			[
				{
					name: "Test",
					kind: "test_backfill",
					isPending: () => true,
					createRunner: () => runner,
				},
			],
			{ logger },
		);

		coordinator.start();
		await vi.advanceTimersByTimeAsync(1000);

		expect(runner.start).toHaveBeenCalledTimes(1);
		expect(runner.stop).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			"Test backfill failed and will be retried on a later startup",
		);
	});

	it("constructs vector migration with the smaller worker-specific batch size", async () => {
		// Arrange
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
		let vectorRunner: VectorModelMigrationRunner | null = null;
		const logger: MaintenanceWorkerLogger = {
			step: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};
		vi.spyOn(VectorModelMigrationRunner.prototype, "start").mockImplementation(function (
			this: VectorModelMigrationRunner,
		) {
			vectorRunner = this;
		});

		// Act
		const runtime = startMaintenanceWorkerRuntime({ dbPath: ":memory:", logger });
		await runtime.stop();

		// Assert
		const configuredBatchSize = (vectorRunner as unknown as { batchSize: number } | null)
			?.batchSize;
		expect(configuredBatchSize).toBe(10);
	});
});
