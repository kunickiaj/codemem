/* Stats + usage endpoints consumed by the Health tab — raw pipeline
 * state, per-project token usage, session summaries, and raw-event
 * queue counters. All are simple GETs so the module stays thin. */

import type { ReadRequestOptions } from "../read-request";
import type {
	AutomaticRecallStats,
	CachedRawEventsPayload,
	CachedSessionPayload,
	CachedStatsPayload,
	CachedUsagePayload,
	HealthMaintenanceJob,
	RecentPack,
	UsageEventSummary,
	UsageTotals,
} from "../state";
import { fetchJson } from "./internal";

export type { AutomaticRecallStats } from "../state";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unitRatio(value: unknown): number | null {
	const ratio = finiteNumber(value);
	return ratio !== null && ratio >= 0 && ratio <= 1 ? ratio : null;
}

function nonNegativeInteger(value: unknown): number | null {
	return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function parseUsageTotals(value: unknown): UsageTotals | null {
	if (!isRecord(value) || value.token_unit !== "tokens") return null;
	const fields = [
		"tokens_read",
		"tokens_written",
		"tokens_saved",
		"count",
		"measured_count",
		"estimated_count",
		"unavailable_count",
		"legacy_text_length_count",
		"legacy_unclassified_count",
	] as const;
	if (fields.some((field) => nonNegativeInteger(value[field]) === null)) return null;
	return {
		tokens_read: Number(value.tokens_read),
		tokens_written: Number(value.tokens_written),
		tokens_saved: Number(value.tokens_saved),
		count: Number(value.count),
		token_unit: "tokens",
		measured_count: Number(value.measured_count),
		estimated_count: Number(value.estimated_count),
		unavailable_count: Number(value.unavailable_count),
		legacy_text_length_count: Number(value.legacy_text_length_count),
		legacy_unclassified_count: Number(value.legacy_unclassified_count),
	};
}

function parseUsageEvent(value: unknown): UsageEventSummary | null {
	if (!isRecord(value) || typeof value.event !== "string" || value.token_unit !== "tokens") {
		return null;
	}
	const fields = [
		"count",
		"total_tokens_read",
		"total_tokens_written",
		"total_tokens_saved",
		"measured_count",
		"estimated_count",
		"unavailable_count",
		"legacy_text_length_count",
		"legacy_unclassified_count",
	] as const;
	if (fields.some((field) => nonNegativeInteger(value[field]) === null)) return null;
	return {
		event: value.event,
		count: Number(value.count),
		total_tokens_read: Number(value.total_tokens_read),
		total_tokens_written: Number(value.total_tokens_written),
		total_tokens_saved: Number(value.total_tokens_saved),
		token_unit: "tokens",
		measured_count: Number(value.measured_count),
		estimated_count: Number(value.estimated_count),
		unavailable_count: Number(value.unavailable_count),
		legacy_text_length_count: Number(value.legacy_text_length_count),
		legacy_unclassified_count: Number(value.legacy_unclassified_count),
	};
}

function parseUsageEvents(value: unknown): UsageEventSummary[] | null {
	if (!Array.isArray(value)) return null;
	const events = value.map(parseUsageEvent);
	return events.every((event): event is UsageEventSummary => event !== null) ? events : null;
}

function parseRecentPack(value: unknown): RecentPack | null {
	if (
		!isRecord(value) ||
		typeof value.created_at !== "string" ||
		nonNegativeInteger(value.tokens_read) === null ||
		nonNegativeInteger(value.tokens_saved) === null ||
		(value.metadata_json !== null && !isRecord(value.metadata_json))
	) {
		return null;
	}
	const metadata = value.metadata_json as JsonRecord | null;
	if (
		metadata &&
		((metadata.exact_duplicates_collapsed !== undefined &&
			nonNegativeInteger(metadata.exact_duplicates_collapsed) === null) ||
			(metadata.exact_dedupe_enabled !== undefined &&
				typeof metadata.exact_dedupe_enabled !== "boolean"))
	) {
		return null;
	}
	return {
		created_at: value.created_at,
		tokens_read: value.tokens_read as number,
		tokens_saved: value.tokens_saved as number,
		metadata_json: metadata
			? {
					exact_duplicates_collapsed: metadata.exact_duplicates_collapsed as number | undefined,
					exact_dedupe_enabled: metadata.exact_dedupe_enabled as boolean | undefined,
				}
			: null,
	};
}

function parseMaintenanceJob(value: unknown): HealthMaintenanceJob | null {
	if (!isRecord(value) || !isRecord(value.progress)) return null;
	if (
		typeof value.kind !== "string" ||
		typeof value.title !== "string" ||
		typeof value.status !== "string" ||
		(value.message !== null && typeof value.message !== "string") ||
		(value.error !== null && typeof value.error !== "string") ||
		nonNegativeInteger(value.progress.current) === null ||
		(value.progress.total !== null && nonNegativeInteger(value.progress.total) === null) ||
		typeof value.progress.unit !== "string"
	) {
		return null;
	}
	return value as unknown as HealthMaintenanceJob;
}

function invalidPayload(endpoint: string): never {
	throw new Error(`Invalid ${endpoint} response`);
}

export function parseStatsPayload(value: unknown): CachedStatsPayload | null {
	if (!isRecord(value) || !isRecord(value.database) || !Array.isArray(value.maintenance_jobs)) {
		return null;
	}
	const database = value.database;
	if (
		typeof database.path !== "string" ||
		nonNegativeInteger(database.size_bytes) === null ||
		nonNegativeInteger(database.active_memory_items) === null ||
		unitRatio(database.vector_coverage) === null ||
		unitRatio(database.tags_coverage) === null
	) {
		return null;
	}
	const maintenanceJobs = value.maintenance_jobs.map(parseMaintenanceJob);
	if (!maintenanceJobs.every((job): job is HealthMaintenanceJob => job !== null)) return null;

	let reliability: CachedStatsPayload["reliability"];
	if (value.reliability !== undefined) {
		if (!isRecord(value.reliability)) return null;
		const { counts, rates } = value.reliability;
		if (
			!isRecord(counts) ||
			!isRecord(rates) ||
			nonNegativeInteger(counts.errored_batches) === null ||
			unitRatio(rates.flush_success_rate) === null ||
			unitRatio(rates.dropped_event_rate) === null
		) {
			return null;
		}
		reliability = {
			counts: { errored_batches: counts.errored_batches as number },
			rates: {
				flush_success_rate: rates.flush_success_rate as number,
				dropped_event_rate: rates.dropped_event_rate as number,
			},
		};
	}

	return {
		automatic_recall: parseAutomaticRecallStats(value.automatic_recall),
		database: {
			path: database.path,
			size_bytes: database.size_bytes as number,
			active_memory_items: database.active_memory_items as number,
			vector_coverage: database.vector_coverage as number,
			tags_coverage: database.tags_coverage as number,
		},
		reliability,
		maintenance_jobs: maintenanceJobs,
	};
}

export function parseUsagePayload(value: unknown): CachedUsagePayload | null {
	if (!isRecord(value)) return null;
	const events = parseUsageEvents(value.events);
	const eventsGlobal = parseUsageEvents(value.events_global);
	const eventsFiltered =
		value.events_filtered === null ? null : parseUsageEvents(value.events_filtered);
	const totals = parseUsageTotals(value.totals);
	const totalsGlobal = parseUsageTotals(value.totals_global);
	const totalsFiltered =
		value.totals_filtered === null ? null : parseUsageTotals(value.totals_filtered);
	if (
		!events ||
		!eventsGlobal ||
		(eventsFiltered === null && value.events_filtered !== null) ||
		!totals ||
		!totalsGlobal ||
		(totalsFiltered === null && value.totals_filtered !== null) ||
		!Array.isArray(value.recent_packs)
	) {
		return null;
	}
	const recentPacks = value.recent_packs.map(parseRecentPack);
	if (!recentPacks.every((pack): pack is RecentPack => pack !== null)) return null;
	return {
		events,
		events_global: eventsGlobal,
		events_filtered: eventsFiltered,
		totals,
		totals_global: totalsGlobal,
		totals_filtered: totalsFiltered,
		recent_packs: recentPacks,
	};
}

export function parseSessionPayload(value: unknown): CachedSessionPayload | null {
	if (!isRecord(value)) return null;
	const fields = ["total", "memories", "artifacts", "prompts", "observations"] as const;
	if (fields.some((field) => nonNegativeInteger(value[field]) === null)) return null;
	return {
		total: Number(value.total),
		memories: Number(value.memories),
		artifacts: Number(value.artifacts),
		prompts: Number(value.prompts),
		observations: Number(value.observations),
	};
}

export function parseRawEventsPayload(value: unknown): CachedRawEventsPayload | null {
	if (!isRecord(value)) return null;
	if (nonNegativeInteger(value.pending) === null || nonNegativeInteger(value.sessions) === null) {
		return null;
	}
	return { pending: value.pending as number, sessions: value.sessions as number };
}

type AutomaticRecallCounts = Pick<
	AutomaticRecallStats,
	| "freshEvaluations"
	| "evaluationsWithDuplicates"
	| "candidateItems"
	| "duplicatesOmitted"
	| "beforeTokens"
	| "afterTokens"
	| "estimatedTokensAvoided"
	| "missingRetainedMetadata"
	| "invalidRetainedMetadata"
	| "packMetadataGaps"
	| "unmeasuredAttempts"
>;

function parseAutomaticRecallCounts(stats: JsonRecord): AutomaticRecallCounts | null {
	const fields = [
		"freshEvaluations",
		"evaluationsWithDuplicates",
		"candidateItems",
		"duplicatesOmitted",
		"beforeTokens",
		"afterTokens",
		"estimatedTokensAvoided",
		"missingRetainedMetadata",
		"invalidRetainedMetadata",
		"packMetadataGaps",
		"unmeasuredAttempts",
	] as const;
	if (fields.some((field) => nonNegativeInteger(stats[field]) === null)) return null;
	return Object.fromEntries(
		fields.map((field) => [field, Number(stats[field])]),
	) as AutomaticRecallCounts;
}

function automaticRecallCountsAreConsistent(
	counts: AutomaticRecallCounts,
	availability: AutomaticRecallStats["availability"],
): boolean {
	const {
		freshEvaluations,
		evaluationsWithDuplicates,
		candidateItems,
		duplicatesOmitted,
		beforeTokens,
		afterTokens,
		estimatedTokensAvoided,
		missingRetainedMetadata,
		invalidRetainedMetadata,
		packMetadataGaps,
		unmeasuredAttempts,
	} = counts;
	return !(
		freshEvaluations + unmeasuredAttempts > 1000 ||
		[
			evaluationsWithDuplicates,
			missingRetainedMetadata,
			invalidRetainedMetadata,
			packMetadataGaps,
		].some((count) => count > freshEvaluations) ||
		candidateItems > freshEvaluations * 50 ||
		duplicatesOmitted > candidateItems ||
		afterTokens > beforeTokens ||
		estimatedTokensAvoided !== beforeTokens - afterTokens ||
		(availability === "available") !== freshEvaluations > 0
	);
}

export function parseAutomaticRecallStats(value: unknown): AutomaticRecallStats | null {
	if (!isRecord(value)) return null;
	const stats = value;
	if (
		(stats.availability !== "available" &&
			stats.availability !== "no_data" &&
			stats.availability !== "unavailable") ||
		stats.captureVersion !== "opencode-retained-v1" ||
		stats.windowLimit !== 1000 ||
		typeof stats.periodStart !== "string" ||
		!Number.isFinite(Date.parse(stats.periodStart)) ||
		typeof stats.periodEnd !== "string" ||
		!Number.isFinite(Date.parse(stats.periodEnd)) ||
		Date.parse(stats.periodStart) > Date.parse(stats.periodEnd)
	)
		return null;
	const counts = parseAutomaticRecallCounts(stats);
	if (!counts || Object.values(counts).some((count) => count > 1_000_000_000)) return null;
	if (!automaticRecallCountsAreConsistent(counts, stats.availability)) return null;
	return {
		availability: stats.availability,
		periodStart: stats.periodStart,
		periodEnd: stats.periodEnd,
		windowLimit: 1000,
		...counts,
		captureVersion: stats.captureVersion,
	};
}

export async function loadStats(options: ReadRequestOptions = {}): Promise<CachedStatsPayload> {
	return parseStatsPayload(await fetchJson("/api/stats", options)) ?? invalidPayload("/api/stats");
}

export async function loadUsage(
	project: string,
	options: ReadRequestOptions = {},
): Promise<CachedUsagePayload> {
	return (
		parseUsagePayload(
			await fetchJson(`/api/usage?project=${encodeURIComponent(project)}`, options),
		) ?? invalidPayload("/api/usage")
	);
}

export async function loadSession(
	project: string,
	options: ReadRequestOptions = {},
): Promise<CachedSessionPayload> {
	return (
		parseSessionPayload(
			await fetchJson(`/api/session?project=${encodeURIComponent(project)}`, options),
		) ?? invalidPayload("/api/session")
	);
}

export async function loadRawEvents(
	project: string,
	options: ReadRequestOptions = {},
): Promise<CachedRawEventsPayload> {
	return (
		parseRawEventsPayload(
			await fetchJson(`/api/raw-events?project=${encodeURIComponent(project)}`, options),
		) ?? invalidPayload("/api/raw-events")
	);
}
