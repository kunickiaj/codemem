/* Health overview renderer — reads system, usage, raw-event, and sync
 * signals off the global state, computes a weighted risk score + set
 * of drivers, then renders the cards row and recommended-action list.
 * The risk scoring and recommendation rules are the single source of
 * truth for the Health tab's "Overall health" status. */

import { openDiagnosticsDrawer } from "../../../components/diagnostics";
import {
	formatAgeShort,
	formatReductionPercent,
	parsePercentValue,
	secondsSince,
	titleCase,
} from "../../../lib/format";
import {
	type CachedRawEventsPayload,
	type CachedStatsPayload,
	type CachedUsagePayload,
	type HealthMaintenanceJob,
	healthData,
	healthResourceIsStale,
	type SyncPeer,
	state,
} from "../../../lib/state";
import { formatAgentClientList } from "../../settings/data/value-helpers";
import {
	buildHealthCard,
	type HealthTileInput,
	renderActionList,
	renderHealthOverviewGrid,
	renderHealthStatus,
	renderIcons,
	renderText,
	renderUpdateBanner,
} from "../components";
import type { HealthAction, HealthCardInput } from "../types";
import { selectPackUsage } from "../usage";

const SCOPE_BACKFILL_JOB = "scope_id_backfill";
const SYNC_PROBLEM_STATES = new Set([
	"error",
	"needs_attention",
	"stopped",
	"degraded",
	"stale",
	"offline-peers",
	"rebootstrapping",
]);
const SYNC_TRANSITION_STATES = new Set(["starting", "stopping"]);
const SYNC_STATE_LABELS: Record<string, string> = {
	"offline-peers": "Offline peers",
	needs_attention: "Needs attention",
	rebootstrapping: "Rebootstrapping",
};

type HealthStatusModel = {
	label: string;
	className: string;
};

type HealthOverviewMounts = {
	healthGrid: HTMLElement;
	healthStatus: HTMLElement;
	healthActions: HTMLElement | null;
	healthDot: HTMLElement | null;
};

type OverviewSignals = {
	maintenanceJobs: HealthMaintenanceJob[];
	scopeBackfillJob: HealthMaintenanceJob | undefined;
	hasFailedMaintenance: boolean;
	hasLowTagCoverage: boolean;
	rawPending: number;
	erroredBatches: number;
	hasReliability: boolean;
	flushSuccessRate: number;
	droppedRate: number;
	reductionLabel: string;
	reductionPercent: number | null;
	hasPackUsage: boolean;
	lastPackAt: string | null;
	packAgeSeconds: number | null;
	syncState: string;
	syncStateLabel: string;
	syncDisabled: boolean;
	syncOfflinePeers: boolean;
	syncNoPeers: boolean;
	syncAgeSeconds: number | null;
	syncLooksStale: boolean;
	syncRecentlyOk: boolean;
	syncHasRecentFailedAttempt: boolean;
	syncProblemPeers: string[];
	syncOfflinePeersNames: string[];
	hasBacklog: boolean;
};

type RiskResult = {
	score: number;
	drivers: string[];
};

export function markHealthStatusUnchecked(): void {
	const healthDot = document.getElementById("healthDot");
	if (healthDot) {
		healthDot.className = "health-dot status-unknown";
		healthDot.title = "Open Health to check status";
	}
	const metaLine = document.getElementById("metaLine");
	if (metaLine) renderText(metaLine, "");
}

function healthOverviewMounts(): HealthOverviewMounts | null {
	const healthGrid = document.getElementById("healthGrid");
	const healthStatus = document.getElementById("healthStatus");
	if (!healthGrid || !healthStatus) return null;
	return {
		healthGrid,
		healthStatus,
		healthActions: document.getElementById("healthActions"),
		healthDot: document.getElementById("healthDot"),
	};
}

function healthMetaMessage(issueCount: number, drivers: string[]): string {
	const parts = [`${issueCount} ${issueCount === 1 ? "issue" : "issues"}`];
	if (issueCount > 0 && drivers.length > 0) {
		parts.push(drivers.join(", "));
	}
	return parts.join(" · ");
}

function healthPresenceState(statusClass: string): HealthTileInput["state"] {
	if (statusClass === "status-healthy") return "online";
	if (statusClass === "status-degraded") return "degraded";
	if (statusClass === "status-attention") return "attention";
	return "unknown";
}

function healthStatus(riskScore: number, hasStaleData: boolean): HealthStatusModel {
	if (riskScore >= 60) return { label: "Attention", className: "status-attention" };
	if (riskScore >= 25) return { label: "Degraded", className: "status-degraded" };
	if (hasStaleData) return { label: "Stale", className: "status-unknown" };
	return { label: "Healthy", className: "status-healthy" };
}

function syncStateLabel(syncState: string): string {
	return SYNC_STATE_LABELS[syncState] ?? titleCase(syncState);
}

function recentFailedPeerIds(peers: SyncPeer[]): Set<string> {
	const latestByPeer = new Map<string, boolean>();
	const activePeerIds = new Set(peers.map((peer) => peer.peer_device_id));
	for (const item of state.lastSyncAttempts) {
		if (!item || typeof item !== "object") continue;
		const attempt = item as Record<string, unknown>;
		const peerId = attempt.peer_device_id;
		if (typeof peerId !== "string" || !activePeerIds.has(peerId) || latestByPeer.has(peerId))
			continue;
		const finishedAt =
			typeof attempt.finished_at === "string" ? Date.parse(attempt.finished_at) : Number.NaN;
		const ageMs = Date.now() - finishedAt;
		if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 600_000) continue;
		latestByPeer.set(peerId, attempt.status === "error");
	}
	return new Set([...latestByPeer].filter(([, failed]) => failed).map(([peerId]) => peerId));
}

function namedPeers(peers: SyncPeer[], include: (peer: SyncPeer) => boolean): string[] {
	return [
		...new Set(
			peers
				.filter(include)
				.map((peer) => peer.name || peer.peer_name || peer.display_name || "")
				.map((name) => name.trim().slice(0, 60))
				.filter(Boolean),
		),
	].sort((left, right) => left.localeCompare(right));
}

function peerHasSyncProblem(peer: SyncPeer, recentlyFailed: Set<string>): boolean {
	return (
		peer.status?.recent_failed_attempt === true ||
		peer.status?.peer_state === "degraded" ||
		Boolean(peer.has_error) ||
		Boolean(peer.peer_device_id && recentlyFailed.has(peer.peer_device_id))
	);
}

function hasRecentFailedAttempt(peers: SyncPeer[], recentlyFailed: Set<string>): boolean {
	return (
		recentlyFailed.size > 0 || peers.some((peer) => peer.status?.recent_failed_attempt === true)
	);
}

function deriveOverviewSignals(
	stats: CachedStatsPayload,
	usage: CachedUsagePayload,
	raw: CachedRawEventsPayload,
): OverviewSignals {
	const packUsage = selectPackUsage(usage, usage.events_filtered != null);
	const lastPackAt = usage.recent_packs[0]?.created_at ?? null;
	const reductionLabel = packUsage
		? formatReductionPercent(packUsage.total_tokens_saved, packUsage.total_tokens_read)
		: "n/a";
	const syncStatus = state.lastSyncStatus ?? {};
	const syncState = String(syncStatus.daemon_state || "unknown");
	const syncDisabled = syncState === "disabled" || syncStatus.enabled === false;
	const peerCount = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers.length : 0;
	const peers = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers : [];
	const recentlyFailed = recentFailedPeerIds(peers);
	const syncAgeSeconds = secondsSince(
		syncStatus.last_sync_at || syncStatus.last_sync_at_utc || null,
	);
	const maintenanceJobs = stats.maintenance_jobs;
	return {
		maintenanceJobs,
		scopeBackfillJob: maintenanceJobs.find((job) => job.kind === SCOPE_BACKFILL_JOB),
		hasFailedMaintenance: maintenanceJobs.some((job) => job.status === "failed"),
		hasLowTagCoverage: stats.database.active_memory_items > 0 && stats.database.tags_coverage < 0.7,
		rawPending: raw.pending,
		erroredBatches: stats.reliability?.counts.errored_batches ?? 0,
		hasReliability: stats.reliability !== undefined,
		flushSuccessRate: stats.reliability?.rates.flush_success_rate ?? 1,
		droppedRate: stats.reliability?.rates.dropped_event_rate ?? 0,
		reductionLabel,
		reductionPercent: parsePercentValue(reductionLabel),
		hasPackUsage: packUsage !== null,
		lastPackAt,
		packAgeSeconds: secondsSince(lastPackAt),
		syncState,
		syncStateLabel: syncStateLabel(syncState),
		syncDisabled,
		syncOfflinePeers: syncState === "offline-peers",
		syncNoPeers: !syncDisabled && peerCount === 0,
		syncAgeSeconds,
		syncLooksStale: syncAgeSeconds !== null && syncAgeSeconds > 7200,
		syncRecentlyOk: syncAgeSeconds !== null && syncAgeSeconds <= 300,
		syncHasRecentFailedAttempt: hasRecentFailedAttempt(peers, recentlyFailed),
		syncProblemPeers: namedPeers(peers, (peer) => peerHasSyncProblem(peer, recentlyFailed)),
		syncOfflinePeersNames: namedPeers(peers, (peer) => peer.status?.peer_state === "offline"),
		hasBacklog: raw.pending >= 200,
	};
}

function addRisk(result: RiskResult, points: number, driver: string): void {
	result.score += points;
	result.drivers.push(driver);
}

function applyPipelineRisk(result: RiskResult, signals: OverviewSignals): void {
	if (signals.rawPending >= 1000) {
		addRisk(result, 40, "high raw-event backlog");
	} else if (signals.rawPending >= 200) {
		addRisk(result, 24, "growing raw-event backlog");
	}
	if (signals.erroredBatches > 0 && signals.rawPending >= 200) {
		const points = signals.erroredBatches >= 5 ? 10 : 6;
		addRisk(result, points, "batch errors during backlog pressure");
	}
	if (signals.flushSuccessRate < 0.95) addRisk(result, 20, "lower flush success");
	if (signals.droppedRate > 0.02) {
		addRisk(result, 24, "high dropped-event rate");
	} else if (signals.droppedRate > 0.005) {
		addRisk(result, 10, "non-trivial dropped-event rate");
	}
}

function applySyncStateRisk(result: RiskResult, signals: OverviewSignals): void {
	if (signals.syncState === "error") addRisk(result, 36, "background sync failed");
	if (signals.syncState === "needs_attention") addRisk(result, 40, "sync needs manual attention");
	if (signals.syncState === "stopped") addRisk(result, 22, "sync daemon stopped");
	if (signals.syncState === "stale") addRisk(result, 20, "sync daemon stale");
	if (signals.syncState === "rebootstrapping") {
		addRisk(result, 20, "sync daemon rebootstrapping");
	}
	if (
		signals.syncState === "degraded" &&
		(!signals.syncRecentlyOk ||
			signals.syncHasRecentFailedAttempt ||
			signals.syncProblemPeers.length > 0)
	) {
		addRisk(result, signals.syncRecentlyOk ? 26 : 20, "sync with paired devices failed");
	}
	if (signals.syncState === "ok" && signals.syncHasRecentFailedAttempt) {
		addRisk(result, 26, "sync with paired devices failed");
	}
}

function applySyncRecencyRisk(result: RiskResult, signals: OverviewSignals): void {
	if (signals.syncOfflinePeers) {
		addRisk(result, 4, "all peers currently offline");
		if (signals.syncLooksStale) addRisk(result, 4, "offline peers and sync not recent");
		return;
	}
	if (signals.syncLooksStale) {
		addRisk(result, 26, "sync looks stale");
		return;
	}
	if (signals.syncAgeSeconds !== null && signals.syncAgeSeconds > 1800) {
		addRisk(result, 12, "sync not recent");
	}
}

function calculateRisk(signals: OverviewSignals): RiskResult {
	const result: RiskResult = { score: 0, drivers: [] };
	applyPipelineRisk(result, signals);
	if (signals.hasLowTagCoverage) addRisk(result, 8, "low tag coverage");
	if (signals.hasFailedMaintenance) addRisk(result, 30, "maintenance job failed");
	if (!signals.syncDisabled && !signals.syncNoPeers) {
		applySyncStateRisk(result, signals);
		applySyncRecencyRisk(result, signals);
	}
	if (signals.reductionPercent !== null && signals.reductionPercent < 10) {
		addRisk(result, 8, "low retrieval reduction");
	}
	if (signals.packAgeSeconds !== null && signals.packAgeSeconds > 86400) {
		addRisk(result, 12, "memory pack activity is old");
	}
	return result;
}

function maintenanceProgress(job: HealthMaintenanceJob): string {
	const current = Number(job.progress?.current || 0);
	const total = typeof job.progress?.total === "number" ? job.progress.total : null;
	const unit = String(job.progress?.unit || "items");
	if (!total || total <= 0) return `${current.toLocaleString()} ${unit}`;
	const percent = Math.round((100 * current) / total);
	return `${current.toLocaleString()}/${total.toLocaleString()} ${unit} (${percent}%)`;
}

function maintenanceCard(job: HealthMaintenanceJob): HealthCardInput {
	const progress = maintenanceProgress(job);
	const title = String(job.title || "Maintenance");
	const isScopeBackfill = job.kind === SCOPE_BACKFILL_JOB;
	let value = progress;
	let detail = isScopeBackfill
		? "One-time upgrade backfill; totals include memories and replication ops"
		: undefined;
	let icon = "loader";
	let tooltip = isScopeBackfill
		? `${title} in progress; inspect with codemem maintenance status`
		: `${title} in progress`;
	if (job.status === "failed") {
		value = "Failed";
		detail = String(job.error || "unknown error").trim();
		icon = "alert-triangle";
		tooltip = `Error: ${job.error || "unknown"}`;
	} else if (job.status === "completed") {
		value = "Complete";
		detail = isScopeBackfill ? `${progress} · one-time Sharing-domain upgrade finished` : progress;
		icon = "check-circle";
		tooltip = `${title} finished`;
	}
	return buildHealthCard({
		key: String(job.kind || job.title || "background-maintenance"),
		label: String(job.title || job.kind || "Background maintenance"),
		value,
		detail,
		icon,
		className: job.status === "failed" ? "status-attention" : undefined,
		title: tooltip,
	});
}

function pipelineTile(signals: OverviewSignals): HealthTileInput {
	if (!signals.hasReliability) {
		const pendingLabel =
			signals.rawPending > 0 ? `${signals.rawPending.toLocaleString()} pending · ` : "";
		return tile(
			"pipeline",
			"Pipeline",
			`${pendingLabel}Reliability unknown`,
			signals.rawPending > 0 ? "degraded" : "unknown",
			"Raw-event queue pressure and flush reliability",
		);
	}
	const reliabilityDegraded = signals.flushSuccessRate < 0.95 || signals.droppedRate > 0.005;
	if (signals.rawPending === 0 && !reliabilityDegraded) {
		return tile(
			"pipeline",
			"Pipeline",
			"Queue clear",
			"online",
			"Raw-event queue pressure and flush reliability",
		);
	}
	const pendingLabel =
		signals.rawPending > 0 ? `${signals.rawPending.toLocaleString()} pending · ` : "";
	if (signals.droppedRate > 0.02) {
		return tile(
			"pipeline",
			"Pipeline",
			`${pendingLabel}Events dropped`,
			"attention",
			"Raw-event queue pressure and flush reliability",
		);
	}
	if (reliabilityDegraded)
		return tile(
			"pipeline",
			"Pipeline",
			`${pendingLabel}Reliability degraded`,
			"degraded",
			"Raw-event queue pressure and flush reliability",
		);
	return tile(
		"pipeline",
		"Pipeline",
		`${signals.rawPending.toLocaleString()} pending`,
		"degraded",
		"Raw-event queue pressure and flush reliability",
	);
}

function syncTile(signals: OverviewSignals): HealthTileInput {
	if (signals.syncDisabled)
		return tile("sync", "Sync", "Off", "unknown", "Daemon state and sync recency");
	if (signals.syncState === "unknown") {
		return tile("sync", "Sync", "Unknown", "unknown", "Daemon state and sync recency");
	}
	if (signals.syncNoPeers) {
		return tile("sync", "Sync", "No peers", "unknown", "Daemon state and sync recency");
	}
	if (signals.syncState === "ok" && signals.syncHasRecentFailedAttempt) {
		return tile("sync", "Sync", "Degraded", "degraded", "Daemon state and sync recency");
	}
	if (
		signals.syncState === "degraded" &&
		signals.syncRecentlyOk &&
		!signals.syncHasRecentFailedAttempt &&
		signals.syncProblemPeers.length === 0
	) {
		return tile("sync", "Sync", "Syncing", "online", "Daemon state and sync recency");
	}
	if (SYNC_PROBLEM_STATES.has(signals.syncState)) {
		return tile(
			"sync",
			"Sync",
			signals.syncStateLabel,
			"degraded",
			"Daemon state and sync recency",
		);
	}
	if (SYNC_TRANSITION_STATES.has(signals.syncState)) {
		return tile("sync", "Sync", signals.syncStateLabel, "unknown", "Daemon state and sync recency");
	}
	if (signals.syncLooksStale) {
		return tile("sync", "Sync", "Stale", "degraded", "Daemon state and sync recency");
	}
	return tile("sync", "Sync", "On", "online", "Daemon state and sync recency");
}

function retrievalTile(signals: OverviewSignals): HealthTileInput {
	if (!signals.hasPackUsage) {
		return tile(
			"retrieval",
			"Retrieval",
			"No packs yet",
			"unknown",
			"Reduction from memory reuse across recent usage",
		);
	}
	if (signals.reductionPercent === null) {
		return tile(
			"retrieval",
			"Retrieval",
			"Unknown",
			"unknown",
			"Reduction is unavailable for the recorded pack usage",
		);
	}
	const isDegraded = signals.reductionPercent !== null && signals.reductionPercent < 10;
	return tile(
		"retrieval",
		"Retrieval",
		signals.reductionLabel,
		isDegraded ? "degraded" : "online",
		"Reduction from memory reuse across recent usage",
	);
}

function freshnessTile(signals: OverviewSignals): HealthTileInput {
	if (!signals.lastPackAt) {
		return tile(
			"freshness",
			"Data freshness",
			signals.hasPackUsage ? "Unknown" : "No packs yet",
			"unknown",
			"Recency is unknown when pack usage exists outside the recent activity window",
		);
	}
	if (signals.packAgeSeconds === null) {
		return tile(
			"freshness",
			"Data freshness",
			"Unknown",
			"unknown",
			"The last memory pack timestamp is unavailable",
		);
	}
	const isDegraded = signals.packAgeSeconds !== null && signals.packAgeSeconds > 86400;
	return tile(
		"freshness",
		"Data freshness",
		formatAgeShort(signals.packAgeSeconds),
		isDegraded ? "degraded" : "online",
		"Recency of last memory pack activity",
	);
}

function tile(
	key: string,
	label: string,
	value: string,
	presenceState: HealthTileInput["state"],
	title: string,
): HealthTileInput {
	return { key, label, value, state: presenceState, title };
}

function buildHealthTiles(signals: OverviewSignals): HealthTileInput[] {
	return [pipelineTile(signals), syncTile(signals), retrievalTile(signals), freshnessTile(signals)];
}

function primaryRecommendations(signals: OverviewSignals): HealthAction[] {
	if (signals.hasBacklog) {
		return [
			{
				label: "Pipeline needs attention. Check queue health first.",
				command: "codemem db raw-events-status",
				action: (trigger) => openDiagnosticsDrawer({ subsystem: "capture", trigger }),
				actionLabel: "View diagnostics",
			},
			{
				label: `Then retry failed batches for impacted sessions (${formatAgentClientList()}).`,
				command: "codemem db raw-events-retry",
			},
		];
	}
	if (signals.syncState === "stopped") {
		return [
			{
				label: "Sync daemon is stopped. Start the background service.",
				command: "codemem serve start",
			},
		];
	}
	if (signals.syncDisabled || signals.syncNoPeers) return [];
	if (
		signals.syncState === "degraded" &&
		signals.syncRecentlyOk &&
		!signals.syncHasRecentFailedAttempt &&
		signals.syncProblemPeers.length === 0
	)
		return [];
	if (
		["error", "degraded", "offline-peers", "stale", "needs_attention"].includes(
			signals.syncState,
		) ||
		(signals.syncState === "ok" && signals.syncHasRecentFailedAttempt) ||
		signals.syncLooksStale
	)
		return unhealthySyncRecommendations(signals);
	return [];
}

function shortDeviceList(names: string[]): string {
	const visible = names.slice(0, 2).join(", ");
	return names.length > 2 ? `${visible} +${names.length - 2} more` : visible;
}

function syncProblemDescription(signals: OverviewSignals): string {
	const failed = shortDeviceList(signals.syncProblemPeers);
	if (signals.syncState === "error") {
		return `Background sync reported an unresolved error.${failed ? ` Check sync with ${failed}.` : ""}`;
	}
	if (signals.syncState === "offline-peers") {
		const offline = shortDeviceList(signals.syncOfflinePeersNames);
		return `All paired devices are offline${offline ? `: ${offline}` : ""}. Check those devices' connections.`;
	}
	if (
		signals.syncState === "degraded" ||
		(signals.syncState === "ok" && signals.syncHasRecentFailedAttempt)
	) {
		return failed
			? `Sync with ${failed} is failing. Other devices may still sync.`
			: "Some device sync attempts are failing.";
	}
	if (signals.syncState === "needs_attention") return "Sync requires manual attention.";
	return "Paired devices have not synced recently.";
}

function unhealthySyncRecommendations(signals: OverviewSignals): HealthAction[] {
	return [
		{
			label: syncProblemDescription(signals),
			command: "codemem sync doctor",
			action: (trigger) => openDiagnosticsDrawer({ subsystem: "sync", trigger }),
			actionLabel: "View diagnostics",
		},
	];
}

function appendMaintenanceRecommendation(
	recommendations: HealthAction[],
	hasFailedMaintenance: boolean,
): void {
	if (!hasFailedMaintenance || recommendations.length >= 3) return;
	recommendations.push({
		label: "Background maintenance failed. Review recent safe failure evidence.",
		command: "codemem maintenance status",
		action: (trigger) =>
			openDiagnosticsDrawer({ severity: "error", subsystem: "maintenance", trigger }),
		actionLabel: "View diagnostics",
	});
}

function buildRecommendations(signals: OverviewSignals): HealthAction[] {
	const recommendations = primaryRecommendations(signals);
	appendMaintenanceRecommendation(recommendations, signals.hasFailedMaintenance);
	if (signals.hasLowTagCoverage && recommendations.length < 2) {
		recommendations.push({
			label: "Tag coverage is low. Preview backfill impact.",
			command: "codemem db backfill-tags --dry-run",
		});
	}
	const backfillIncomplete = signals.scopeBackfillJob?.status !== "completed";
	if (signals.scopeBackfillJob && backfillIncomplete && recommendations.length < 3) {
		recommendations.push({
			label:
				"Sharing-domain upgrade backfill is expected one-time work. Inspect progress if startup feels busy.",
			command: "codemem maintenance status",
		});
	}
	return recommendations;
}

function updateHealthDot(healthDot: HTMLElement | null, status: HealthStatusModel): void {
	if (!healthDot) return;
	healthDot.className = `health-dot ${status.className}`;
	healthDot.title = status.label;
}

function commitHealthOverview(
	mounts: HealthOverviewMounts,
	signals: OverviewSignals,
	risk: RiskResult,
	status: HealthStatusModel,
	hasStaleData: boolean,
): void {
	const recommendations = buildRecommendations(signals);
	const maintenanceCards = signals.maintenanceJobs.map(maintenanceCard);
	updateHealthDot(mounts.healthDot, status);
	renderHealthOverviewGrid(mounts.healthGrid, buildHealthTiles(signals), maintenanceCards);
	renderActionList(mounts.healthActions, recommendations);
	renderHealthStatus(mounts.healthStatus, {
		label: status.label,
		message: healthMetaMessage(risk.drivers.length, risk.drivers),
		stale: hasStaleData,
		state: healthPresenceState(status.className),
		statusClass: status.className,
	});
	renderIcons();
}

export function renderHealthOverview(): void {
	const mounts = healthOverviewMounts();
	if (!mounts) return;
	renderUpdateBanner(document.getElementById("healthUpdateBanner"), state.lastUpdateStatus);
	const stats = healthData(state.healthStats);
	const usage = healthData(state.healthUsage, state.currentProject);
	const raw = healthData(state.healthRawEvents);
	if (!stats || !usage || !raw) {
		renderUnavailableOverview(mounts);
		return;
	}
	const signals = deriveOverviewSignals(stats, usage, raw);
	const risk = calculateRisk(signals);
	const hasStaleData = [state.healthStats, state.healthUsage, state.healthRawEvents].some(
		(resource) => healthResourceIsStale(resource),
	);
	commitHealthOverview(mounts, signals, risk, healthStatus(risk.score, hasStaleData), hasStaleData);
}

function renderUnavailableOverview(mounts: HealthOverviewMounts): void {
	const resources = [state.healthStats, state.healthUsage, state.healthRawEvents];
	const failed = resources.some((resource) => resource.status === "failed");
	const loading = resources.some((resource) => resource.status === "loading");
	const showLoading = loading && !failed;
	let value = "Not loaded";
	let message = "Open or refresh Health to load status.";
	if (failed) {
		value = "Unavailable";
		message = "Some health data failed to load. Refresh Health to try again.";
	} else if (loading) {
		value = "Loading";
		message = "Loading health data…";
	}
	renderHealthOverviewGrid(mounts.healthGrid, [], []);
	renderActionList(mounts.healthActions, []);
	renderHealthStatus(mounts.healthStatus, {
		label: value,
		message,
		stale: false,
		state: showLoading ? "syncing" : "unknown",
		statusClass: "status-unknown",
	});
	updateHealthDot(mounts.healthDot, { label: value, className: "status-unknown" });
	renderIcons();
}
