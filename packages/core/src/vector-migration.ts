import type { Database as SqliteDatabase } from "better-sqlite3";
import { connect, isEmbeddingDisabled, loadSqliteVec, resolveDbPath } from "./db.js";
import { getEmbeddingClient } from "./embeddings.js";
import {
	completeMaintenanceJob,
	failMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import { backfillVectors, memoryHasCompleteVectorCoverage } from "./vectors.js";

export const VECTOR_MODEL_MIGRATION_JOB = "vector_model_migration";

export interface VectorModelMigrationOptions {
	batchSize?: number;
	intervalMs?: number;
	dbPath?: string;
	signal?: AbortSignal;
}

function activeMemoryRows(
	db: SqliteDatabase,
): Array<{ id: number; title: string | null; body_text: string | null }> {
	return db
		.prepare(
			"SELECT id, title, body_text FROM memory_items WHERE active = 1 ORDER BY created_at ASC",
		)
		.all() as Array<{ id: number; title: string | null; body_text: string | null }>;
}

function vectorModels(db: SqliteDatabase): Array<{ model: string; rows: number }> {
	return db
		.prepare(
			"SELECT model, COUNT(*) AS rows FROM memory_vectors GROUP BY model ORDER BY rows DESC, model ASC",
		)
		.all() as Array<{ model: string; rows: number }>;
}

function modelCoverage(
	db: SqliteDatabase,
	targetModel: string,
	batchSize: number,
): { total: number; covered: number; nextBatchIds: number[] } {
	const rows = activeMemoryRows(db);
	let covered = 0;
	const nextBatchIds: number[] = [];
	for (const row of rows) {
		const complete = memoryHasCompleteVectorCoverage(db, row, targetModel);
		if (complete) {
			covered++;
			continue;
		}
		if (nextBatchIds.length < batchSize) nextBatchIds.push(row.id);
	}
	return { total: rows.length, covered, nextBatchIds };
}

function cleanupStaleModels(db: SqliteDatabase, targetModel: string): number {
	const row = db
		.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model != ?")
		.get(targetModel) as { c?: number } | undefined;
	const count = Number(row?.c ?? 0);
	if (count > 0) {
		db.prepare("DELETE FROM memory_vectors WHERE model != ?").run(targetModel);
	}
	return count;
}

function detectSourceModel(db: SqliteDatabase, targetModel: string): string | null {
	const rows = vectorModels(db).filter((row) => row.model !== targetModel);
	return rows[0]?.model ?? null;
}

export async function runVectorMigrationPass(
	db: SqliteDatabase,
	options: { batchSize?: number } = {},
): Promise<void> {
	if (isEmbeddingDisabled()) return;
	const client = await getEmbeddingClient();
	if (!client) return;
	const targetModel = client.model;
	const coverage = modelCoverage(db, targetModel, Math.max(1, options.batchSize ?? 50));
	const total = coverage.total;
	if (total <= 0) return;

	const sourceModel = detectSourceModel(db, targetModel);
	if (!sourceModel && coverage.covered >= total) {
		return;
	}

	const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
	if (!job || job.status === "completed" || job.status === "failed") {
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			message: sourceModel
				? `Building ${targetModel} vectors while semantic search falls back to FTS-only`
				: `Building ${targetModel} vectors`,
			progressTotal: total,
			metadata: {
				source_model: sourceModel,
				target_model: targetModel,
			},
		});
	}

	const batchIds = coverage.nextBatchIds;
	if (batchIds.length > 0) {
		await backfillVectors(db, { memoryIds: batchIds });
	}

	const nextCoverage = modelCoverage(db, targetModel, Math.max(1, options.batchSize ?? 50));
	if (nextCoverage.covered >= total) {
		db.transaction(() => {
			const removed = cleanupStaleModels(db, targetModel);
			completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				message:
					removed > 0
						? `Finished re-indexing and removed ${removed} stale vector rows`
						: "Finished re-indexing memories",
				progressCurrent: total,
				progressTotal: total,
				metadata: {
					source_model: sourceModel,
					target_model: targetModel,
					removed_stale_rows: removed,
				},
			});
		})();
		return;
	}

	updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
		message: `Re-indexed ${nextCoverage.covered} of ${total} memories (semantic search uses FTS-only until complete)`,
		progressCurrent: nextCoverage.covered,
		progressTotal: total,
		metadata: {
			source_model: sourceModel,
			target_model: targetModel,
		},
	});
}

export class VectorModelMigrationRunner {
	private readonly dbPath: string;
	private readonly signal?: AbortSignal;
	private readonly batchSize: number;
	private readonly intervalMs: number;
	private active = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private currentRun: Promise<void> | null = null;

	constructor(options: VectorModelMigrationOptions = {}) {
		this.dbPath = resolveDbPath(options.dbPath);
		this.signal = options.signal;
		this.batchSize = Math.max(1, options.batchSize ?? 50);
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
				.catch(() => {})
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
			loadSqliteVec(db);
			await runVectorMigrationPass(db, { batchSize: this.batchSize });
		} catch (error) {
			if (db) {
				failMaintenanceJob(
					db,
					VECTOR_MODEL_MIGRATION_JOB,
					error instanceof Error ? error.message : String(error),
				);
			}
			console.warn("Vector migration runner failed", error);
		} finally {
			db?.close();
		}
	}
}
