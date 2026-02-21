/* Global application state — shared across tabs. */

export type RefreshState = 'idle' | 'refreshing' | 'paused' | 'error';
export type TabId = 'feed' | 'health' | 'sync';

const TAB_KEY = 'codemem-tab';
const FEED_FILTER_KEY = 'codemem-feed-filter';
const DETAILS_OPEN_KEY = 'codemem-details-open';
const SYNC_DIAGNOSTICS_KEY = 'codemem-sync-diagnostics';
const SYNC_PAIRING_KEY = 'codemem-sync-pairing';
const SYNC_REDACT_KEY = 'codemem-sync-redact';

export const FEED_FILTERS = ['all', 'observations', 'summaries'] as const;
export type FeedFilter = (typeof FEED_FILTERS)[number];

/* ── Mutable application state ─────────────────────────────── */

export const state = {
  /* Tab */
  activeTab: 'feed' as TabId,

  /* Project filter */
  currentProject: '',

  /* Refresh */
  refreshState: 'idle' as RefreshState,
  refreshInFlight: false,
  refreshQueued: false,
  refreshTimer: null as ReturnType<typeof setInterval> | null,

  /* Feed */
  feedTypeFilter: 'all' as FeedFilter,
  feedQuery: '',
  lastFeedItems: [] as any[],
  lastFeedFilteredCount: 0,
  lastFeedSignature: '',
  pendingFeedItems: null as any[] | null,

  /* Feed item view state */
  itemViewState: new Map<string, string>(),
  itemExpandState: new Map<string, boolean>(),
  newItemKeys: new Set<string>(),

  /* Cached payloads */
  lastStatsPayload: null as any,
  lastUsagePayload: null as any,
  lastRawEventsPayload: null as any,
  lastSyncStatus: null as any,
  lastSyncPeers: [] as any[],
  lastSyncAttempts: [] as any[],
  pairingPayloadRaw: null as any,
  pairingCommandRaw: '',

  /* Config */
  configDefaults: {} as Record<string, any>,
  configPath: '',
  settingsDirty: false,

  /* Sync UI toggles */
  syncDiagnosticsOpen: false,
  syncPairingOpen: false,
};

/* ── Persistence helpers ───────────────────────────────────── */

export function getActiveTab(): TabId {
  const hash = window.location.hash.replace('#', '') as TabId;
  if (['feed', 'health', 'sync'].includes(hash)) return hash;
  const saved = localStorage.getItem(TAB_KEY);
  if (saved && ['feed', 'health', 'sync'].includes(saved)) return saved as TabId;
  return 'feed';
}

export function setActiveTab(tab: TabId) {
  state.activeTab = tab;
  window.location.hash = tab;
  localStorage.setItem(TAB_KEY, tab);
}

export function getFeedTypeFilter(): FeedFilter {
  const saved = localStorage.getItem(FEED_FILTER_KEY) || 'all';
  return FEED_FILTERS.includes(saved as FeedFilter) ? (saved as FeedFilter) : 'all';
}

export function setFeedTypeFilter(value: string) {
  state.feedTypeFilter = FEED_FILTERS.includes(value as FeedFilter) ? (value as FeedFilter) : 'all';
  localStorage.setItem(FEED_FILTER_KEY, state.feedTypeFilter);
}

export function isSyncDiagnosticsOpen(): boolean {
  return localStorage.getItem(SYNC_DIAGNOSTICS_KEY) === '1';
}

export function setSyncDiagnosticsOpen(open: boolean) {
  state.syncDiagnosticsOpen = open;
  localStorage.setItem(SYNC_DIAGNOSTICS_KEY, open ? '1' : '0');
}

export function isSyncPairingOpen(): boolean {
  return state.syncPairingOpen;
}

export function setSyncPairingOpen(open: boolean) {
  state.syncPairingOpen = open;
  try { localStorage.setItem(SYNC_PAIRING_KEY, open ? '1' : '0'); } catch {}
}

export function isSyncRedactionEnabled(): boolean {
  return localStorage.getItem(SYNC_REDACT_KEY) !== '0';
}

export function setSyncRedactionEnabled(enabled: boolean) {
  localStorage.setItem(SYNC_REDACT_KEY, enabled ? '1' : '0');
}

export function isDetailsOpen(): boolean {
  return localStorage.getItem(DETAILS_OPEN_KEY) === '1';
}

export function setDetailsOpen(open: boolean) {
  localStorage.setItem(DETAILS_OPEN_KEY, open ? '1' : '0');
}

/* ── Init from storage ─────────────────────────────────────── */

export function initState() {
  state.activeTab = getActiveTab();
  state.feedTypeFilter = getFeedTypeFilter();
  state.syncDiagnosticsOpen = isSyncDiagnosticsOpen();
  try {
    state.syncPairingOpen = localStorage.getItem(SYNC_PAIRING_KEY) === '1';
  } catch {
    state.syncPairingOpen = false;
  }
}
