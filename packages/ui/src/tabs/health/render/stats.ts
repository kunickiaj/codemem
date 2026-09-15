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
import type { CachedStatsPayload } from "../../../lib/state";
import { healthData, healthResourceIsStale, state } from "../../../lib/state";
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

	const stats = healthData(state.healthStats);
	const usagePayload = healthData(state.healthUsage, state.currentProject);
	const raw = healthData(state.healthRawEvents);
	const db = stats?.database;
	const project = state.currentProject;
	const totalsFiltered = usagePayload?.totals_filtered ?? null;
	const isFiltered = !!(project && totalsFiltered);
	const globalPackUsage = usagePayload ? selectPackUsage(usagePayload, false) : null;
	const packUsage = usagePayload ? selectPackUsage(usagePayload, isFiltered) : null;
	const rawSessions = raw?.sessions ?? 0;
	const rawPending = raw?.pending ?? 0;

	const globalLineRead =
		isFiltered && globalPackUsage
			? `\nGlobal: ${globalPackUsage.total_tokens_read.toLocaleString()} estimated injected`
			: "";
	const globalLineSaved =
		isFiltered && globalPackUsage
			? `\nGlobal: ${globalPackUsage.total_tokens_saved.toLocaleString()} estimated saved`
			: "";

	const items: StatItem[] = [
		{
			label: isFiltered ? "Savings (project)" : "Savings",
			value: packUsage ? formatTokenCount(packUsage.total_tokens_saved) : "n/a",
			tooltip: packUsage
				? `Estimated tokens saved by reusing compressed memories: ${packUsage.total_tokens_saved.toLocaleString()}${globalLineSaved}`
				: "Usage data is unavailable",
			icon: "trending-up",
		},
		{
			label: isFiltered ? "Injected (project)" : "Injected",
			value: packUsage ? formatTokenCount(packUsage.total_tokens_read) : "n/a",
			tooltip: packUsage
				? `Estimated tokens injected into context (pack size): ${packUsage.total_tokens_read.toLocaleString()}${globalLineRead}`
				: "Usage data is unavailable",
			icon: "book-open",
		},
		{
			label: isFiltered ? "Reduction (project)" : "Reduction",
			value: packUsage
				? formatReductionPercent(packUsage.total_tokens_saved, packUsage.total_tokens_read)
				: "n/a",
			tooltip: packUsage
				? `Estimated percent reduction from reuse. Factor: ${formatMultiplier(packUsage.total_tokens_saved, packUsage.total_tokens_read)}.${globalLineRead}${globalLineSaved}`
				: "Usage data is unavailable",
			icon: "percent",
		},
		{
			label: isFiltered ? "Work investment (project)" : "Work investment",
			value: "n/a",
			tooltip: "Work-investment data is unavailable",
			icon: "pencil",
		},
		{ label: "Active memories", value: db?.active_memory_items ?? "n/a", icon: "check-circle" },
		{
			label: "Embedding coverage",
			value: db ? formatPercent(db.vector_coverage) : "n/a",
			tooltip: "Share of active memories with embeddings",
			icon: "layers",
		},
		{
			label: "Tag coverage",
			value: db ? formatPercent(db.tags_coverage) : "n/a",
			tooltip: "Share of active memories with tags",
			icon: "tag",
		},
	];
	if (raw) appendRawEventStats(items, rawPending, rawSessions);

	renderStatBlocks(statsGrid, items);

	if (metaLine) renderStatsMeta(metaLine, db, project);
	renderIcons();
}

function renderStatsMeta(
	metaLine: HTMLElement,
	db: CachedStatsPayload["database"] | null | undefined,
	project: string,
): void {
	if (!db) {
		renderText(metaLine, healthResourceMessage(state.healthStats, "Database metrics"));
		return;
	}
	const projectSuffix = project ? ` · project: ${project}` : "";
	const staleSuffix = healthResourceIsStale(state.healthStats) ? " · showing stale data" : "";
	const dbPath = collapseHome(db.path);
	renderText(
		metaLine,
		`DB: ${dbPath} · ${formatBytes(db.size_bytes)}${projectSuffix}${staleSuffix}`,
	);
}

function healthResourceMessage(
	resource: { status: "not_loaded" | "loading" | "available" | "failed" | "stale" },
	label: string,
): string {
	if (resource.status === "loading") return `Loading ${label.toLowerCase()}…`;
	if (resource.status === "failed") return `${label} failed to load`;
	return `${label} not loaded`;
}
