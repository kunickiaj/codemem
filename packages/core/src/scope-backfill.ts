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
	// Two-tick confirmation flag. The runner cannot atomically observe
	// "no stampable ops left" *and* persist the completion watermark in
	// the same instant — concurrent writers (sync daemon, raw-event
	// sweeper, local writes) can insert a new stampable op between the
	// batch-selection query returning empty and the watermark capture,
	// after which the watermark would already include the new row and
	// the cheap startup probe would treat it as accounted for. Require
	// the runner to observe an empty selection on TWO consecutive ticks
	// before declaring complete; any concurrent writer in the ~5s gap
	// resets this flag back to false on the next pass.
	exhausted_in_previous_pass?: boolean;
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
	// Split the original `(import_key = entity_id OR CAST(id AS TEXT) = entity_id)`
	// EXISTS into a UNION of two index-friendly INNER JOIN probes. The
	// import_key branch hits idx_memory_items_import_key directly; the
	// id branch hits the memory_items primary key after CAST. Without
	// this split the planner sees the OR clause and degrades to a full
	// scan of memory_items per replication_ops row, which is exactly
	// what pegged Pi-class hardware on real-shape databases.
	//
	// Subtlety on the id branch: `mi.id = CAST(entity_id AS INTEGER)` is
	// index-friendly but SQLite's INTEGER cast is lenient — strings like
	// "123abc" or "  42 " cast to 123 / 42 and would produce false-
	// positive matches that the old text-compare path filtered out.
	// We pair the integer compare (for index access) with a strict
	// text-equality check (`CAST(mi.id AS TEXT) = ro.entity_id`) that
	// the planner only evaluates on the small post-join candidate set,
	// preserving exact-match semantics. False positives would otherwise
	// occupy the batch slot, then fail to stamp via lookupMemoryScopeForOp
	// (which uses the original strict text-compare), starving real work.
	return db
		.prepare(
			`SELECT op_id, entity_id, created_at
			 FROM (
				SELECT ro.op_id, ro.entity_id, ro.created_at
				FROM replication_ops ro
				INNER JOIN memory_items mi ON mi.import_key = ro.entity_id
				WHERE ro.entity_type = 'memory_item'
				  AND (ro.scope_id IS NULL OR TRIM(ro.scope_id) = '')
				  AND mi.scope_id IS NOT NULL
				  AND TRIM(mi.scope_id) != ''
				UNION
				SELECT ro.op_id, ro.entity_id, ro.created_at
				FROM replication_ops ro
				INNER JOIN memory_items mi ON mi.id = CAST(ro.entity_id AS INTEGER)
				WHERE ro.entity_type = 'memory_item'
				  AND (ro.scope_id IS NULL OR TRIM(ro.scope_id) = '')
				  AND mi.scope_id IS NOT NULL
				  AND TRIM(mi.scope_id) != ''
				  AND CAST(mi.id AS TEXT) = ro.entity_id
			 )
			 ORDER BY created_at ASC, op_id ASC
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
		// Cheap, index-aided proxy. The earlier "stampable-only" count via
		// a correlated EXISTS join over memory_items was the slow query
		// that pegged Pi/M4 hardware on every batch tick. The runner uses
		// result.checkedReplicationOps === 0 (precise via the
		// EXISTS-with-LIMIT batch query) for completion; this number just
		// drives the progress bar, where slight over-counting (orphans
		// included) is acceptable.
		remainingReplicationOps: countAllUnstampedReplicationOps(db),
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

	// Cheap, index-friendly proxy for "is there work to potentially do?".
	// pendingWorkCount(db) (the legacy correlated-EXISTS COUNT(*) path)
	// freezes the libuv event loop on Pi-class hardware when
	// replication_ops is large; the runner cannot afford to call it
	// twice per tick. The actual batch-selection query in
	// backfillScopeIds (selectReplicationOpScopeCandidates) still runs
	// the precise EXISTS-with-LIMIT — that is bounded by batchSize so
	// it scans only as far as it needs to fill or exhaust the batch. A
	// pass that selects zero memory candidates AND zero op candidates
	// is the runner's completion signal.
	const initialMemoryPending = countPendingMemoryScopes(db);
	const initialOpPending = countAllUnstampedReplicationOps(db);
	const initialMissingScopes = countMissingRequiredScopes(db);
	const totalBefore = initialMemoryPending + initialOpPending + initialMissingScopes;

	if (totalBefore <= 0) {
		// "Nothing to do at startup" still has to honor the two-tick
		// confirmation guard — a concurrent writer between the count
		// above and a subsequent completion would otherwise be lost.
		// On the first such pass, arm the candidate-complete flag and
		// schedule another tick; on the second consecutive empty pass,
		// commit the watermarks and finish.
		const previouslyExhausted = Boolean(existingMetadata.exhausted_in_previous_pass);
		if (existingJob && existingJob.status !== "completed") {
			if (previouslyExhausted) {
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
				return false;
			}
			updateMaintenanceJob(db, SCOPE_BACKFILL_JOB, {
				message: "Scope backfill quiescent — confirming on next tick",
				progressCurrent: Number(existingMetadata.processed_memories ?? 0),
				progressTotal: Number(existingMetadata.processed_memories ?? 0),
				metadata: {
					...existingMetadata,
					remaining_memories: 0,
					remaining_replication_ops: 0,
					exhausted_in_previous_pass: true,
				},
			});
			return true;
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
				remaining_memories: initialMemoryPending,
				remaining_replication_ops: initialOpPending,
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

	// Completion signal: no pending memory items, no missing required
	// scopes, and the precise batch-selection query
	// (selectReplicationOpScopeCandidates) returned zero stampable ops.
	// That last condition is what was previously inferred from
	// pendingWorkCount(db) <= 0; result.checkedReplicationOps === 0
	// captures the same fact without paying for the slow COUNT(*).
	//
	// Concurrency guard: a single empty selection is not enough to
	// declare complete because a concurrent writer (sync daemon, raw
	// event sweeper, local memory writes) can insert a new stampable
	// op between the batch-selection query and the runner persisting
	// the completion watermark. Require TWO consecutive empty passes,
	// separated by the runner's ~5s gap, before completing — any
	// concurrent writer in that gap will surface as
	// `result.checkedReplicationOps > 0` on the next pass and clears
	// the candidate-complete flag.
	const remainingMemory = result.remainingMemoryItems;
	const stampableOpsExhausted = result.checkedReplicationOps === 0;
	const remainingMissingScopes = countMissingRequiredScopes(db);
	const passLooksDone =
		remainingMemory === 0 && stampableOpsExhausted && remainingMissingScopes === 0;
	const previouslyExhausted = Boolean(latestMetadata.exhausted_in_previous_pass);
	const isComplete = passLooksDone && previouslyExhausted;
	const progressCurrent = Math.max(
		totalBefore - (remainingMemory + remainingMissingScopes + (stampableOpsExhausted ? 0 : 1)),
		0,
	);
	const metadata: ScopeBackfillMetadata = {
		seeded_scopes: seededScopes,
		processed_memories: processedMemories,
		updated_memories: updatedMemories,
		processed_replication_ops: processedReplicationOps,
		updated_replication_ops: updatedReplicationOps,
		skipped_replication_ops: skippedReplicationOps,
		remaining_memories: remainingMemory,
		remaining_replication_ops: result.remainingReplicationOps,
		exhausted_in_previous_pass: passLooksDone,
	};

	if (isComplete) {
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
