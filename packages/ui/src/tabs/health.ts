/* Health tab — system health, stats, session overview. */

import * as api from "../lib/api";
import { formatReductionPercent, formatTimestamp, formatTokenCount } from "../lib/format";
import { state } from "../lib/state";
import { updateFeedView } from "./feed";
import { renderIcons, renderStatBlocks, renderText } from "./health/components";
import { renderHealthOverview } from "./health/render/health-overview";
import { renderStats } from "./health/render/stats";
import type { StatItem, UsageEvent } from "./health/types";

export { renderHealthOverview, renderStats };

/* ── Session summary renderer ────────────────────────────── */

export function renderSessionSummary() {
	const sessionGrid = document.getElementById("sessionGrid");
	const sessionMeta = document.getElementById("sessionMeta");
	if (!sessionGrid || !sessionMeta) return;

	const usagePayload = state.lastUsagePayload || {};
	const project = state.currentProject;
	const _totalsGlobal = usagePayload?.totals_global || usagePayload?.totals || {};
	const totalsFiltered = usagePayload?.totals_filtered || null;
	const isFiltered = !!(project && totalsFiltered);

	const events: UsageEvent[] = Array.isArray(usagePayload?.events) ? usagePayload.events : [];
	const packEvent = events.find((event) => event.event === "pack") || null;
	const recentPacks = Array.isArray(usagePayload?.recent_packs) ? usagePayload.recent_packs : [];
	const latestPack = recentPacks.length ? recentPacks[0] : null;
	const latestPackMeta = latestPack?.metadata_json || {};
	const lastPackAt = latestPack?.created_at || "";
	const packCount = Number(packEvent?.count || 0);
	const packTokens = Number(latestPack?.tokens_read || 0);
	const savedTokens = Number(latestPack?.tokens_saved || 0);
	const dedupedCount = Number(latestPackMeta?.exact_duplicates_collapsed || 0);
	const dedupeEnabled = !!latestPackMeta?.exact_dedupe_enabled;
	const reductionPercent = formatReductionPercent(savedTokens, packTokens);

	const packLine = packCount ? `${packCount} packs` : "No packs yet";
	const lastPackLine = lastPackAt ? `Last pack: ${formatTimestamp(lastPackAt)}` : "";
	const scopeLabel = isFiltered ? "Project" : "All projects";
	const items: StatItem[] = [
		{
			label: "Last pack savings",
			value: latestPack ? `${formatTokenCount(savedTokens)} (${reductionPercent})` : "n/a",
			tooltip: latestPack ? `Exact: ${savedTokens.toLocaleString()} saved` : undefined,
			icon: "trending-up",
		},
		{
			label: "Last pack size",
			value: latestPack ? formatTokenCount(packTokens) : "n/a",
			tooltip: latestPack ? `Exact: ${packTokens.toLocaleString()} injected` : undefined,
			icon: "package",
		},
		{
			label: "Last pack deduped",
			value: latestPack ? dedupedCount.toLocaleString() : "n/a",
			icon: "copy-check",
		},
		{
			label: "Exact dedupe",
			value: latestPack ? (dedupeEnabled ? "On" : "Off") : "n/a",
			icon: "shield-check",
		},
		{ label: "Packs", value: packCount || 0, icon: "archive" },
	];

	renderText(sessionMeta, [scopeLabel, packLine, lastPackLine].filter(Boolean).join(" · "));
	renderStatBlocks(sessionGrid, items);

	renderIcons();
}

/* ── Data loading ────────────────────────────────────────── */

export async function loadHealthData() {
	const previousActorId = state.lastStatsPayload?.identity?.actor_id || null;
	const [statsPayload, usagePayload, _sessionsPayload, rawEventsPayload] = await Promise.all([
		api.loadStats(),
		api.loadUsage(state.currentProject),
		api.loadSession(state.currentProject),
		api.loadRawEvents(state.currentProject),
	]);

	state.lastStatsPayload = statsPayload || {};
	state.lastUsagePayload = usagePayload || {};
	state.lastRawEventsPayload = rawEventsPayload || {};
	const nextActorId = state.lastStatsPayload?.identity?.actor_id || null;

	renderStats();
	renderSessionSummary();
	renderHealthOverview();
	if (state.activeTab === "feed" && previousActorId !== nextActorId) {
		updateFeedView(true);
	}
}

/* ── Init ────────────────────────────────────────────────── */

export function initHealthTab() {
	// No special init needed beyond data loading.
}
