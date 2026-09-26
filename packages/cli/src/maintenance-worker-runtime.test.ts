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

	it("advances after the backfill completes even when its pending predicate stays true", async () => {
		const logger: MaintenanceWorkerLogger = { step: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const runner = {
			start: vi.fn(() => {
				startMaintenanceJob(db, { kind: "test_backfill", title: "Test", status: "running" });
				// Completes with skipped rows, so the predicate keeps reporting work.
				updateMaintenanceJob(db, "test_backfill", { status: "completed" });
			}),
			stop: vi.fn(async () => {}),
		};
		const isPending = vi.fn(() => true);
		const next = { start: vi.fn(), stop: vi.fn(async () => {}) };
		const coordinator = createSequentialBackfillCoordinator(
			{ db } as never,
			[
				{ name: "Test", kind: "test_backfill", isPending, createRunner: () => runner },
				{ name: "Next", kind: "next_backfill", isPending: () => true, createRunner: () => next },
			],
			{ logger },
		);

		coordinator.start();
		await vi.advanceTimersByTimeAsync(1000);
		const checksAfterCompletion = isPending.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);

		expect(runner.stop).toHaveBeenCalledTimes(1);
		expect(next.start).toHaveBeenCalledTimes(1);
		expect(logger.step).toHaveBeenCalledWith("Test backfill complete");
		expect(isPending.mock.calls.length).toBe(checksAfterCompletion);
		await coordinator.stop();
	});

	it("does not treat a completed row from an earlier run as this run finishing", async () => {
		const logger: MaintenanceWorkerLogger = { step: vi.fn(), warn: vi.fn(), error: vi.fn() };
		startMaintenanceJob(db, { kind: "test_backfill", title: "Test", status: "running" });
		updateMaintenanceJob(db, "test_backfill", { status: "completed" });
		db.prepare("UPDATE maintenance_jobs SET updated_at = ?, finished_at = ? WHERE kind = ?").run(
			"2026-01-01T00:00:00.000Z",
			"2026-01-01T00:00:00.000Z",
			"test_backfill",
		);
		const runner = { start: vi.fn(), stop: vi.fn(async () => {}) };
		const coordinator = createSequentialBackfillCoordinator(
			{ db } as never,
			[{ name: "Test", kind: "test_backfill", isPending: () => true, createRunner: () => runner }],
			{ logger },
		);

		coordinator.start();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(runner.stop).not.toHaveBeenCalled();
		await coordinator.stop();
	});

	it("constructs vector migration with bounded batches and the default idle cadence", async () => {
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
		const configuredIdleInterval = (vectorRunner as unknown as { idleIntervalMs: number } | null)
			?.idleIntervalMs;
		expect(configuredBatchSize).toBe(10);
		expect(configuredIdleInterval).toBeGreaterThanOrEqual(60_000);
	});
});
