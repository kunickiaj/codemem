/* Health tab — system health, stats, session overview. */

import { Fragment, h, render } from "preact";
import * as api from "../lib/api";
import { copyToClipboard } from "../lib/dom";
import {
	formatAgeShort,
	formatMultiplier,
	formatPercent,
	formatReductionPercent,
	formatTimestamp,
	formatTokenCount,
	parsePercentValue,
	secondsSince,
	titleCase,
} from "../lib/format";
import { state } from "../lib/state";
import { updateFeedView } from "./feed";

type HealthAction = {
	label: string;
	command: string;
	/** If set, show an actionable button that triggers this async function. */
	action?: () => Promise<void>;
	actionLabel?: string;
};

/* ── Health card builder ─────────────────────────────────── */

type HealthCardInput = {
	key?: string;
	label: string;
	value: string;
	detail?: string;
	icon?: string;
	className?: string;
	title?: string;
};

type HealthActionRowProps = {
	item: HealthAction;
};

type StatItem = {
	label: string;
	value: string | number | null | undefined;
	icon: string;
	tooltip?: string;
};

type UsageEvent = {
	event?: string;
	count?: number;
};

type LucideRuntime = {
	createIcons: () => void;
};

function buildHealthCard(input: HealthCardInput): HealthCardInput {
	return input;
}

function HealthCard({ label, value, detail, icon, className, title }: HealthCardInput) {
	return h(
		"div",
		{
			class: `stat${className ? ` ${className}` : ""}`,
			title,
			style: title ? "cursor: help;" : undefined,
		},
		icon
			? h("i", {
					"data-lucide": icon,
					class: "stat-icon",
				})
			: null,
		h(
			"div",
			{ class: "stat-content" },
			h("div", { class: "value" }, value),
			h("div", { class: "label" }, label),
			detail ? h("div", { class: "small" }, detail) : null,
		),
	);
}

function HealthActionRow({ item }: HealthActionRowProps) {
	let actionButton: HTMLButtonElement | null = null;
	let copyButton: HTMLButtonElement | null = null;
	const actionLabel = item.actionLabel || "Run";

	async function handleAction() {
		if (!item.action || !actionButton) return;
		actionButton.disabled = true;
		actionButton.textContent = "Running…";
		try {
			await item.action();
		} catch {}
		actionButton.disabled = false;
		actionButton.textContent = actionLabel;
	}

	function handleCopy() {
		if (!item.command || !copyButton) return;
		copyToClipboard(item.command, copyButton);
	}

	return h(
		"div",
		{ class: "health-action" },
		h(
			"div",
			{ class: "health-action-text" },
			item.label,
			item.command ? h("span", { class: "health-action-command" }, item.command) : null,
		),
		h(
			"div",
			{ class: "health-action-buttons" },
			item.action
				? h(
						"button",
						{
							class: "settings-button",
							onClick: handleAction,
							ref: (node: HTMLButtonElement | null) => {
								actionButton = node;
							},
						},
						actionLabel,
					)
				: null,
			item.command
				? h(
						"button",
						{
							class: "settings-button health-action-copy",
							onClick: handleCopy,
							ref: (node: HTMLButtonElement | null) => {
								copyButton = node;
							},
						},
						"Copy",
					)
				: null,
		),
	);
}

function formatStatValue(value: StatItem["value"]): string {
	if (typeof value === "number") return value.toLocaleString();
	if (value == null) return "n/a";
	return String(value);
}

function StatBlock({ label, value, icon, tooltip }: StatItem) {
	return h(
		"div",
		{
			class: "stat",
			title: tooltip,
			style: tooltip ? "cursor: help;" : undefined,
		},
		h("i", {
			"data-lucide": icon,
			class: "stat-icon",
		}),
		h(
			"div",
			{ class: "stat-content" },
			h("div", { class: "value" }, formatStatValue(value)),
			h("div", { class: "label" }, label),
		),
	);
}

function renderStatBlocks(container: HTMLElement | null, items: StatItem[]) {
	if (!container) return;
	render(
		h(
			Fragment,
			null,
			items.map((item) => h(StatBlock, { ...item, key: `${item.label}-${item.icon}` })),
		),
		container,
	);
}

function renderText(container: HTMLElement | null, value: string) {
	if (!container) return;
	render(h(Fragment, null, value), container);
}

function renderIcons() {
	const lucide = (globalThis as typeof globalThis & { lucide?: LucideRuntime }).lucide;
	if (lucide && typeof lucide.createIcons === "function") lucide.createIcons();
}

function renderHealthCards(container: HTMLElement | null, cards: HealthCardInput[]) {
	if (!container) return;
	render(
		h(
			Fragment,
			null,
			cards.map((card) => h(HealthCard, { ...card, key: card.key ?? card.label })),
		),
		container,
	);
}

function renderActionList(container: HTMLElement | null, actions: HealthAction[]) {
	if (!container) return;
	if (!actions.length) {
		container.hidden = true;
		render(null, container);
		return;
	}

	container.hidden = false;
	render(
		h(
			Fragment,
			null,
			actions
				.slice(0, 3)
				.map((item, index) => h(HealthActionRow, { item, key: `${item.label}-${index}` })),
		),
		container,
	);
}

/* ── Health overview renderer ────────────────────────────── */

export function renderHealthOverview() {
	const healthGrid = document.getElementById("healthGrid");
	const healthMeta = document.getElementById("healthMeta");
	const healthActions = document.getElementById("healthActions");
	const healthDot = document.getElementById("healthDot");
	if (!healthGrid || !healthMeta) return;

	const stats = state.lastStatsPayload || {};
	const usagePayload = state.lastUsagePayload || {};
	const raw =
		state.lastRawEventsPayload && typeof state.lastRawEventsPayload === "object"
			? state.lastRawEventsPayload
			: {};
	const syncStatus = state.lastSyncStatus || {};
	const maintenanceJobs: Array<{
		kind?: string;
		title?: string;
		status?: string;
		message?: string | null;
		error?: string | null;
		progress?: { current?: number; total?: number | null; unit?: string };
	}> = Array.isArray(stats.maintenance_jobs) ? stats.maintenance_jobs : [];
	const reliability = stats.reliability || {};
	const counts = reliability.counts || {};
	const rates = reliability.rates || {};
	const dbStats = stats.database || {};
	const totals =
		usagePayload.totals_filtered ||
		usagePayload.totals ||
		usagePayload.totals_global ||
		stats.usage?.totals ||
		{};
	const recentPacks = Array.isArray(usagePayload.recent_packs) ? usagePayload.recent_packs : [];
	const lastPackAt = recentPacks.length ? recentPacks[0]?.created_at : null;
	const latestPackMeta = recentPacks.length ? recentPacks[0]?.metadata_json || {} : {};
	const latestPackDeduped = Number(latestPackMeta?.exact_duplicates_collapsed || 0);
	const rawPending = Number(raw.pending || 0);
	const erroredBatches = Number(counts.errored_batches || 0);
	const flushSuccessRate = Number(rates.flush_success_rate ?? 1);
	const droppedRate = Number(rates.dropped_event_rate || 0);
	const reductionLabel = formatReductionPercent(totals.tokens_saved, totals.tokens_read);
	const reductionPercent = parsePercentValue(reductionLabel);
	const tagCoverage = Number(dbStats.tags_coverage || 0);
	const syncState = String(syncStatus.daemon_state || "unknown");
	const syncStateLabel =
		syncState === "offline-peers"
			? "Offline peers"
			: syncState === "needs_attention"
				? "Needs attention"
				: syncState === "rebootstrapping"
					? "Rebootstrapping"
					: titleCase(syncState);
	const peerCount = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers.length : 0;
	const syncDisabled = syncState === "disabled" || syncStatus.enabled === false;
	const syncOfflinePeers = syncState === "offline-peers";
	const syncNoPeers = !syncDisabled && peerCount === 0;
	const syncCardValue = syncDisabled ? "Disabled" : syncNoPeers ? "No peers" : syncStateLabel;
	const lastSyncAt = syncStatus.last_sync_at || syncStatus.last_sync_at_utc || null;
	const syncAgeSeconds = secondsSince(lastSyncAt);
	const packAgeSeconds = secondsSince(lastPackAt);
	const syncLooksStale = syncAgeSeconds !== null && syncAgeSeconds > 7200;
	const hasBacklog = rawPending >= 200;

	// Risk scoring
	let riskScore = 0;
	const drivers: string[] = [];
	if (rawPending >= 1000) {
		riskScore += 40;
		drivers.push("high raw-event backlog");
	} else if (rawPending >= 200) {
		riskScore += 24;
		drivers.push("growing raw-event backlog");
	}
	if (erroredBatches > 0 && rawPending >= 200) {
		riskScore += erroredBatches >= 5 ? 10 : 6;
		drivers.push("batch errors during backlog pressure");
	}
	if (flushSuccessRate < 0.95) {
		riskScore += 20;
		drivers.push("lower flush success");
	}
	if (droppedRate > 0.02) {
		riskScore += 24;
		drivers.push("high dropped-event rate");
	} else if (droppedRate > 0.005) {
		riskScore += 10;
		drivers.push("non-trivial dropped-event rate");
	}
	if (!syncDisabled && !syncNoPeers) {
		if (syncState === "error") {
			riskScore += 36;
			drivers.push("sync daemon reports errors");
		} else if (syncState === "needs_attention") {
			riskScore += 40;
			drivers.push("sync needs manual attention");
		} else if (syncState === "stopped") {
			riskScore += 22;
			drivers.push("sync daemon stopped");
		} else if (syncState === "degraded") {
			riskScore += 20;
			drivers.push("sync daemon degraded");
		}
		if (syncOfflinePeers) {
			riskScore += 4;
			drivers.push("all peers currently offline");
			if (syncLooksStale) {
				riskScore += 4;
				drivers.push("offline peers and sync not recent");
			}
		} else {
			if (syncLooksStale) {
				riskScore += 26;
				drivers.push("sync looks stale");
			} else if (syncAgeSeconds !== null && syncAgeSeconds > 1800) {
				riskScore += 12;
				drivers.push("sync not recent");
			}
		}
	}
	if (reductionPercent !== null && reductionPercent < 10) {
		riskScore += 8;
		drivers.push("low retrieval reduction");
	}
	if (packAgeSeconds !== null && packAgeSeconds > 86400) {
		riskScore += 12;
		drivers.push("memory pack activity is old");
	}

	let statusLabel = "Healthy";
	let statusClass = "status-healthy";
	if (riskScore >= 60) {
		statusLabel = "Attention";
		statusClass = "status-attention";
	} else if (riskScore >= 25) {
		statusLabel = "Degraded";
		statusClass = "status-degraded";
	}

	// Update header health dot
	if (healthDot) {
		healthDot.className = `health-dot ${statusClass}`;
		healthDot.title = statusLabel;
	}

	const retrievalDetail = `${Number(totals.tokens_saved || 0).toLocaleString()} saved tokens · ${latestPackDeduped.toLocaleString()} deduped in latest pack`;
	const pipelineDetail = rawPending > 0 ? "Queue is actively draining" : "Queue is clear";
	const syncDetail = syncDisabled
		? "Sync disabled"
		: syncNoPeers
			? "No peers configured"
			: syncOfflinePeers
				? `${peerCount} peers offline · last sync ${formatAgeShort(syncAgeSeconds)} ago`
				: `${peerCount} peers · last sync ${formatAgeShort(syncAgeSeconds)} ago`;
	const freshnessDetail = `last pack ${formatAgeShort(packAgeSeconds)} ago`;

	// Build maintenance card(s) for active background jobs
	const maintenanceCards: HealthCardInput[] = maintenanceJobs.map((job) => {
		const current = Number(job.progress?.current || 0);
		const total = typeof job.progress?.total === "number" ? job.progress.total : null;
		const unit = String(job.progress?.unit || "items");
		const pct = total && total > 0 ? ` (${Math.round((100 * current) / total)}%)` : "";
		const progress =
			total && total > 0
				? `${current.toLocaleString()}/${total.toLocaleString()} ${unit}${pct}`
				: `${current.toLocaleString()} ${unit}`;
		const isFailed = job.status === "failed";
		const detail = isFailed ? String(job.error || "unknown error").trim() : undefined;
		return buildHealthCard({
			key: String(job.kind || job.title || "background-maintenance"),
			label: String(job.title || job.kind || "Background maintenance"),
			value: isFailed ? "Failed" : progress,
			detail,
			icon: isFailed ? "alert-triangle" : "loader",
			className: isFailed ? "status-attention" : undefined,
			title: isFailed
				? `Error: ${job.error || "unknown"}`
				: `${String(job.title || "Maintenance")} in progress`,
		});
	});

	const cards = [
		buildHealthCard({
			key: "overall-health",
			label: "Overall health",
			value: statusLabel,
			detail: `Weighted score ${riskScore}`,
			icon: "heart-pulse",
			className: `health-primary ${statusClass}`,
			title: drivers.length
				? `Main signals: ${drivers.join(", ")}`
				: "No major risk signals detected",
		}),
		...maintenanceCards,
		buildHealthCard({
			key: "pipeline-health",
			label: "Pipeline health",
			value: `${rawPending.toLocaleString()} pending`,
			detail: pipelineDetail,
			icon: "workflow",
			title: "Raw-event queue pressure and flush reliability",
		}),
		buildHealthCard({
			key: "retrieval-impact",
			label: "Retrieval impact",
			value: reductionLabel,
			detail: retrievalDetail,
			icon: "sparkles",
			title: "Reduction from memory reuse across recent usage",
		}),
		buildHealthCard({
			key: "sync-health",
			label: "Sync health",
			value: syncCardValue,
			detail: syncDetail,
			icon: "refresh-cw",
			title: "Daemon state and sync recency",
		}),
		buildHealthCard({
			key: "data-freshness",
			label: "Data freshness",
			value: formatAgeShort(packAgeSeconds),
			detail: freshnessDetail,
			icon: "clock-3",
			title: "Recency of last memory pack activity",
		}),
	];
	renderHealthCards(healthGrid, cards);

	// Recommendations
	const triggerSync = async () => {
		await api.triggerSync();
	};
	const recommendations: HealthAction[] = [];
	if (hasBacklog) {
		recommendations.push({
			label: "Pipeline needs attention. Check queue health first.",
			command: "codemem db raw-events-status",
		});
		recommendations.push({
			label: "Then retry failed batches for impacted sessions.",
			command: "codemem db raw-events-retry <opencode_session_id>",
		});
	} else if (syncState === "stopped") {
		recommendations.push({
			label: "Sync daemon is stopped. Start the background service.",
			command: "codemem serve start",
		});
	} else if (!syncDisabled && !syncNoPeers && (syncState === "error" || syncState === "degraded")) {
		recommendations.push({
			label: "Sync is unhealthy. Restart and run one immediate pass.",
			command: "codemem serve restart",
			action: triggerSync,
			actionLabel: "Sync now",
		});
		recommendations.push({
			label: "Then run doctor to see root cause details.",
			command: "codemem sync doctor",
		});
	} else if (!syncDisabled && !syncNoPeers && syncLooksStale) {
		recommendations.push({
			label: "Sync is stale. Run one immediate sync pass.",
			command: "codemem sync once",
			action: triggerSync,
			actionLabel: "Sync now",
		});
	}
	if (tagCoverage > 0 && tagCoverage < 0.7 && recommendations.length < 2) {
		recommendations.push({
			label: "Tag coverage is low. Preview backfill impact.",
			command: "codemem db backfill-tags --dry-run",
		});
	}
	renderActionList(healthActions, recommendations);

	healthMeta.textContent = drivers.length
		? `Why this status: ${drivers.join(", ")}.`
		: "Healthy right now. Diagnostics stay available if you want details.";

	renderIcons();
}

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
		renderText(
			metaLine,
			`DB: ${db.path || "unknown"} · ${Math.round((db.size_bytes || 0) / 1024)} KB${projectSuffix}`,
		);
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
