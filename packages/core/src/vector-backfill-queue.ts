import type { Database } from "./db.js";
import {
	getMaintenanceJob,
	type MaintenanceJobSnapshot,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";

export const VECTOR_MODEL_MIGRATION_JOB = "vector_model_migration";
export const SYNC_INCREMENTAL_TRIGGER = "sync_incremental";

export interface VectorBackfillWork {
	upsertMemoryIds: readonly number[];
	deleteMemoryIds: readonly number[];
}

export type VectorBackfillQueueMetadata = {
	target_model?: string | null;
	requested_model?: string | null;
	requested_revision?: string | null;
	removed_stale_rows?: number;
	cleanup_pending?: boolean;
	trigger?: string | null;
	pending_upsert_memory_ids?: number[];
	pending_delete_memory_ids?: number[];
	queue_revision?: number;
	/** Local repair may drain queued IDs without resuming a cancelled migration. */
	local_repair_preserves_migration_state?: boolean;
};

function uniquePositiveIds(memoryIds: readonly number[]): number[] {
	return [
		...new Set(memoryIds.filter((memoryId) => Number.isInteger(memoryId) && memoryId > 0)),
	].sort((a, b) => a - b);
}

export function metadataMemoryIds(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	return uniquePositiveIds(value.filter((item): item is number => typeof item === "number"));
}

export function mergeQueuedSyncMemoryIds(
	metadata: VectorBackfillQueueMetadata,
	work: VectorBackfillWork,
): Pick<VectorBackfillQueueMetadata, "pending_upsert_memory_ids" | "pending_delete_memory_ids"> {
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

function retainedQueueMetadata(
	job: MaintenanceJobSnapshot | null,
	options: { resumeMigration?: boolean },
): VectorBackfillQueueMetadata {
	const metadata = (job?.metadata ?? {}) as VectorBackfillQueueMetadata;
	if (job?.status === "cancelled" && !options.resumeMigration) {
		return metadata;
	}
	if (job && job.status !== "completed" && job.status !== "cancelled") return metadata;
	const cleanupMetadata: VectorBackfillQueueMetadata = metadata.cleanup_pending
		? {
				cleanup_pending: true,
				target_model: metadata.target_model,
				requested_model: metadata.requested_model,
				requested_revision: metadata.requested_revision,
				removed_stale_rows: metadata.removed_stale_rows,
				queue_revision: metadata.queue_revision,
			}
		: {};
	if (job?.status === "cancelled" && metadata.local_repair_preserves_migration_state) {
		// Explicit sync starts fresh, but repair IDs accumulated during cancellation must survive.
		return {
			...cleanupMetadata,
			pending_upsert_memory_ids: metadata.pending_upsert_memory_ids,
			pending_delete_memory_ids: metadata.pending_delete_memory_ids,
			queue_revision: metadata.queue_revision,
		};
	}
	return cleanupMetadata;
}

/** Persist intent on this connection; nested calls commit only with the outer transaction. */
export function queueVectorBackfill(
	db: Database,
	work: VectorBackfillWork,
	options: { resumeMigration?: boolean } = {},
): void {
	const queuedWork = mergeQueuedSyncMemoryIds({}, work);
	if (
		(queuedWork.pending_upsert_memory_ids?.length ?? 0) === 0 &&
		(queuedWork.pending_delete_memory_ids?.length ?? 0) === 0
	) {
		return;
	}

	db.transaction(() => {
		const existingJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		const existingMetadata = retainedQueueMetadata(existingJob, options);
		const metadata: VectorBackfillQueueMetadata = {
			...existingMetadata,
			...mergeQueuedSyncMemoryIds(existingMetadata, work),
			queue_revision: Number(existingMetadata.queue_revision ?? 0) + 1,
		};
		if (
			!options.resumeMigration &&
			(existingJob?.status === "failed" || existingJob?.status === "cancelled")
		) {
			updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				metadata: {
					...metadata,
					local_repair_preserves_migration_state: existingJob.status === "cancelled" || undefined,
				},
			});
			return;
		}
		// The worker uses this trigger to drain queued IDs before migration cutover.
		metadata.trigger = existingMetadata.trigger ?? SYNC_INCREMENTAL_TRIGGER;
		metadata.local_repair_preserves_migration_state = undefined;
		const message = options.resumeMigration
			? "Queued vector catch-up for incremental sync data"
			: "Queued vector catch-up for memories";
		const pendingWorkCount =
			metadataMemoryIds(metadata.pending_upsert_memory_ids).length +
			metadataMemoryIds(metadata.pending_delete_memory_ids).length;

		if (!existingJob || existingJob.status === "completed" || existingJob.status === "cancelled") {
			startMaintenanceJob(db, {
				kind: VECTOR_MODEL_MIGRATION_JOB,
				title: "Re-indexing memories",
				status: "pending",
				message,
				progressTotal: null,
				metadata,
			});
			return;
		}

		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			status: "pending",
			message,
			progressCurrent:
				existingJob.status === "failed"
					? 0
					: Math.min(existingJob.progress.current, pendingWorkCount),
			progressTotal: existingJob.progress.total,
			metadata,
		});
	}).immediate();
}
