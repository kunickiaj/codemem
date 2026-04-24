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
import type { ReplicationVectorWork } from "./sync-replication.js";
import { backfillVectors, pruneStaleCurrentModelVectors } from "./vectors.js";

export const VECTOR_MODEL_MIGRATION_JOB = "vector_model_migration";
const SYNC_BOOTSTRAP_TRIGGER = "sync_bootstrap";
const SYNC_INCREMENTAL_TRIGGER = "sync_incremental";

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
	pending_upsert_memory_ids?: number[];
	pending_delete_memory_ids?: number[];
};

function uniquePositiveIds(memoryIds: number[]): number[] {
	return [
		...new Set(memoryIds.filter((memoryId) => Number.isInteger(memoryId) && memoryId > 0)),
	].sort((a, b) => a - b);
}

function metadataMemoryIds(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	return uniquePositiveIds(value.filter((item): item is number => typeof item === "number"));
}

function mergeQueuedSyncMemoryIds(
	metadata: MigrationMetadata,
	work: ReplicationVectorWork,
): Pick<MigrationMetadata, "pending_upsert_memory_ids" | "pending_delete_memory_ids"> {
	const pendingUpsertMemoryIds = new Set(metadataMemoryIds(metadata.pending_upsert_memory_ids));
	const pendingDeleteMemoryIds = new Set(metadataMemoryIds(metadata.pending_delete_memory_ids));

	for (const memoryId of uniquePositiveIds(work.deleteMemoryIds)) {
		pendingUpsertMemoryIds.delete(memoryId);
		pendingDeleteMemoryIds.add(memoryId);
	}
	for (const memoryId of uniquePositiveIds(work.upsertMemoryIds)) {
		pendingDeleteMemoryIds.delete(memoryId);
		pendingUpsertMemoryIds.add(memoryId);
	}

	return {
		pending_upsert_memory_ids: [...pendingUpsertMemoryIds],
		pending_delete_memory_ids: [...pendingDeleteMemoryIds],
	};
}

function deleteVectorsForMemoryIds(db: SqliteDatabase, memoryIds: number[]): void {
	if (memoryIds.length === 0) return;
	const placeholders = memoryIds.map(() => "?").join(", ");
	db.prepare(`DELETE FROM memory_vectors WHERE memory_id IN (${placeholders})`).run(...memoryIds);
}

function sameQueuedSyncMemoryIds(a: MigrationMetadata, b: MigrationMetadata): boolean {
	return (
		JSON.stringify(metadataMemoryIds(a.pending_upsert_memory_ids)) ===
			JSON.stringify(metadataMemoryIds(b.pending_upsert_memory_ids)) &&
		JSON.stringify(metadataMemoryIds(a.pending_delete_memory_ids)) ===
			JSON.stringify(metadataMemoryIds(b.pending_delete_memory_ids))
	);
}

export function queueVectorBackfillForIncrementalSync(
	db: SqliteDatabase,
	work: ReplicationVectorWork,
): void {
	const queuedWork = mergeQueuedSyncMemoryIds({}, work);
	if (
		(queuedWork.pending_upsert_memory_ids?.length ?? 0) === 0 &&
		(queuedWork.pending_delete_memory_ids?.length ?? 0) === 0
	) {
		return;
	}

	const existingJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
	const existingMetadata =
		existingJob && existingJob.status !== "completed" && existingJob.status !== "cancelled"
			? ((existingJob.metadata ?? {}) as MigrationMetadata)
			: {};
	const metadata: MigrationMetadata = {
		...existingMetadata,
		...mergeQueuedSyncMemoryIds(existingMetadata, work),
		trigger: existingMetadata.trigger ?? SYNC_INCREMENTAL_TRIGGER,
	};
	const pendingWorkCount =
		metadataMemoryIds(metadata.pending_upsert_memory_ids).length +
		metadataMemoryIds(metadata.pending_delete_memory_ids).length;

	if (!existingJob || existingJob.status === "completed" || existingJob.status === "cancelled") {
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			status: "pending",
			message: "Queued vector catch-up for incremental sync data",
			progressTotal: null,
			metadata,
		});
		return;
	}

	updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
		status: "pending",
		message: "Queued vector catch-up for incremental sync data",
		progressCurrent:
			existingJob.status === "failed"
				? 0
				: Math.min(existingJob.progress.current, pendingWorkCount),
		progressTotal: existingJob.progress.total,
		metadata,
	});
}

async function runQueuedSyncVectorWork(
	db: SqliteDatabase,
	job: NonNullable<ReturnType<typeof getMaintenanceJob>>,
	targetModel: string,
	batchSize: number,
): Promise<{ completed: boolean; metadata: MigrationMetadata }> {
	const metadata = (job.metadata ?? {}) as MigrationMetadata;
	const pendingDeleteMemoryIds = metadataMemoryIds(metadata.pending_delete_memory_ids);
	const pendingUpsertMemoryIds = metadataMemoryIds(metadata.pending_upsert_memory_ids);
	if (pendingDeleteMemoryIds.length === 0 && pendingUpsertMemoryIds.length === 0) {
		return { completed: false, metadata };
	}

	if (pendingDeleteMemoryIds.length > 0) {
		deleteVectorsForMemoryIds(db, pendingDeleteMemoryIds);
	}
	const batchUpsertMemoryIds = pendingUpsertMemoryIds.slice(0, batchSize);
	if (batchUpsertMemoryIds.length > 0) {
		await backfillVectors(db, { memoryIds: batchUpsertMemoryIds });
		pruneStaleCurrentModelVectors(db, batchUpsertMemoryIds, targetModel);
	}

	const drainedMetadata: MigrationMetadata = {
		...metadata,
		pending_delete_memory_ids: [],
		pending_upsert_memory_ids: pendingUpsertMemoryIds.slice(batchUpsertMemoryIds.length),
	};
	const latestJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
	const latestMetadata = (latestJob?.metadata ?? {}) as MigrationMetadata;
	const nextMetadata = sameQueuedSyncMemoryIds(latestMetadata, metadata)
		? drainedMetadata
		: {
				...latestMetadata,
				...mergeQueuedSyncMemoryIds(latestMetadata, {
					upsertMemoryIds: metadataMemoryIds(drainedMetadata.pending_upsert_memory_ids),
					deleteMemoryIds: metadataMemoryIds(drainedMetadata.pending_delete_memory_ids),
				}),
			};
	const remainingWorkCount =
		metadataMemoryIds(nextMetadata.pending_delete_memory_ids).length +
		metadataMemoryIds(nextMetadata.pending_upsert_memory_ids).length;
	const incrementalOnly =
		(metadata.trigger ?? SYNC_INCREMENTAL_TRIGGER) === SYNC_INCREMENTAL_TRIGGER &&
		!metadata.source_model &&
		!metadata.last_cursor_id &&
		metadata.embeddable_total == null;

	if (remainingWorkCount === 0 && incrementalOnly) {
		completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			message: "Finished vector catch-up for incremental sync data",
			progressCurrent: 0,
			progressTotal: null,
			metadata: nextMetadata,
		});
		return { completed: true, metadata: nextMetadata };
	}

	updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
		status: remainingWorkCount > 0 ? "running" : job.status,
		message:
			remainingWorkCount > 0
				? `Queued vector catch-up has ${remainingWorkCount} memory change(s) remaining`
				: job.message,
		progressCurrent: 0,
		progressTotal: null,
		metadata: nextMetadata,
	});
	return { completed: false, metadata: nextMetadata };
}

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
	const row = db
		.prepare(
			`SELECT COUNT(*) AS c FROM memory_items
			 WHERE active = 1
			   AND TRIM(COALESCE(title, '') || COALESCE(body_text, '')) != ''`,
		)
		.get() as { c?: number } | undefined;
	return Number(row?.c ?? 0);
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
	let existingJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
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
	const effectiveBatchSize = Math.max(1, options.batchSize ?? 50);
	const existingMetadata = (existingJob?.metadata ?? {}) as MigrationMetadata;
	const queuedSyncWorkCount =
		metadataMemoryIds(existingMetadata.pending_upsert_memory_ids).length +
		metadataMemoryIds(existingMetadata.pending_delete_memory_ids).length;
	if (
		existingJob?.status === "completed" &&
		existingMetadata.target_model === targetModel &&
		queuedSyncWorkCount === 0
	) {
		return;
	}
	if (existingJob) {
		const queuedSyncWork = await runQueuedSyncVectorWork(
			db,
			existingJob,
			targetModel,
			effectiveBatchSize,
		);
		if (queuedSyncWork.completed) {
			return;
		}
		const queuedSyncRemainingWork =
			metadataMemoryIds(queuedSyncWork.metadata.pending_delete_memory_ids).length +
			metadataMemoryIds(queuedSyncWork.metadata.pending_upsert_memory_ids).length;
		if (
			(queuedSyncWork.metadata.trigger ?? SYNC_INCREMENTAL_TRIGGER) === SYNC_INCREMENTAL_TRIGGER &&
			queuedSyncRemainingWork > 0
		) {
			return;
		}
		existingJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
	}
	const sourceModel = detectSourceModel(db, targetModel);
	const hasInFlightJob =
		existingJob?.status === "running" ||
		existingJob?.status === "pending" ||
		existingJob?.status === "failed";
	// codemem-ad6m: when a sync-triggered job (bootstrap or incremental)
	// drains its queued work, status can remain 'running' without the
	// batch loop having anything to do. The previous logic fell through
	// and re-embedded the entire corpus. Fast-exit for that specific
	// case — but ONLY for sync-triggered jobs, since the `uncovered`
	// SQL counts memories that have ANY target-model row (even a single
	// chunk of a multi-chunk memory). Full-migration jobs (no trigger,
	// or an older full-migration trigger) must keep falling through to
	// the batch loop so backfillVectors can detect partial chunk
	// coverage and repair it.
	const existingJobTrigger = (existingJob?.metadata as MigrationMetadata | undefined)?.trigger;
	const fromSyncTrigger =
		existingJobTrigger === SYNC_INCREMENTAL_TRIGGER ||
		existingJobTrigger === SYNC_BOOTSTRAP_TRIGGER;
	if (!sourceModel && fromSyncTrigger && hasInFlightJob) {
		const uncovered = db
			.prepare(
				`SELECT COUNT(*) AS c FROM memory_items
				 WHERE active = 1
				   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_vectors WHERE model = ?)`,
			)
			.get(targetModel) as { c?: number } | undefined;
		if (Number(uncovered?.c ?? 0) <= 0) {
			const jobMeta = (existingJob?.metadata ?? {}) as MigrationMetadata;
			const indexedTotal = countEmbeddableActiveMemories(db);
			completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				message: "Finished re-indexing memories",
				progressCurrent: indexedTotal,
				progressTotal: indexedTotal,
				metadata: {
					...jobMeta,
					source_model: null,
					target_model: targetModel,
					processed_embeddable: indexedTotal,
					embeddable_total: indexedTotal,
				},
			});
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
