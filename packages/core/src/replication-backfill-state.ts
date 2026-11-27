/**
 * Where the incremental replication backfill has got to. Kept apart from the pass itself so
 * that replication op pruning can ask for a full recheck without importing the pass.
 *
 * The position lives in the `maintenance_jobs` row for {@link REPLICATION_BACKFILL_JOB}. The
 * row reads `running` during the first full check of a store and `completed` afterwards.
 * The pass writes it while holding the write lock, so the sync pass and the maintenance
 * worker, which run slices from separate processes, never overwrite each other's progress
 * or a recheck request.
 */
import type { Database } from "./db.js";
import {
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";

export const REPLICATION_BACKFILL_JOB = "replication_op_backfill";
const JOB_TITLE = "Preparing memories for sync";
/** How many of the newest checked memories are remembered. */
const NEWEST_CHECKED_ROWS = 8;

/** A memory's ID and import key, enough to tell whether an ID now holds another memory. */
export type MemoryRowIdentity = [id: number, importKey: string | null];

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
	/**
	 * The newest checked memories, newest first. SQLite reuses the ID of a deleted newest
	 * row, so a slice compares these with the store to notice checked rows that were deleted
	 * and replaced since the last one.
	 */
	newestCheckedRows: MemoryRowIdentity[];
}

function finiteInteger(value: unknown): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function rowIdentitiesFrom(value: unknown): MemoryRowIdentity[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry): MemoryRowIdentity[] => {
		if (!Array.isArray(entry) || finiteInteger(entry[0]) === 0) return [];
		return [[finiteInteger(entry[0]), typeof entry[1] === "string" ? entry[1] : null]];
	});
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
		newestCheckedRows: rowIdentitiesFrom(metadata.newest_checked_rows),
	};
}

/** The newest memories at or below `throughId`, newest first, as the store has them now. */
function readNewestRows(db: Database, throughId: number): MemoryRowIdentity[] {
	return db
		.prepare("SELECT id, import_key FROM memory_items WHERE id <= ? ORDER BY id DESC LIMIT ?")
		.raw()
		.all(throughId, NEWEST_CHECKED_ROWS) as MemoryRowIdentity[];
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
		newest_checked_rows: state.newestCheckedRows,
	};
}

/**
 * Store the position a slice reached, and report unmigratable legacy keys once the first
 * check is done. The caller holds the write lock.
 */
export function saveBackfillState(
	db: Database,
	state: BackfillState,
	context: { newestMemoryId: number; warn: (message: string) => void },
): void {
	const unreported = state.blockedLegacyKeys - state.reportedBlockedLegacyKeys;
	const report = state.initialPassComplete ? blockedKeysMessage(unreported) : null;
	if (report) state.reportedBlockedLegacyKeys = state.blockedLegacyKeys;
	state.newestCheckedRows = readNewestRows(db, state.checkedThroughId);

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
		progressTotal: Math.max(context.newestMemoryId, state.checkedThroughId),
		metadata,
	});
	if (report) context.warn(`[codemem] ${report}. They are not tried again.`);
}

/**
 * Have the backfill check every memory for a missing op again, from the lowest ID. Called
 * when replication ops are pruned: a memory whose current op was removed gets a new one, as
 * it did when each sync pass read every memory. A store that has not been checked yet needs
 * nothing, because its first check covers every row.
 */
export function requestReplicationBackfillRecheck(db: Database): void {
	const state = readBackfillState(db);
	if (!state || state.checkedThroughId === 0) return;
	updateMaintenanceJob(db, REPLICATION_BACKFILL_JOB, {
		metadata: stateMetadata({ ...state, checkedThroughId: 0 }),
	});
}
