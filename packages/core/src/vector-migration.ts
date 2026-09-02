import type { Database as SqliteDatabase } from "better-sqlite3";
import { connect, isEmbeddingDisabled, loadSqliteVec, resolveDbPath } from "./db.js";
import {
	DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL,
	type EmbeddingClient,
	getEmbeddingClient,
	resolveEmbeddingClientVectorIdentityLabel,
	tryResolveEmbeddingVectorIdentityLabel,
} from "./embeddings.js";
import {
	completeMaintenanceJob,
	failMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import type { ReplicationVectorWork } from "./sync-replication.js";
import {
	backfillVectors,
	countIncompleteActiveMemoryVectorCoverage,
	pruneObsoleteTargetModelVectors,
	pruneStaleCurrentModelVectors,
} from "./vectors.js";

export const VECTOR_MODEL_MIGRATION_JOB = "vector_model_migration";
const LEGACY_DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
const SYNC_BOOTSTRAP_TRIGGER = "sync_bootstrap";
const SYNC_INCREMENTAL_TRIGGER = "sync_incremental";

export interface VectorModelMigrationOptions {
	batchSize?: number;
	intervalMs?: number;
	idleIntervalMs?: number;
	dbPath?: string;
	signal?: AbortSignal;
}

// Runner uses this cadence after a tick that detected no work. A live
// migration or queued sync work switches back to intervalMs automatically.
const IDLE_INTERVAL_MS = 60_000;

// Module-level singleton so the queue writers can nudge the runner out of
// its long idle cadence the moment new incremental/bootstrap work lands.
// Assumes one active runner per process (the viewer serve loop), which
// matches the current deployment model.
let activeRunner: VectorModelMigrationRunner | null = null;

type MemoryRow = { id: number; title: string | null; body_text: string | null };

type MigrationMetadata = {
	source_model?: string | null;
	target_model?: string | null;
	requested_model?: string | null;
	requested_revision?: string | null;
	last_cursor_id?: number;
	processed_embeddable?: number;
	embeddable_total?: number;
	removed_stale_rows?: number;
	uncovered_target_memories?: number;
	cleanup_pending?: boolean;
	reconciliation_target_coverage_complete?: boolean;
	cutover_retry_count?: number;
	trigger?: string | null;
	pending_upsert_memory_ids?: number[];
	pending_delete_memory_ids?: number[];
	queue_revision?: number;
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

function sameQueuedSyncWork(a: MigrationMetadata, b: MigrationMetadata): boolean {
	return (
		Number(a.queue_revision ?? 0) === Number(b.queue_revision ?? 0) &&
		JSON.stringify(metadataMemoryIds(a.pending_upsert_memory_ids)) ===
			JSON.stringify(metadataMemoryIds(b.pending_upsert_memory_ids)) &&
		JSON.stringify(metadataMemoryIds(a.pending_delete_memory_ids)) ===
			JSON.stringify(metadataMemoryIds(b.pending_delete_memory_ids))
	);
}

export function wakeActiveVectorMigrationRunner(): void {
	activeRunner?.wake();
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
	const jobMetadata = (existingJob?.metadata ?? {}) as MigrationMetadata;
	let existingMetadata: MigrationMetadata = {};
	if (existingJob && existingJob.status !== "completed" && existingJob.status !== "cancelled") {
		existingMetadata = jobMetadata;
	} else if (jobMetadata.cleanup_pending) {
		existingMetadata = {
			cleanup_pending: true,
			target_model: jobMetadata.target_model,
			requested_model: jobMetadata.requested_model,
			requested_revision: jobMetadata.requested_revision,
			removed_stale_rows: jobMetadata.removed_stale_rows,
			queue_revision: jobMetadata.queue_revision,
		};
	}
	const metadata: MigrationMetadata = {
		...existingMetadata,
		...mergeQueuedSyncMemoryIds(existingMetadata, work),
		queue_revision: Number(existingMetadata.queue_revision ?? 0) + 1,
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
		wakeActiveVectorMigrationRunner();
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
	wakeActiveVectorMigrationRunner();
}

async function runQueuedSyncVectorWork(
	db: SqliteDatabase,
	job: NonNullable<ReturnType<typeof getMaintenanceJob>>,
	client: EmbeddingClient,
	targetModel: string,
	batchSize: number,
	signal?: AbortSignal,
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
	let prunedRows = 0;
	if (batchUpsertMemoryIds.length > 0) {
		await backfillVectors(db, { memoryIds: batchUpsertMemoryIds, signal, client });
		// If the abort fired mid-batch, backfillVectors may have only
		// processed a prefix. Skip the prune-and-drop bookkeeping so the
		// unprocessed IDs stay in pending_upsert_memory_ids for the next
		// tick to retry.
		if (signal?.aborted) {
			return { completed: false, metadata };
		}
		prunedRows = pruneStaleCurrentModelVectors(db, batchUpsertMemoryIds, targetModel);
	}

	const targetChanged = metadata.target_model != null && metadata.target_model !== targetModel;
	const retainedMetadata: MigrationMetadata = targetChanged
		? {
				trigger: metadata.trigger,
				pending_delete_memory_ids: metadata.pending_delete_memory_ids,
				pending_upsert_memory_ids: metadata.pending_upsert_memory_ids,
				source_model: null,
				last_cursor_id: 0,
				processed_embeddable: 0,
			}
		: metadata;
	const drainedMetadata: MigrationMetadata = {
		...retainedMetadata,
		target_model: targetModel,
		requested_model: client.model,
		requested_revision: client.identity?.requestedRevision ?? client.identity?.revision ?? null,
		removed_stale_rows: Number(metadata.removed_stale_rows ?? 0) + prunedRows,
		pending_delete_memory_ids: [],
		pending_upsert_memory_ids: pendingUpsertMemoryIds.slice(batchUpsertMemoryIds.length),
	};
	const latestJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
	const latestMetadata = (latestJob?.metadata ?? {}) as MigrationMetadata;
	const nextMetadata = sameQueuedSyncWork(latestMetadata, metadata)
		? drainedMetadata
		: {
				...drainedMetadata,
				...mergeQueuedSyncMemoryIds(latestMetadata, {
					upsertMemoryIds: metadataMemoryIds(drainedMetadata.pending_upsert_memory_ids),
					deleteMemoryIds: metadataMemoryIds(drainedMetadata.pending_delete_memory_ids),
				}),
				queue_revision: latestMetadata.queue_revision,
			};
	const remainingWorkCount =
		metadataMemoryIds(nextMetadata.pending_delete_memory_ids).length +
		metadataMemoryIds(nextMetadata.pending_upsert_memory_ids).length;
	const requiresLegacyRebuild =
		remainingWorkCount === 0 && detectSourceModel(db, targetModel) != null;
	const incrementalOnly =
		(nextMetadata.trigger ?? SYNC_INCREMENTAL_TRIGGER) === SYNC_INCREMENTAL_TRIGGER &&
		!nextMetadata.source_model &&
		!nextMetadata.last_cursor_id &&
		nextMetadata.embeddable_total == null &&
		!requiresLegacyRebuild;

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
	wakeActiveVectorMigrationRunner();
}

function vectorModels(db: SqliteDatabase): Array<{ model: string; rows: number }> {
	return db
		.prepare(
			"SELECT model, COUNT(*) AS rows FROM memory_vectors GROUP BY model ORDER BY rows DESC, model ASC",
		)
		.all() as Array<{ model: string; rows: number }>;
}

function hasSourceModelVectors(db: SqliteDatabase, targetModel: string): boolean {
	return Boolean(
		db.prepare("SELECT 1 FROM memory_vectors WHERE model != ? LIMIT 1").pluck().get(targetModel),
	);
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

function describeIncompleteTargetMemories(count: number): string {
	return `${count} ${count === 1 ? "memory" : "memories"}`;
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
	requestedModel: string,
	requestedRevision: string,
	embeddableTotal: number,
	options: {
		restartFromBeginning?: boolean;
		reconciliationTargetCoverageComplete?: boolean;
	} = {},
): MigrationMetadata {
	const metadata = (job?.metadata ?? {}) as MigrationMetadata;
	const pendingUpsertMemoryIds = metadataMemoryIds(metadata.pending_upsert_memory_ids);
	const pendingDeleteMemoryIds = metadataMemoryIds(metadata.pending_delete_memory_ids);
	const pending_upsert_memory_ids =
		pendingUpsertMemoryIds.length > 0 ? pendingUpsertMemoryIds : undefined;
	const pending_delete_memory_ids =
		pendingDeleteMemoryIds.length > 0 ? pendingDeleteMemoryIds : undefined;
	if (metadata.target_model !== targetModel || options.restartFromBeginning) {
		return {
			trigger: metadata.trigger,
			reconciliation_target_coverage_complete:
				options.reconciliationTargetCoverageComplete || undefined,
			pending_upsert_memory_ids,
			pending_delete_memory_ids,
			queue_revision: metadata.queue_revision,
			source_model: sourceModel,
			target_model: targetModel,
			requested_model: requestedModel,
			requested_revision: requestedRevision,
			last_cursor_id: 0,
			processed_embeddable: 0,
			embeddable_total: embeddableTotal,
		};
	}
	return {
		...metadata,
		pending_upsert_memory_ids,
		pending_delete_memory_ids,
		source_model: sourceModel ?? metadata.source_model ?? null,
		target_model: targetModel,
		requested_model: requestedModel,
		requested_revision: requestedRevision,
		last_cursor_id: Number(metadata.last_cursor_id ?? 0),
		processed_embeddable: Number(metadata.processed_embeddable ?? 0),
		embeddable_total: Number(metadata.embeddable_total ?? embeddableTotal),
		removed_stale_rows: metadata.removed_stale_rows,
	};
}

function deleteStaleModelVectors(
	db: SqliteDatabase,
	targetModel: string,
	signal?: AbortSignal,
): { deleted: number; exhausted: boolean } {
	const batchSize = 250;
	let deleted = 0;
	const selectStmt = db.prepare(
		"SELECT rowid FROM memory_vectors WHERE model != ? ORDER BY rowid ASC LIMIT ?",
	);
	const deleteStmt = db.prepare("DELETE FROM memory_vectors WHERE rowid = ?");
	if (signal?.aborted) return { deleted, exhausted: false };
	const rows = selectStmt.all(targetModel, batchSize) as Array<{ rowid: number }>;
	if (rows.length === 0) return { deleted, exhausted: true };
	if (signal?.aborted) return { deleted, exhausted: false };
	// Stop after one bounded batch so the event loop can deliver shutdown before
	// the next migration pass. Deleted rows are the durable cleanup cursor.
	db.transaction(() => {
		for (const row of rows) deleted += deleteStmt.run(row.rowid).changes;
	})();
	return { deleted, exhausted: rows.length < batchSize };
}

function cleanupStaleModels(
	db: SqliteDatabase,
	targetModel: string,
): { removed: number; exhausted: boolean } {
	const cleanup = deleteStaleModelVectors(db, targetModel);
	// Also prune obsolete rows within the target model: coverage is a subset
	// check, so a memory can be "covered" while retaining target rows for content
	// that no longer exists (interrupted migration, or an edit/redaction without
	// vector maintenance). Leaving them lets MIN-distance recall surface stale
	// content after the migration reports success.
	const prunedObsolete = pruneObsoleteTargetModelVectors(db, targetModel);
	return { removed: cleanup.deleted + prunedObsolete, exhausted: cleanup.exhausted };
}

type DatabaseMutationSnapshot = {
	dataVersion: number;
	totalChanges: number;
};

function readDatabaseMutationSnapshot(
	db: SqliteDatabase,
	phase:
		| "prune-start"
		| "prune-end"
		| "cleanup-prune-start"
		| "cleanup-prune-end"
		| "cleanup-end"
		| "validation",
): DatabaseMutationSnapshot {
	const row = db
		.prepare(`/* vector-cutover-${phase} */ SELECT total_changes() AS total_changes`)
		.get() as {
		total_changes?: number;
	};
	return {
		dataVersion: Number(db.pragma("data_version", { simple: true })),
		totalChanges: Number(row.total_changes ?? 0),
	};
}

function sameDatabaseDataVersion(
	before: DatabaseMutationSnapshot,
	after: DatabaseMutationSnapshot,
): boolean {
	return after.dataVersion === before.dataVersion;
}

function sameDatabaseMutationSnapshot(
	db: SqliteDatabase,
	snapshot: DatabaseMutationSnapshot,
): boolean {
	const current = readDatabaseMutationSnapshot(db, "validation");
	return (
		current.dataVersion === snapshot.dataVersion && current.totalChanges === snapshot.totalChanges
	);
}

function finalizeMigrationCutover(
	db: SqliteDatabase,
	targetModel: string,
	metadata: MigrationMetadata,
	lastCursorId: number,
	processedEmbeddable: number,
	embeddableTotal: number,
	signal?: AbortSignal,
): void {
	const previouslyRemoved = Number(metadata.removed_stale_rows ?? 0);
	const pruneSnapshot = readDatabaseMutationSnapshot(db, "prune-start");
	const prunedTargetRows = pruneObsoleteTargetModelVectors(db, targetModel, { signal });
	const validationSnapshot = readDatabaseMutationSnapshot(db, "prune-end");
	// data_version changes only when another connection commits, so pruning on
	// this connection does not trip its own mutation fence.
	const pruningWasIsolated = sameDatabaseDataVersion(pruneSnapshot, validationSnapshot);
	const uncovered = countIncompleteActiveMemoryVectorCoverage(db, targetModel);
	let readyForLegacyCleanup = false;
	let removedBeforeCleanup = previouslyRemoved + prunedTargetRows;

	db.transaction(() => {
		const latestJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		const latestMetadata = (latestJob?.metadata ?? {}) as MigrationMetadata;
		removedBeforeCleanup =
			Math.max(
				Number(latestMetadata.removed_stale_rows ?? 0),
				Number(metadata.removed_stale_rows ?? 0),
			) + prunedTargetRows;
		const progressMetadata = {
			...(sameQueuedSyncWork(latestMetadata, metadata) ? metadata : latestMetadata),
			last_cursor_id: lastCursorId,
			processed_embeddable: processedEmbeddable,
			embeddable_total: embeddableTotal,
			removed_stale_rows: removedBeforeCleanup,
		};
		if (!sameQueuedSyncWork(latestMetadata, metadata)) {
			updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				status: "running",
				message: "Draining vector changes queued before cutover",
				progressCurrent: processedEmbeddable,
				progressTotal: embeddableTotal,
				metadata: progressMetadata,
			});
			return;
		}
		if (!pruningWasIsolated || !sameDatabaseMutationSnapshot(db, validationSnapshot)) {
			updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				status: "running",
				message: "Memory changes arrived during cutover validation; retrying",
				progressCurrent: processedEmbeddable,
				progressTotal: embeddableTotal,
				metadata: {
					...progressMetadata,
					cutover_retry_count: Number(latestMetadata.cutover_retry_count ?? 0) + 1,
				},
			});
			return;
		}
		if (uncovered > 0) {
			failMaintenanceJob(
				db,
				VECTOR_MODEL_MIGRATION_JOB,
				`Target vector coverage is incomplete for ${describeIncompleteTargetMemories(uncovered)}`,
				{
					message:
						"Vector re-indexing stopped before cutover; existing valid vectors remain available",
					metadata: {
						...progressMetadata,
						reconciliation_target_coverage_complete: undefined,
						last_cursor_id: 0,
						processed_embeddable: 0,
						cutover_retry_count: 0,
						uncovered_target_memories: uncovered,
					},
				},
			);
			return;
		}
		completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			message: "Finished re-indexing; removing stale vectors",
			progressCurrent: processedEmbeddable,
			progressTotal: embeddableTotal,
			metadata: {
				...progressMetadata,
				cleanup_pending: true,
				cutover_retry_count: 0,
				uncovered_target_memories: undefined,
			},
		});
		readyForLegacyCleanup = true;
	}).immediate();

	if (!readyForLegacyCleanup) return;
	const cleanup = deleteStaleModelVectors(db, targetModel, signal);
	recordResumedCleanupResult(db, {
		cleanup,
		validationSnapshot,
		previouslyRemoved: removedBeforeCleanup,
		prunedTargetRows: 0,
	});
}

function detectSourceModel(db: SqliteDatabase, targetModel: string): string | null {
	const rows = vectorModels(db).filter((row) => row.model !== targetModel);
	return rows[0]?.model ?? null;
}

function mergedRemovedRows(
	latestMetadata: MigrationMetadata,
	previouslyRemoved: number,
	newlyRemoved: number,
): number {
	return Math.max(Number(latestMetadata.removed_stale_rows ?? 0), previouslyRemoved) + newlyRemoved;
}

function deferCompletedCleanup(
	db: SqliteDatabase,
	previouslyRemoved: number,
	prunedTargetRows: number,
	message: string,
): void {
	db.transaction(() => {
		const latestJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		const latestMetadata = (latestJob?.metadata ?? {}) as MigrationMetadata;
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			status: "completed",
			message,
			metadata: {
				...latestMetadata,
				removed_stale_rows: mergedRemovedRows(latestMetadata, previouslyRemoved, prunedTargetRows),
				cleanup_pending: true,
				reconciliation_target_coverage_complete: undefined,
			},
		});
	}).immediate();
}

function restartMigrationForIncompleteCoverage(
	db: SqliteDatabase,
	previouslyRemoved: number,
	prunedTargetRows: number,
	uncovered: number,
): void {
	db.transaction(() => {
		const latestJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		const latestMetadata = (latestJob?.metadata ?? {}) as MigrationMetadata;
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			status: "pending",
			message: "Target coverage changed before cleanup; rebuilding missing vectors",
			progressCurrent: 0,
			progressTotal: null,
			metadata: {
				...latestMetadata,
				cleanup_pending: false,
				reconciliation_target_coverage_complete: undefined,
				source_model: null,
				last_cursor_id: 0,
				processed_embeddable: 0,
				embeddable_total: undefined,
				removed_stale_rows: mergedRemovedRows(latestMetadata, previouslyRemoved, prunedTargetRows),
				uncovered_target_memories: uncovered,
			},
		});
	}).immediate();
}

function recordResumedCleanupResult(
	db: SqliteDatabase,
	options: {
		cleanup: { deleted: number; exhausted: boolean };
		validationSnapshot: DatabaseMutationSnapshot;
		previouslyRemoved: number;
		prunedTargetRows: number;
	},
): boolean {
	let cleanupCompleted = false;
	db.transaction(() => {
		const cleanupSnapshot = readDatabaseMutationSnapshot(db, "cleanup-end");
		const cleanupWasIsolated = sameDatabaseDataVersion(options.validationSnapshot, cleanupSnapshot);
		const latestJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		const latestMetadata = (latestJob?.metadata ?? {}) as MigrationMetadata;
		const newlyRemoved = cleanupWasIsolated
			? options.prunedTargetRows + options.cleanup.deleted
			: 0;
		const removed = mergedRemovedRows(latestMetadata, options.previouslyRemoved, newlyRemoved);
		cleanupCompleted = options.cleanup.exhausted && cleanupWasIsolated;
		let message = "Finished re-indexing; removing stale vectors";
		if (!cleanupWasIsolated) message = "Memory changes arrived during cleanup; retrying";
		if (cleanupCompleted) {
			message =
				removed > 0
					? `Finished re-indexing and removed ${removed} stale vector rows`
					: "Finished re-indexing memories";
		}
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			status: "completed",
			message,
			metadata: {
				...latestMetadata,
				removed_stale_rows: removed,
				cleanup_pending: !cleanupCompleted,
				reconciliation_target_coverage_complete: undefined,
			},
		});
	}).immediate();
	return cleanupCompleted;
}

type CompletedCleanupPassResult = {
	continueMigration: boolean;
	restartFromBeginning: boolean;
	reconciliationTargetPruningComplete: boolean;
};

function finishCompletedCleanupPass(
	db: SqliteDatabase,
	targetModel: string,
	metadata: MigrationMetadata,
	signal?: AbortSignal,
): CompletedCleanupPassResult {
	const stop: CompletedCleanupPassResult = {
		continueMigration: false,
		restartFromBeginning: false,
		reconciliationTargetPruningComplete: false,
	};
	if (signal?.aborted) return stop;

	const previouslyRemoved = Number(metadata.removed_stale_rows ?? 0);
	const pruneSnapshot = readDatabaseMutationSnapshot(db, "cleanup-prune-start");
	const prunedTargetRows = pruneObsoleteTargetModelVectors(db, targetModel, { signal });
	const validationSnapshot = readDatabaseMutationSnapshot(db, "cleanup-prune-end");
	const uncovered = signal?.aborted
		? 0
		: countIncompleteActiveMemoryVectorCoverage(db, targetModel);
	const pruningWasIsolated = sameDatabaseDataVersion(pruneSnapshot, validationSnapshot);
	if (
		signal?.aborted ||
		!pruningWasIsolated ||
		!sameDatabaseMutationSnapshot(db, validationSnapshot)
	) {
		let message = "Memory changes arrived during cleanup validation; retrying";
		if (signal?.aborted) message = "Cleanup paused during shutdown; retrying";
		deferCompletedCleanup(db, previouslyRemoved, prunedTargetRows, message);
		return stop;
	}
	if (uncovered > 0) {
		restartMigrationForIncompleteCoverage(db, previouslyRemoved, prunedTargetRows, uncovered);
		return {
			continueMigration: true,
			restartFromBeginning: false,
			reconciliationTargetPruningComplete: false,
		};
	}
	if (!metadata.cleanup_pending) {
		return {
			continueMigration: true,
			restartFromBeginning: true,
			reconciliationTargetPruningComplete: true,
		};
	}

	const cleanup = deleteStaleModelVectors(db, targetModel, signal);
	const cleanupCompleted = recordResumedCleanupResult(db, {
		cleanup,
		validationSnapshot,
		previouslyRemoved,
		prunedTargetRows,
	});
	if (!cleanupCompleted) return stop;
	return {
		continueMigration: true,
		restartFromBeginning: true,
		reconciliationTargetPruningComplete: true,
	};
}

function resolveMigrationStartMessage(
	sourceModel: string | null,
	targetModel: string,
	targetDisplay: string,
): string {
	const servesCompatibleLegacySource =
		sourceModel === LEGACY_DEFAULT_EMBEDDING_MODEL &&
		targetModel === DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;
	if (servesCompatibleLegacySource) {
		return `Building ${targetDisplay} vectors while semantic search continues on the compatible legacy index`;
	}
	if (sourceModel) {
		return `Building ${targetDisplay} vectors while semantic search uses FTS-only`;
	}
	return `Building ${targetDisplay} vectors`;
}

export async function runVectorMigrationPass(
	db: SqliteDatabase,
	options: { batchSize?: number; signal?: AbortSignal } = {},
): Promise<void> {
	let existingJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
	const isInFlightJob = existingJob?.status === "running" || existingJob?.status === "pending";
	if (isEmbeddingDisabled()) {
		if (isInFlightJob) {
			failMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, "Embeddings are disabled", {
				message: "Vector re-indexing is waiting for embeddings to be enabled",
				metadata: {
					...(existingJob?.metadata ?? {}),
					reconciliation_target_coverage_complete: undefined,
				},
			});
		}
		return;
	}
	const client = await getEmbeddingClient();
	if (!client) {
		if (isInFlightJob) {
			failMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, "Embedding client unavailable", {
				message: "Vector re-indexing is waiting for the embedding client",
				metadata: {
					...(existingJob?.metadata ?? {}),
					reconciliation_target_coverage_complete: undefined,
				},
			});
		}
		return;
	}
	const targetModel = resolveEmbeddingClientVectorIdentityLabel(client);
	const requestedModel = client.model;
	const requestedRevision = client.identity?.requestedRevision ?? client.identity?.revision;
	if (!requestedRevision) {
		throw new TypeError("Embedding runtime identity is required to migrate persisted vectors");
	}
	const requestMetadata = {
		requested_model: requestedModel,
		requested_revision: requestedRevision,
	};
	const targetDisplay = client.identity?.revision
		? `${client.model}@${client.identity.revision.slice(0, 12)}`
		: client.model;
	const effectiveBatchSize = Math.max(1, options.batchSize ?? 50);
	const existingMetadata = (existingJob?.metadata ?? {}) as MigrationMetadata;
	const queuedSyncWorkCount =
		metadataMemoryIds(existingMetadata.pending_upsert_memory_ids).length +
		metadataMemoryIds(existingMetadata.pending_delete_memory_ids).length;
	let restartCompletedMigration = false;
	let reconciliationTargetCoverageComplete = false;
	if (
		existingJob?.status === "completed" &&
		existingMetadata.target_model === targetModel &&
		queuedSyncWorkCount === 0
	) {
		if (!existingMetadata.cleanup_pending && !hasSourceModelVectors(db, targetModel)) return;
		const cleanupResult = finishCompletedCleanupPass(
			db,
			targetModel,
			existingMetadata,
			options.signal,
		);
		if (
			!cleanupResult.continueMigration ||
			options.signal?.aborted ||
			(cleanupResult.restartFromBeginning && !hasSourceModelVectors(db, targetModel))
		) {
			return;
		}
		restartCompletedMigration = cleanupResult.restartFromBeginning;
		reconciliationTargetCoverageComplete =
			cleanupResult.reconciliationTargetPruningComplete &&
			countIncompleteActiveMemoryVectorCoverage(db, targetModel) === 0;
		existingJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
	}
	if (existingJob) {
		const queuedSyncWork = await runQueuedSyncVectorWork(
			db,
			existingJob,
			client,
			targetModel,
			effectiveBatchSize,
			options.signal,
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
	const existingMeta = (existingJob?.metadata ?? {}) as MigrationMetadata;
	const existingJobTrigger = existingMeta.trigger;
	const fromSyncTrigger =
		existingJobTrigger === SYNC_INCREMENTAL_TRIGGER ||
		existingJobTrigger === SYNC_BOOTSTRAP_TRIGGER;
	const hasKnownIncompleteCoverage = Number(existingMeta.uncovered_target_memories ?? 0) > 0;
	if (!sourceModel && fromSyncTrigger && hasInFlightJob && !hasKnownIncompleteCoverage) {
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
					...requestMetadata,
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
	const isResumingJob = existingJob?.status === "running" || existingJob?.status === "pending";
	const embeddableTotal =
		isResumingJob && existingMeta.target_model === targetModel && existingMeta.embeddable_total
			? Number(existingMeta.embeddable_total)
			: countEmbeddableActiveMemories(db);
	if (embeddableTotal <= 0 && hasInFlightJob && !sourceModel) {
		completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			message: "No embeddable memories to re-index",
			progressCurrent: 0,
			progressTotal: 0,
			metadata: {
				...existingMeta,
				...requestMetadata,
				last_cursor_id: 0,
				processed_embeddable: 0,
				embeddable_total: 0,
			},
		});
		return;
	}
	if (sourceModel && embeddableTotal <= 0) {
		const cleanup = cleanupStaleModels(db, targetModel);
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			message:
				cleanup.removed > 0
					? `Removed ${cleanup.removed} stale vector rows`
					: "No embeddable memories to re-index",
			progressTotal: 0,
			metadata: {
				...requestMetadata,
				source_model: sourceModel,
				target_model: targetModel,
				removed_stale_rows: cleanup.removed,
				cleanup_pending: !cleanup.exhausted,
			},
		});
		completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			progressCurrent: 0,
			progressTotal: 0,
			metadata: {
				...requestMetadata,
				source_model: sourceModel,
				target_model: targetModel,
				removed_stale_rows: cleanup.removed,
				cleanup_pending: !cleanup.exhausted,
			},
		});
		return;
	}

	const job = existingJob;
	const metadata = nextMigrationMetadata(
		job,
		sourceModel,
		targetModel,
		requestedModel,
		requestedRevision,
		embeddableTotal,
		{
			restartFromBeginning: restartCompletedMigration,
			reconciliationTargetCoverageComplete,
		},
	);
	if (!job || job.status === "completed" || job.status === "failed") {
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			message: resolveMigrationStartMessage(sourceModel, targetModel, targetDisplay),
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
		await backfillVectors(db, { memoryIds: batchIds, signal: options.signal, client });
		// If the signal fired mid-batch, backfillVectors may have processed
		// only a prefix of batchRows. Don't advance the cursor or mark the
		// job completed in that case — the next tick after restart needs to
		// re-process this batch from the same cursor to cover any rows the
		// abort skipped. Leave the metadata untouched.
		if (options.signal?.aborted) return;
		const prunedCoveredRows = pruneStaleCurrentModelVectors(db, batchIds, targetModel);
		const metadataAfterPrune: MigrationMetadata = {
			...metadata,
			removed_stale_rows: Number(metadata.removed_stale_rows ?? 0) + prunedCoveredRows,
		};
		if (batchRows.length < effectiveBatchSize) {
			finalizeMigrationCutover(
				db,
				targetModel,
				metadataAfterPrune,
				lastCursorId,
				processedEmbeddable,
				embeddableTotal,
				options.signal,
			);
			return;
		}
		db.transaction(() => {
			const latestJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
			const latestMetadata = (latestJob?.metadata ?? {}) as MigrationMetadata;
			updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				status: "running",
				message: `Re-indexed ${processedEmbeddable} of ${embeddableTotal} memories with ${targetDisplay}`,
				progressCurrent: processedEmbeddable,
				progressTotal: embeddableTotal,
				metadata: {
					...(sameQueuedSyncWork(latestMetadata, metadata) ? metadataAfterPrune : latestMetadata),
					removed_stale_rows:
						Number(latestMetadata.removed_stale_rows ?? metadata.removed_stale_rows ?? 0) +
						prunedCoveredRows,
					last_cursor_id: lastCursorId,
					processed_embeddable: processedEmbeddable,
					embeddable_total: embeddableTotal,
				},
			});
		}).immediate();
		return;
	}

	if (metadata.last_cursor_id && metadata.last_cursor_id > 0) {
		finalizeMigrationCutover(
			db,
			targetModel,
			metadata,
			metadata.last_cursor_id,
			embeddableTotal,
			embeddableTotal,
			options.signal,
		);
	}
}

export class VectorModelMigrationRunner {
	private readonly dbPath: string;
	private readonly signal?: AbortSignal;
	private readonly batchSize: number;
	private readonly intervalMs: number;
	private readonly idleIntervalMs: number;
	private active = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private currentRun: Promise<void> | null = null;
	private lastTickWasIdle = false;

	constructor(options: VectorModelMigrationOptions = {}) {
		this.dbPath = resolveDbPath(options.dbPath);
		this.signal = options.signal;
		this.batchSize = Math.max(1, options.batchSize ?? 50);
		this.intervalMs = Math.max(1000, options.intervalMs ?? 5000);
		this.idleIntervalMs = Math.max(1000, options.idleIntervalMs ?? IDLE_INTERVAL_MS);
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.lastTickWasIdle = false;
		activeRunner = this;
		this.schedule(100);
	}

	async stop(): Promise<void> {
		this.active = false;
		if (activeRunner === this) activeRunner = null;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.currentRun) await this.currentRun;
	}

	/**
	 * Pulls the runner out of its idle cadence and schedules an immediate
	 * tick. Queue writers (sync bootstrap / incremental replication) call
	 * this through {@link wakeActiveVectorMigrationRunner} so freshly
	 * replicated memories don't sit unembedded for the full idle interval.
	 */
	wake(): void {
		if (!this.active) return;
		this.lastTickWasIdle = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
			this.schedule(100);
		}
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
					const next = this.lastTickWasIdle ? this.idleIntervalMs : this.intervalMs;
					this.schedule(next);
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
			await runVectorMigrationPass(db, {
				batchSize: this.batchSize,
				signal: this.signal,
			});
			this.lastTickWasIdle = this.computeIdle(db);
		} catch (error) {
			if (db) {
				const metadata = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.metadata ?? {};
				failMaintenanceJob(
					db,
					VECTOR_MODEL_MIGRATION_JOB,
					error instanceof Error ? error.message : String(error),
					{ metadata: { ...metadata, reconciliation_target_coverage_complete: undefined } },
				);
			}
			// Treat exceptions as idle — a thrown tick is not going to unthrow
			// at 5s cadence. The failMaintenanceJob record captures the error;
			// the next tick at IDLE_INTERVAL_MS will retry.
			this.lastTickWasIdle = true;
			console.warn("Vector migration runner failed", error);
		} finally {
			db?.close();
		}
	}

	private computeIdle(db: SqliteDatabase): boolean {
		// Embeddings disabled → the pass returns immediately with no work
		// possible. Polling fast adds nothing.
		if (isEmbeddingDisabled()) return true;
		const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		if (job) {
			// A `failed` job is not going to un-fail from polling; wait until
			// an operator retries, queues new sync work, or embeddings become
			// available again (all of which re-enter at full cadence on the
			// next tick). Running/pending stay non-idle because work is in
			// progress.
			const meta = (job.metadata ?? {}) as MigrationMetadata;
			if (job.status === "running" || job.status === "pending") {
				if (Number(meta.cutover_retry_count ?? 0) > 0) return true;
				return false;
			}
			const queued =
				metadataMemoryIds(meta.pending_upsert_memory_ids).length +
				metadataMemoryIds(meta.pending_delete_memory_ids).length;
			if (queued > 0) return false;
			return true;
		}
		// No job row yet. Peek coverage directly to tell whether the first
		// tick on a fresh DB genuinely had nothing to do.
		const targetModel = tryResolveEmbeddingVectorIdentityLabel();
		if (!targetModel) return true;
		try {
			const uncovered = db
				.prepare(
					`SELECT COUNT(*) AS c FROM memory_items
					 WHERE active = 1
					   AND TRIM(COALESCE(title, '') || COALESCE(body_text, '')) != ''
					   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_vectors WHERE model = ?)`,
				)
				.get(targetModel) as { c?: number } | undefined;
			if (Number(uncovered?.c ?? 0) > 0) return false;
			return detectSourceModel(db, targetModel) === null;
		} catch (error) {
			// Don't silently tick fast forever on a query failure; log so it
			// shows up in dogfood logs. Conservatively treat as non-idle so
			// the next tick tries again at full cadence.
			console.warn("Vector migration runner idle peek failed", error);
			return false;
		}
	}
}
