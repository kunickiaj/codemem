/* Stats + usage endpoints consumed by the Health tab — raw pipeline
 * state, per-project token usage, session summaries, and raw-event
 * queue counters. All are simple GETs so the module stays thin. */

import { fetchJson } from "./internal";

export interface AutomaticRecallStats {
	availability: "available" | "no_data" | "unavailable";
	periodStart: string;
	periodEnd: string;
	windowLimit: number;
	freshEvaluations: number;
	evaluationsWithDuplicates: number;
	candidateItems: number;
	duplicatesOmitted: number;
	beforeTokens: number;
	afterTokens: number;
	estimatedTokensAvoided: number;
	missingRetainedMetadata: number;
	invalidRetainedMetadata: number;
	packMetadataGaps: number;
	unmeasuredAttempts: number;
	captureVersion: string;
}

export function parseAutomaticRecallStats(value: unknown): AutomaticRecallStats | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const stats = value as AutomaticRecallStats;
	if (
		!["available", "no_data", "unavailable"].includes(stats.availability) ||
		stats.captureVersion !== "opencode-retained-v1" ||
		stats.windowLimit !== 1000 ||
		typeof stats.periodStart !== "string" ||
		!Number.isFinite(Date.parse(stats.periodStart)) ||
		typeof stats.periodEnd !== "string" ||
		!Number.isFinite(Date.parse(stats.periodEnd)) ||
		Date.parse(stats.periodStart) > Date.parse(stats.periodEnd)
	)
		return null;
	const counts = [
		stats.freshEvaluations,
		stats.evaluationsWithDuplicates,
		stats.candidateItems,
		stats.duplicatesOmitted,
		stats.beforeTokens,
		stats.afterTokens,
		stats.estimatedTokensAvoided,
		stats.missingRetainedMetadata,
		stats.invalidRetainedMetadata,
		stats.packMetadataGaps,
		stats.unmeasuredAttempts,
	];
	if (
		!counts.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000) ||
		stats.freshEvaluations + stats.unmeasuredAttempts > 1000 ||
		[
			stats.evaluationsWithDuplicates,
			stats.missingRetainedMetadata,
			stats.invalidRetainedMetadata,
			stats.packMetadataGaps,
		].some((n) => n > stats.freshEvaluations) ||
		stats.candidateItems > stats.freshEvaluations * 50 ||
		stats.duplicatesOmitted > stats.candidateItems ||
		stats.afterTokens > stats.beforeTokens ||
		stats.estimatedTokensAvoided !== stats.beforeTokens - stats.afterTokens ||
		(stats.availability === "available") !== stats.freshEvaluations > 0
	)
		return null;
	return stats;
}

export async function loadStats(): Promise<unknown> {
	return fetchJson("/api/stats");
}

export async function loadUsage(project: string): Promise<unknown> {
	return fetchJson(`/api/usage?project=${encodeURIComponent(project)}`);
}

export async function loadSession(project: string): Promise<unknown> {
	return fetchJson(`/api/session?project=${encodeURIComponent(project)}`);
}

export async function loadRawEvents(project: string): Promise<unknown> {
	return fetchJson(`/api/raw-events?project=${encodeURIComponent(project)}`);
}
