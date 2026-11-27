/**
 * Where the incremental replication backfill has got to. Kept apart from the pass itself so
 * that replication op pruning can ask for a full recheck without importing the pass.
 *
 * The position lives in the `maintenance_jobs` row for {@link REPLICATION_BACKFILL_JOB}. The
 * row reads `running` during the first full check of a store and `completed` afterwards.
 */
import type { Database } from "./db.js";
import {
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";

export const REPLICATION_BACKFILL_JOB = "replication_op_backfill";
const JOB_TITLE = "Preparing memories for sync";

export interface BackfillState {
	/** Every memory with an ID up to this one has been checked for a missing op. */
	checkedThroughId: number;
	/** Legacy import keys were tried up to this ID. It stays put when a recheck is requested. */
	legacyKeysTriedThroughId: number;
	/** Position in (`updated_at`, ID) order up to which changed rows have been checked. */
	updatedAt: string;
	updatedId: number;
	/** Legacy keys found unmigratable, and how many of them a warning has covered. */
	blockedLegacyKeys: number;
	reportedBlockedLegacyKeys: number;
	/** Whether every existing memory has been checked once. */
	initialPassComplete: boolean;
	/** How many full rechecks have been requested; a slice compares it to notice a new one. */
	recheckRequests: number;
}

/** What one slice did, for {@link commitBackfillProgress} to combine with the stored position. */
export interface BackfillProgress {
	/** The position the slice read when it started, or null on a store never checked. */
	startedFrom: BackfillState | null;
	/** The position the slice reached. Its counts of blocked keys are ignored. */
	reached: BackfillState;
	/** Memories whose legacy key the slice tried and found blocked. */
	blockedMemoryIds: readonly number[];
	newestMemoryId: number;
	/** Receives the one-time report of unmigratable legacy keys. */
	warn: (message: string) => void;
}

function finiteInteger(value: unknown): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function readBackfillState(db: Database): BackfillState | null {
	const metadata = getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)?.metadata;
	if (!metadata || typeof metadata.updated_at !== "string") return null;
	return {
		checkedThroughId: finiteInteger(metadata.checked_through_id),
		legacyKeysTriedThroughId: finiteInteger(metadata.legacy_keys_tried_through_id),
		updatedAt: metadata.updated_at,
		updatedId: finiteInteger(metadata.updated_id),
		blockedLegacyKeys: finiteInteger(metadata.blocked_legacy_keys),
		reportedBlockedLegacyKeys: finiteInteger(metadata.reported_blocked_legacy_keys),
		initialPassComplete: metadata.initial_pass_complete === true,
		recheckRequests: finiteInteger(metadata.recheck_requests),
	};
}

function blockedKeysMessage(count: number): string | null {
	if (count <= 0) return null;
	return `${count} legacy import ${count === 1 ? "key was" : "keys were"} left unchanged because another memory already has the device-scoped key`;
}

function stateMetadata(state: BackfillState): Record<string, unknown> {
	return {
		checked_through_id: state.checkedThroughId,
		legacy_keys_tried_through_id: state.legacyKeysTriedThroughId,
		updated_at: state.updatedAt,
		updated_id: state.updatedId,
		blocked_legacy_keys: state.blockedLegacyKeys,
		reported_blocked_legacy_keys: state.reportedBlockedLegacyKeys,
		initial_pass_complete: state.initialPassComplete,
		recheck_requests: state.recheckRequests,
	};
}

/**
 * The sync pass and the maintenance worker run slices from separate processes, and pruning
 * can request a recheck while a slice is under way. Combine a slice's result with what is
 * stored now, so neither a recheck request nor another process's progress is overwritten
 * and a blocked key another process already counted is not counted twice.
 */
function combineWithStored(saved: BackfillState | null, progress: BackfillProgress): BackfillState {
	const { startedFrom, reached, blockedMemoryIds } = progress;
	if (!saved) return { ...reached, blockedLegacyKeys: blockedMemoryIds.length };
	const recheckRequested = saved.recheckRequests > (startedFrom?.recheckRequests ?? 0);
	const newlyBlocked = blockedMemoryIds.filter((id) => id > saved.legacyKeysTriedThroughId);
	// Another process may be further along, but no mark may pass the newest memory: a deleted
	// newest row frees its ID, and the memory that reuses it must still be read as new.
	const newestChecked = Math.max(progress.newestMemoryId, reached.checkedThroughId);
	const furthest = (savedMark: number, reachedMark: number) =>
		Math.min(newestChecked, Math.max(savedMark, reachedMark));
	return {
		...reached,
		checkedThroughId: recheckRequested
			? 0
			: furthest(saved.checkedThroughId, reached.checkedThroughId),
		legacyKeysTriedThroughId: furthest(
			saved.legacyKeysTriedThroughId,
			reached.legacyKeysTriedThroughId,
		),
		blockedLegacyKeys: saved.blockedLegacyKeys + newlyBlocked.length,
		reportedBlockedLegacyKeys: saved.reportedBlockedLegacyKeys,
		initialPassComplete: saved.initialPassComplete || reached.initialPassComplete,
		recheckRequests: saved.recheckRequests,
	};
}

/** Store a slice's progress, and report unmigratable legacy keys once the first check is done. */
export function commitBackfillProgress(db: Database, progress: BackfillProgress): void {
	db.transaction(() => {
		const state = combineWithStored(readBackfillState(db), progress);
		const unreported = state.blockedLegacyKeys - state.reportedBlockedLegacyKeys;
		const report = state.initialPassComplete ? blockedKeysMessage(unreported) : null;
		if (report) state.reportedBlockedLegacyKeys = state.blockedLegacyKeys;

		const metadata = stateMetadata(state);
		if (!getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)) {
			startMaintenanceJob(db, {
				kind: REPLICATION_BACKFILL_JOB,
				title: JOB_TITLE,
				progressUnit: "memories",
				metadata,
			});
		}
		updateMaintenanceJob(db, REPLICATION_BACKFILL_JOB, {
			status: state.initialPassComplete ? "completed" : "running",
			message: state.initialPassComplete ? blockedKeysMessage(state.blockedLegacyKeys) : null,
			progressCurrent: state.checkedThroughId,
			progressTotal: Math.max(progress.newestMemoryId, state.checkedThroughId),
			metadata,
		});
		if (report) progress.warn(`[codemem] ${report}. They are not tried again.`);
	}).immediate();
}

/**
 * Have the backfill check every memory for a missing op again, from the lowest ID. Called
 * when replication ops are pruned: a memory whose current op was removed gets a new one, as
 * it did when each sync pass read every memory. A store that has not been checked yet needs
 * nothing, because its first check covers every row.
 */
export function requestReplicationBackfillRecheck(db: Database): void {
	const state = readBackfillState(db);
	if (!state) return;
	updateMaintenanceJob(db, REPLICATION_BACKFILL_JOB, {
		metadata: stateMetadata({
			...state,
			checkedThroughId: 0,
			recheckRequests: state.recheckRequests + 1,
		}),
	});
}
