/* Stats renderer for the Health tab — reads usage totals and database
 * state off the global store, builds the StatItem grid (including
 * project-filtered variants when a project is selected), and writes a
 * meta line describing the database path and size. */

import {
	collapseHome,
	formatBytes,
	formatMultiplier,
	formatPercent,
	formatReductionPercent,
	formatTokenCount,
} from "../../../lib/format";
import { state } from "../../../lib/state";
import { renderIcons, renderStatBlocks, renderText } from "../components";
import type { StatItem } from "../types";
import { selectPackUsage } from "../usage";

function appendRawEventStats(items: StatItem[], pending: number, sessions: number): void {
	if (pending > 0) {
		items.push({
			label: "Raw events pending",
			value: pending,
			tooltip: "Pending raw events waiting to be flushed",
			icon: "activity",
		});
		return;
	}
	if (sessions > 0) {
		items.push({
			label: "Raw sessions",
			value: sessions,
			tooltip: "Sessions with pending raw events",
			icon: "inbox",
		});
	}
}

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
	const globalPackUsage = selectPackUsage(usagePayload, false);
	const packUsage = selectPackUsage(usagePayload, isFiltered);
	const rawSessions = Number(raw.sessions || 0);
	const rawPending = Number(raw.pending || 0);

	const globalLineWork = isFiltered
		? `\nGlobal: ${Number(totalsGlobal.work_investment_tokens || 0).toLocaleString()} invested`
		: "";
	const globalLineRead = isFiltered
		? `\nGlobal: ${Number(globalPackUsage?.total_tokens_read || 0).toLocaleString()} estimated injected`
		: "";
	const globalLineSaved = isFiltered
		? `\nGlobal: ${Number(globalPackUsage?.total_tokens_saved || 0).toLocaleString()} estimated saved`
		: "";

	const items: StatItem[] = [
		{
			label: isFiltered ? "Savings (project)" : "Savings",
			value: formatTokenCount(packUsage.total_tokens_saved || 0),
			tooltip: `Estimated tokens saved by reusing compressed memories: ${Number(packUsage.total_tokens_saved || 0).toLocaleString()}${globalLineSaved}`,
			icon: "trending-up",
		},
		{
			label: isFiltered ? "Injected (project)" : "Injected",
			value: formatTokenCount(packUsage.total_tokens_read || 0),
			tooltip: `Estimated tokens injected into context (pack size): ${Number(packUsage.total_tokens_read || 0).toLocaleString()}${globalLineRead}`,
			icon: "book-open",
		},
		{
			label: isFiltered ? "Reduction (project)" : "Reduction",
			value: formatReductionPercent(packUsage.total_tokens_saved, packUsage.total_tokens_read),
			tooltip:
				`Estimated percent reduction from reuse. Factor: ${formatMultiplier(packUsage.total_tokens_saved, packUsage.total_tokens_read)}.` +
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
	appendRawEventStats(items, rawPending, rawSessions);

	renderStatBlocks(statsGrid, items);

	if (metaLine) {
		const projectSuffix = project ? ` · project: ${project}` : "";
		const dbPath = collapseHome(db.path || "unknown");
		renderText(metaLine, `DB: ${dbPath} · ${formatBytes(db.size_bytes || 0)}${projectSuffix}`);
	}
	renderIcons();
}
