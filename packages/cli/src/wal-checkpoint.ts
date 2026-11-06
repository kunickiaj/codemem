import type { Database } from "@codemem/core";

export interface WalCheckpointLogger {
	step(message: string): void;
	warn(message: string): void;
}

export interface WalCheckpointResult {
	/** Frames still in the WAL after the passive pass, or null when the pass failed. */
	remainingFrames: number | null;
	truncated: boolean;
	elapsedMs: number;
}

type CheckpointRow = { busy: number; log: number; checkpointed: number };

/** Log a checkpoint that took at least this long, so writer stalls show up in logs. */
export const SLOW_WAL_CHECKPOINT_MS = 250;

function isBusy(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return (
		typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
	);
}

function runCheckpoint(db: Database, mode: "PASSIVE" | "TRUNCATE"): CheckpointRow | null {
	try {
		return (db.pragma(`wal_checkpoint(${mode})`) as CheckpointRow[])[0] ?? null;
	} catch (error) {
		if (isBusy(error)) return null;
		throw error;
	}
}

/** TRUNCATE takes the writer lock; with no busy wait it gives up instead of stalling writers. */
function truncateWithoutWaiting(db: Database): boolean {
	const timeout = Number(db.pragma("busy_timeout", { simple: true }));
	db.pragma("busy_timeout = 0");
	try {
		const row = runCheckpoint(db, "TRUNCATE");
		return row !== null && row.busy === 0;
	} finally {
		db.pragma(`busy_timeout = ${timeout}`);
	}
}

/**
 * Keep the WAL from growing without blocking other writers.
 *
 * A PASSIVE checkpoint copies frames without taking the writer lock. Only once
 * it has copied every frame does a TRUNCATE try to reset the file, and it runs
 * with busy_timeout 0, so a busy database skips the truncate until the next run
 * instead of holding off writers. The old TRUNCATE-only checkpoint waited up to
 * busy_timeout and blocked new writers while it waited.
 */
export function checkpointWalWithoutBlocking(
	db: Database,
	logger: WalCheckpointLogger,
	now: () => number = () => performance.now(),
): WalCheckpointResult {
	const started = now();
	const passive = runCheckpoint(db, "PASSIVE");
	const copiedAll = passive !== null && passive.busy === 0 && passive.checkpointed >= passive.log;
	const truncated = copiedAll ? truncateWithoutWaiting(db) : false;
	const elapsedMs = now() - started;
	const remainingFrames = passive === null ? null : Math.max(0, passive.log - passive.checkpointed);
	if (elapsedMs >= SLOW_WAL_CHECKPOINT_MS) {
		logger.step(
			`WAL checkpoint took ${Math.round(elapsedMs)} ms (${remainingFrames ?? "unknown"} frames left, truncated: ${truncated ? "yes" : "no"})`,
		);
	}
	return { remainingFrames, truncated, elapsedMs };
}
