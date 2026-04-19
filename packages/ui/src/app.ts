/* Viewer UI entry point.
 *
 * Built to: codemem/viewer_static/app.js (served at /assets/app.js)
 *
 * Orchestrates tab routing, polling, and delegates rendering to tab modules.
 */

/* global marked, lucide */

declare const __CODEMEM_GIT_COMMIT__: string;

import { mountToastHost } from "./components/primitives/toast";
import * as api from "./lib/api";
import { $, $button, $select } from "./lib/dom";
import {
	ALL_TAB_IDS,
	getVisibleTabs,
	initState,
	resolveAccessibleTab,
	setActiveTab,
	state,
	type TabId,
} from "./lib/state";
import { getTheme, initThemeToggle, setTheme } from "./lib/theme";

import { initCoordinatorAdminTab, loadCoordinatorAdminData } from "./tabs/coordinator-admin";
import { initFeedTab, loadFeedData, updateFeedView } from "./tabs/feed";
import { initHealthTab, loadHealthData } from "./tabs/health";
import { initSettings, isSettingsOpen, loadConfigData } from "./tabs/settings";
import { initSyncTab, loadPairingData, loadSyncData } from "./tabs/sync";

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

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnecting = false;

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

function stopReconnectLoop() {
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	reconnecting = false;
	setReconnectOverlay(false);
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
			stopReconnectLoop();
			if (canResumeRefresh()) {
				setRefreshStatus("refreshing");
				startPolling();
				void doRefresh();
			} else {
				setRefreshStatus(
					"paused",
					document.visibilityState === "hidden" ? "(tab hidden)" : "(settings open)",
				);
			}
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
		btn.classList.toggle("active", id === activeTab && visibleTabs.has(id));
	});
}

function switchTab(tab: TabId) {
	const nextTab = resolveAccessibleTab(tab, state.lastCoordinatorAdminStatus);
	setActiveTab(nextTab);
	renderTabs(nextTab);

	// Refresh data for active tab
	refresh();
}

function initTabs() {
	ALL_TAB_IDS.forEach((id) => {
		const btn = $(`tabBtn-${id}`);
		btn?.addEventListener("click", () => switchTab(id));
	});

	// Listen for hash changes (back/forward navigation)
	window.addEventListener("hashchange", () => {
		const hash = window.location.hash.replace("#", "") as TabId;
		if (ALL_TAB_IDS.includes(hash) && hash !== state.activeTab) {
			switchTab(hash);
		}
	});

	// Set initial tab
	switchTab(state.activeTab);
}

/* ── Project filter ──────────────────────────────────────── */

async function loadProjects() {
	try {
		const projects = await api.loadProjects();
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

		let refreshTab = state.activeTab;
		if (refreshTab === "coordinator-admin") {
			try {
				const status = await api.loadCoordinatorAdminStatus();
				state.lastCoordinatorAdminStatus =
					status && typeof status === "object"
						? (status as typeof state.lastCoordinatorAdminStatus)
						: null;
			} catch {
				state.lastCoordinatorAdminStatus = null;
			}
			refreshTab = state.activeTab;
			refreshTab = resolveAccessibleTab(refreshTab, state.lastCoordinatorAdminStatus);
			if (refreshTab !== state.activeTab) {
				setActiveTab(refreshTab);
				renderTabs(refreshTab);
			}
		}

		// Always load health data (for the header health dot) and config
		const promises: Promise<unknown>[] = [loadHealthData(), loadConfigData()];
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
		// Sync data is needed by both Sync tab and Health tab (health cards derive sync state)
		if (refreshTab === "sync" || refreshTab === "health") {
			promises.push(loadSyncData());
		}
		if (refreshTab === "coordinator-admin") {
			promises.push(loadCoordinatorAdminData());
		}

		// Load pairing if open
		if (state.syncPairingOpen) {
			promises.push(loadPairingData());
		}

		await Promise.all(promises);
		const nextTab = resolveAccessibleTab(state.activeTab, state.lastCoordinatorAdminStatus);
		if (nextTab !== state.activeTab) {
			setActiveTab(nextTab);
		}
		renderTabs(state.activeTab);
		setRefreshStatus("idle");
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
	stopReconnectLoop();
	startPolling();
	void doRefresh();
});

// Version label
loadRuntimeLabel();

// Start
refresh();
startPolling();
