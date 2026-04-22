import type { Database as SqliteDatabase } from "better-sqlite3";
import { connect, resolveDbPath } from "./db.js";
import { applyMemoryDedupKeyUpdates, planMemoryDedupKeys } from "./maintenance.js";
import {
	completeMaintenanceJob,
	failMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";

export const DEDUP_KEY_BACKFILL_JOB = "memory_dedup_key_backfill";

type DedupKeyBackfillMetadata = {
	total_backfillable?: number;
	processed_updates?: number;
	remaining_backfillable?: number;
	skipped_rows?: number;
	checked_rows?: number;
	last_batch_updated?: number;
	last_cursor_id?: number;
};

export interface DedupKeyBackfillRunnerOptions {
	batchSize?: number;
	intervalMs?: number;
	dbPath?: string;
	signal?: AbortSignal;
}

export function hasPendingDedupKeyBackfill(db: SqliteDatabase): boolean {
	return planMemoryDedupKeys(db, { updateLimit: 1 }).backfillable > 0;
}

function getExistingMetadata(db: SqliteDatabase): DedupKeyBackfillMetadata {
	return (getMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB)?.metadata ??
		{}) as DedupKeyBackfillMetadata;
}

export async function runDedupKeyBackfillPass(
	db: SqliteDatabase,
	options: { batchSize?: number } = {},
): Promise<boolean> {
	const existingJob = getMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB);
	const existingMetadata = getExistingMetadata(db);
	const batchSize = Math.max(1, options.batchSize ?? 250);
	const lastCursorId = Number(existingMetadata.last_cursor_id ?? 0);
	const plan = planMemoryDedupKeys(db, {
		rowLimit: batchSize,
		updateLimit: batchSize,
		afterId: lastCursorId,
	});

	if (plan.checked <= 0) {
		if (existingJob && existingJob.status !== "completed") {
			const processedUpdates = Number(existingMetadata.processed_updates ?? 0);
			completeMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB, {
				message:
					Number(existingMetadata.skipped_rows ?? 0) > 0
						? `No backfillable dedup keys remaining (${Number(existingMetadata.skipped_rows ?? 0)} skipped)`
						: "Dedup-key backfill complete",
				progressCurrent: processedUpdates,
				progressTotal: Number(existingMetadata.total_backfillable ?? processedUpdates),
				metadata: {
					...existingMetadata,
					remaining_backfillable: 0,
					checked_rows: 0,
					last_batch_updated: 0,
					last_cursor_id: lastCursorId,
				},
			});
		}
		return false;
	}

	const processedBefore = Number(existingMetadata.processed_updates ?? 0);
	let progressTotal = Number(existingMetadata.total_backfillable ?? 0);
	const processedAfter = processedBefore + plan.updates.length;
	const cumulativeSkipped = Number(existingMetadata.skipped_rows ?? 0) + plan.skipped;
	const reachedEnd = plan.exhausted;
	const remainingWork = !reachedEnd;

	if (!existingJob || existingJob.status === "completed" || existingJob.status === "failed") {
		const totalPlan = planMemoryDedupKeys(db, { updateLimit: 1 });
		const initialTotal = totalPlan.backfillable;
		startMaintenanceJob(db, {
			kind: DEDUP_KEY_BACKFILL_JOB,
			title: "Backfilling dedup keys",
			message: `Backfilling ${initialTotal} legacy memories with dedup keys`,
			progressTotal: initialTotal,
			metadata: {
				total_backfillable: initialTotal,
				processed_updates: processedBefore,
				remaining_backfillable: initialTotal,
				skipped_rows: 0,
				checked_rows: plan.checked,
				last_batch_updated: 0,
				last_cursor_id: 0,
			},
		});
		progressTotal = initialTotal;
	}

	applyMemoryDedupKeyUpdates(db, plan.updates);

	if (!remainingWork) {
		const finalProgressTotal = Number(
			getExistingMetadata(db).total_backfillable ?? progressTotal ?? processedAfter,
		);
		completeMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB, {
			message:
				cumulativeSkipped > 0
					? `Dedup-key backfill complete (${cumulativeSkipped} skipped)`
					: "Dedup-key backfill complete",
			progressCurrent: processedAfter,
			progressTotal: finalProgressTotal,
			metadata: {
				total_backfillable: finalProgressTotal,
				processed_updates: processedAfter,
				remaining_backfillable: 0,
				skipped_rows: cumulativeSkipped,
				checked_rows: plan.checked,
				last_batch_updated: plan.updates.length,
				last_cursor_id: plan.lastScannedId,
			},
		});
		return false;
	}

	updateMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB, {
		message: `Backfilled ${processedAfter} of ${progressTotal} legacy dedup keys`,
		progressCurrent: processedAfter,
		progressTotal,
		metadata: {
			total_backfillable: progressTotal,
			processed_updates: processedAfter,
			remaining_backfillable: Math.max(progressTotal - processedAfter, 0),
			skipped_rows: cumulativeSkipped,
			checked_rows: plan.checked,
			last_batch_updated: plan.updates.length,
			last_cursor_id: plan.lastScannedId,
		},
	});
	return true;
}

export class DedupKeyBackfillRunner {
	private readonly dbPath: string;
	private readonly signal?: AbortSignal;
	private readonly batchSize: number;
	private readonly intervalMs: number;
	private active = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private currentRun: Promise<void> | null = null;

	constructor(options: DedupKeyBackfillRunnerOptions = {}) {
		this.dbPath = resolveDbPath(options.dbPath);
		this.signal = options.signal;
		this.batchSize = Math.max(1, options.batchSize ?? 250);
		this.intervalMs = Math.max(1000, options.intervalMs ?? 5000);
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.schedule(100);
	}

	async stop(): Promise<void> {
		this.active = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.currentRun) await this.currentRun;
	}

	private schedule(delayMs: number): void {
		if (!this.active || this.signal?.aborted) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.currentRun = this.runOnce()
				.catch((err) => {
					console.error("Dedup-key backfill runner tick failed:", err);
				})
				.finally(() => {
					this.currentRun = null;
					this.schedule(this.intervalMs);
				});
		}, delayMs);
		if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
	}

	private async runOnce(): Promise<void> {
		if (!this.active || this.signal?.aborted) return;
		let db: SqliteDatabase | null = null;
		try {
			db = connect(this.dbPath) as SqliteDatabase;
			const hasMoreWork = await runDedupKeyBackfillPass(db, { batchSize: this.batchSize });
			if (!hasMoreWork) {
				this.active = false;
			}
		} catch (error) {
			if (db) {
				failMaintenanceJob(
					db,
					DEDUP_KEY_BACKFILL_JOB,
					error instanceof Error ? error.message : String(error),
				);
			}
			console.warn("Dedup-key backfill runner failed", error);
		} finally {
			db?.close();
		}
	}
}
