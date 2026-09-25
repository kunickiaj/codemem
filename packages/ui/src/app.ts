/* Viewer UI entry point.
 *
 * Built to: packages/viewer-server/static/app.js (served at /assets/app.js)
 *
 * Orchestrates tab routing, polling, and delegates rendering to tab modules.
 */

/* global lucide */

declare const __CODEMEM_GIT_COMMIT__: string;

import { createRecipientPolicySharingLoader } from "./app-sharing";
import {
	closeDiagnosticsDrawer,
	coordinatedRefreshDiagnosticsDrawer,
	initDiagnosticsEntryPoints,
	mountDiagnosticsDrawer,
	recordViewerConnectionEvent,
} from "./components/diagnostics";
import {
	hideLegacyUpgradeDialog,
	type LegacyUpgradeReviewSummary,
	mountLegacyUpgradeDialog,
	showLegacyUpgradeDialog,
} from "./components/legacy-upgrade-dialog";
import { mountToastHost } from "./components/primitives/toast";
import * as api from "./lib/api";
import type { ProjectScopeInventoryProject } from "./lib/api/sync";
import { coordinatorEnrollmentOpenIssueCount } from "./lib/coordinator-enrollment-attention";
import { $, $button, $select } from "./lib/dom";
import { isReadTimeout, type ReadRequestOptions, waitForAbort } from "./lib/read-request";
import { createRefreshSessionOwner, type RefreshSession } from "./lib/refresh-session";
import {
	type AdvancedSection,
	ALL_TAB_IDS,
	getVisibleTabs,
	initState,
	isCoordinatorAdministrationRoute,
	parseAdvancedSectionFromHash,
	parseTabFromHash,
	resolveAccessibleTab,
	setActiveTab,
	setAdvancedSection,
	state,
	type TabId,
} from "./lib/state";
import { createTabVisibilityTracker } from "./lib/tab-visibility";
import { getTheme, initThemeToggle, setTheme } from "./lib/theme";
import { type AdvancedTabValue, mountAdvancedTabs } from "./tabs/advanced-tabs";
import { initCoordinatorAdminTab, loadCoordinatorAdminData } from "./tabs/coordinator-admin";
import {
	beginStandaloneCoordinatorAdminStatusRefresh,
	refreshCoordinatorAdminStatusForGeneration,
} from "./tabs/coordinator-admin/data/status-refresh";
import {
	type DeviceAvailabilityInput,
	type DevicePeerRuntimeMetadataInput,
	type DevicesNavigationTarget,
	type DevicesProjectInput,
	type DevicesRendererOptions,
	mountDevices,
} from "./tabs/devices";
import { initFeedTab, loadFeedData, updateFeedView } from "./tabs/feed";
import { completeFirstRunStep } from "./tabs/feed/data/first-run-guide";
import {
	initHealthTab,
	loadHealthData,
	markHealthStatusUnchecked,
	refreshViewerStatus,
} from "./tabs/health";
import { mountLegacyTeamSetupDialog, openLegacyTeamSetup } from "./tabs/legacy-team-setup-dialog";
import { initProjectsTab, loadProjectsData } from "./tabs/projects";
import { toRecipientPolicyManagementProjects } from "./tabs/recipient-policy-projects";
import { requestSharingNavigation } from "./tabs/recipient-policy-sharing";
import { initSettings, isSettingsOpen, loadConfigData, openSettings } from "./tabs/settings";
import { setSettingsTab } from "./tabs/settings/data/state-ops";
import {
	initSyncTab,
	invalidateSyncPeerScopeCache,
	loadPairingData,
	loadSyncData,
} from "./tabs/sync";
import { applySyncSubView } from "./tabs/sync/sync-view-controller";
import { derivePeerUiStatus } from "./tabs/sync/view-model/peer-status";

function setRuntimeLabel(version: string, commit: string | null) {
	const el = $("runtimeLabel");
	if (!el) return;
	const label = commit ? `v${version} (${commit})` : `v${version}`;
	el.textContent = label;
	el.title = commit ? `codemem ${version} (${commit})` : `codemem ${version}`;
	el.hidden = false;
}

async function loadRuntimeLabel() {
	try {
		const runtime = await api.loadRuntimeInfo();
		if (!runtime?.version) return;
		const commit = __CODEMEM_GIT_COMMIT__ || null;
		setRuntimeLabel(runtime.version, commit);
	} catch {}
}

/* ── Refresh status ──────────────────────────────────────── */

type RefreshState = "idle" | "refreshing" | "paused" | "error";
let lastAnnouncedRefreshState: RefreshState | null = null;
const RECONNECT_POLL_MS = 1500;
const refreshSessions = createRefreshSessionOwner();
const LEGACY_UPGRADE_NOTICE_DISMISSED_KEY = "codemem-legacy-upgrade-notice-dismissed";

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnecting = false;
let viewerIncidentAwaitingRefresh = false;
let legacyUpgradeNoticeShown = false;

function readNonNegativeCount(value: unknown, fallback = 0): number {
	const count = Number(value);
	return Number.isFinite(count) ? Math.max(0, count) : fallback;
}

function readLegacyUpgradeReviewSummary(payload: unknown): LegacyUpgradeReviewSummary | null {
	if (!payload || typeof payload !== "object") return null;
	const review = (payload as { legacy_shared_review?: unknown }).legacy_shared_review ?? payload;
	if (!review || typeof review !== "object") return null;
	const raw = review as {
		groups?: unknown;
		has_data?: unknown;
		memory_count?: unknown;
		total_group_count?: unknown;
	};
	if (raw.has_data !== true) return null;
	const groups = Array.isArray(raw.groups) ? raw.groups : [];
	const groupCount = readNonNegativeCount(raw.total_group_count, groups.length);
	const memoryCount = readNonNegativeCount(raw.memory_count);
	if (groupCount <= 0 || memoryCount <= 0) return null;
	return { groupCount, memoryCount };
}

function isLegacyUpgradeNoticeDismissed(): boolean {
	try {
		return localStorage.getItem(LEGACY_UPGRADE_NOTICE_DISMISSED_KEY) === "1";
	} catch {
		return false;
	}
}

function dismissLegacyUpgradeNoticeIfRequested() {
	const checkbox = document.getElementById("legacyUpgradeDontShow") as HTMLInputElement | null;
	if (!checkbox?.checked) return;
	try {
		localStorage.setItem(LEGACY_UPGRADE_NOTICE_DISMISSED_KEY, "1");
	} catch {}
}

function setLegacyUpgradeNotice(open: boolean, summary?: LegacyUpgradeReviewSummary) {
	if (open && summary) showLegacyUpgradeDialog(summary);
	else hideLegacyUpgradeDialog();
}

function maybeShowLegacyUpgradeNotice(summary: LegacyUpgradeReviewSummary | null) {
	if (!summary || legacyUpgradeNoticeShown || isLegacyUpgradeNoticeDismissed()) return;
	legacyUpgradeNoticeShown = true;
	closeDiagnosticsDrawer(() => setLegacyUpgradeNotice(true, summary));
}

async function checkLegacyUpgradeNotice() {
	if (legacyUpgradeNoticeShown || isLegacyUpgradeNoticeDismissed()) return;
	try {
		const payload = await api.loadSyncStatus(false, "", { includeJoinRequests: false });
		maybeShowLegacyUpgradeNotice(readLegacyUpgradeReviewSummary(payload));
	} catch {}
}

function setReconnectOverlay(open: boolean, detail?: string) {
	state.viewerReconnectOpen = open;
	const overlay = $("viewerReconnectOverlay");
	const detailEl = $("viewerReconnectDetail");
	if (!overlay || !detailEl) return;
	overlay.hidden = !open;
	detailEl.textContent = detail || "Trying again automatically while the viewer comes back.";
	if (state.activeTab === "feed") updateFeedView(true);
}

async function isViewerReady() {
	try {
		await api.pingViewerReady();
		return true;
	} catch {
		return false;
	}
}

function canResumeRefresh() {
	return document.visibilityState !== "hidden" && !isSettingsOpen();
}

function activeRefreshSurface(): string {
	return `${state.activeTab}:${state.advancedSection}:${state.syncPairingOpen}`;
}

function recordViewerRestoredAfterSuccessfulRefresh(options: {
	refreshSucceeded: boolean;
	surface: string;
}): void {
	if (state.refreshQueued || options.surface !== activeRefreshSurface()) return;
	if (!options.refreshSucceeded || !viewerIncidentAwaitingRefresh || reconnecting) return;
	viewerIncidentAwaitingRefresh = false;
	recordViewerConnectionEvent("connection_restored");
}

function scheduleReconnectLoop() {
	if (reconnecting) return;
	reconnecting = true;
	viewerIncidentAwaitingRefresh = true;
	recordViewerConnectionEvent("connection_lost");
	stopPolling();
	closeDiagnosticsDrawer();
	setRefreshStatus("error", "(reconnecting)");
	setReconnectOverlay(
		true,
		"The viewer server is restarting or temporarily unavailable. Trying again automatically…",
	);

	const tick = async () => {
		const ready = await isViewerReady();
		if (ready) {
			// Keep the overlay visible through the handoff. Hiding here and
			// then re-showing if the follow-up refresh fails (a common case
			// when the server's HTTP port opens a moment before all handlers
			// are wired) produces a visible background flash. Clear the tick
			// timer, release the reconnecting flag so doRefresh can proceed,
			// let doRefresh run under the overlay, and only dismiss after it
			// completes without re-scheduling a reconnect.
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			reconnecting = false;
			setReconnectOverlay(true, "Viewer responded. Restoring your session…");
			if (canResumeRefresh()) {
				setRefreshStatus("refreshing");
				startPolling();
				try {
					await doRefresh();
				} catch {
					// doRefresh handles its own failures (and may re-schedule
					// the reconnect loop on catch).
				}
			} else {
				setRefreshStatus(
					"paused",
					document.visibilityState === "hidden" ? "(tab hidden)" : "(settings open)",
				);
			}
			// If doRefresh re-scheduled a reconnect, `reconnecting` is true
			// again and the overlay is already showing the new message —
			// leave it up. Otherwise the session is restored; dismiss.
			if (!reconnecting) setReconnectOverlay(false);
			return;
		}
		setReconnectOverlay(
			true,
			"Still reconnecting… the viewer will recover automatically as soon as the server responds.",
		);
		reconnectTimer = setTimeout(tick, RECONNECT_POLL_MS);
	};

	reconnectTimer = setTimeout(tick, RECONNECT_POLL_MS);
}

function setRefreshStatus(rs: RefreshState, detail?: string) {
	state.refreshState = rs;
	const el = $("refreshStatus");
	if (!el) return;
	el.dataset.refreshState = rs;

	const announce = (msg: string) => {
		const announcer = $("refreshAnnouncer");
		if (!announcer || lastAnnouncedRefreshState === rs) return;
		announcer.textContent = msg;
		lastAnnouncedRefreshState = rs;
	};

	if (rs === "refreshing") {
		el.textContent = "refreshing…";
		return;
	}
	if (rs === "paused") {
		el.textContent = "paused";
		announce("Auto refresh paused.");
		return;
	}
	if (rs === "error" && detail === "(reconnecting)") {
		el.textContent = "reconnecting…";
		announce("Viewer reconnecting.");
		return;
	}
	if (rs === "error") {
		el.textContent = "refresh failed";
		announce("Refresh failed.");
		return;
	}
	const suffix = detail ? ` ${detail}` : "";
	el.textContent = `updated ${new Date().toLocaleTimeString()}${suffix}`;
	lastAnnouncedRefreshState = null;
}

/* ── Polling ─────────────────────────────────────────────── */

function stopPolling() {
	refreshSessions.cancel();
	if (refreshDebounceTimer) {
		clearTimeout(refreshDebounceTimer);
		refreshDebounceTimer = null;
	}
	state.refreshQueued = false;
	if (state.refreshTimer) {
		clearInterval(state.refreshTimer);
		state.refreshTimer = null;
	}
}

function pausePolling() {
	stopPolling();
	setRefreshStatus("paused");
}

function startPolling() {
	if (state.refreshTimer) return;
	// Polling drives health/config updates and disconnect detection in
	// doRefresh(), so it must run regardless of which tab is active. The
	// Projects tab's draft-preservation lives inside loadProjectsData()
	// itself: it short-circuits when a Space select is focused
	// (isProjectSpaceSelectActive) and persists drafts across re-renders
	// via the draftClusterDomainSelections / draftDomainSelections maps.
	state.refreshTimer = setInterval(() => refresh(), 5000);
}

document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") {
		stopPolling();
		setRefreshStatus("paused", "(tab hidden)");
	} else if (!isSettingsOpen() && !reconnecting) {
		startPolling();
		refresh();
	}
});

/* ── Tab routing ─────────────────────────────────────────── */

let revealCoordinatorAdministration = false;

function renderAdvancedSection() {
	const isSync = state.advancedSection === "sync";
	const syncContent = $("advancedSyncContent");
	const teamsContent = $("advancedTeamsContent");
	if (syncContent) syncContent.hidden = !isSync;
	if (teamsContent) teamsContent.hidden = isSync;
	const tabsMount = $("advancedTabsMount");
	if (tabsMount) mountAdvancedTabs(tabsMount, state.advancedSection, selectAdvancedSection);
	queueMicrotask(() => {
		const hash = window.location.hash.replace(/^#/, "");
		if (!isSync && revealCoordinatorAdministration) {
			revealCoordinatorAdministration = false;
			const disclosure = document.getElementById("advancedAdministrationDisclosure");
			if (disclosure instanceof HTMLDetailsElement) disclosure.open = true;
			document.getElementById("coordinatorAdminHeading")?.focus();
		}
		applySyncSubView(
			hash === "sync/diagnostics" || hash === "advanced/sync/diagnostics" ? "diagnostics" : "main",
		);
	});
}

function selectAdvancedSection(
	section: AdvancedTabValue,
	options: { focusContent?: boolean } = {},
) {
	setAdvancedSection(section, true);
	renderAdvancedSection();
	if (section === "teams" && options.focusContent) {
		queueMicrotask(() => document.getElementById("coordinatorAdminHeading")?.focus());
	}
}

const revealChangedTab = createTabVisibilityTracker();

function renderTabs(activeTab: TabId) {
	const visibleTabs = new Set(getVisibleTabs(state.lastCoordinatorAdminStatus));
	ALL_TAB_IDS.forEach((id) => {
		const panel = $(`tab-${id}`);
		if (panel) panel.hidden = id !== activeTab || !visibleTabs.has(id);
	});

	ALL_TAB_IDS.forEach((id) => {
		const btn = $(`tabBtn-${id}`);
		if (!btn) return;
		btn.hidden = !visibleTabs.has(id);
		const active = id === activeTab && visibleTabs.has(id);
		btn.classList.toggle("active", active);
		if (active) btn.setAttribute("aria-current", "page");
		else btn.removeAttribute("aria-current");
	});
	const activeButton = $(`tabBtn-${activeTab}`);
	if (activeButton) revealChangedTab(activeButton);
	if (activeTab === "advanced") renderAdvancedSection();
}

function switchTab(
	tab: TabId,
	options: { canonicalHash?: boolean; advancedSection?: AdvancedSection } = {},
) {
	refreshSessions.cancel();
	const nextTab = resolveAccessibleTab(tab, state.lastCoordinatorAdminStatus);
	if (nextTab === "advanced") {
		setAdvancedSection(
			options.advancedSection ?? parseAdvancedSectionFromHash() ?? state.advancedSection,
		);
	}
	setActiveTab(nextTab, options.canonicalHash ? { canonicalHash: true } : {});
	if (nextTab === "health") completeFirstRunStep("settings-health");
	renderTabs(nextTab);

	// Refresh data for active tab
	refresh();
}

function initTabs() {
	window.addEventListener("codemem:navigate-advanced-sync", navigateToAdvancedSyncFromSharing);
	ALL_TAB_IDS.forEach((id) => {
		const btn = $(`tabBtn-${id}`);
		btn?.addEventListener("click", () =>
			switchTab(
				id,
				id === "advanced"
					? { canonicalHash: true, advancedSection: "sync" }
					: { canonicalHash: true },
			),
		);
	});
	$("syncTurnOnButton")?.addEventListener("click", () => {
		setSettingsTab("sync");
		openSettings(pausePolling);
	});
	$("advancedTeamSettingsLink")?.addEventListener("click", (event) => {
		event.preventDefault();
		requestSharingNavigation("teams");
		switchTab("sharing", { canonicalHash: true });
		queueMicrotask(() => document.getElementById("tabBtn-sharing")?.focus());
	});
	$("advancedSharingLink")?.addEventListener("click", (event) => {
		event.preventDefault();
		requestSharingNavigation("invitations");
		switchTab("sharing", { canonicalHash: true });
		queueMicrotask(() => document.getElementById("tabBtn-sharing")?.focus());
	});

	// Listen for hash changes (back/forward navigation). Hashes may include a
	// sub-view segment (e.g. `#sync/diagnostics`) — parse with the shared
	// helper so nested segments still resolve to their parent tab.
	window.addEventListener("hashchange", () => {
		const top = parseTabFromHash();
		if (top) {
			const advancedSection = parseAdvancedSectionFromHash();
			revealCoordinatorAdministration = isCoordinatorAdministrationRoute();
			switchTab(top, advancedSection ? { advancedSection } : {});
			if (top === "advanced" && advancedSection === "teams") {
				queueMicrotask(() => document.getElementById("coordinatorAdminHeading")?.focus());
			}
		}
	});

	// Set initial tab
	revealCoordinatorAdministration = isCoordinatorAdministrationRoute();
	switchTab(state.activeTab);
}

/* ── Project filter ──────────────────────────────────────── */

async function loadProjects() {
	try {
		const projects = await api.loadProjects();
		state.knownProjects = projects;
		// The Sync peer-scope picker caches these as clickable chips; its
		// render is otherwise deduped on an unrelated payload hash, so tell
		// it to invalidate. No-op when Sync hasn't loaded yet.
		invalidateSyncPeerScopeCache();
		const projectFilter = $select("projectFilter");
		if (!projectFilter) return;
		projectFilter.textContent = "";
		const allOpt = document.createElement("option");
		allOpt.value = "";
		allOpt.textContent = "All Projects";
		projectFilter.appendChild(allOpt);
		projects.forEach((p) => {
			const opt = document.createElement("option");
			opt.value = p;
			opt.textContent = p;
			projectFilter.appendChild(opt);
		});
	} catch {}
}

function reviewDevicesFromSharing(deviceId?: string) {
	state.pendingDeviceIdentityFocus = deviceId?.trim() || null;
	switchTab("devices", { canonicalHash: true });
}

function navigateToAdvancedSyncFromSharing() {
	switchTab("advanced", { advancedSection: "sync" });
	queueMicrotask(() => document.getElementById("advancedSyncButton")?.focus());
}

const loadRecipientPolicySharingData = createRecipientPolicySharingLoader(
	{},
	{
		onOpenTeamSetup: openLegacyTeamSetup,
		onReviewDevices: reviewDevicesFromSharing,
	},
);
const emptyRecipientPolicyIntent: api.RecipientPolicyIntentGraphV1 = {
	version: 1,
	identities: [],
	teams: [],
	teamMemberships: [],
	identityDevices: [],
	projectRecipients: [],
};
let devicesLoadRevision = 0;
let latestDevicesLoad: Promise<boolean> | null = null;
let lastDevicesData: {
	projects: DevicesProjectInput[];
	intent: api.RecipientPolicyIntentGraphV1;
	reconciliation: api.RecipientPolicyReconciliationStatusV1;
	availability: DeviceAvailabilityInput[];
	peerRuntimeMetadata: DevicePeerRuntimeMetadataInput[];
	inventory: api.DeviceIdentityInventoryV1 | undefined;
	inventoryUnavailable: boolean;
	coordinatorEnrollmentIssueCount: number;
} | null = null;

async function loadRecipientPolicyProjects(
	options: ReadRequestOptions = {},
): Promise<DevicesProjectInput[]> {
	const projects: ProjectScopeInventoryProject[] = [];
	let offset = 0;
	while (true) {
		const page = await api.loadProjectScopeInventory({
			limit: 250,
			offset,
			signal: options.signal,
		});
		projects.push(...page.projects);
		if (!page.has_more) break;
		offset += page.limit;
	}
	return toRecipientPolicyManagementProjects(projects);
}

function deriveDeviceAvailability(): DeviceAvailabilityInput[] {
	const availability = new Map<string, DeviceAvailabilityInput["state"]>();
	const rank = { unknown: 0, offline: 1, available: 2 } as const;
	const record = (deviceId: string, next: DeviceAvailabilityInput["state"]) => {
		if (!deviceId || rank[next] <= rank[availability.get(deviceId) ?? "unknown"]) return;
		availability.set(deviceId, next);
	};
	for (const device of state.lastSyncCoordinator?.discovered_devices ?? []) {
		// Expired coordinator presence does not prove the machine is offline.
		record(String(device.device_id ?? "").trim(), device.stale ? "unknown" : "available");
	}
	for (const peer of state.lastSyncPeers) {
		const deviceId = String(peer.peer_device_id ?? "").trim();
		const syncState = derivePeerUiStatus(peer);
		record(
			deviceId,
			syncState === "connected" || syncState === "available"
				? "available"
				: syncState === "offline"
					? "offline"
					: "unknown",
		);
	}
	return [...availability].map(([deviceId, state]) => ({ deviceId, state }));
}

function deriveDevicePeerRuntimeMetadata(): DevicePeerRuntimeMetadataInput[] {
	return state.lastSyncPeers.flatMap((peer) => {
		const deviceId = String(peer.peer_device_id ?? "").trim();
		if (!deviceId) return [];
		return [
			{
				deviceId,
				runtimeVersion: peer.runtime_version ?? null,
				runtimeVersionObservedAt: peer.runtime_version_observed_at ?? null,
			},
		];
	});
}

function navigateFromDevices(target: DevicesNavigationTarget) {
	if (target === "advanced_sync") {
		switchTab("advanced", { advancedSection: "sync" });
		queueMicrotask(() => document.getElementById("tabBtn-advanced")?.focus());
		return;
	}
	if (target === "sharing_teams") {
		switchTab("sharing", { canonicalHash: true });
		requestSharingNavigation("teams");
		queueMicrotask(() => document.getElementById("tabBtn-sharing")?.focus());
		return;
	}
	switchTab(target, { canonicalHash: true });
	queueMicrotask(() => document.getElementById(`tabBtn-${target}`)?.focus());
}

function loadDevicesData(
	options: ReadRequestOptions & { deferWhileRenaming?: boolean } = {},
): Promise<boolean> {
	const mount = document.getElementById("devicesMount");
	if (!mount) return Promise.resolve(true);
	if (options.deferWhileRenaming && document.activeElement?.closest(".devices-rename-form")) {
		return Promise.resolve(true);
	}
	const revision = ++devicesLoadRevision;
	const operation = runLoadDevicesData(mount, revision, options);
	latestDevicesLoad = operation;
	return operation;
}

async function refreshDevicesAfterCommit(): Promise<boolean> {
	const [devicesRefreshed, sharingRefreshed] = await Promise.all([
		loadDevicesData(),
		loadRecipientPolicySharingData(),
	]);
	return devicesRefreshed && sharingRefreshed;
}

function deviceRendererActions(): Pick<
	DevicesRendererOptions,
	"onCommitted" | "onNavigate" | "onRetry" | "localDeviceId"
> {
	return {
		localDeviceId: state.lastSyncStatus?.device_id ?? undefined,
		onCommitted: refreshDevicesAfterCommit,
		onNavigate: navigateFromDevices,
		onRetry: () => void loadDevicesData(),
	};
}

async function runLoadDevicesData(
	mount: HTMLElement,
	revision: number,
	options: ReadRequestOptions,
): Promise<boolean> {
	if (!lastDevicesData) {
		mountDevices(mount, emptyRecipientPolicyIntent, { version: 1, items: [] }, [], [], {
			loading: true,
		});
	}
	try {
		const [projects, intent, reconciliation, inventoryResult, syncRefreshed] = await Promise.all([
			loadRecipientPolicyProjects(options),
			api.loadRecipientPolicyIntent(options),
			api.loadRecipientPolicyReconciliationStatus(options),
			api
				.loadDeviceIdentityInventory(options)
				.then((inventory) => ({ inventory, unavailable: false }))
				.catch(() => ({ inventory: lastDevicesData?.inventory, unavailable: true })),
			loadSyncData({ requiredSurface: "devices", signal: options.signal }),
		]);
		if (options.signal?.aborted) return false;
		if (revision !== devicesLoadRevision) return latestDevicesLoad ?? false;
		const availability = deriveDeviceAvailability();
		const peerRuntimeMetadata = deriveDevicePeerRuntimeMetadata();
		const coordinatorEnrollmentIssueCount = coordinatorEnrollmentOpenIssueCount(
			state.lastSyncStatus,
		);
		if (!inventoryResult.unavailable && inventoryResult.inventory) {
			state.lastDeviceIdentityInventory = inventoryResult.inventory;
		}
		state.deviceIdentityInventoryLoadError = inventoryResult.unavailable;
		mountDevices(mount, intent, reconciliation, projects, availability, {
			...deviceRendererActions(),
			inventory: inventoryResult.inventory,
			inventoryUnavailable: inventoryResult.unavailable,
			coordinatorEnrollmentIssueCount,
			peerRuntimeMetadata,
		});
		lastDevicesData = {
			projects,
			intent,
			reconciliation,
			availability,
			peerRuntimeMetadata,
			inventory: inventoryResult.inventory,
			inventoryUnavailable: inventoryResult.unavailable,
			coordinatorEnrollmentIssueCount,
		};
		return syncRefreshed;
	} catch {
		if (options.signal?.aborted) return false;
		if (revision !== devicesLoadRevision) return latestDevicesLoad ?? false;
		if (lastDevicesData) {
			mountDevices(
				mount,
				lastDevicesData.intent,
				lastDevicesData.reconciliation,
				lastDevicesData.projects,
				lastDevicesData.availability,
				{
					...deviceRendererActions(),
					coordinatorEnrollmentIssueCount: lastDevicesData.coordinatorEnrollmentIssueCount,
					inventory: lastDevicesData.inventory,
					inventoryUnavailable: lastDevicesData.inventoryUnavailable,
					peerRuntimeMetadata: lastDevicesData.peerRuntimeMetadata,
					refreshError: true,
				},
			);
		} else {
			mountDevices(mount, emptyRecipientPolicyIntent, { version: 1, items: [] }, [], [], {
				loadError: true,
			});
		}
		return false;
	}
}

$select("projectFilter")?.addEventListener("change", () => {
	refreshSessions.cancel();
	state.currentProject = $select("projectFilter")?.value || "";
	completeFirstRunStep("scope");
	updateFeedView(true);
	refresh();
});

/* ── Main refresh ────────────────────────────────────────── */

let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;

async function loadGlobalRefreshData(session: RefreshSession): Promise<void> {
	await Promise.all([
		refreshViewerStatus({ signal: session.signal }),
		loadConfigData({ signal: session.signal }),
		coordinatedRefreshDiagnosticsDrawer().catch(() => undefined),
	]);
}

function appendTabRefreshTasks(
	promises: Promise<unknown>[],
	refreshTab: TabId,
	recordBooleanResult: (succeeded: boolean) => void,
	session: RefreshSession,
): void {
	if (refreshTab !== "health") markHealthStatusUnchecked();
	if (refreshTab === "feed") {
		const coordinatorGeneration = beginStandaloneCoordinatorAdminStatusRefresh();
		promises.push(
			refreshCoordinatorAdminStatusForGeneration(coordinatorGeneration, { signal: session.signal }),
			loadFeedData({ signal: session.signal }),
		);
	}
	if (refreshTab === "projects") {
		promises.push(
			loadProjectsData({ awaitTeamSetupSummary: true, signal: session.signal }).then(
				recordBooleanResult,
			),
		);
	}
	if (refreshTab === "sharing") {
		promises.push(
			loadRecipientPolicySharingData({
				awaitTeamSetupSummary: true,
				signal: session.signal,
			}).then(recordBooleanResult),
		);
	}
	if (refreshTab === "devices") {
		promises.push(
			loadDevicesData({ deferWhileRenaming: true, signal: session.signal }).then(
				recordBooleanResult,
			),
		);
	}
	if (refreshTab === "health") {
		promises.push(
			loadHealthData({ signal: session.signal }),
			loadSyncData({
				requiredSurface: "health",
				requireFreshSyncStatus: viewerIncidentAwaitingRefresh,
				signal: session.signal,
			}).then(recordBooleanResult),
		);
	}
	if (refreshTab === "advanced" && state.advancedSection === "sync") {
		promises.push(loadSyncData({ signal: session.signal }).then(recordBooleanResult));
	}
	if (refreshTab === "advanced" && state.advancedSection === "teams") {
		promises.push(
			loadCoordinatorAdminData({ deferWhileRenaming: true, signal: session.signal }).then(
				recordBooleanResult,
			),
		);
	}
	if (!state.syncPairingOpen) return;
	const pairingVisible = refreshTab === "advanced" && state.advancedSection === "sync";
	const pairingRefresh = loadPairingData({ signal: session.signal });
	promises.push(pairingVisible ? pairingRefresh.then(recordBooleanResult) : pairingRefresh);
}

async function refresh() {
	if (reconnecting) return;
	// Debounce rapid calls (tab switch + hash change + visibility)
	if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
	refreshDebounceTimer = setTimeout(() => doRefresh(), 80);
}

async function handleRefreshFailure(error: unknown, session: RefreshSession): Promise<void> {
	if (!session.isCurrent() && !isReadTimeout(error)) return;
	const ready = await isViewerReady();
	if (!session.isOwned()) return;
	if (!ready) scheduleReconnectLoop();
	else setRefreshStatus("error");
}

function finishRefresh(session: RefreshSession): void {
	refreshSessions.finish(session);
	state.refreshInFlight = false;
	if (!state.refreshQueued || reconnecting || !canResumeRefresh()) return;
	state.refreshQueued = false;
	void doRefresh();
}

async function doRefresh(): Promise<void> {
	if (reconnecting || !canResumeRefresh()) return;
	if (state.refreshInFlight) {
		state.refreshQueued = true;
		return;
	}
	state.refreshInFlight = true;
	const session = refreshSessions.begin();

	try {
		setRefreshStatus("refreshing");
		const refreshTab = state.activeTab;
		const surface = activeRefreshSurface();
		const promises: Promise<unknown>[] = [loadGlobalRefreshData(session)];
		let activeTabRefreshSucceeded = true;
		appendTabRefreshTasks(
			promises,
			refreshTab,
			(succeeded) => {
				activeTabRefreshSucceeded = activeTabRefreshSucceeded && succeeded;
			},
			session,
		);
		await waitForAbort(Promise.all(promises), session.signal);
		if (!session.isCurrent()) {
			if (isReadTimeout(session.signal.reason)) throw session.signal.reason;
			return;
		}
		maybeShowLegacyUpgradeNotice(readLegacyUpgradeReviewSummary(state.lastSyncLegacySharedReview));
		if (refreshTab === "feed") updateFeedView(true);
		const nextTab = resolveAccessibleTab(state.activeTab, state.lastCoordinatorAdminStatus);
		if (nextTab !== state.activeTab) {
			setActiveTab(nextTab);
		}
		renderTabs(state.activeTab);
		setRefreshStatus(activeTabRefreshSucceeded ? "idle" : "error");
		recordViewerRestoredAfterSuccessfulRefresh({
			refreshSucceeded: activeTabRefreshSucceeded,
			surface,
		});
	} catch (error) {
		await handleRefreshFailure(error, session);
	} finally {
		finishRefresh(session);
	}
}

/* ── Boot ────────────────────────────────────────────────── */

initState();

// Toast host — mount first so early notices (from tab init etc.) land.
const toastRoot = document.getElementById("toastRoot");
if (toastRoot) mountToastHost(toastRoot);
const diagnosticsDrawerRoot = document.getElementById("diagnosticsDrawerMount");
if (diagnosticsDrawerRoot) mountDiagnosticsDrawer(diagnosticsDrawerRoot);
const legacyTeamSetupRoot = document.getElementById("legacyTeamSetupMount");
if (legacyTeamSetupRoot) {
	mountLegacyTeamSetupDialog(legacyTeamSetupRoot, {
		onCompleted: async () => {
			let sharingUpdated: boolean;
			let projectsUpdated: boolean;
			const refreshOptions = { requireTeamSetupSummary: true };
			if (state.activeTab === "sharing") {
				projectsUpdated = await loadProjectsData(refreshOptions);
				sharingUpdated = await loadRecipientPolicySharingData(refreshOptions);
			} else {
				sharingUpdated = await loadRecipientPolicySharingData(refreshOptions);
				projectsUpdated = await loadProjectsData(refreshOptions);
			}
			if (!sharingUpdated || !projectsUpdated) throw new Error("team_setup_refresh_failed");
		},
	});
}
const legacyUpgradeDialogRoot = document.getElementById("legacyUpgradeDialogMount");
if (legacyUpgradeDialogRoot) {
	mountLegacyUpgradeDialog(legacyUpgradeDialogRoot, {
		onDismiss: dismissLegacyUpgradeNoticeIfRequested,
		onReviewGroups: () => {
			window.location.hash = "sync";
			setTimeout(
				() => document.getElementById("syncSharingReview")?.scrollIntoView({ block: "start" }),
				120,
			);
		},
		onReviewProjects: () => {
			window.location.hash = "projects";
		},
	});
}

// Theme
initThemeToggle($button("themeToggle"));
setTheme(getTheme());

// Tabs
initTabs();

// Tab modules
initFeedTab();
initHealthTab();
initDiagnosticsEntryPoints();
initProjectsTab(() => refresh(), { onOpenTeamSetup: openLegacyTeamSetup });
initSyncTab(() => refresh());
initCoordinatorAdminTab();
initSettings(pausePolling, startPolling, () => refresh());

// Projects
loadProjects();

$("viewerReconnectRetry")?.addEventListener("click", async () => {
	recordViewerConnectionEvent("reconnect_requested");
	setReconnectOverlay(true, "Checking whether the viewer server is back…");
	const ready = await isViewerReady();
	if (!ready) {
		scheduleReconnectLoop();
		return;
	}
	// Release the reconnecting flag but keep the overlay up while the first
	// refresh runs — otherwise a failed refresh causes a hide→show flash.
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	reconnecting = false;
	setReconnectOverlay(true, "Viewer responded. Restoring your session…");
	startPolling();
	try {
		await doRefresh();
	} catch {
		// doRefresh handles its own failures
	}
	if (!reconnecting) setReconnectOverlay(false);
});

// Version label
loadRuntimeLabel();

// Upgrade notice
checkLegacyUpgradeNotice();

// Start
refresh();
startPolling();
