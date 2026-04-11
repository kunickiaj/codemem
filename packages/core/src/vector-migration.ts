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
import { backfillVectors } from "./vectors.js";

export const VECTOR_MODEL_MIGRATION_JOB = "vector_model_migration";
const SYNC_BOOTSTRAP_TRIGGER = "sync_bootstrap";

export interface VectorModelMigrationOptions {
	batchSize?: number;
	intervalMs?: number;
	dbPath?: string;
	signal?: AbortSignal;
}

type MemoryRow = { id: number; title: string | null; body_text: string | null };

type MigrationMetadata = {
	source_model?: string | null;
	target_model?: string | null;
	last_cursor_id?: number;
	processed_embeddable?: number;
	embeddable_total?: number;
	removed_stale_rows?: number;
	trigger?: string | null;
};

export function queueVectorBackfillForSyncBootstrap(
	db: SqliteDatabase,
	options: { embeddableTotal?: number | null } = {},
): void {
	const embeddableTotal =
		typeof options.embeddableTotal === "number" && options.embeddableTotal >= 0
			? options.embeddableTotal
			: null;
	const metadata: MigrationMetadata = {
		last_cursor_id: 0,
		processed_embeddable: 0,
		trigger: SYNC_BOOTSTRAP_TRIGGER,
	};
	if (embeddableTotal != null) {
		metadata.embeddable_total = embeddableTotal;
	}
	startMaintenanceJob(db, {
		kind: VECTOR_MODEL_MIGRATION_JOB,
		title: "Re-indexing memories",
		status: "pending",
		message: "Queued vector catch-up for synced bootstrap data",
		progressTotal: embeddableTotal,
		metadata,
	});
}

function vectorModels(db: SqliteDatabase): Array<{ model: string; rows: number }> {
	return db
		.prepare(
			"SELECT model, COUNT(*) AS rows FROM memory_vectors GROUP BY model ORDER BY rows DESC, model ASC",
		)
		.all() as Array<{ model: string; rows: number }>;
}

function countEmbeddableActiveMemories(db: SqliteDatabase): number {
	return db
		.prepare("SELECT id, title, body_text FROM memory_items WHERE active = 1")
		.all()
		.filter((row) => isEmbeddableMemory(row as MemoryRow)).length;
}

function selectNextMigrationBatch(
	db: SqliteDatabase,
	afterId: number,
	batchSize: number,
): MemoryRow[] {
	return db
		.prepare(
			`SELECT id, title, body_text
			 FROM memory_items
			 WHERE active = 1 AND id > ?
			 ORDER BY id ASC
			 LIMIT ?`,
		)
		.all(afterId, batchSize) as MemoryRow[];
}

function isEmbeddableMemory(row: MemoryRow): boolean {
	return (
		`${row.title ?? ""}
${row.body_text ?? ""}`.trim().length > 0
	);
}

function nextMigrationMetadata(
	job: ReturnType<typeof getMaintenanceJob>,
	sourceModel: string | null,
	targetModel: string,
	embeddableTotal: number,
): MigrationMetadata {
	const metadata = (job?.metadata ?? {}) as MigrationMetadata;
	return {
		source_model: sourceModel ?? metadata.source_model ?? null,
		target_model: targetModel,
		last_cursor_id: Number(metadata.last_cursor_id ?? 0),
		processed_embeddable: Number(metadata.processed_embeddable ?? 0),
		embeddable_total: Number(metadata.embeddable_total ?? embeddableTotal),
	};
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
	const existingJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
	const isInFlightJob = existingJob?.status === "running" || existingJob?.status === "pending";
	if (isEmbeddingDisabled()) {
		if (isInFlightJob) {
			failMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, "Embeddings are disabled", {
				message: "Vector re-indexing is waiting for embeddings to be enabled",
			});
		}
		return;
	}
	const client = await getEmbeddingClient();
	if (!client) {
		if (isInFlightJob) {
			failMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, "Embedding client unavailable", {
				message: "Vector re-indexing is waiting for the embedding client",
			});
		}
		return;
	}
	const targetModel = client.model;
	const sourceModel = detectSourceModel(db, targetModel);
	const hasInFlightJob =
		existingJob?.status === "running" ||
		existingJob?.status === "pending" ||
		existingJob?.status === "failed";
	if (!sourceModel && !hasInFlightJob) {
		// No stale model and no in-flight job — check if any active memories lack target vectors.
		const uncovered = db
			.prepare(
				`SELECT COUNT(*) AS c FROM memory_items
				 WHERE active = 1
				   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_vectors WHERE model = ?)`,
			)
			.get(targetModel) as { c?: number } | undefined;
		if (Number(uncovered?.c ?? 0) <= 0) {
			return;
		}
	}
	// Use cached embeddable_total from an in-progress job to avoid a full table scan per tick.
	// Only recompute when starting a fresh migration or when the job is terminal.
	const existingMeta = (existingJob?.metadata ?? {}) as MigrationMetadata;
	const isResumingJob = existingJob?.status === "running" || existingJob?.status === "pending";
	const embeddableTotal =
		isResumingJob && existingMeta.embeddable_total
			? Number(existingMeta.embeddable_total)
			: countEmbeddableActiveMemories(db);
	if (embeddableTotal <= 0 && hasInFlightJob && !sourceModel) {
		completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			message: "No embeddable memories to re-index",
			progressCurrent: 0,
			progressTotal: 0,
			metadata: {
				...existingMeta,
				last_cursor_id: 0,
				processed_embeddable: 0,
				embeddable_total: 0,
			},
		});
		return;
	}
	if (sourceModel && embeddableTotal <= 0) {
		const removed = cleanupStaleModels(db, targetModel);
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			message:
				removed > 0 ? `Removed ${removed} stale vector rows` : "No embeddable memories to re-index",
			progressTotal: 0,
			metadata: {
				source_model: sourceModel,
				target_model: targetModel,
				removed_stale_rows: removed,
			},
		});
		completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			progressCurrent: 0,
			progressTotal: 0,
			metadata: {
				source_model: sourceModel,
				target_model: targetModel,
				removed_stale_rows: removed,
			},
		});
		return;
	}

	const job = existingJob;
	const metadata = nextMigrationMetadata(job, sourceModel, targetModel, embeddableTotal);
	if (!job || job.status === "completed" || job.status === "failed") {
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			message: sourceModel
				? `Building ${targetModel} vectors while semantic search falls back to FTS-only`
				: `Building ${targetModel} vectors`,
			progressTotal: embeddableTotal,
			metadata,
		});
	}

	const effectiveBatchSize = Math.max(1, options.batchSize ?? 50);
	const batchRows = selectNextMigrationBatch(db, metadata.last_cursor_id ?? 0, effectiveBatchSize);
	const batchIds = batchRows.map((row) => row.id);
	const embeddableInBatch = batchRows.filter(isEmbeddableMemory).length;
	const lastCursorId = batchRows.at(-1)?.id ?? metadata.last_cursor_id ?? 0;
	const processedEmbeddable = Math.min(
		embeddableTotal,
		(metadata.processed_embeddable ?? 0) + embeddableInBatch,
	);

	if (batchIds.length > 0) {
		await backfillVectors(db, { memoryIds: batchIds });
		if (batchRows.length < effectiveBatchSize) {
			db.transaction(() => {
				const removed = cleanupStaleModels(db, targetModel);
				completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
					message:
						removed > 0
							? `Finished re-indexing and removed ${removed} stale vector rows`
							: "Finished re-indexing memories",
					progressCurrent: processedEmbeddable,
					progressTotal: embeddableTotal,
					metadata: {
						...metadata,
						last_cursor_id: lastCursorId,
						processed_embeddable: processedEmbeddable,
						embeddable_total: embeddableTotal,
						removed_stale_rows: removed,
					},
				});
			})();
			return;
		}
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			message: `Re-indexed ${processedEmbeddable} of ${embeddableTotal} memories`,
			progressCurrent: processedEmbeddable,
			progressTotal: embeddableTotal,
			metadata: {
				...metadata,
				last_cursor_id: lastCursorId,
				processed_embeddable: processedEmbeddable,
				embeddable_total: embeddableTotal,
			},
		});
		return;
	}

	if (metadata.last_cursor_id && metadata.last_cursor_id > 0) {
		db.transaction(() => {
			const removed = cleanupStaleModels(db, targetModel);
			completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				message:
					removed > 0
						? `Finished re-indexing and removed ${removed} stale vector rows`
						: "Finished re-indexing memories",
				progressCurrent: embeddableTotal,
				progressTotal: embeddableTotal,
				metadata: {
					...metadata,
					removed_stale_rows: removed,
					processed_embeddable: embeddableTotal,
					embeddable_total: embeddableTotal,
				},
			});
		})();
	}
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
				.catch((err) => {
					console.error("Vector migration runner tick failed:", err);
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
