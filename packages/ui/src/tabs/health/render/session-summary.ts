/* Session summary renderer for the Health tab — reads the latest pack
 * from the usage payload and renders a small grid describing its size,
 * savings, and dedupe behavior, plus a scope/packs/last-pack meta line. */

import { formatReductionPercent, formatTimestamp, formatTokenCount } from "../../../lib/format";
import type { CachedSessionPayload, CachedUsagePayload, RecentPack } from "../../../lib/state";
import { healthData, healthResourceIsStale, state } from "../../../lib/state";
import { renderIcons, renderStatBlocks, renderText } from "../components";
import type { StatItem, UsageEvent } from "../types";

export function renderSessionSummary() {
	const sessionGrid = document.getElementById("sessionGrid");
	const sessionMeta = document.getElementById("sessionMeta");
	if (!sessionGrid || !sessionMeta) return;

	const usagePayload = healthData(state.healthUsage, state.currentProject);
	const sessionPayload = healthData(state.healthSession, state.currentProject);
	const { latestPack, packCount, packLine } = summarizePacks(usagePayload);
	const lastPackAt = latestPack?.created_at || "";
	const lastPackLine = lastPackAt ? `Last pack: ${formatTimestamp(lastPackAt)}` : "";
	const scopeLabel = state.currentProject ? "Project" : "All projects";
	const sessionLine = summarizeStoredItems(sessionPayload, state.healthSession.status === "failed");
	const items = buildSessionItems(latestPack, packCount);
	const staleLine = healthSummaryIsStale(usagePayload, sessionPayload) ? "Showing stale data" : "";
	renderText(
		sessionMeta,
		[scopeLabel, packLine, lastPackLine, sessionLine, staleLine].filter(Boolean).join(" · "),
	);
	renderStatBlocks(sessionGrid, items);
	renderIcons();
}

function summarizePacks(usagePayload: CachedUsagePayload | null): {
	latestPack: RecentPack | null;
	packCount: number | null;
	packLine: string;
} {
	if (!usagePayload) {
		return { latestPack: null, packCount: null, packLine: "Pack totals unavailable" };
	}
	const events: UsageEvent[] = usagePayload.events;
	const packCount = events.find((event) => event.event === "pack")?.count ?? 0;
	return {
		latestPack: usagePayload.recent_packs[0] ?? null,
		packCount,
		packLine: packCount ? `${packCount} packs` : "No packs yet",
	};
}

function summarizeStoredItems(payload: CachedSessionPayload | null, failed: boolean): string {
	if (payload) return `${payload.total.toLocaleString()} stored items`;
	return failed ? "Stored-item totals unavailable" : "";
}

function healthSummaryIsStale(
	usagePayload: CachedUsagePayload | null,
	sessionPayload: CachedSessionPayload | null,
): boolean {
	return (
		(!!usagePayload && healthResourceIsStale(state.healthUsage, state.currentProject)) ||
		(!!sessionPayload && healthResourceIsStale(state.healthSession, state.currentProject))
	);
}

function buildSessionItems(
	latestPack: RecentPack | null | undefined,
	packCount: number | null,
): StatItem[] {
	const latestPackMeta = latestPack?.metadata_json || {};
	const packTokens = latestPack?.tokens_read ?? 0;
	const savedTokens = latestPack?.tokens_saved ?? 0;
	const dedupedCount = latestPackMeta.exact_duplicates_collapsed ?? 0;
	const reductionPercent = formatReductionPercent(savedTokens, packTokens);
	let dedupeValue = "n/a";
	if (latestPack) dedupeValue = latestPackMeta.exact_dedupe_enabled ? "On" : "Off";
	return [
		{
			label: "Last pack savings",
			value: latestPack ? `${formatTokenCount(savedTokens)} (${reductionPercent})` : "n/a",
			tooltip: latestPack ? `Estimate: ${savedTokens.toLocaleString()} saved` : undefined,
			icon: "trending-up",
		},
		{
			label: "Last pack size",
			value: latestPack ? formatTokenCount(packTokens) : "n/a",
			tooltip: latestPack ? `Estimate: ${packTokens.toLocaleString()} injected` : undefined,
			icon: "package",
		},
		{
			label: "Last pack deduped",
			value: latestPack ? dedupedCount.toLocaleString() : "n/a",
			icon: "copy-check",
		},
		{
			label: "Exact dedupe",
			value: dedupeValue,
			icon: "shield-check",
		},
		{ label: "Packs", value: packCount ?? "n/a", icon: "archive" },
	];
}
