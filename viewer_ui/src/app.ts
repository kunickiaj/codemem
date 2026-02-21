/* Viewer UI entry point.
 *
 * Built to: codemem/viewer_static/app.js (served at /assets/app.js)
 *
 * Orchestrates tab routing, polling, and delegates rendering to tab modules.
 */

/* global marked, lucide */

import { $, $select } from './lib/dom';
import { getTheme, setTheme, initThemeSelect } from './lib/theme';
import { state, initState, setActiveTab, type TabId } from './lib/state';
import * as api from './lib/api';

import { initFeedTab, loadFeedData, updateFeedView } from './tabs/feed';
import { initHealthTab, loadHealthData, renderHealthOverview } from './tabs/health';
import { initSyncTab, loadSyncData, loadPairingData, renderSyncStatus, renderSyncPeers, renderSyncAttempts, renderPairing } from './tabs/sync';
import { initSettings, loadConfigData, isSettingsOpen } from './tabs/settings';

/* ── Refresh status ──────────────────────────────────────── */

type RefreshState = 'idle' | 'refreshing' | 'paused' | 'error';
let lastAnnouncedRefreshState: RefreshState | null = null;

function setRefreshStatus(rs: RefreshState, detail?: string) {
  state.refreshState = rs;
  const el = $('refreshStatus');
  if (!el) return;

  const announce = (msg: string) => {
    const announcer = $('refreshAnnouncer');
    if (!announcer || lastAnnouncedRefreshState === rs) return;
    announcer.textContent = msg;
    lastAnnouncedRefreshState = rs;
  };

  if (rs === 'refreshing') { el.textContent = "refreshing…"; return; }
  if (rs === 'paused') { el.textContent = "paused"; announce('Auto refresh paused.'); return; }
  if (rs === 'error') { el.textContent = "refresh failed"; announce('Refresh failed.'); return; }
  const suffix = detail ? ` ${detail}` : '';
  el.textContent = "updated " + new Date().toLocaleTimeString() + suffix;
  lastAnnouncedRefreshState = null;
}

/* ── Polling ─────────────────────────────────────────────── */

function stopPolling() {
  if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
}

function startPolling() {
  if (state.refreshTimer) return;
  state.refreshTimer = setInterval(() => refresh(), 5000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopPolling();
    setRefreshStatus('paused', '(tab hidden)');
  } else if (!isSettingsOpen()) {
    startPolling();
    refresh();
  }
});

/* ── Tab routing ─────────────────────────────────────────── */

const TAB_IDS: TabId[] = ['feed', 'health', 'sync'];

function switchTab(tab: TabId) {
  setActiveTab(tab);

  // Toggle tab panels
  TAB_IDS.forEach((id) => {
    const panel = $(`tab-${id}`);
    if (panel) (panel as any).hidden = id !== tab;
  });

  // Toggle tab buttons
  TAB_IDS.forEach((id) => {
    const btn = $(`tabBtn-${id}`);
    if (btn) btn.classList.toggle('active', id === tab);
  });

  // Refresh data for active tab
  refresh();
}

function initTabs() {
  TAB_IDS.forEach((id) => {
    const btn = $(`tabBtn-${id}`);
    btn?.addEventListener('click', () => switchTab(id));
  });

  // Listen for hash changes (back/forward navigation)
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace('#', '') as TabId;
    if (TAB_IDS.includes(hash) && hash !== state.activeTab) {
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
    const projectFilter = $select('projectFilter');
    if (!projectFilter) return;
    projectFilter.textContent = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All Projects';
    projectFilter.appendChild(allOpt);
    projects.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      projectFilter.appendChild(opt);
    });
  } catch {}
}

$select('projectFilter')?.addEventListener('change', () => {
  state.currentProject = $select('projectFilter')?.value || '';
  refresh();
});

/* ── Main refresh ────────────────────────────────────────── */

async function refresh() {
  if (state.refreshInFlight) { state.refreshQueued = true; return; }
  state.refreshInFlight = true;

  try {
    setRefreshStatus('refreshing');

    // Always load health data (for the header health dot) and config
    const promises: Promise<any>[] = [
      loadHealthData(),
      loadConfigData(),
      loadSyncData(),
    ];

    // Load tab-specific data
    if (state.activeTab === 'feed') {
      promises.push(loadFeedData());
    }

    // Load pairing if open
    if (state.syncPairingOpen) {
      promises.push(loadPairingData());
    }

    await Promise.all(promises);
    setRefreshStatus('idle');
  } catch {
    setRefreshStatus('error');
  } finally {
    state.refreshInFlight = false;
    if (state.refreshQueued) {
      state.refreshQueued = false;
      refresh();
    }
  }
}

/* ── Boot ────────────────────────────────────────────────── */

initState();

// Theme
initThemeSelect($select('themeSelect'));
setTheme(getTheme());

// Tabs
initTabs();

// Tab modules
initFeedTab();
initHealthTab();
initSyncTab(() => refresh());
initSettings(stopPolling, startPolling, () => refresh());

// Projects
loadProjects();

// Start
refresh();
startPolling();
