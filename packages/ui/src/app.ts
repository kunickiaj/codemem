/* Viewer UI entry point.
 *
 * Built to: packages/viewer-server/static/app.js (served at /assets/app.js)
 *
 * Orchestrates tab routing, polling, and delegates rendering to tab modules.
 */

/* global lucide */

declare const __CODEMEM_GIT_COMMIT__: string;

import { createRecipientPolicySharingLoader } from "./app-sharing";
import { mountToastHost } from "./components/primitives/toast";
import * as api from "./lib/api";
import type { ProjectScopeInventoryProject } from "./lib/api/sync";
import { $, $button, $select } from "./lib/dom";
import { handlePrimaryActionKeyboard } from "./lib/keyboard";
import {
	type AdvancedSection,
	ALL_TAB_IDS,
	getVisibleTabs,
	initState,
	parseAdvancedSectionFromHash,
	parseTabFromHash,
	resolveAccessibleTab,
	setActiveTab,
	setAdvancedSection,
	state,
	type TabId,
} from "./lib/state";
import { getTheme, initThemeToggle, setTheme } from "./lib/theme";

import { initCoordinatorAdminTab, loadCoordinatorAdminData } from "./tabs/coordinator-admin";
import {
	type DeviceAvailabilityInput,
	type DevicesNavigationTarget,
	type DevicesProjectInput,
	mountDevices,
} from "./tabs/devices";
import { initFeedTab, loadFeedData, updateFeedView } from "./tabs/feed";
import { initHealthTab, loadHealthData } from "./tabs/health";
import { initProjectsTab, loadProjectsData } from "./tabs/projects";
import { toRecipientPolicyManagementProjects } from "./tabs/recipient-policy-projects";
import { initSettings, isSettingsOpen, loadConfigData } from "./tabs/settings";
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
const LEGACY_UPGRADE_NOTICE_DISMISSED_KEY = "codemem-legacy-upgrade-notice-dismissed";

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnecting = false;
let legacyUpgradeNoticeShown = false;
let legacyUpgradeNoticePreviousFocus: HTMLElement | null = null;

type LegacyUpgradeReviewSummary = {
	groupCount: number;
	memoryCount: number;
};

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

function legacyUpgradeFocusableElements(): HTMLElement[] {
	const modal = $("legacyUpgradeModal");
	if (!modal || modal.hidden) return [];
	return Array.from(
		modal.querySelectorAll<HTMLElement>(
			'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
		),
	).filter((element) => !element.hidden && element.offsetParent !== null);
}

function focusLegacyUpgradeModal() {
	const focusable = legacyUpgradeFocusableElements();
	const primary = $("legacyUpgradeReviewGroups") as HTMLElement | null;
	(primary && focusable.includes(primary) ? primary : focusable[0])?.focus();
}

function handleLegacyUpgradeModalKeydown(event: KeyboardEvent) {
	const modal = $("legacyUpgradeModal");
	if (!modal || modal.hidden) return;
	if (event.key === "Escape") {
		event.preventDefault();
		dismissLegacyUpgradeNoticeIfRequested();
		setLegacyUpgradeNotice(false);
		return;
	}
	if (event.key === "Enter") {
		const primary = $("legacyUpgradeReviewGroups") as HTMLButtonElement | null;
		handlePrimaryActionKeyboard(event, {
			onSubmit: () => primary?.click(),
			disabled: !primary || primary.disabled,
		});
		return;
	}
	if (event.key !== "Tab") return;
	const focusable = legacyUpgradeFocusableElements();
	if (focusable.length === 0) return;
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();
		last.focus();
		return;
	}
	if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();
		first.focus();
	}
}

function setLegacyUpgradeBackgroundInert(inert: boolean) {
	for (const element of document.querySelectorAll<HTMLElement>(
		"header, .tab-bar, .tab-panel, #toastRoot, #viewerReconnectOverlay, #settingsDialogMount",
	)) {
		if (element.id === "viewerReconnectOverlay" && element.hidden) continue;
		element.inert = inert;
		if (inert) element.setAttribute("aria-hidden", "true");
		else element.removeAttribute("aria-hidden");
	}
}

function setLegacyUpgradeNotice(open: boolean, summary?: LegacyUpgradeReviewSummary) {
	const overlay = $("legacyUpgradeModalBackdrop");
	const modal = $("legacyUpgradeModal");
	const summaryEl = $("legacyUpgradeSummary");
	if (!overlay || !modal || !summaryEl) return;
	if (summary) {
		summaryEl.textContent = `${summary.groupCount.toLocaleString()} older ${summary.groupCount === 1 ? "project needs" : "projects need"} a Sharing domain. They contain ${summary.memoryCount.toLocaleString()} older shared memories total; you will review the projects, not individual memories.`;
	}
	overlay.hidden = !open;
	modal.hidden = !open;
	if (open) {
		legacyUpgradeNoticePreviousFocus = document.activeElement as HTMLElement | null;
		document.addEventListener("keydown", handleLegacyUpgradeModalKeydown);
		focusLegacyUpgradeModal();
		setLegacyUpgradeBackgroundInert(true);
		return;
	}
	setLegacyUpgradeBackgroundInert(false);
	document.removeEventListener("keydown", handleLegacyUpgradeModalKeydown);
	if (legacyUpgradeNoticePreviousFocus && document.contains(legacyUpgradeNoticePreviousFocus)) {
		legacyUpgradeNoticePreviousFocus.focus();
	}
	legacyUpgradeNoticePreviousFocus = null;
}

function maybeShowLegacyUpgradeNotice(summary: LegacyUpgradeReviewSummary | null) {
	if (!summary || legacyUpgradeNoticeShown || isLegacyUpgradeNoticeDismissed()) return;
	legacyUpgradeNoticeShown = true;
	setLegacyUpgradeNotice(true, summary);
}

async function checkLegacyUpgradeNotice() {
	if (legacyUpgradeNoticeShown || isLegacyUpgradeNoticeDismissed()) return;
	try {
		const payload = await api.loadSyncStatus(false, "", { includeJoinRequests: false });
		maybeShowLegacyUpgradeNotice(readLegacyUpgradeReviewSummary(payload));
	} catch {}
}

function setReconnectOverlay(open: boolean, detail?: string) {
	const overlay = $("viewerReconnectOverlay");
	const detailEl = $("viewerReconnectDetail");
	if (!overlay || !detailEl) return;
	overlay.hidden = !open;
	detailEl.textContent = detail || "Trying again automatically while the viewer comes back.";
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

function scheduleReconnectLoop() {
	if (reconnecting) return;
	reconnecting = true;
	stopPolling();
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
	if (state.refreshTimer) {
		clearInterval(state.refreshTimer);
		state.refreshTimer = null;
	}
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

function renderAdvancedSection() {
	const isSync = state.advancedSection === "sync";
	const syncContent = $("advancedSyncContent");
	const teamsContent = $("advancedTeamsContent");
	if (syncContent) syncContent.hidden = !isSync;
	if (teamsContent) teamsContent.hidden = isSync;
	const syncButton = $("advancedSyncButton");
	const teamsButton = $("advancedTeamsButton");
	syncButton?.setAttribute("aria-pressed", String(isSync));
	teamsButton?.setAttribute("aria-pressed", String(!isSync));
	queueMicrotask(() => {
		const hash = window.location.hash.replace(/^#/, "");
		applySyncSubView(
			hash === "sync/diagnostics" || hash === "advanced/sync/diagnostics" ? "diagnostics" : "main",
		);
	});
}

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
	renderAdvancedSection();
}

function switchTab(
	tab: TabId,
	options: { canonicalHash?: boolean; advancedSection?: AdvancedSection } = {},
) {
	const nextTab = resolveAccessibleTab(tab, state.lastCoordinatorAdminStatus);
	if (nextTab === "advanced") {
		setAdvancedSection(
			options.advancedSection ?? parseAdvancedSectionFromHash() ?? state.advancedSection,
		);
	}
	setActiveTab(nextTab, options.canonicalHash ? { canonicalHash: true } : {});
	renderTabs(nextTab);

	// Refresh data for active tab
	refresh();
}

function initTabs() {
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
	$("advancedSyncButton")?.addEventListener("click", () => setAdvancedSection("sync", true));
	$("advancedTeamsButton")?.addEventListener("click", () => setAdvancedSection("teams", true));

	// Listen for hash changes (back/forward navigation). Hashes may include a
	// sub-view segment (e.g. `#sync/diagnostics`) — parse with the shared
	// helper so nested segments still resolve to their parent tab.
	window.addEventListener("hashchange", () => {
		const top = parseTabFromHash();
		if (top) {
			const advancedSection = parseAdvancedSectionFromHash();
			switchTab(top, advancedSection ? { advancedSection } : {});
		}
	});

	// Set initial tab
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

const loadRecipientPolicySharingData = createRecipientPolicySharingLoader();
const emptyRecipientPolicyIntent: api.RecipientPolicyIntentGraphV1 = {
	version: 1,
	identities: [],
	teams: [],
	teamMemberships: [],
	identityDevices: [],
	projectRecipients: [],
};
let devicesLoaded = false;
let lastDevicesData: {
	projects: DevicesProjectInput[];
	intent: api.RecipientPolicyIntentGraphV1;
	reconciliation: api.RecipientPolicyReconciliationStatusV1;
	availability: DeviceAvailabilityInput[];
} | null = null;

async function loadRecipientPolicyProjects(): Promise<DevicesProjectInput[]> {
	const projects: ProjectScopeInventoryProject[] = [];
	let offset = 0;
	while (true) {
		const page = await api.loadProjectScopeInventory({ limit: 250, offset });
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
		record(String(device.device_id ?? "").trim(), device.stale ? "offline" : "available");
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

function navigateFromDevices(target: DevicesNavigationTarget) {
	switchTab(target, { canonicalHash: true });
	queueMicrotask(() => document.getElementById(`tabBtn-${target}`)?.focus());
}

async function loadDevicesData(): Promise<boolean> {
	const mount = document.getElementById("devicesMount");
	if (!mount) return true;
	if (!devicesLoaded) {
		mountDevices(mount, emptyRecipientPolicyIntent, { version: 1, items: [] }, [], [], {
			loading: true,
		});
	}
	try {
		const [projects, intent, reconciliation] = await Promise.all([
			loadRecipientPolicyProjects(),
			api.loadRecipientPolicyIntent(),
			api.loadRecipientPolicyReconciliationStatus(),
			loadSyncData(),
		]);
		const availability = deriveDeviceAvailability();
		mountDevices(mount, intent, reconciliation, projects, availability, {
			onNavigate: navigateFromDevices,
		});
		lastDevicesData = { projects, intent, reconciliation, availability };
		devicesLoaded = true;
		return true;
	} catch {
		if (lastDevicesData) {
			mountDevices(
				mount,
				lastDevicesData.intent,
				lastDevicesData.reconciliation,
				lastDevicesData.projects,
				lastDevicesData.availability,
				{
					onNavigate: navigateFromDevices,
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
	state.currentProject = $select("projectFilter")?.value || "";
	updateFeedView(true);
	refresh();
});

/* ── Main refresh ────────────────────────────────────────── */

let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;

async function refresh() {
	if (reconnecting) return;
	// Debounce rapid calls (tab switch + hash change + visibility)
	if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
	refreshDebounceTimer = setTimeout(() => doRefresh(), 80);
}

async function doRefresh() {
	if (reconnecting) return;
	if (state.refreshInFlight) {
		state.refreshQueued = true;
		return;
	}
	state.refreshInFlight = true;

	try {
		setRefreshStatus("refreshing");

		const refreshTab = state.activeTab;

		// Always load health data (for the header health dot) and config
		const promises: Promise<unknown>[] = [loadHealthData(), loadConfigData()];
		let devicesRefreshSucceeded = true;
		if (refreshTab === "feed") {
			promises.push(
				api
					.loadCoordinatorAdminStatus()
					.then((status) => {
						state.lastCoordinatorAdminStatus =
							status && typeof status === "object"
								? (status as typeof state.lastCoordinatorAdminStatus)
								: null;
					})
					.catch(() => {
						state.lastCoordinatorAdminStatus = null;
					}),
			);
		}

		// Load tab-specific data
		if (refreshTab === "feed") {
			promises.push(loadFeedData());
		}
		if (refreshTab === "projects") {
			promises.push(loadProjectsData());
		}
		if (refreshTab === "sharing") {
			promises.push(loadRecipientPolicySharingData());
		}
		if (refreshTab === "devices") {
			promises.push(
				loadDevicesData().then((succeeded) => {
					devicesRefreshSucceeded = succeeded;
				}),
			);
		}
		// Sync data is needed by Advanced Sync and Health (health cards derive sync state).
		if (
			(refreshTab === "advanced" && state.advancedSection === "sync") ||
			refreshTab === "health"
		) {
			promises.push(loadSyncData());
		}
		if (refreshTab === "advanced" && state.advancedSection === "teams") {
			promises.push(loadCoordinatorAdminData());
		}

		// Load pairing if open
		if (state.syncPairingOpen) {
			promises.push(loadPairingData());
		}

		await Promise.all(promises);
		maybeShowLegacyUpgradeNotice(readLegacyUpgradeReviewSummary(state.lastSyncLegacySharedReview));
		const nextTab = resolveAccessibleTab(state.activeTab, state.lastCoordinatorAdminStatus);
		if (nextTab !== state.activeTab) {
			setActiveTab(nextTab);
		}
		renderTabs(state.activeTab);
		setRefreshStatus(devicesRefreshSucceeded ? "idle" : "error");
	} catch {
		const ready = await isViewerReady();
		if (!ready) {
			scheduleReconnectLoop();
		} else {
			setRefreshStatus("error");
		}
	} finally {
		state.refreshInFlight = false;
		if (state.refreshQueued && !reconnecting) {
			state.refreshQueued = false;
			doRefresh();
		}
	}
}

/* ── Boot ────────────────────────────────────────────────── */

initState();

// Toast host — mount first so early notices (from tab init etc.) land.
const toastRoot = document.getElementById("toastRoot");
if (toastRoot) mountToastHost(toastRoot);

// Theme
initThemeToggle($button("themeToggle"));
setTheme(getTheme());

// Tabs
initTabs();

// Tab modules
initFeedTab();
initHealthTab();
initProjectsTab(() => refresh());
initSyncTab(() => refresh());
initCoordinatorAdminTab();
initSettings(stopPolling, startPolling, () => refresh());

// Projects
loadProjects();

$("viewerReconnectRetry")?.addEventListener("click", async () => {
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

$("legacyUpgradeReviewGroups")?.addEventListener("click", () => {
	dismissLegacyUpgradeNoticeIfRequested();
	setLegacyUpgradeNotice(false);
	window.location.hash = "sync";
	setTimeout(
		() => document.getElementById("syncSharingReview")?.scrollIntoView({ block: "start" }),
		120,
	);
});

$("legacyUpgradeReviewProjects")?.addEventListener("click", () => {
	dismissLegacyUpgradeNoticeIfRequested();
	setLegacyUpgradeNotice(false);
	window.location.hash = "projects";
});

$("legacyUpgradeNotNow")?.addEventListener("click", () => {
	dismissLegacyUpgradeNoticeIfRequested();
	setLegacyUpgradeNotice(false);
});

// Version label
loadRuntimeLabel();

// Upgrade notice
checkLegacyUpgradeNotice();

// Start
refresh();
startPolling();
