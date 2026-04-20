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
