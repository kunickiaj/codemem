/**
 * Historical cleanup for sessions that accumulated multiple active
 * `session_summary` memories before the write-path guard in
 * `ingest-pipeline.ts#supersedePriorObserverSummaries` landed.
 *
 * For each session with more than one active `observer_summary` row, keep
 * the most recent one (by created_at, tie-break by id) and soft-delete the
 * rest with `superseded_at` / `superseded_by` audit metadata + replication
 * delete ops — matching the semantics the live write path now enforces
 * on every flush.
 *
 * Only runs against rows where `metadata.source === "observer_summary"`.
 * Manually-created or legacy-imported session summaries are left alone.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import { connect, fromJson, resolveDbPath, toJson } from "./db.js";
import {
	completeMaintenanceJob,
	failMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import { recordReplicationOp } from "./sync-replication.js";

export const SUMMARY_DEDUP_BACKFILL_JOB = "session_summary_dedup_backfill";

type SummaryDedupBackfillMetadata = {
	total_sessions?: number;
	processed_sessions?: number;
	superseded_rows?: number;
	last_session_id?: number;
};

export interface SummaryDedupBackfillRunnerOptions {
	batchSize?: number;
	intervalMs?: number;
	dbPath?: string;
	signal?: AbortSignal;
	deviceId?: string;
}

interface CandidateRow {
	id: number;
	rev: number | null;
	metadata_json: string | null;
	created_at: string;
}

interface SessionPlan {
	session_id: number;
	winner_id: number;
	superseded: CandidateRow[];
}

function countPendingSessions(db: SqliteDatabase): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n FROM (
				SELECT session_id
				FROM memory_items
				WHERE active = 1
				  AND kind = 'session_summary'
				  AND json_extract(metadata_json, '$.source') = 'observer_summary'
				GROUP BY session_id
				HAVING COUNT(*) > 1
			)`,
		)
		.get() as { n: number } | undefined;
	return Number(row?.n ?? 0);
}

export function hasPendingSummaryDedupBackfill(db: SqliteDatabase): boolean {
	// Intentionally work-driven, not status-gated: this backfill is a
	// continuous cleanup — sync can bring in new observer summaries that
	// raise a session's active-summary count above 1 long after the initial
	// job row was marked completed. Announcing and re-running on the next
	// viewer start is the intended behavior in that case.
	return countPendingSessions(db) > 0;
}

function getExistingMetadata(db: SqliteDatabase): SummaryDedupBackfillMetadata {
	return (getMaintenanceJob(db, SUMMARY_DEDUP_BACKFILL_JOB)?.metadata ??
		{}) as SummaryDedupBackfillMetadata;
}

function planBatch(db: SqliteDatabase, afterSessionId: number, batchSize: number): SessionPlan[] {
	const sessionRows = db
		.prepare(
			`SELECT session_id
			 FROM memory_items
			 WHERE active = 1
			   AND kind = 'session_summary'
			   AND json_extract(metadata_json, '$.source') = 'observer_summary'
			   AND session_id > ?
			 GROUP BY session_id
			 HAVING COUNT(*) > 1
			 ORDER BY session_id ASC
			 LIMIT ?`,
		)
		.all(afterSessionId, batchSize) as Array<{ session_id: number }>;

	if (sessionRows.length === 0) return [];

	const rowStmt = db.prepare(
		`SELECT id, rev, metadata_json, created_at
		 FROM memory_items
		 WHERE session_id = ?
		   AND active = 1
		   AND kind = 'session_summary'
		   AND json_extract(metadata_json, '$.source') = 'observer_summary'
		 ORDER BY created_at DESC, id DESC`,
	);

	const plans: SessionPlan[] = [];
	for (const { session_id } of sessionRows) {
		const rows = rowStmt.all(session_id) as CandidateRow[];
		if (rows.length < 2) continue;
		const [winner, ...rest] = rows;
		if (!winner) continue;
		plans.push({ session_id, winner_id: winner.id, superseded: rest });
	}
	return plans;
}

function applySessionPlan(db: SqliteDatabase, plan: SessionPlan, deviceId: string): number {
	const now = new Date().toISOString();
	const updateStmt = db.prepare(
		`UPDATE memory_items
		 SET active = 0,
		     deleted_at = ?,
		     updated_at = ?,
		     metadata_json = ?,
		     rev = ?
		 WHERE id = ?`,
	);

	let superseded = 0;
	for (const row of plan.superseded) {
		const meta = fromJson(row.metadata_json);
		meta.superseded_at = now;
		meta.superseded_by = plan.winner_id;
		meta.clock_device_id = deviceId;
		updateStmt.run(now, now, toJson(meta), (row.rev ?? 0) + 1, row.id);
		try {
			recordReplicationOp(db, {
				memoryId: row.id,
				opType: "delete",
				deviceId,
			});
		} catch {
			// Replication-op recording is best-effort; continue with supersede.
		}
		superseded += 1;
	}
	return superseded;
}

export interface SummaryDedupBackfillPassOptions {
	batchSize?: number;
	deviceId?: string;
}

export async function runSummaryDedupBackfillPass(
	db: SqliteDatabase,
	options: SummaryDedupBackfillPassOptions = {},
): Promise<boolean> {
	const batchSize = Math.max(1, options.batchSize ?? 50);
	const deviceId = options.deviceId ?? "local";
	const existingJob = getMaintenanceJob(db, SUMMARY_DEDUP_BACKFILL_JOB);
	const existingMetadata = getExistingMetadata(db);
	// A previous run can leave `last_session_id` at the highest seen id. If
	// new duplicates later appear on older session_ids (e.g. via sync import),
	// resuming from that cursor would silently skip them and leave the job
	// pending forever while the runner exits. Restart the scan from 0 whenever
	// we're beginning a fresh pass (no prior job, or it's in a terminal state).
	const startingFresh =
		!existingJob || existingJob.status === "completed" || existingJob.status === "failed";
	const lastSessionId = startingFresh ? 0 : Number(existingMetadata.last_session_id ?? 0);

	const plans = planBatch(db, lastSessionId, batchSize);
	const processedBefore = startingFresh ? 0 : Number(existingMetadata.processed_sessions ?? 0);
	const supersededBefore = startingFresh ? 0 : Number(existingMetadata.superseded_rows ?? 0);

	if (plans.length === 0) {
		if (existingJob && existingJob.status !== "completed") {
			completeMaintenanceJob(db, SUMMARY_DEDUP_BACKFILL_JOB, {
				message:
					supersededBefore > 0
						? `Session-summary dedup complete (${supersededBefore} rows superseded)`
						: "Session-summary dedup complete",
				progressCurrent: processedBefore,
				progressTotal: Number(existingMetadata.total_sessions ?? processedBefore),
				metadata: {
					...existingMetadata,
					last_session_id: lastSessionId,
				},
			});
		}
		return false;
	}

	if (!existingJob || existingJob.status === "completed" || existingJob.status === "failed") {
		const initialTotal = countPendingSessions(db);
		startMaintenanceJob(db, {
			kind: SUMMARY_DEDUP_BACKFILL_JOB,
			title: "Deduplicating historical session summaries",
			message: `Cleaning up ${initialTotal} sessions with duplicate observer summaries`,
			progressTotal: initialTotal,
			progressUnit: "sessions",
			metadata: {
				total_sessions: initialTotal,
				processed_sessions: processedBefore,
				superseded_rows: supersededBefore,
				last_session_id: lastSessionId,
			},
		});
	}

	let supersededInBatch = 0;
	let maxSessionId = lastSessionId;
	const runTxn = db.transaction(() => {
		for (const plan of plans) {
			supersededInBatch += applySessionPlan(db, plan, deviceId);
			if (plan.session_id > maxSessionId) maxSessionId = plan.session_id;
		}
	});
	runTxn();

	const processedAfter = processedBefore + plans.length;
	const supersededAfter = supersededBefore + supersededInBatch;
	const remaining = countPendingSessions(db);
	const totalSessions = Math.max(
		Number(existingMetadata.total_sessions ?? processedAfter),
		processedAfter + remaining,
	);

	if (remaining === 0) {
		completeMaintenanceJob(db, SUMMARY_DEDUP_BACKFILL_JOB, {
			message: `Session-summary dedup complete (${supersededAfter} rows superseded across ${processedAfter} sessions)`,
			progressCurrent: processedAfter,
			progressTotal: totalSessions,
			metadata: {
				total_sessions: totalSessions,
				processed_sessions: processedAfter,
				superseded_rows: supersededAfter,
				last_session_id: maxSessionId,
			},
		});
		return false;
	}

	updateMaintenanceJob(db, SUMMARY_DEDUP_BACKFILL_JOB, {
		message: `Deduplicated ${processedAfter} of ${totalSessions} sessions (${supersededAfter} rows superseded)`,
		progressCurrent: processedAfter,
		progressTotal: totalSessions,
		metadata: {
			total_sessions: totalSessions,
			processed_sessions: processedAfter,
			superseded_rows: supersededAfter,
			last_session_id: maxSessionId,
		},
	});
	return true;
}

export class SummaryDedupBackfillRunner {
	private readonly dbPath: string;
	private readonly signal?: AbortSignal;
	private readonly batchSize: number;
	private readonly intervalMs: number;
	private readonly deviceId?: string;
	private active = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private currentRun: Promise<void> | null = null;

	constructor(options: SummaryDedupBackfillRunnerOptions = {}) {
		this.dbPath = resolveDbPath(options.dbPath);
		this.signal = options.signal;
		this.batchSize = Math.max(1, options.batchSize ?? 50);
		this.intervalMs = Math.max(1000, options.intervalMs ?? 5000);
		this.deviceId = options.deviceId;
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
					console.error("Summary-dedup backfill runner tick failed:", err);
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
			const hasMoreWork = await runSummaryDedupBackfillPass(db, {
				batchSize: this.batchSize,
				deviceId: this.deviceId,
			});
			if (!hasMoreWork) {
				this.active = false;
			}
		} catch (error) {
			if (db) {
				failMaintenanceJob(
					db,
					SUMMARY_DEDUP_BACKFILL_JOB,
					error instanceof Error ? error.message : String(error),
				);
			}
			console.warn("Summary-dedup backfill runner failed", error);
		} finally {
			db?.close();
		}
	}
}
