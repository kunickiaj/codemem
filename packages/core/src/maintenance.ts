export { initDatabase, vacuumDatabase } from "./maintenance/init-vacuum.js";
export {
	compareMemoryRoleReports,
	getMemoryRoleReport,
} from "./maintenance/memory-role-report.js";
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
export type {
	ScanSecretsRetroactiveOptions,
	ScanSecretsRetroactiveResult,
} from "./maintenance/scan-secrets.js";
export { scanSecretsRetroactive } from "./maintenance/scan-secrets.js";
