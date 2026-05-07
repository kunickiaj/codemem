import { connect, type Database, startMaintenanceJob, updateMaintenanceJob } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSequentialBackfillCoordinator,
	type MaintenanceWorkerLogger,
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
});
