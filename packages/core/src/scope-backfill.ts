/**
 * Safe scope backfill for legacy memories and replication ops.
 *
 * Phase 1 scope metadata is classification only. This backfill deliberately
 * under-shares: private/personal memories go to the local-only scope, and
 * legacy shared memories go to a review scope rather than an org/team scope.
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
import { LOCAL_DEFAULT_SCOPE_ID } from "./scope-resolution.js";

export const LEGACY_SHARED_REVIEW_SCOPE_ID = "legacy-shared-review";
export const SCOPE_BACKFILL_JOB = "scope_id_backfill";

export type ScopeBackfillReason =
	| "private_or_personal"
	| "shared_with_canonical_workspace_review"
	| "shared_ambiguous_review";

export interface LegacyMemoryScopeInput {
	visibility?: string | null;
	workspaceKind?: string | null;
	workspaceId?: string | null;
	project?: string | null;
	cwd?: string | null;
	gitRemote?: string | null;
}

export interface LegacyMemoryScopeClassification {
	scopeId: string;
	reason: ScopeBackfillReason;
	needsReview: boolean;
}

export interface ScopeBackfillResult {
	seededScopes: number;
	checkedMemoryItems: number;
	updatedMemoryItems: number;
	checkedReplicationOps: number;
	updatedReplicationOps: number;
	skippedReplicationOps: number;
	remainingMemoryItems: number;
	remainingReplicationOps: number;
}

export interface ScopeBackfillOptions {
	memoryLimit?: number;
	replicationOpLimit?: number;
	now?: string;
}

export interface ScopeBackfillRunnerOptions {
	batchSize?: number;
	intervalMs?: number;
	dbPath?: string;
	signal?: AbortSignal;
}

type ScopeBackfillMetadata = {
	seeded_scopes?: number;
	processed_memories?: number;
	updated_memories?: number;
	processed_replication_ops?: number;
	updated_replication_ops?: number;
	skipped_replication_ops?: number;
	remaining_memories?: number;
	remaining_replication_ops?: number;
	// Live count of unstamped replication_ops captured the last time the
	// runner reached a quiescent state (pendingWorkCount == 0). The cheap
	// startup probe uses this to distinguish "all remaining ops are
	// already-known-unstampable" (no work) from "new ops have arrived
	// since the runner last finished" (there is work).
	unstamped_replication_ops_at_completion?: number;
	// Highest memory_items.id with a non-empty scope_id at completion.
	// Orphan replication_ops can become stampable later when a matching
	// memory_items row finally gets stamped — the unstamped op count
	// won't grow in that case, but new work has appeared. Probing for
	// memory_items past this id catches that scenario without joining
	// replication_ops × memory_items.
	max_stamped_memory_id_at_completion?: number;
};

interface MemoryScopeCandidateRow {
	id: number;
	visibility: string | null;
	workspace_id: string | null;
	workspace_kind: string | null;
	project: string | null;
	cwd: string | null;
	git_remote: string | null;
}

interface ReplicationOpScopeCandidateRow {
	op_id: string;
	entity_id: string;
}

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function hasCanonicalWorkspaceSignal(input: LegacyMemoryScopeInput): boolean {
	if (clean(input.gitRemote)) return true;
	if (clean(input.cwd)) return true;
	const workspaceId = clean(input.workspaceId);
	return workspaceId != null && workspaceId !== "shared:default";
}

export function classifyLegacyMemoryScope(
	input: LegacyMemoryScopeInput,
): LegacyMemoryScopeClassification {
	const visibility = clean(input.visibility)?.toLowerCase() ?? null;
	const workspaceKind = clean(input.workspaceKind)?.toLowerCase() ?? null;
	const workspaceId = clean(input.workspaceId)?.toLowerCase() ?? null;

	if (
		visibility === "private" ||
		visibility === "personal" ||
		workspaceKind === "personal" ||
		workspaceId?.startsWith("personal:")
	) {
		return {
			scopeId: LOCAL_DEFAULT_SCOPE_ID,
			reason: "private_or_personal",
			needsReview: false,
		};
	}

	return {
		scopeId: LEGACY_SHARED_REVIEW_SCOPE_ID,
		reason: hasCanonicalWorkspaceSignal(input)
			? "shared_with_canonical_workspace_review"
			: "shared_ambiguous_review",
		needsReview: true,
	};
}

function countMissingRequiredScopes(db: SqliteDatabase): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n
			 FROM (SELECT ? AS scope_id UNION ALL SELECT ? AS scope_id) required
			 WHERE NOT EXISTS (
				SELECT 1 FROM replication_scopes rs WHERE rs.scope_id = required.scope_id
			 )`,
		)
		.get(LOCAL_DEFAULT_SCOPE_ID, LEGACY_SHARED_REVIEW_SCOPE_ID) as { n: number } | undefined;
	return Number(row?.n ?? 0);
}

export function ensureScopeBackfillScopes(
	db: SqliteDatabase,
	now = new Date().toISOString(),
): number {
	const insert = db.prepare(
		`INSERT OR IGNORE INTO replication_scopes(
			scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, ?, 'local', 0, 'active', ?, ?)`,
	);
	return db.transaction(() => {
		let inserted = 0;
		inserted += Number(
			insert.run(LOCAL_DEFAULT_SCOPE_ID, "Local only", "system", now, now).changes ?? 0,
		);
		inserted += Number(
			insert.run(LEGACY_SHARED_REVIEW_SCOPE_ID, "Legacy shared review", "system", now, now)
				.changes ?? 0,
		);
		return inserted;
	})();
}

function countPendingMemoryScopes(db: SqliteDatabase): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n
			 FROM memory_items
			 WHERE scope_id IS NULL OR TRIM(scope_id) = ''`,
		)
		.get() as { n: number } | undefined;
	return Number(row?.n ?? 0);
}

function maxStampedMemoryId(db: SqliteDatabase): number {
	// Highest id of memory_items with a non-empty scope_id. Used as the
	// other half of the cheap startup probe — when a new stamped memory
	// row appears past this id, an existing orphan op might become
	// stampable, even if the unstamped op count itself hasn't moved.
	const row = db
		.prepare(
			`SELECT MAX(id) AS max_id
			 FROM memory_items
			 WHERE scope_id IS NOT NULL AND TRIM(scope_id) <> ''`,
		)
		.get() as { max_id: number | null } | undefined;
	return Number(row?.max_id ?? 0);
}

function countAllUnstampedReplicationOps(db: SqliteDatabase): number {
	// Index-aided via idx_replication_ops_scope_created. Counts every
	// unstamped op (stampable or not) — used to set the
	// "unstamped_replication_ops_at_completion" watermark and to read it
	// back from the cheap startup probe.
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n
			 FROM replication_ops
			 WHERE entity_type = 'memory_item'
			   AND (scope_id IS NULL OR TRIM(scope_id) = '')`,
		)
		.get() as { n: number } | undefined;
	return Number(row?.n ?? 0);
}

function countPendingReplicationOpScopes(db: SqliteDatabase): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n
			 FROM replication_ops ro
			 WHERE ro.entity_type = 'memory_item'
			   AND (ro.scope_id IS NULL OR TRIM(ro.scope_id) = '')
			   AND EXISTS (
				SELECT 1
				FROM memory_items mi
				WHERE (mi.import_key = ro.entity_id OR CAST(mi.id AS TEXT) = ro.entity_id)
				  AND mi.scope_id IS NOT NULL
				  AND TRIM(mi.scope_id) != ''
			   )`,
		)
		.get() as { n: number } | undefined;
	return Number(row?.n ?? 0);
}

function pendingWorkCount(db: SqliteDatabase): number {
	return (
		countMissingRequiredScopes(db) +
		countPendingMemoryScopes(db) +
		countPendingReplicationOpScopes(db)
	);
}

/**
 * Cheap existence probe used by the viewer's backfill coordinator at
 * startup. Must avoid the full COUNT(*) + correlated-EXISTS scan in
 * pendingWorkCount; on databases with even moderate replication_ops
 * volume that scan blocks the main thread for tens of seconds, freezing
 * the HTTP server before the backfill runner can even log itself.
 *
 * The runner still calls pendingWorkCount inside its paced ticks for
 * progress accounting; this helper only answers "is there any work to
 * do at all?" with index-friendly probes.
 */
export function hasPendingScopeBackfill(db: SqliteDatabase): boolean {
	const missingRequired = db
		.prepare(
			`SELECT 1
			 FROM (SELECT ? AS scope_id UNION ALL SELECT ? AS scope_id) required
			 WHERE NOT EXISTS (
				SELECT 1 FROM replication_scopes rs WHERE rs.scope_id = required.scope_id
			 )
			 LIMIT 1`,
		)
		.get(LOCAL_DEFAULT_SCOPE_ID, LEGACY_SHARED_REVIEW_SCOPE_ID);
	if (missingRequired) return true;

	const pendingMemory = db
		.prepare(
			`SELECT 1
			 FROM memory_items
			 WHERE scope_id IS NULL OR TRIM(scope_id) = ''
			 LIMIT 1`,
		)
		.get();
	if (pendingMemory) return true;

	// For replication ops we can't cheaply distinguish "stampable" from
	// "already known unstampable" with a join — the correlated EXISTS over
	// memory_items.import_key OR CAST(id AS TEXT) is exactly the scan that
	// freezes the event loop on Pi-class hardware. Instead: a watermark.
	// When the runner reaches a quiescent state (pendingWorkCount == 0) it
	// snapshots the live count of unstamped replication_ops in
	// metadata.unstamped_replication_ops_at_completion. The startup probe
	// then asks "is the live unstamped count still equal to the watermark?"
	// — if so, no new work; if it grew, new ops have arrived and the
	// runner should sweep again. Both queries hit
	// idx_replication_ops_scope_created.
	const unstampedCount = countAllUnstampedReplicationOps(db);
	if (unstampedCount === 0) return false;

	const job = getMaintenanceJob(db, SCOPE_BACKFILL_JOB);
	if (!job || job.status !== "completed") return true;
	const metadata = (job.metadata ?? {}) as ScopeBackfillMetadata;
	const opWatermark = metadata.unstamped_replication_ops_at_completion;
	if (typeof opWatermark !== "number") return true;
	if (unstampedCount > opWatermark) return true;

	// Even when the unstamped op count is unchanged, a previously orphan op
	// can become stampable later if a matching memory_items row arrives
	// with a scope. Watch the stamped-memory id watermark for growth: any
	// new memory_items row stamped beyond it might match an orphan op, so
	// the runner needs another sweep to reclassify.
	const memoryWatermark = metadata.max_stamped_memory_id_at_completion;
	if (typeof memoryWatermark !== "number") return true;
	const newStamped = db
		.prepare(
			`SELECT 1
			 FROM memory_items
			 WHERE id > ?
			   AND scope_id IS NOT NULL AND TRIM(scope_id) <> ''
			 LIMIT 1`,
		)
		.get(memoryWatermark);
	return Boolean(newStamped);
}

function selectMemoryScopeCandidates(db: SqliteDatabase, limit: number): MemoryScopeCandidateRow[] {
	return db
		.prepare(
			`SELECT
				mi.id,
				mi.visibility,
				mi.workspace_id,
				mi.workspace_kind,
				s.project,
				s.cwd,
				s.git_remote
			 FROM memory_items mi
			 LEFT JOIN sessions s ON s.id = mi.session_id
			 WHERE mi.scope_id IS NULL OR TRIM(mi.scope_id) = ''
			 ORDER BY mi.id ASC
			 LIMIT ?`,
		)
		.all(limit) as MemoryScopeCandidateRow[];
}

function selectReplicationOpScopeCandidates(
	db: SqliteDatabase,
	limit: number,
): ReplicationOpScopeCandidateRow[] {
	return db
		.prepare(
			`SELECT ro.op_id, ro.entity_id
			 FROM replication_ops ro
			 WHERE ro.entity_type = 'memory_item'
			   AND (ro.scope_id IS NULL OR TRIM(ro.scope_id) = '')
			   AND EXISTS (
				SELECT 1
				FROM memory_items mi
				WHERE (mi.import_key = ro.entity_id OR CAST(mi.id AS TEXT) = ro.entity_id)
				  AND mi.scope_id IS NOT NULL
				  AND TRIM(mi.scope_id) != ''
			   )
			 ORDER BY ro.created_at ASC, ro.op_id ASC
			 LIMIT ?`,
		)
		.all(limit) as ReplicationOpScopeCandidateRow[];
}

function lookupMemoryScopeForOp(db: SqliteDatabase, entityId: string): string | null {
	const row = db
		.prepare(
			`SELECT scope_id
			 FROM memory_items
			 WHERE (import_key = ? OR CAST(id AS TEXT) = ?)
			   AND scope_id IS NOT NULL
			   AND TRIM(scope_id) != ''
			 ORDER BY CASE WHEN import_key = ? THEN 0 ELSE 1 END, id ASC
			 LIMIT 1`,
		)
		.get(entityId, entityId, entityId) as { scope_id: string | null } | undefined;
	return clean(row?.scope_id);
}

export function backfillScopeIds(
	db: SqliteDatabase,
	options: ScopeBackfillOptions = {},
): ScopeBackfillResult {
	const memoryLimit = Math.max(1, options.memoryLimit ?? 250);
	const replicationOpLimit = Math.max(1, options.replicationOpLimit ?? memoryLimit);
	const seededScopes = ensureScopeBackfillScopes(db, options.now);
	const memoryRows = selectMemoryScopeCandidates(db, memoryLimit);

	const updateMemoryScope = db.prepare(
		`UPDATE memory_items
		 SET scope_id = ?
		 WHERE id = ?
		   AND (scope_id IS NULL OR TRIM(scope_id) = '')`,
	);
	const updateOpScope = db.prepare(
		`UPDATE replication_ops
		 SET scope_id = ?
		 WHERE op_id = ?
		   AND (scope_id IS NULL OR TRIM(scope_id) = '')`,
	);

	const apply = db.transaction(() => {
		let updatedMemoryItems = 0;
		let updatedReplicationOps = 0;
		let skippedReplicationOps = 0;

		for (const row of memoryRows) {
			const classification = classifyLegacyMemoryScope({
				visibility: row.visibility,
				workspaceKind: row.workspace_kind,
				workspaceId: row.workspace_id,
				project: row.project,
				cwd: row.cwd,
				gitRemote: row.git_remote,
			});
			updatedMemoryItems += Number(
				updateMemoryScope.run(classification.scopeId, row.id).changes ?? 0,
			);
		}

		const opRows = selectReplicationOpScopeCandidates(db, replicationOpLimit);
		for (const row of opRows) {
			const scopeId = lookupMemoryScopeForOp(db, row.entity_id);
			if (!scopeId) {
				skippedReplicationOps += 1;
				continue;
			}
			updatedReplicationOps += Number(updateOpScope.run(scopeId, row.op_id).changes ?? 0);
		}

		return {
			checkedReplicationOps: opRows.length,
			updatedMemoryItems,
			updatedReplicationOps,
			skippedReplicationOps,
		};
	});

	const applied = apply();

	return {
		seededScopes,
		checkedMemoryItems: memoryRows.length,
		updatedMemoryItems: applied.updatedMemoryItems,
		checkedReplicationOps: applied.checkedReplicationOps,
		updatedReplicationOps: applied.updatedReplicationOps,
		skippedReplicationOps: applied.skippedReplicationOps,
		remainingMemoryItems: countPendingMemoryScopes(db),
		remainingReplicationOps: countPendingReplicationOpScopes(db),
	};
}

function getExistingMetadata(db: SqliteDatabase): ScopeBackfillMetadata {
	return (getMaintenanceJob(db, SCOPE_BACKFILL_JOB)?.metadata ?? {}) as ScopeBackfillMetadata;
}

export async function runScopeBackfillPass(
	db: SqliteDatabase,
	options: { batchSize?: number } = {},
): Promise<boolean> {
	const batchSize = Math.max(1, options.batchSize ?? 250);
	const existingJob = getMaintenanceJob(db, SCOPE_BACKFILL_JOB);
	const existingMetadata = getExistingMetadata(db);
	const startingFresh =
		!existingJob || existingJob.status === "completed" || existingJob.status === "failed";
	const totalBefore = pendingWorkCount(db);

	if (totalBefore <= 0) {
		if (existingJob && existingJob.status !== "completed") {
			completeMaintenanceJob(db, SCOPE_BACKFILL_JOB, {
				message: "Scope backfill complete",
				progressCurrent: Number(existingMetadata.processed_memories ?? 0),
				progressTotal: Number(existingMetadata.processed_memories ?? 0),
				metadata: {
					...existingMetadata,
					remaining_memories: 0,
					remaining_replication_ops: 0,
					unstamped_replication_ops_at_completion: countAllUnstampedReplicationOps(db),
					max_stamped_memory_id_at_completion: maxStampedMemoryId(db),
				},
			});
		}
		return false;
	}

	if (startingFresh) {
		startMaintenanceJob(db, {
			kind: SCOPE_BACKFILL_JOB,
			title: "Backfilling sharing domains",
			message: `Backfilling ${totalBefore} legacy scope item(s)`,
			progressTotal: totalBefore,
			metadata: {
				seeded_scopes: 0,
				processed_memories: 0,
				updated_memories: 0,
				processed_replication_ops: 0,
				updated_replication_ops: 0,
				skipped_replication_ops: 0,
				remaining_memories: countPendingMemoryScopes(db),
				remaining_replication_ops: countPendingReplicationOpScopes(db),
			},
		});
	}

	const result = backfillScopeIds(db, {
		memoryLimit: batchSize,
		replicationOpLimit: batchSize,
	});
	const latestMetadata = startingFresh ? {} : existingMetadata;
	const seededScopes = Number(latestMetadata.seeded_scopes ?? 0) + result.seededScopes;
	const processedMemories =
		Number(latestMetadata.processed_memories ?? 0) + result.checkedMemoryItems;
	const updatedMemories = Number(latestMetadata.updated_memories ?? 0) + result.updatedMemoryItems;
	const processedReplicationOps =
		Number(latestMetadata.processed_replication_ops ?? 0) + result.checkedReplicationOps;
	const updatedReplicationOps =
		Number(latestMetadata.updated_replication_ops ?? 0) + result.updatedReplicationOps;
	const skippedReplicationOps =
		Number(latestMetadata.skipped_replication_ops ?? 0) + result.skippedReplicationOps;
	const remaining = pendingWorkCount(db);
	const progressCurrent = Math.max(totalBefore - remaining, 0);
	const metadata: ScopeBackfillMetadata = {
		seeded_scopes: seededScopes,
		processed_memories: processedMemories,
		updated_memories: updatedMemories,
		processed_replication_ops: processedReplicationOps,
		updated_replication_ops: updatedReplicationOps,
		skipped_replication_ops: skippedReplicationOps,
		remaining_memories: result.remainingMemoryItems,
		remaining_replication_ops: result.remainingReplicationOps,
	};

	if (remaining <= 0) {
		completeMaintenanceJob(db, SCOPE_BACKFILL_JOB, {
			message: "Scope backfill complete",
			progressCurrent: totalBefore,
			progressTotal: totalBefore,
			metadata: {
				...metadata,
				unstamped_replication_ops_at_completion: countAllUnstampedReplicationOps(db),
				max_stamped_memory_id_at_completion: maxStampedMemoryId(db),
			},
		});
		return false;
	}

	updateMaintenanceJob(db, SCOPE_BACKFILL_JOB, {
		message: `Backfilled sharing domains for ${progressCurrent} of ${totalBefore} item(s)`,
		progressCurrent,
		progressTotal: totalBefore,
		metadata,
	});
	return true;
}

export class ScopeBackfillRunner {
	private readonly dbPath: string;
	private readonly signal?: AbortSignal;
	private readonly batchSize: number;
	private readonly intervalMs: number;
	private active = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private currentRun: Promise<void> | null = null;

	constructor(options: ScopeBackfillRunnerOptions = {}) {
		this.dbPath = resolveDbPath(options.dbPath);
		this.signal = options.signal;
		this.batchSize = Math.max(1, options.batchSize ?? 250);
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
					console.error("Scope backfill runner tick failed:", err);
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
			const hasMoreWork = await runScopeBackfillPass(db, { batchSize: this.batchSize });
			if (!hasMoreWork) {
				this.active = false;
			}
		} catch (error) {
			if (db) {
				failMaintenanceJob(
					db,
					SCOPE_BACKFILL_JOB,
					error instanceof Error ? error.message : String(error),
				);
			}
			console.warn("Scope backfill runner failed", error);
		} finally {
			db?.close();
		}
	}
}
