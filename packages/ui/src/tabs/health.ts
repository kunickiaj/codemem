/* Health tab — system health, stats, session overview. */

import * as api from "../lib/api";
import {
	collapseHome,
	formatBytes,
	formatMultiplier,
	formatPercent,
	formatReductionPercent,
	formatTimestamp,
	formatTokenCount,
} from "../lib/format";
import { state } from "../lib/state";
import { updateFeedView } from "./feed";
import { renderIcons, renderStatBlocks, renderText } from "./health/components";
import { renderHealthOverview } from "./health/render/health-overview";
import type { StatItem, UsageEvent } from "./health/types";

export { renderHealthOverview };

/* ── Stats renderer ──────────────────────────────────────── */

export function renderStats() {
	const statsGrid = document.getElementById("statsGrid");
	const metaLine = document.getElementById("metaLine");
	if (!statsGrid) return;

	const stats = state.lastStatsPayload || {};
	const usagePayload = state.lastUsagePayload || {};
	const raw =
		state.lastRawEventsPayload && typeof state.lastRawEventsPayload === "object"
			? state.lastRawEventsPayload
			: {};
	const db = stats.database || {};
	const project = state.currentProject;
	const totalsGlobal =
		usagePayload?.totals_global || usagePayload?.totals || stats.usage?.totals || {};
	const totalsFiltered = usagePayload?.totals_filtered || null;
	const isFiltered = !!(project && totalsFiltered);
	const usage = isFiltered ? totalsFiltered : totalsGlobal;
	const rawSessions = Number(raw.sessions || 0);
	const rawPending = Number(raw.pending || 0);

	const globalLineWork = isFiltered
		? `\nGlobal: ${Number(totalsGlobal.work_investment_tokens || 0).toLocaleString()} invested`
		: "";
	const globalLineRead = isFiltered
		? `\nGlobal: ${Number(totalsGlobal.tokens_read || 0).toLocaleString()} read`
		: "";
	const globalLineSaved = isFiltered
		? `\nGlobal: ${Number(totalsGlobal.tokens_saved || 0).toLocaleString()} saved`
		: "";

	const items: StatItem[] = [
		{
			label: isFiltered ? "Savings (project)" : "Savings",
			value: formatTokenCount(usage.tokens_saved || 0),
			tooltip: `Tokens saved by reusing compressed memories. Exact: ${Number(usage.tokens_saved || 0).toLocaleString()} saved${globalLineSaved}`,
			icon: "trending-up",
		},
		{
			label: isFiltered ? "Injected (project)" : "Injected",
			value: formatTokenCount(usage.tokens_read || 0),
			tooltip: `Tokens injected into context (pack size). Exact: ${Number(usage.tokens_read || 0).toLocaleString()} injected${globalLineRead}`,
			icon: "book-open",
		},
		{
			label: isFiltered ? "Reduction (project)" : "Reduction",
			value: formatReductionPercent(usage.tokens_saved, usage.tokens_read),
			tooltip:
				`Percent reduction from reuse. Factor: ${formatMultiplier(usage.tokens_saved, usage.tokens_read)}.` +
				globalLineRead +
				globalLineSaved,
			icon: "percent",
		},
		{
			label: isFiltered ? "Work investment (project)" : "Work investment",
			value: formatTokenCount(usage.work_investment_tokens || 0),
			tooltip: `Token cost of unique discovery groups. Exact: ${Number(usage.work_investment_tokens || 0).toLocaleString()} invested${globalLineWork}`,
			icon: "pencil",
		},
		{ label: "Active memories", value: db.active_memory_items || 0, icon: "check-circle" },
		{
			label: "Embedding coverage",
			value: formatPercent(db.vector_coverage),
			tooltip: "Share of active memories with embeddings",
			icon: "layers",
		},
		{
			label: "Tag coverage",
			value: formatPercent(db.tags_coverage),
			tooltip: "Share of active memories with tags",
			icon: "tag",
		},
	];
	if (rawPending > 0)
		items.push({
			label: "Raw events pending",
			value: rawPending,
			tooltip: "Pending raw events waiting to be flushed",
			icon: "activity",
		});
	else if (rawSessions > 0)
		items.push({
			label: "Raw sessions",
			value: rawSessions,
			tooltip: "Sessions with pending raw events",
			icon: "inbox",
		});

	renderStatBlocks(statsGrid, items);

	if (metaLine) {
		const projectSuffix = project ? ` · project: ${project}` : "";
		const dbPath = collapseHome(db.path || "unknown");
		renderText(metaLine, `DB: ${dbPath} · ${formatBytes(db.size_bytes || 0)}${projectSuffix}`);
	}
	renderIcons();
}

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
