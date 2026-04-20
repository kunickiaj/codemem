import { statSync } from "node:fs";
import { assertSchemaReady, connect, getSchemaVersion, resolveDbPath } from "./db.js";
import { withDb } from "./maintenance/with-db.js";
import { ensureMaintenanceJobsSchema } from "./maintenance-jobs.js";
import { bootstrapSchema } from "./schema-bootstrap.js";

export {
	applyRawEventRelinkPlan,
	applyRawEventRelinkPlanWithDb,
	getRawEventRelinkPlan,
	getRawEventRelinkReport,
} from "./maintenance/relink.js";
export { getRawEventStatus, retryRawEventFailures } from "./maintenance/status.js";
export type {
	MemoryRole,
	MemoryRoleProbeComparison,
	MemoryRoleProbeItem,
	MemoryRoleProbeResult,
	MemoryRoleReport,
	MemoryRoleReportComparison,
	MemoryRoleReportComparisonOptions,
	MemoryRoleReportOptions,
	RawEventRelinkAction,
	RawEventRelinkApplyOptions,
	RawEventRelinkApplyResult,
	RawEventRelinkGroup,
	RawEventRelinkPlan,
	RawEventRelinkPlanOptions,
	RawEventRelinkReport,
	RawEventRelinkReportOptions,
	RawEventStatusItem,
	RawEventStatusResult,
} from "./maintenance/types.js";

import { applyRawEventRelinkPlanWithDb } from "./maintenance/relink.js";

export {
	compareMemoryRoleReports,
	getMemoryRoleReport,
} from "./maintenance/memory-role-report.js";

export function initDatabase(dbPath?: string): { path: string; sizeBytes: number } {
	const resolvedPath = resolveDbPath(dbPath);
	const db = connect(resolvedPath);
	try {
		if (getSchemaVersion(db) === 0) {
			bootstrapSchema(db);
		}
		assertSchemaReady(db);
		ensureMaintenanceJobsSchema(db);
		applyRawEventRelinkPlanWithDb(db);
		const stats = statSync(resolvedPath);
		return { path: resolvedPath, sizeBytes: stats.size };
	} finally {
		db.close();
	}
}

export function vacuumDatabase(dbPath?: string): { path: string; sizeBytes: number } {
	return withDb(dbPath, (db, resolvedPath) => {
		db.exec("VACUUM");
		const stats = statSync(resolvedPath);
		return { path: resolvedPath, sizeBytes: stats.size };
	});
}

// ---------------------------------------------------------------------------
// Reliability metrics
// ---------------------------------------------------------------------------

export type { GateResult, ReliabilityMetrics } from "./maintenance/reliability.js";
export { getReliabilityMetrics, rawEventsGate } from "./maintenance/reliability.js";

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export type {
	BackfillTagsTextOptions,
	BackfillTagsTextResult,
} from "./maintenance/backfill-tags.js";
export { backfillTagsText } from "./maintenance/backfill-tags.js";

export type {
	DeactivateLowSignalMemoriesOptions,
	DeactivateLowSignalResult,
} from "./maintenance/low-signal.js";
export {
	deactivateLowSignalMemories,
	deactivateLowSignalObservations,
} from "./maintenance/low-signal.js";

// ---------------------------------------------------------------------------
// Retroactive near-duplicate deactivation
// ---------------------------------------------------------------------------

export type {
	DedupNearDuplicatesOptions,
	DedupNearDuplicatesResult,
} from "./maintenance/dedup.js";
export { dedupNearDuplicateMemories } from "./maintenance/dedup.js";

// ---------------------------------------------------------------------------
// Heuristic narrative extraction from session_summary body_text
// ---------------------------------------------------------------------------

export type {
	BackfillNarrativeOptions,
	BackfillNarrativeResult,
} from "./maintenance/backfill-narrative.js";
export { backfillNarrativeFromBody } from "./maintenance/backfill-narrative.js";
export type {
	BackfillDedupKeysOptions,
	BackfillDedupKeysPlan,
	BackfillDedupKeysResult,
} from "./maintenance/dedup-keys.js";
export {
	applyMemoryDedupKeyUpdates,
	backfillMemoryDedupKeys,
	planMemoryDedupKeys,
} from "./maintenance/dedup-keys.js";
export { extractNarrativeFromBody } from "./maintenance/narrative-extract.js";

// ---------------------------------------------------------------------------
// AI structured-content backfill
// ---------------------------------------------------------------------------

export type {
	AIBackfillStructuredContentOptions,
	AIBackfillStructuredContentResult,
} from "./maintenance/ai-structured.js";
export { aiBackfillStructuredContent } from "./maintenance/ai-structured.js";
