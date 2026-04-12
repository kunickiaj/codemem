/**
 * Ref backfill — maintenance job that populates `memory_file_refs` and
 * `memory_concept_refs` for existing `memory_items` that have JSON data in
 * `files_read`/`files_modified`/`concepts` columns but were written before
 * the junction tables existed.
 *
 * Uses `INSERT OR IGNORE` so the backfill is fully idempotent: memories that
 * already have ref rows populated (e.g. written after the write-time
 * population landed) simply have all their inserts ignored.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import { connect, resolveDbPath } from "./db.js";
import {
	completeMaintenanceJob,
	failMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import { normalizeConcept } from "./ref-populate.js";

export const REF_BACKFILL_JOB = "memory_ref_backfill";

type RefBackfillMetadata = {
	total_backfillable?: number;
	processed?: number;
	remaining?: number;
	last_cursor_id?: number;
};

export interface RefBackfillRunnerOptions {
	batchSize?: number;
	intervalMs?: number;
	dbPath?: string;
	signal?: AbortSignal;
}

/**
 * Check if any active memory_items have non-null files/concepts columns.
 * This is a cheap existence check — it does NOT verify whether ref rows
 * already exist (the backfill itself uses INSERT OR IGNORE for that).
 */
export function hasPendingRefBackfill(db: SqliteDatabase): boolean {
	const row = db
		.prepare(
			`SELECT 1 FROM memory_items mi
			 WHERE mi.active = 1
			   AND (mi.files_read IS NOT NULL OR mi.files_modified IS NOT NULL OR mi.concepts IS NOT NULL)
			   AND (
			     ((mi.files_read IS NOT NULL OR mi.files_modified IS NOT NULL) AND NOT EXISTS (
			       SELECT 1 FROM memory_file_refs mfr WHERE mfr.memory_id = mi.id
			     ))
			     OR
			     (mi.concepts IS NOT NULL AND NOT EXISTS (
			       SELECT 1 FROM memory_concept_refs mcr WHERE mcr.memory_id = mi.id
			     ))
			   )
			 LIMIT 1`,
		)
		.get();
	return row != null;
}

function getExistingMetadata(db: SqliteDatabase): RefBackfillMetadata {
	return ((getMaintenanceJob(db, REF_BACKFILL_JOB)?.metadata ?? {}) as RefBackfillMetadata) ?? {};
}

interface BackfillRow {
	id: number;
	files_read: string | null;
	files_modified: string | null;
	concepts: string | null;
}

function safeJsonArray(value: string | null): string[] | null {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((v): v is string => typeof v === "string");
	} catch {
		// corrupt JSON — skip gracefully
	}
	return null;
}

export async function runRefBackfillPass(
	db: SqliteDatabase,
	options: { batchSize?: number } = {},
): Promise<boolean> {
	const existingJob = getMaintenanceJob(db, REF_BACKFILL_JOB);
	const existingMetadata = getExistingMetadata(db);
	const batchSize = Math.max(1, options.batchSize ?? 50);
	const lastCursorId = Number(existingMetadata.last_cursor_id ?? 0);

	const rows = db
		.prepare(
			`SELECT mi.id, mi.files_read, mi.files_modified, mi.concepts
			 FROM memory_items mi
			 WHERE mi.active = 1
			   AND mi.id > ?
			   AND (mi.files_read IS NOT NULL OR mi.files_modified IS NOT NULL OR mi.concepts IS NOT NULL)
			 ORDER BY mi.id ASC
			 LIMIT ?`,
		)
		.all(lastCursorId, batchSize) as BackfillRow[];

	if (rows.length === 0) {
		if (existingJob && existingJob.status !== "completed") {
			const processed = Number(existingMetadata.processed ?? 0);
			completeMaintenanceJob(db, REF_BACKFILL_JOB, {
				message: "Ref backfill complete",
				progressCurrent: processed,
				progressTotal: Number(existingMetadata.total_backfillable ?? processed),
				metadata: {
					...existingMetadata,
					remaining: 0,
					last_cursor_id: lastCursorId,
				},
			});
		}
		return false;
	}

	const processedBefore = Number(existingMetadata.processed ?? 0);
	let progressTotal = Number(existingMetadata.total_backfillable ?? 0);

	if (!existingJob || existingJob.status === "completed" || existingJob.status === "failed") {
		const countRow = db
			.prepare(
				`SELECT COUNT(*) AS cnt FROM memory_items
				 WHERE active = 1
				   AND (files_read IS NOT NULL OR files_modified IS NOT NULL OR concepts IS NOT NULL)`,
			)
			.get() as { cnt: number };
		const initialTotal = countRow.cnt;
		startMaintenanceJob(db, {
			kind: REF_BACKFILL_JOB,
			title: "Backfilling memory file/concept refs",
			message: `Backfilling refs for ${initialTotal} memories`,
			progressTotal: initialTotal,
			metadata: {
				total_backfillable: initialTotal,
				processed: processedBefore,
				remaining: initialTotal,
				last_cursor_id: 0,
			},
		});
		progressTotal = initialTotal;
	}

	// Insert refs for each row
	const insertFileRef = db.prepare(
		"INSERT OR IGNORE INTO memory_file_refs (memory_id, file_path, relation) VALUES (?, ?, ?)",
	);
	const insertConceptRef = db.prepare(
		"INSERT OR IGNORE INTO memory_concept_refs (memory_id, concept) VALUES (?, ?)",
	);

	// Insert refs per-row (not per-batch) to keep write transactions short
	// and avoid blocking the viewer's read connections on large databases.
	const insertOneRow = db.transaction((row: BackfillRow) => {
		const filesRead = safeJsonArray(row.files_read);
		const filesModified = safeJsonArray(row.files_modified);
		const concepts = safeJsonArray(row.concepts);

		if (filesRead) {
			for (const path of filesRead) {
				if (path) insertFileRef.run(row.id, path, "read");
			}
		}
		if (filesModified) {
			for (const path of filesModified) {
				if (path) insertFileRef.run(row.id, path, "modified");
			}
		}
		if (concepts) {
			for (const concept of concepts) {
				const normalized = normalizeConcept(concept ?? "");
				if (normalized) insertConceptRef.run(row.id, normalized);
			}
		}
	});
	for (const row of rows) {
		insertOneRow(row);
	}

	const processedAfter = processedBefore + rows.length;
	const exhausted = rows.length < batchSize;
	// rows.length > 0 guaranteed by early return above
	const newCursor = (rows[rows.length - 1] as BackfillRow).id;

	if (exhausted) {
		const finalProgressTotal = Number(
			getExistingMetadata(db).total_backfillable ?? progressTotal ?? processedAfter,
		);
		completeMaintenanceJob(db, REF_BACKFILL_JOB, {
			message: "Ref backfill complete",
			progressCurrent: processedAfter,
			progressTotal: finalProgressTotal,
			metadata: {
				total_backfillable: finalProgressTotal,
				processed: processedAfter,
				remaining: 0,
				last_cursor_id: newCursor,
			},
		});
		return false;
	}

	updateMaintenanceJob(db, REF_BACKFILL_JOB, {
		message: `Backfilled refs for ${processedAfter} of ${progressTotal} memories`,
		progressCurrent: processedAfter,
		progressTotal,
		metadata: {
			total_backfillable: progressTotal,
			processed: processedAfter,
			remaining: Math.max(progressTotal - processedAfter, 0),
			last_cursor_id: newCursor,
		},
	});
	return true;
}

export class RefBackfillRunner {
	private readonly dbPath: string;
	private readonly signal?: AbortSignal;
	private readonly batchSize: number;
	private readonly intervalMs: number;
	private active = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private currentRun: Promise<void> | null = null;

	constructor(options: RefBackfillRunnerOptions = {}) {
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
					console.error("Ref backfill runner tick failed:", err);
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
			const hasMoreWork = await runRefBackfillPass(db, { batchSize: this.batchSize });
			if (!hasMoreWork) {
				this.active = false;
			}
		} catch (error) {
			if (db) {
				failMaintenanceJob(
					db,
					REF_BACKFILL_JOB,
					error instanceof Error ? error.message : String(error),
				);
			}
			console.warn("Ref backfill runner failed", error);
		} finally {
			db?.close();
		}
	}
}
