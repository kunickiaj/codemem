/**
 * Incremental backfill of what a memory needs before it can sync: a device-scoped import
 * key for legacy rows, and a replication op for rows written without one (imports, local
 * recovery copies, maintenance deactivations).
 *
 * `backfillReplicationOps` answers the same question by reading every memory on every call,
 * which blocked the process for seconds on a large store. This pass records how far it has
 * checked and then reads only what changed:
 *
 * - new rows, by ID above the recorded high-water mark;
 * - rows changed in place, by `updated_at` above the recorded position. Every writer that
 *   deactivates a memory or bumps its revision without recording an op also sets
 *   `updated_at`.
 *
 * A legacy key that cannot be migrated, because its device-scoped form belongs to another
 * memory, is attempted once when its row is first checked and then counted and reported
 * once.
 *
 * Pruning old replication ops asks for every memory to be checked again, because a memory
 * whose current op was pruned needs a new one.
 *
 * The position is stored by `replication-backfill-state.ts`. Callers run slices with a time
 * limit: the sync pass a short one on each tick, the maintenance worker longer passes that
 * finish a full check of an existing store.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Statement } from "better-sqlite3";
import type { Database } from "./db.js";
import { isTransientSqliteBusy } from "./maintenance-jobs.js";
import {
	PeriodicRetentionRunner,
	type PeriodicRetentionRunnerOptions,
	type RetentionPassOutcome,
	startRetentionBudget,
} from "./periodic-retention.js";
import {
	type BackfillState,
	type MemoryRowIdentity,
	readBackfillState,
	readNewestRows,
	saveBackfillState,
} from "./replication-backfill-state.js";
import type * as schema from "./schema.js";
import {
	insertBackfillReplicationOp,
	localReplicationDeviceId,
	migrateLegacyImportKeyForRow,
} from "./sync-replication.js";

/** A sync tick's share: enough for new rows, short enough for a process that serves requests. */
export const DEFAULT_REPLICATION_BACKFILL_SLICE_MS = 25;
/** One step of a maintenance worker pass, and the pause that lets other writers in. */
const PASS_SLICE_MS = 50;
const PASS_PAUSE_MS = 25;
/** Rows read per step, so the time limit is checked often. */
const WINDOW_ROWS = 200;
/**
 * Changed rows are rechecked this far back on every pass. It covers a writer whose
 * transaction commits after it took its timestamp.
 */
const RECHECK_WINDOW_MS = 5 * 60_000;
/** An idle pass writes its position at most this often. */
const IDLE_SAVE_INTERVAL_MS = 5 * 60_000;

type MemoryItemRow = typeof schema.memoryItems.$inferSelect;
/** The columns that decide whether a memory needs a key or an op. */
type SyncStateColumns = Pick<MemoryItemRow, "import_key" | "rev" | "active" | "deleted_at">;

export interface ReplicationBackfillSliceOptions {
	maxRuntimeMs?: number;
	signal?: AbortSignal;
	/** Milliseconds clock for the time limit; tests replace it. */
	clock?: () => number;
	/** Wall-clock time recorded on new ops and used for the recheck window. */
	now?: () => Date;
	/** Receives the one-time report of unmigratable legacy keys. */
	warn?: (message: string) => void;
	/**
	 * Whether a slice with something to write waits for another writer to finish. A process
	 * that serves requests passes false: the slice is skipped and the next one does the work.
	 */
	waitForWriteLock?: boolean;
}

export interface ReplicationBackfillSliceResult {
	opsCreated: number;
	keysMigrated: number;
	/** Whether everything written before this slice started has been checked. */
	complete: boolean;
}

interface SliceContext {
	db: Database;
	state: BackfillState;
	localDeviceId: string;
	nowIso: string;
	outOfTime: (shareOfLimit: number) => boolean;
	result: ReplicationBackfillSliceResult;
	/** A read-only look: stop at the first row that needs a write instead of writing it. */
	dryRun: boolean;
	selectMemory: Statement<[number]>;
	selectOp: Statement<[string | null, string, number]>;
}

function hasOp(context: SliceContext, row: SyncStateColumns, opType: string): boolean {
	return context.selectOp.get(row.import_key, opType, Number(row.rev ?? 0)) !== undefined;
}

/** The op a row's current state calls for, matching `backfillReplicationOps`. */
function expectedOpType(row: SyncStateColumns): "delete" | "upsert" | null {
	if (row.deleted_at != null || row.active === 0) return "delete";
	if (row.active === 1) return "upsert";
	return null;
}

function hasLegacyImportKey(importKey: string | null): boolean {
	const key = String(importKey ?? "").trim();
	return !key || key.startsWith("legacy:memory_item:");
}

function needsOp(context: SliceContext, row: SyncStateColumns): boolean {
	const opType = expectedOpType(row);
	return opType !== null && !hasOp(context, row, opType);
}

/**
 * Gives one memory its device-scoped key and its missing op. Returns whether its key is
 * blocked. A row whose legacy key was already tried keeps it and is not tried again.
 */
function prepareMemory(context: SliceContext, memoryId: number): { keyBlocked: boolean } {
	const { db, localDeviceId, result, selectMemory, state } = context;
	let row = selectMemory.get(memoryId) as MemoryItemRow | undefined;
	if (!row) return { keyBlocked: false };

	let keyBlocked = false;
	if (memoryId > state.legacyKeysTriedThroughId && hasLegacyImportKey(row.import_key)) {
		const outcome = migrateLegacyImportKeyForRow(db, row, localDeviceId);
		keyBlocked = outcome === "blocked";
		if (outcome === "migrated") {
			result.keysMigrated += 1;
			row = selectMemory.get(memoryId) as MemoryItemRow | undefined;
			if (!row) return { keyBlocked };
		}
	}

	const opType = expectedOpType(row);
	if (!opType || hasOp(context, row, opType)) return { keyBlocked };
	if (insertBackfillReplicationOp(db, row, localDeviceId, context.nowIso)) result.opsCreated += 1;
	return { keyBlocked };
}

type ScanOutcome = "caught-up" | "out-of-time" | "found-work";

/**
 * One page of changed rows. Moves the position past each row it handled, and returns
 * whether a dry run met a row that needs a write.
 */
function checkChangedPage(
	context: SliceContext,
	rows: Array<{ id: number; updated_at: string }>,
	syncState: Statement<[number]>,
): boolean {
	for (const { id, updated_at } of rows) {
		const row = syncState.get(id) as SyncStateColumns | undefined;
		if (row && needsOp(context, row)) {
			if (context.dryRun) return true;
			prepareMemory(context, id);
		}
		context.state.updatedAt = updated_at;
		context.state.updatedId = id;
	}
	return false;
}

/**
 * Rows changed in place since the last pass, among the rows the ID scan has already covered.
 * Reads the `updated_at` index only until a row needs work.
 */
function checkChangedRows(context: SliceContext): ScanOutcome {
	const { db, state } = context;
	if (state.checkedThroughId <= 0) return "caught-up";
	// The unary plus keeps the planner on the updated_at index: without it the ID bound could
	// be chosen as the access path, which reads every checked row.
	const page = db.prepare(
		`SELECT id, updated_at FROM memory_items
		 WHERE updated_at >= ? AND (updated_at > ? OR id > ?) AND +id <= ?
		 ORDER BY updated_at, id LIMIT ?`,
	);
	const syncState = db.prepare(
		"SELECT import_key, rev, active, deleted_at FROM memory_items WHERE id = ?",
	);
	while (true) {
		const rows = page.all(
			state.updatedAt,
			state.updatedAt,
			state.updatedId,
			state.checkedThroughId,
			WINDOW_ROWS,
		) as Array<{ id: number; updated_at: string }>;
		if (checkChangedPage(context, rows, syncState)) return "found-work";
		if (rows.length < WINDOW_ROWS) return "caught-up";
		if (context.outOfTime(0.5)) return "out-of-time";
	}
}

const NEW_ROW_CANDIDATES_SQL = `SELECT m.id FROM memory_items m
	WHERE m.id > ? AND m.id <= ?
	AND (
		m.import_key IS NULL OR TRIM(m.import_key) = ''
		OR substr(TRIM(m.import_key), 1, 19) = 'legacy:memory_item:'
		OR ((m.deleted_at IS NOT NULL OR m.active = 0) AND NOT EXISTS (
			SELECT 1 FROM replication_ops ro
			WHERE ro.entity_type = 'memory_item' AND ro.entity_id = m.import_key
			AND ro.op_type = 'delete' AND ro.clock_rev = COALESCE(m.rev, 0)))
		OR (m.deleted_at IS NULL AND m.active = 1 AND NOT EXISTS (
			SELECT 1 FROM replication_ops ro
			WHERE ro.entity_type = 'memory_item' AND ro.entity_id = m.import_key
			AND ro.op_type = 'upsert' AND ro.clock_rev = COALESCE(m.rev, 0)))
	)
	ORDER BY m.id`;

/** Rows above the ID high-water mark, one window at a time. Returns whether it caught up. */
function checkNewRows(context: SliceContext): boolean {
	const { db, state } = context;
	const windowEnd = db.prepare(
		`SELECT max(id) AS upper FROM (
			SELECT id FROM memory_items WHERE id > ? ORDER BY id LIMIT ?
		)`,
	);
	const candidates = db.prepare(NEW_ROW_CANDIDATES_SQL).pluck();
	while (true) {
		const upper = (windowEnd.get(state.checkedThroughId, WINDOW_ROWS) as { upper: number | null })
			.upper;
		if (upper == null) return true;
		for (const id of candidates.all(state.checkedThroughId, upper) as number[]) {
			if (prepareMemory(context, id).keyBlocked) state.blockedLegacyKeys += 1;
		}
		state.checkedThroughId = upper;
		state.legacyKeysTriedThroughId = Math.max(state.legacyKeysTriedThroughId, upper);
		if (context.outOfTime(1)) return false;
	}
}

/**
 * SQLite gives a new memory the ID of a deleted newest row. A replacement can therefore sit
 * at or below the mark without having been checked, with any `updated_at`, as an import has.
 * Compare the newest checked rows with the store. When the newest one is gone or is another
 * memory, go back to the newest remembered row that is unchanged: IDs are only reused above
 * the rows that survived. With none unchanged, check every memory again.
 */
function markBelowReplacedRows(db: Database, state: BackfillState): number {
	const remembered = state.newestCheckedRows;
	const newest = remembered[0];
	if (!newest) return state.checkedThroughId;
	const current = new Map(readNewestRows(db, newest[0]));
	const unchanged = ([id, importKey]: MemoryRowIdentity) =>
		current.has(id) && current.get(id) === importKey;
	if (unchanged(newest)) return state.checkedThroughId;
	return remembered.find(unchanged)?.[0] ?? 0;
}

/**
 * Lower the mark past any checked row that was deleted since the last slice, so a memory
 * that reuses a freed ID is read as a new row. Returns the newest memory ID.
 */
function lowerMarkToSurvivingRows(db: Database, state: BackfillState): number {
	const newest = db.prepare("SELECT max(id) AS id FROM memory_items").get() as {
		id: number | null;
	};
	const newestId = newest.id ?? 0;
	state.checkedThroughId = Math.min(
		state.checkedThroughId,
		newestId,
		markBelowReplacedRows(db, state),
	);
	return newestId;
}

function initialState(recheckFrom: string): BackfillState {
	return {
		checkedThroughId: 0,
		legacyKeysTriedThroughId: 0,
		// Rows the first full check has already passed are rechecked from here.
		updatedAt: recheckFrom,
		updatedId: 0,
		blockedLegacyKeys: 0,
		reportedBlockedLegacyKeys: 0,
		initialPassComplete: false,
		newestCheckedRows: [],
	};
}

interface SliceTiming {
	nowIso: string;
	/** Changed rows are rechecked from this instant on every pass. */
	recheckFrom: string;
	outOfTime: (shareOfLimit: number) => boolean;
}

function sliceContext(
	db: Database,
	state: BackfillState,
	timing: SliceTiming,
	options: { localDeviceId: string; dryRun: boolean },
): SliceContext {
	return {
		db,
		state,
		localDeviceId: options.localDeviceId,
		nowIso: timing.nowIso,
		outOfTime: timing.outOfTime,
		result: { opsCreated: 0, keysMigrated: 0, complete: true },
		dryRun: options.dryRun,
		selectMemory: db.prepare("SELECT * FROM memory_items WHERE id = ?"),
		selectOp: db.prepare(
			`SELECT 1 FROM replication_ops
			 WHERE entity_type = 'memory_item' AND entity_id = ? AND op_type = ? AND clock_rev = ?
			 LIMIT 1`,
		),
	};
}

/**
 * Whether a slice would write anything, found by reading only. An idle slice ends here, so
 * it never takes the write lock.
 */
function hasWork(db: Database, timing: SliceTiming, localDeviceId: string): boolean {
	const stored = readBackfillState(db);
	if (!stored) return true;
	const state = { ...stored };
	lowerMarkToSurvivingRows(db, state);
	if (state.checkedThroughId !== stored.checkedThroughId || !stored.initialPassComplete)
		return true;
	const newRow = db.prepare("SELECT 1 FROM memory_items WHERE id > ? LIMIT 1");
	if (newRow.get(state.checkedThroughId)) return true;
	const context = sliceContext(db, state, timing, { localDeviceId, dryRun: true });
	if (checkChangedRows(context) !== "caught-up") return true;
	// Nothing to write but the position, and that only once it has moved far enough.
	return Date.parse(timing.recheckFrom) - Date.parse(stored.updatedAt) >= IDLE_SAVE_INTERVAL_MS;
}

/** The slice proper. The caller holds the write lock, so the stored position cannot change. */
function runLockedSlice(
	db: Database,
	timing: SliceTiming,
	options: { localDeviceId: string; warn: (message: string) => void },
): ReplicationBackfillSliceResult {
	const state = readBackfillState(db) ?? initialState(timing.recheckFrom);
	const newestMemoryId = lowerMarkToSurvivingRows(db, state);
	const context = sliceContext(db, state, timing, {
		localDeviceId: options.localDeviceId,
		dryRun: false,
	});

	const changedDone = checkChangedRows(context) === "caught-up";
	// Caught up: the next pass rechecks the recent window again, wherever this one stopped.
	if (changedDone) {
		state.updatedAt = timing.recheckFrom;
		state.updatedId = 0;
	}
	const newDone = checkNewRows(context);
	if (newDone) state.initialPassComplete = true;
	context.result.complete = changedDone && newDone;

	saveBackfillState(db, state, { newestMemoryId, warn: options.warn });
	return context.result;
}

/**
 * Runs `work` holding the write lock. Without `wait`, returns null when another writer
 * holds the lock.
 */
function withWriteLock<T>(db: Database, wait: boolean, work: () => T): T | null {
	if (wait) return db.transaction(work).immediate();
	const previous = db.pragma("busy_timeout", { simple: true }) as number;
	db.pragma("busy_timeout = 0");
	try {
		return db.transaction(work).immediate();
	} catch (error) {
		if (isTransientSqliteBusy(error)) return null;
		throw error;
	} finally {
		db.pragma(`busy_timeout = ${Number(previous) || 0}`);
	}
}

/**
 * Check what changed since the last slice, within a time limit. Never reads more than a
 * window of rows between checks of the limit.
 *
 * A slice first reads whether there is anything to write. Only then does it take the write
 * lock and work under it, so slices from the sync pass and from the maintenance worker run
 * one at a time and each sees the position the other stored.
 */
export function runReplicationBackfillSlice(
	db: Database,
	options: ReplicationBackfillSliceOptions = {},
): ReplicationBackfillSliceResult {
	const idle: ReplicationBackfillSliceResult = { opsCreated: 0, keysMigrated: 0, complete: true };
	// Without a device identity no row can be attributed; leave the position untouched so the
	// first pass after an identity exists covers every row.
	const localDeviceId = localReplicationDeviceId(db);
	if (!localDeviceId) return idle;

	const clock = options.clock ?? Date.now;
	const started = clock();
	const maxRuntimeMs = options.maxRuntimeMs ?? DEFAULT_REPLICATION_BACKFILL_SLICE_MS;
	const now = (options.now ?? (() => new Date()))();
	const timing: SliceTiming = {
		nowIso: now.toISOString(),
		recheckFrom: new Date(now.getTime() - RECHECK_WINDOW_MS).toISOString(),
		outOfTime: (shareOfLimit) =>
			Boolean(options.signal?.aborted) || clock() - started >= maxRuntimeMs * shareOfLimit,
	};
	if (!hasWork(db, timing, localDeviceId)) return idle;

	const result = withWriteLock(db, options.waitForWriteLock ?? true, () =>
		runLockedSlice(db, timing, { localDeviceId, warn: options.warn ?? console.warn }),
	);
	return result ?? { ...idle, complete: false };
}

/**
 * A maintenance worker pass: slices with pauses between them, so other writers get the lock,
 * until everything is checked or the pass's time limit is spent. Here `maxRuntimeMs` limits
 * the whole pass and defaults to the retention passes' five seconds.
 */
export async function runReplicationBackfillPass(
	db: Database,
	options: ReplicationBackfillSliceOptions = {},
): Promise<ReplicationBackfillSliceResult> {
	const budget = startRetentionBudget(options);
	const total: ReplicationBackfillSliceResult = { opsCreated: 0, keysMigrated: 0, complete: false };
	while (true) {
		const slice = runReplicationBackfillSlice(db, { ...options, maxRuntimeMs: PASS_SLICE_MS });
		total.opsCreated += slice.opsCreated;
		total.keysMigrated += slice.keysMigrated;
		total.complete = slice.complete;
		if (slice.complete || budget.outOfBudget()) return total;
		await sleep(PASS_PAUSE_MS);
	}
}

/**
 * Runs the backfill in the maintenance worker, so the first full check of an existing store
 * and the regular check for new rows both happen outside the process that serves requests.
 * It shares the retention runners' timer and failure handling.
 */
export class ReplicationBackfillRunner extends PeriodicRetentionRunner {
	protected readonly label = "Replication backfill";
	private readonly warn: (message: string) => void;

	constructor(options: PeriodicRetentionRunnerOptions = {}) {
		super({
			initialDelayMs: 15_000,
			// Sync passes run every two minutes by default; new rows get their op before the next.
			idleIntervalMs: 60_000,
			backlogIntervalMs: 5_000,
			...options,
		});
		this.warn = options.logger ? (message) => options.logger?.warn(message) : console.warn;
	}

	protected async runPass(db: Database): Promise<RetentionPassOutcome> {
		const result = await runReplicationBackfillPass(db, { signal: this.signal, warn: this.warn });
		return {
			// The shared runner logs a pass that changed rows.
			purged: result.opsCreated + result.keysMigrated,
			complete: result.complete,
			summary: `Replication backfill recorded ${result.opsCreated} sync changes and rewrote ${result.keysMigrated} legacy import keys`,
		};
	}
}
