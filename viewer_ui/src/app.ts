/* Viewer UI source (TypeScript).
 *
 * Built to: opencode_mem/viewer_static/app.js (served at /assets/app.js)
 */

/* global marked, lucide */

const refreshStatus = document.getElementById('refreshStatus');
const statsGrid = document.getElementById('statsGrid');
const metaLine = document.getElementById('metaLine');
const feedList = document.getElementById('feedList');
const feedMeta = document.getElementById('feedMeta');
const feedTypeToggle = document.getElementById('feedTypeToggle');
const sessionGrid = document.getElementById('sessionGrid');
const sessionMeta = document.getElementById('sessionMeta');
const settingsButton = document.getElementById('settingsButton');
const settingsBackdrop = document.getElementById('settingsBackdrop');
const settingsModal = document.getElementById('settingsModal');
const settingsClose = document.getElementById('settingsClose');
const settingsSave = document.getElementById('settingsSave');
const settingsStatus = document.getElementById('settingsStatus');
const settingsPath = document.getElementById('settingsPath');
const settingsEffective = document.getElementById('settingsEffective');
const settingsOverrides = document.getElementById('settingsOverrides');
const observerProviderInput = document.getElementById(
  'observerProvider',
) as HTMLSelectElement | null;
const observerModelInput = document.getElementById(
  'observerModel',
) as HTMLInputElement | null;
const observerMaxCharsInput = document.getElementById(
  'observerMaxChars',
) as HTMLInputElement | null;
const observerMaxCharsHint = document.getElementById('observerMaxCharsHint');
const packObservationLimitInput = document.getElementById(
  'packObservationLimit',
) as HTMLInputElement | null;
const packSessionLimitInput = document.getElementById(
  'packSessionLimit',
) as HTMLInputElement | null;
const syncEnabledInput = document.getElementById(
  'syncEnabled',
) as HTMLInputElement | null;
const syncHostInput = document.getElementById(
  'syncHost',
) as HTMLInputElement | null;
const syncPortInput = document.getElementById(
  'syncPort',
) as HTMLInputElement | null;
const syncIntervalInput = document.getElementById(
  'syncInterval',
) as HTMLInputElement | null;
const syncMdnsInput = document.getElementById(
  'syncMdns',
) as HTMLInputElement | null;
const projectFilter = document.getElementById(
  'projectFilter',
) as HTMLSelectElement | null;
const themeToggle = document.getElementById(
  'themeToggle',
) as HTMLButtonElement | null;
const syncMeta = document.getElementById('syncMeta');
const syncHealthGrid = document.getElementById('syncHealthGrid');
const syncStatusGrid = document.getElementById('syncStatusGrid');
const syncDiagnostics = document.getElementById('syncDiagnostics');
const syncPeers = document.getElementById('syncPeers');
const syncAttempts = document.getElementById('syncAttempts');
const syncNowButton = document.getElementById(
  'syncNowButton',
) as HTMLButtonElement | null;
const syncDetailsToggle = document.getElementById(
  'syncDetailsToggle',
) as HTMLButtonElement | null;
const syncPairingToggle = document.getElementById(
  'syncPairingToggle',
) as HTMLButtonElement | null;
const syncRedact = document.getElementById(
  'syncRedact',
) as HTMLInputElement | null;
const pairingPayload = document.getElementById('pairingPayload');
const pairingCopy = document.getElementById(
  'pairingCopy',
) as HTMLButtonElement | null;
const pairingHint = document.getElementById('pairingHint');
const syncPairing = document.getElementById('syncPairing');

let configDefaults: Record<string, any> = {};
let configPath = '';
let currentProject = '';
const itemViewState = new Map();
const FEED_FILTER_KEY = 'opencode-mem-feed-filter';
const FEED_FILTERS = ['all', 'observations', 'summaries'];

const SYNC_DIAGNOSTICS_KEY = 'opencode-mem-sync-diagnostics';
const SYNC_PAIRING_KEY = 'opencode-mem-sync-pairing';
const SYNC_REDACT_KEY = 'opencode-mem-sync-redact';
let feedTypeFilter = 'all';
let pairingPayloadRaw: any = null;
let pairingCommandRaw = '';
let lastSyncStatus: any = null;
let lastSyncPeers: any[] = [];
let lastSyncAttempts: any[] = [];
let syncPairingOpen = false;

let refreshInFlight = false;
let refreshQueued = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let lastFeedSignature = '';

function isSettingsOpen() {
  return Boolean(settingsModal && !settingsModal.hasAttribute('hidden'));
}

function stopPolling() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startPolling() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    refresh();
  }, 5000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopPolling();
    return;
  }
  if (!isSettingsOpen()) {
    startPolling();
    refresh();
  }
});

// Theme management
function getTheme() {
  const saved = localStorage.getItem('opencode-mem-theme');
  if (saved) return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function setTheme(theme: string) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('opencode-mem-theme', theme);
  if (themeToggle) {
    themeToggle.innerHTML =
      theme === 'dark'
        ? '<i data-lucide="sun"></i>'
        : '<i data-lucide="moon"></i>';
    themeToggle.title =
      theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
  if (typeof (globalThis as any).lucide !== 'undefined')
    (globalThis as any).lucide.createIcons();
}

function toggleTheme() {
  const current = getTheme();
  setTheme(current === 'dark' ? 'light' : 'dark');
}

// Initialize theme
setTheme(getTheme());
themeToggle?.addEventListener('click', toggleTheme);

setSyncDiagnosticsOpen(isSyncDiagnosticsOpen());
try {
  syncPairingOpen = localStorage.getItem(SYNC_PAIRING_KEY) === '1';
} catch {
  syncPairingOpen = false;
}
setSyncPairingOpen(syncPairingOpen);
setSyncRedactionEnabled(isSyncRedactionEnabled());

syncDetailsToggle?.addEventListener('click', () => {
  const next = !isSyncDiagnosticsOpen();
  setSyncDiagnosticsOpen(next);
  refresh();
});

syncPairingToggle?.addEventListener('click', () => {
  const next = !isSyncPairingOpen();
  setSyncPairingOpen(next);
  if (next) {
    if (pairingPayload) pairingPayload.textContent = 'Loading…';
    if (pairingHint) pairingHint.textContent = 'Fetching pairing command…';
  }
  refresh();
});

syncRedact?.addEventListener('change', () => {
  setSyncRedactionEnabled(Boolean(syncRedact.checked));
  renderSyncStatus(lastSyncStatus);
  renderSyncPeers(lastSyncPeers);
  renderSyncAttempts(lastSyncAttempts);
  renderPairing(pairingPayloadRaw);
});

feedTypeFilter = getFeedTypeFilter();
updateFeedTypeToggle();
feedTypeToggle?.addEventListener('click', (event) => {
  const target = (event as any).target?.closest?.('button');
  if (!target) return;
  const value = target.dataset.filter || 'all';
  setFeedTypeFilter(value);
});

function formatDate(value: any) {
  if (!value) return 'n/a';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function normalize(text: any) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseJsonArray(value: any) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function getFeedTypeFilter() {
  const saved = localStorage.getItem(FEED_FILTER_KEY) || 'all';
  return FEED_FILTERS.includes(saved) ? saved : 'all';
}

function isSyncDiagnosticsOpen() {
  return localStorage.getItem(SYNC_DIAGNOSTICS_KEY) === '1';
}

function setSyncDiagnosticsOpen(open: boolean) {
  if (syncDiagnostics) {
    (syncDiagnostics as any).hidden = !open;
  }
  if (syncDetailsToggle) {
    syncDetailsToggle.textContent = open ? 'Hide diagnostics' : 'Diagnostics';
  }
  localStorage.setItem(SYNC_DIAGNOSTICS_KEY, open ? '1' : '0');
}

function isSyncPairingOpen() {
  return syncPairingOpen;
}

function setSyncPairingOpen(open: boolean) {
  syncPairingOpen = open;
  if (syncPairing) {
    (syncPairing as any).hidden = !open;
  }
  if (syncPairingToggle) {
    syncPairingToggle.textContent = open ? 'Close' : 'Pair';
  }
  try {
    localStorage.setItem(SYNC_PAIRING_KEY, open ? '1' : '0');
  } catch {
    // Ignore persistence errors.
  }
}

function isSyncRedactionEnabled() {
  const raw = localStorage.getItem(SYNC_REDACT_KEY);
  return raw !== '0';
}

function setSyncRedactionEnabled(enabled: boolean) {
  localStorage.setItem(SYNC_REDACT_KEY, enabled ? '1' : '0');
  if (syncRedact) {
    syncRedact.checked = enabled;
  }
}

function setFeedTypeFilter(value: string) {
  feedTypeFilter = FEED_FILTERS.includes(value) ? value : 'all';
  localStorage.setItem(FEED_FILTER_KEY, feedTypeFilter);
  updateFeedTypeToggle();
  refresh();
}

function updateFeedTypeToggle() {
  if (!feedTypeToggle) return;
  const buttons = Array.from(feedTypeToggle.querySelectorAll('.toggle-button'));
  buttons.forEach((button) => {
    const value = (button as any).dataset?.filter || 'all';
    button.classList.toggle('active', value === feedTypeFilter);
  });
}

function filterFeedItems(items: any[]) {
  if (feedTypeFilter === 'observations') {
    return items.filter(
      (item) => String(item.kind || '').toLowerCase() !== 'session_summary',
    );
  }
  if (feedTypeFilter === 'summaries') {
    return items.filter(
      (item) => String(item.kind || '').toLowerCase() === 'session_summary',
    );
  }
  return items;
}

function formatFeedFilterLabel() {
  if (feedTypeFilter === 'observations') return ' · observations';
  if (feedTypeFilter === 'summaries') return ' · session summaries';
  return '';
}

function extractFactsFromBody(text: any) {
  if (!text) return [];
  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const bulletLines = lines.filter(
    (line) => /^[-*\u2022]\s+/.test(line) || /^\d+\./.test(line),
  );
  if (!bulletLines.length) return [];
  return bulletLines.map((line) =>
    line.replace(/^[-*\u2022]\s+/, '').replace(/^\d+\.\s+/, ''),
  );
}

function isLowSignalObservation(item: any) {
  const title = normalize(item.title);
  const body = normalize(item.body_text);
  if (!title && !body) return true;

  const combined = body || title;
  if (combined.length < 10) return true;
  if (title && body && title === body && combined.length < 40) return true;

  const leadGlyph = title.charAt(0);
  const isPrompty = leadGlyph === '\u2514' || leadGlyph === '\u203a';
  if (isPrompty && combined.length < 40) return true;

  if (title.startsWith('list ') && combined.length < 20) return true;
  if (combined === 'ls' || combined === 'list ls') return true;

  return false;
}

function createElement(tag: string, className?: string | null, text?: any) {
  const el = document.createElement(tag);
  if (className) {
    (el as any).className = className;
  }
  if (text !== undefined && text !== null) {
    el.textContent = String(text);
  }
  return el;
}

function formatTagLabel(tag: any) {
  if (!tag) return '';
  const trimmed = String(tag).trim();
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex === -1) return trimmed;
  return trimmed.slice(0, colonIndex).trim();
}

function createTagChip(tag: any) {
  const display = formatTagLabel(tag);
  if (!display) return null;
  const chip = createElement('span', 'tag-chip', display);
  (chip as any).title = String(tag);
  return chip;
}

function mergeMetadata(metadata: any) {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }
  const importMetadata = (metadata as any).import_metadata;
  if (importMetadata && typeof importMetadata === 'object') {
    return { ...(importMetadata as any), ...(metadata as any) };
  }
  return metadata;
}

function formatFileList(files: any[], limit = 2) {
  if (!files.length) return '';
  const trimmed = files.map((file) => String(file).trim()).filter(Boolean);
  const slice = trimmed.slice(0, limit);
  const suffix = trimmed.length > limit ? ` +${trimmed.length - limit}` : '';
  return `${slice.join(', ')}${suffix}`.trim();
}

function renderStats(
  stats: any,
  usagePayload: any,
  project: string,
  rawEvents: any,
) {
  const db = stats.database || {};
  const totalsGlobal =
    usagePayload?.totals_global ||
    usagePayload?.totals ||
    stats.usage?.totals ||
    {};
  const totalsFiltered = usagePayload?.totals_filtered || null;
  const isFiltered = !!(project && totalsFiltered);
  const usage = isFiltered ? totalsFiltered : totalsGlobal;

  const raw = rawEvents && typeof rawEvents === 'object' ? rawEvents : {};
  const rawSessions = Number(raw.sessions || 0);
  const rawPending = Number(raw.pending || 0);

  const globalLineWork = isFiltered
    ? `\nGlobal: ${Number(totalsGlobal.work_investment_tokens || 0).toLocaleString()} invested`
    : '';
  const globalLineRead = isFiltered
    ? `\nGlobal: ${Number(totalsGlobal.tokens_read || 0).toLocaleString()} read`
    : '';
  const globalLineSaved = isFiltered
    ? `\nGlobal: ${Number(totalsGlobal.tokens_saved || 0).toLocaleString()} saved`
    : '';

  const items = [
    { label: 'Sessions', value: db.sessions || 0, icon: 'database' },
    { label: 'Memories', value: db.memory_items || 0, icon: 'brain' },
    {
      label: 'Active memories',
      value: db.active_memory_items || 0,
      icon: 'check-circle',
    },
    { label: 'Artifacts', value: db.artifacts || 0, icon: 'package' },
    {
      label: 'Raw sessions',
      value: rawSessions,
      tooltip:
        'OpenCode sessions with pending raw events waiting to be flushed',
      icon: 'inbox',
    },
    {
      label: 'Raw events pending',
      value: rawPending,
      tooltip: 'Total pending raw events waiting to be flushed',
      icon: 'activity',
    },
    {
      label: isFiltered ? 'Work investment (project)' : 'Work investment',
      value: Number(usage.work_investment_tokens || 0),
      tooltip:
        'Token cost of unique discovery groups (avoids double-counting when one response yields multiple memories)' +
        globalLineWork,
      icon: 'pencil',
    },
    {
      label: isFiltered ? 'Read cost (project)' : 'Read cost',
      value: Number(usage.tokens_read || 0),
      tooltip:
        'Tokens to read memories when injected into context' + globalLineRead,
      icon: 'book-open',
    },
    {
      label: isFiltered ? 'Savings (project)' : 'Savings',
      value: Number(usage.tokens_saved || 0),
      tooltip:
        'Tokens saved by reusing compressed memories instead of raw context' +
        globalLineSaved,
      icon: 'trending-up',
    },
  ];

  if (statsGrid) {
    statsGrid.textContent = '';
    items.forEach((item) => {
      const stat = createElement('div', 'stat');
      if ((item as any).tooltip) {
        (stat as any).title = (item as any).tooltip;
        (stat as any).style.cursor = 'help';
      }
      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', (item as any).icon);
      (icon as any).className = 'stat-icon';
      const content = createElement('div', 'stat-content');
      const value = createElement(
        'div',
        'value',
        Number((item as any).value || 0).toLocaleString(),
      );
      const label = createElement('div', 'label', (item as any).label);
      content.append(value, label);
      stat.append(icon, content);
      statsGrid.appendChild(stat);
    });
  }
  if (typeof (globalThis as any).lucide !== 'undefined')
    (globalThis as any).lucide.createIcons();
  const projectSuffix = project ? ` · project: ${project}` : '';
  if (metaLine) {
    metaLine.textContent = `DB: ${db.path || 'unknown'} · ${Math.round(
      (db.size_bytes || 0) / 1024,
    )} KB${projectSuffix}`;
  }
}

function formatTimestamp(value: any) {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function redactAddress(address: any) {
  const raw = String(address || '');
  if (!raw) return '';
  let scheme = '';
  let remainder = raw;
  const schemeMatch = raw.match(/^(\w+):\/\/([^/]+)(.*)$/);
  if (schemeMatch) {
    scheme = schemeMatch[1];
    remainder = schemeMatch[2] + schemeMatch[3];
  }
  const redacted = remainder.replace(/\d+/g, '#');
  return scheme ? `${scheme}://${redacted}` : redacted;
}

function renderSyncStatus(status: any) {
  if (!syncStatusGrid) return;
  syncStatusGrid.textContent = '';
  if (!status) return;

  const peers = status.peers || {};
  const pingPayload = status.ping || {};
  const syncPayload = status.sync || {};
  const lastSync = status.last_sync_at || status.last_sync_at_utc || null;
  const lastPing = pingPayload.last_ping_at || status.last_ping_at || null;
  const syncError = status.last_sync_error || '';
  const pingError = status.last_ping_error || '';
  const pending = Number(status.pending || 0);

  const items = [
    { label: 'Pending events', value: pending },
    { label: 'Last sync', value: formatTimestamp(lastSync) },
    { label: 'Last ping', value: formatTimestamp(lastPing) },
    { label: 'Peers', value: Object.keys(peers).length },
  ];
  items.forEach((item) => {
    const block = createElement('div', 'stat');
    const value = createElement('div', 'value', item.value);
    const label = createElement('div', 'label', item.label);
    const content = createElement('div', 'stat-content');
    content.append(value, label);
    block.append(content);
    syncStatusGrid.appendChild(block);
  });

  if (syncError || pingError) {
    const block = createElement('div', 'stat');
    const value = createElement('div', 'value', 'Errors');
    const label = createElement(
      'div',
      'label',
      [syncError, pingError].filter(Boolean).join(' · '),
    );
    const content = createElement('div', 'stat-content');
    content.append(value, label);
    block.append(content);
    syncStatusGrid.appendChild(block);
  }

  if (syncPayload && syncPayload.seconds_since_last) {
    const block = createElement('div', 'stat');
    const value = createElement(
      'div',
      'value',
      `${syncPayload.seconds_since_last}s`,
    );
    const label = createElement('div', 'label', 'Since last sync');
    const content = createElement('div', 'stat-content');
    content.append(value, label);
    block.append(content);
    syncStatusGrid.appendChild(block);
  }

  if (pingPayload && pingPayload.seconds_since_last) {
    const block = createElement('div', 'stat');
    const value = createElement(
      'div',
      'value',
      `${pingPayload.seconds_since_last}s`,
    );
    const label = createElement('div', 'label', 'Since last ping');
    const content = createElement('div', 'stat-content');
    content.append(value, label);
    block.append(content);
    syncStatusGrid.appendChild(block);
  }
}

function renderSyncPeers(peers: any[]) {
  if (!syncPeers) return;
  syncPeers.textContent = '';
  if (!Array.isArray(peers) || !peers.length) return;

  peers.forEach((peer) => {
    const card = createElement('div', 'peer-card');
    const title = createElement('div', 'peer-title');
    const peerId = peer.peer_device_id ? String(peer.peer_device_id) : '';
    const displayName = peer.name || (peerId ? peerId.slice(0, 8) : 'unknown');
    const name = createElement('strong', null, displayName);
    if (peerId) (name as any).title = peerId;
    const actions = createElement('div', 'peer-actions');

    const status = peer.status || {};
    const syncStatus = status.sync_status || '';
    const pingStatus = status.ping_status || '';
    const online = syncStatus === 'ok' || pingStatus === 'ok';
    const statusBadge = createElement(
      'span',
      'badge',
      online ? 'Online' : 'Offline',
    );
    (statusBadge as any).style.background = online
      ? 'rgba(31, 111, 92, 0.12)'
      : 'rgba(230, 126, 77, 0.15)';
    (statusBadge as any).style.color = online
      ? 'var(--accent)'
      : 'var(--accent-2)';
    name.append(' ', statusBadge);

    const peerAddresses = Array.isArray(peer.addresses)
      ? Array.from(new Set(peer.addresses.filter(Boolean)))
      : [];
    const addressLine = peerAddresses.length
      ? peerAddresses
          .map((address) =>
            isSyncRedactionEnabled() ? redactAddress(address) : address,
          )
          .join(' · ')
      : 'No addresses';
    const addressLabel = createElement('div', 'peer-addresses', addressLine);

    const lastSyncAt = status.last_sync_at || status.last_sync_at_utc || '';
    const lastPingAt = status.last_ping_at || status.last_ping_at_utc || '';
    const metaLine = [
      lastSyncAt ? `Sync: ${formatTimestamp(lastSyncAt)}` : 'Sync: never',
      lastPingAt ? `Ping: ${formatTimestamp(lastPingAt)}` : 'Ping: never',
    ].join(' · ');
    const meta = createElement('div', 'peer-meta', metaLine);

    if (peerAddresses.length) {
      peerAddresses.forEach((address: string) => {
        const button = createElement(
          'button',
          null,
          'Sync now',
        ) as HTMLButtonElement;
        button.addEventListener('click', () => syncNow(address));
        actions.appendChild(button);
      });
    }

    title.append(name, actions);
    card.append(title, addressLabel, meta);
    syncPeers.appendChild(card);
  });
}

function renderSyncAttempts(attempts: any[]) {
  if (!syncAttempts) return;
  syncAttempts.textContent = '';
  if (!Array.isArray(attempts) || !attempts.length) return;

  attempts.forEach((attempt) => {
    const line = createElement('div', 'diag-line');
    const left = createElement('div', 'left');
    const right = createElement('div', 'right');

    const attemptStatus = attempt.status || 'unknown';
    const status = createElement('div', null, attemptStatus);
    const address = attempt.address ? String(attempt.address) : '';
    const redacted = isSyncRedactionEnabled()
      ? redactAddress(address)
      : address;
    const addressLabel = createElement('div', 'small', redacted || 'n/a');
    left.append(status, addressLabel);

    const time = attempt.started_at || attempt.started_at_utc || '';
    right.textContent = time ? formatTimestamp(time) : '';

    line.append(left, right);
    syncAttempts.appendChild(line);
  });
}

function renderSyncHealth(syncHealth: any) {
  if (!syncHealthGrid) return;
  syncHealthGrid.textContent = '';
  const health = syncHealth || {};
  const title = createElement('div', 'stat');
  const value = createElement('div', 'value', health.status || 'unknown');
  const label = createElement('div', 'label', 'Sync status');
  const content = createElement('div', 'stat-content');
  content.append(value, label);
  title.append(content);
  syncHealthGrid.append(title);
  if (health.details) {
    const detail = createElement('div', 'stat');
    const detailValue = createElement('div', 'value', health.details);
    const detailLabel = createElement('div', 'label', 'Details');
    const detailContent = createElement('div', 'stat-content');
    detailContent.append(detailValue, detailLabel);
    detail.append(detailContent);
    syncHealthGrid.append(detail);
  }
}

function renderPairing(payload: any) {
  if (!pairingPayload) return;
  if (!payload) {
    pairingPayload.textContent = 'No pairing payload available';
    if (pairingHint)
      pairingHint.textContent =
        'Pairing will appear after at least one sync scan.';
    return;
  }

  const command = payload.command || '';
  pairingPayload.textContent = command || 'Pairing not available';
  pairingCommandRaw = command || '';
  if (pairingHint) {
    pairingHint.textContent =
      payload.hint || 'Copy/paste this on the other device to pair.';
  }
}

async function copyPairingCommand() {
  const command = pairingCommandRaw || pairingPayload?.textContent || '';
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    if (pairingCopy) pairingCopy.textContent = 'Copied';
    setTimeout(() => {
      if (pairingCopy) pairingCopy.textContent = 'Copy pairing command';
    }, 1200);
  } catch {
    if (pairingCopy) pairingCopy.textContent = 'Copy failed';
  }
}

pairingCopy?.addEventListener('click', copyPairingCommand);

function itemSignature(item: any) {
  return String(
    item.id ??
      item.memory_id ??
      item.observation_id ??
      item.session_id ??
      item.created_at_utc ??
      item.created_at ??
      '',
  );
}

type ItemViewMode = 'summary' | 'facts' | 'narrative';

function itemKey(item: any) {
  return `${String(item.kind || '').toLowerCase()}:${itemSignature(item)}`;
}

function toTitleLabel(value: string) {
  return value
    .replace(/_/g, ' ')
    .split(' ')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ')
    .trim();
}

function getSummaryObject(item: any): Record<string, any> | null {
  const preferredKeys = [
    'request',
    'outcome',
    'plan',
    'completed',
    'learned',
    'investigated',
    'next',
    'next_steps',
    'notes',
  ];
  const looksLikeSummary = (value: any) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return preferredKeys.some((key) => {
      const raw = (value as any)[key];
      return typeof raw === 'string' && raw.trim().length > 0;
    });
  };

  const candidate = item?.summary;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    return candidate;
  }
  const nested = item?.summary?.summary;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested;
  }

  const metadata = item?.metadata_json;
  if (looksLikeSummary(metadata)) {
    return metadata;
  }
  const metadataNested = metadata?.summary;
  if (looksLikeSummary(metadataNested)) {
    return metadataNested;
  }
  return null;
}

function getNarrativeText(item: any) {
  const html = item?.body_html;
  const text = item?.body_text;
  return String(html || text || '').trim();
}

function getFactsList(item: any) {
  const summary = getSummaryObject(item);
  if (summary) {
    const preferred = [
      'request',
      'outcome',
      'plan',
      'completed',
      'learned',
      'investigated',
      'next',
      'next_steps',
      'notes',
    ];
    const keys = Object.keys(summary || {});
    const remaining = keys
      .filter((key) => !preferred.includes(key))
      .sort((a, b) => a.localeCompare(b));
    const ordered = [...preferred.filter((key) => keys.includes(key)), ...remaining];

    const facts: string[] = [];
    ordered.forEach((key) => {
      const raw = (summary as any)[key];
      const content = String(raw || '').trim();
      if (!content) return;

      const bullets = extractFactsFromBody(content);
      if (bullets.length) {
        bullets.forEach((bullet) => {
          facts.push(`${toTitleLabel(key)}: ${bullet}`.trim());
        });
        return;
      }

      facts.push(`${toTitleLabel(key)}: ${content}`.trim());
    });
    return facts;
  }

  const text = String(item?.body_text || '');
  return extractFactsFromBody(text);
}

function renderSummaryObject(summary: Record<string, any>): HTMLElement | null {
  const preferred = [
    'request',
    'outcome',
    'plan',
    'completed',
    'learned',
    'investigated',
    'next',
    'next_steps',
    'notes',
  ];
  const keys = Object.keys(summary || {});
  const ordered = preferred.filter((key) => keys.includes(key));

  const container = createElement('div', 'feed-body facts') as HTMLDivElement;
  let wrote = false;
  ordered.forEach((key) => {
    const raw = (summary as any)[key];
    const content = String(raw || '').trim();
    if (!content) return;
    wrote = true;
    const row = createElement('div', 'summary-section') as HTMLDivElement;
    const label = createElement('div', 'summary-section-label', toTitleLabel(key));
    const value = createElement('div', 'summary-section-content');
    try {
      value.innerHTML = (globalThis as any).marked.parse(content);
    } catch {
      value.textContent = content;
    }
    row.append(label, value);
    container.appendChild(row);
  });
  return wrote ? container : null;
}

function renderFacts(facts: string[]): HTMLElement | null {
  const trimmed = facts.map((fact) => String(fact || '').trim()).filter(Boolean);
  if (!trimmed.length) return null;
  const container = createElement('div', 'feed-body') as HTMLDivElement;
  const list = document.createElement('ul');
  trimmed.forEach((fact) => {
    const li = document.createElement('li');
    li.textContent = fact;
    list.appendChild(li);
  });
  container.appendChild(list);
  return container;
}

function renderNarrative(narrative: string): HTMLElement | null {
  const content = String(narrative || '').trim();
  if (!content) return null;
  const body = createElement('div', 'feed-body') as HTMLDivElement;
  body.innerHTML = (globalThis as any).marked.parse(content);
  return body;
}

function _sentenceFacts(text: string, limit = 6): string[] {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const parts = collapsed
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const facts: string[] = [];
  for (const part of parts) {
    if (part.length < 18) continue;
    facts.push(part);
    if (facts.length >= limit) break;
  }
  return facts;
}

function _observationViewData(item: any) {
  const metadata = mergeMetadata(item?.metadata_json);
  const summary = String(item?.subtitle || item?.body_text || '').trim();
  const narrative = String(item?.narrative || metadata?.narrative || '').trim();
  const normalizedSummary = normalize(summary);
  const normalizedNarrative = normalize(narrative);
  const narrativeDistinct = Boolean(narrative) && normalizedNarrative !== normalizedSummary;
  const explicitFacts = parseJsonArray(item?.facts || metadata?.facts || []);
  const fallbackFacts = explicitFacts.length
    ? explicitFacts
    : extractFactsFromBody(summary || narrative);
  const derivedFacts = fallbackFacts.length ? fallbackFacts : _sentenceFacts(summary);
  return {
    summary,
    narrative,
    facts: derivedFacts,
    hasSummary: Boolean(summary),
    hasFacts: derivedFacts.length > 0,
    hasNarrative: narrativeDistinct,
  };
}

function _observationViewModes(data: {
  hasSummary: boolean;
  hasFacts: boolean;
  hasNarrative: boolean;
}): Array<{ id: ItemViewMode; label: string }> {
  const modes: Array<{ id: ItemViewMode; label: string }> = [];
  if (data.hasSummary) modes.push({ id: 'summary', label: 'Summary' });
  if (data.hasFacts) modes.push({ id: 'facts', label: 'Facts' });
  if (data.hasNarrative) modes.push({ id: 'narrative', label: 'Narrative' });
  return modes;
}

function _defaultObservationView(data: {
  hasSummary: boolean;
  hasFacts: boolean;
  hasNarrative: boolean;
}): ItemViewMode {
  if (data.hasSummary) return 'summary';
  if (data.hasFacts) return 'facts';
  return 'narrative';
}

function _renderObservationBody(
  data: { summary: string; narrative: string; facts: string[] },
  mode: ItemViewMode,
): HTMLElement {
  if (mode === 'facts') {
    return renderFacts(data.facts) || createElement('div', 'feed-body');
  }
  if (mode === 'narrative') {
    return renderNarrative(data.narrative) || createElement('div', 'feed-body');
  }
  return renderNarrative(data.summary) || createElement('div', 'feed-body');
}

function renderItemViewToggle(
  modes: Array<{ id: ItemViewMode; label: string }>,
  active: ItemViewMode,
  onSelect: (mode: ItemViewMode) => void,
): HTMLElement | null {
  if (modes.length <= 1) return null;
  const toggle = createElement('div', 'feed-toggle') as HTMLDivElement;
  modes.forEach((mode) => {
    const button = createElement(
      'button',
      'toggle-button',
      mode.label,
    ) as HTMLButtonElement;
    button.dataset.filter = mode.id;
    button.classList.toggle('active', mode.id === active);
    button.addEventListener('click', () => onSelect(mode.id));
    toggle.appendChild(button);
  });
  return toggle;
}

function computeFeedSignature(items: any[]) {
  const parts = items.map(
    (item) =>
      `${itemSignature(item)}:${item.kind || ''}:${item.created_at_utc || item.created_at || ''}`,
  );
  return `${feedTypeFilter}|${currentProject}|${parts.join('|')}`;
}

function renderFeed(items: any[]) {
  if (!feedList) return;
  feedList.textContent = '';
  if (!Array.isArray(items) || !items.length) {
    const empty = createElement('div', 'small', 'No memories yet.');
    feedList.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const kindValue = String(item.kind || 'session_summary').toLowerCase();
    const isSessionSummary = kindValue === 'session_summary';
    const metadata = mergeMetadata(item?.metadata_json);

    const card = createElement(
      'div',
      `feed-item ${kindValue}`.trim(),
    );
    (card as any).dataset.key = itemKey(item);
    const header = createElement('div', 'feed-card-header');
    const titleWrap = createElement('div', 'feed-header');
    const defaultTitle = item.title || '(untitled)';
    const displayTitle = isSessionSummary && metadata?.request ? metadata.request : defaultTitle;
    const title = createElement('div', 'feed-title title', displayTitle);
    const kind = createElement(
      'span',
      `kind-pill ${kindValue}`.trim(),
      kindValue.replace(/_/g, ' '),
    );
    titleWrap.append(title, kind);

    const rightWrap = document.createElement('div');
    rightWrap.style.display = 'flex';
    rightWrap.style.alignItems = 'center';
    rightWrap.style.gap = '10px';
    rightWrap.style.flexShrink = '0';

    const createdAt = formatDate(item.created_at || item.created_at_utc);
    const age = createElement('div', 'small', createdAt);

    let bodyNode: HTMLElement = createElement('div', 'feed-body');

    if (isSessionSummary) {
      const summaryObject = getSummaryObject({ metadata_json: metadata });
      const rendered = summaryObject ? renderSummaryObject(summaryObject) : null;
      bodyNode = rendered || renderNarrative(String(item.body_text || '')) || bodyNode;
    } else {
      const data = _observationViewData({ ...item, metadata_json: metadata });
      const modes = _observationViewModes(data);
      const defaultView = _defaultObservationView(data);

      const key = itemKey(item);
      const stored = itemViewState.get(key) as ItemViewMode | undefined;
      let activeMode: ItemViewMode = stored && modes.some((m) => m.id === stored) ? stored : defaultView;
      itemViewState.set(key, activeMode);

      bodyNode = _renderObservationBody(data, activeMode);

      const toggle = renderItemViewToggle(modes, activeMode, (mode) => {
        activeMode = mode;
        itemViewState.set(key, mode);
        const nextBody = _renderObservationBody(data, mode);
        card.replaceChild(nextBody, bodyNode);
        bodyNode = nextBody;

        if (toggle) {
          const buttons = Array.from(toggle.querySelectorAll('.toggle-button'));
          buttons.forEach((button) => {
            const value = (button as HTMLButtonElement).dataset.filter as ItemViewMode;
            button.classList.toggle('active', value === mode);
          });
        }
      });
      if (toggle) rightWrap.appendChild(toggle);
    }
    rightWrap.appendChild(age);

    header.append(titleWrap, rightWrap);

    const meta = createElement('div', 'feed-meta');
    const tags = parseJsonArray(item.tags || []);
    const files = parseJsonArray(item.files || []);
    const project = item.project || '';
    const tagContent = tags.length
      ? ` · ${tags.map((tag) => formatTagLabel(tag)).join(', ')}`
      : '';
    const fileContent = files.length ? ` · ${formatFileList(files)}` : '';
    const projectContent = project ? `Project: ${project}` : 'Project: n/a';
    meta.textContent = `${projectContent}${tagContent}${fileContent}`;

    const footer = createElement('div', 'feed-footer');
    const footerLeft = createElement('div', 'feed-footer-left');
    const filesWrap = createElement('div', 'feed-files');
    const tagsWrap = createElement('div', 'feed-tags');

    files.forEach((file: any) => {
      const chip = createElement('span', 'feed-file', file);
      filesWrap.appendChild(chip);
    });

    tags.forEach((tag: any) => {
      const chip = createTagChip(tag);
      if (chip) tagsWrap.appendChild(chip);
    });

    if (filesWrap.childElementCount) {
      footerLeft.appendChild(filesWrap);
    }
    if (tagsWrap.childElementCount) {
      footerLeft.appendChild(tagsWrap);
    }
    footer.appendChild(footerLeft);

    card.append(header, meta, bodyNode, footer);
    feedList.appendChild(card);
  });
  if (typeof (globalThis as any).lucide !== 'undefined')
    (globalThis as any).lucide.createIcons();
}

function renderSessionSummary(summary: any) {
  if (!sessionGrid || !sessionMeta) return;
  sessionGrid.textContent = '';
  if (!summary) {
    sessionMeta.textContent = 'No injections yet';
    return;
  }

  const total = Number(summary.total || 0);
  sessionMeta.textContent = total
    ? `${total} injections so far`
    : 'No injections yet';

  const items = [
    { label: 'Memories', value: summary.memories || 0 },
    { label: 'Artifacts', value: summary.artifacts || 0 },
    { label: 'Prompts', value: summary.prompts || 0 },
    { label: 'Observations', value: summary.observations || 0 },
  ];
  items.forEach((item) => {
    const block = createElement('div', 'stat');
    const value = createElement(
      'div',
      'value',
      Number(item.value || 0).toLocaleString(),
    );
    const label = createElement('div', 'label', item.label);
    const content = createElement('div', 'stat-content');
    content.append(value, label);
    block.append(content);
    sessionGrid.appendChild(block);
  });
}

function renderConfigModal(defaults: any, config: any) {
  if (!defaults || !config) return;
  configDefaults = defaults;
  configPath = config.path || '';

  const observerProvider = config.observer_provider || '';
  const observerModel = config.observer_model || '';
  const observerMaxChars = config.observer_max_chars || '';
  const packObservationLimit = config.pack_observation_limit || '';
  const packSessionLimit = config.pack_session_limit || '';
  const syncEnabled = config.sync_enabled || false;
  const syncHost = config.sync_host || '';
  const syncPort = config.sync_port || '';
  const syncInterval = config.sync_interval_seconds || '';
  const syncMdns = config.sync_mdns || false;

  if (observerProviderInput) observerProviderInput.value = observerProvider;
  if (observerModelInput) observerModelInput.value = observerModel;
  if (observerMaxCharsInput) observerMaxCharsInput.value = observerMaxChars;
  if (packObservationLimitInput)
    packObservationLimitInput.value = packObservationLimit;
  if (packSessionLimitInput) packSessionLimitInput.value = packSessionLimit;
  if (syncEnabledInput) syncEnabledInput.checked = Boolean(syncEnabled);
  if (syncHostInput) syncHostInput.value = syncHost;
  if (syncPortInput) syncPortInput.value = syncPort;
  if (syncIntervalInput) syncIntervalInput.value = syncInterval;
  if (syncMdnsInput) syncMdnsInput.checked = Boolean(syncMdns);

  if (settingsPath)
    settingsPath.textContent = configPath
      ? `Config path: ${configPath}`
      : 'Config path: n/a';
  if (observerMaxCharsHint) {
    const defaultValue = configDefaults?.observer_max_chars || '';
    observerMaxCharsHint.textContent = defaultValue
      ? `Default: ${defaultValue}`
      : '';
  }
  if (settingsEffective) settingsEffective.textContent = config.effective ?? '';
}

function openSettings() {
  stopPolling();
  if (settingsBackdrop) (settingsBackdrop as any).hidden = false;
  if (settingsModal) (settingsModal as any).hidden = false;
}

function closeSettings() {
  if (settingsBackdrop) (settingsBackdrop as any).hidden = true;
  if (settingsModal) (settingsModal as any).hidden = true;
  startPolling();
  refresh();
}

settingsButton?.addEventListener('click', openSettings);
settingsClose?.addEventListener('click', closeSettings);
settingsBackdrop?.addEventListener('click', closeSettings);

async function syncNow(address: string) {
  if (!syncNowButton) return;
  syncNowButton.disabled = true;
  syncNowButton.textContent = 'Syncing...';
  try {
    const payload = address ? { address } : {};
    await fetch('/api/sync/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    refresh();
  } catch {
    // Ignore errors.
  } finally {
    syncNowButton.disabled = false;
    syncNowButton.textContent = 'Sync now';
  }
}

syncNowButton?.addEventListener('click', () => syncNow(''));

function hideSettingsOverrideNotice(config: any) {
  if (!settingsOverrides) return;
  if (config?.has_env_overrides) {
    (settingsOverrides as any).hidden = false;
  } else {
    (settingsOverrides as any).hidden = true;
  }
}

async function saveSettings() {
  if (!settingsSave || !settingsStatus) return;
  (settingsSave as any).disabled = true;
  settingsStatus.textContent = 'Saving...';
  try {
    const payload = {
      observer_provider: observerProviderInput?.value || '',
      observer_model: observerModelInput?.value || '',
      observer_max_chars: Number(observerMaxCharsInput?.value || 0) || '',
      pack_observation_limit:
        Number(packObservationLimitInput?.value || 0) || '',
      pack_session_limit: Number(packSessionLimitInput?.value || 0) || '',
      sync_enabled: syncEnabledInput?.checked || false,
      sync_host: syncHostInput?.value || '',
      sync_port: Number(syncPortInput?.value || 0) || '',
      sync_interval_seconds: Number(syncIntervalInput?.value || 0) || '',
      sync_mdns: syncMdnsInput?.checked || false,
    };
    const resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const message = await resp.text();
      throw new Error(message);
    }
    settingsStatus.textContent = 'Saved';
    setTimeout(() => {
      settingsStatus.textContent = 'Ready';
    }, 1500);
    refresh();
  } catch {
    settingsStatus.textContent = 'Save failed';
  } finally {
    (settingsSave as any).disabled = false;
  }
}

settingsSave?.addEventListener('click', saveSettings);

async function loadStats() {
  try {
    const [statsResp, usageResp, sessionsResp, rawEventsResp] =
      await Promise.all([
        fetch('/api/stats'),
        fetch(`/api/usage?project=${encodeURIComponent(currentProject || '')}`),
        fetch(
          `/api/session?project=${encodeURIComponent(currentProject || '')}`,
        ),
        fetch(
          `/api/raw-events?project=${encodeURIComponent(currentProject || '')}`,
        ),
      ]);

    const statsPayload = await statsResp.json();
    const usagePayload = usageResp.ok ? await usageResp.json() : {};
    const sessionsPayload = sessionsResp.ok ? await sessionsResp.json() : {};
    const rawEventsPayload = rawEventsResp.ok ? await rawEventsResp.json() : {};

    const stats = statsPayload || {};
    const sessions = sessionsPayload || {};
    const rawEvents = rawEventsPayload || {};

    renderStats(stats, usagePayload, currentProject, rawEvents);
    renderSessionSummary(sessions);
    renderSyncHealth(stats.sync_health || {});
  } catch {
    if (metaLine) metaLine.textContent = 'Stats unavailable';
  }
}

async function loadFeed() {
  try {
    const [observationsResp, summariesResp] = await Promise.all([
      fetch(
        `/api/memories?project=${encodeURIComponent(currentProject || '')}`,
      ),
      fetch(
        `/api/summaries?project=${encodeURIComponent(currentProject || '')}`,
      ),
    ]);

    const observations = await observationsResp.json();
    const summaries = await summariesResp.json();

    const summaryItems = summaries.items || [];
    const observationItems = observations.items || [];
    const filteredObservations = observationItems.filter(
      (item: any) => !isLowSignalObservation(item),
    );
    const filteredCount = observationItems.length - filteredObservations.length;
    const feedItems = [...summaryItems, ...filteredObservations].sort(
      (a, b) => {
        const left = new Date(a.created_at || 0).getTime();
        const right = new Date(b.created_at || 0).getTime();
        return right - left;
      },
    );
    const visibleItems = filterFeedItems(feedItems);
    const filterLabel = formatFeedFilterLabel();

    const signature = computeFeedSignature(visibleItems);
    const changed = signature !== lastFeedSignature;
    lastFeedSignature = signature;

    if (feedMeta) {
      feedMeta.textContent = `${visibleItems.length} items${filterLabel}${
        filteredCount ? ' · ' + filteredCount + ' observations filtered' : ''
      }`;
    }
    if (changed) {
      renderFeed(visibleItems);
    }
    if (refreshStatus) {
      refreshStatus.innerHTML =
        "<span class='dot'></span>updated " + new Date().toLocaleTimeString();
    }
  } catch {
    if (refreshStatus) {
      refreshStatus.innerHTML = "<span class='dot'></span>refresh failed";
    }
  }
}

async function loadConfig() {
  if (isSettingsOpen()) {
    // Avoid blowing away in-progress edits while the modal is open.
    return;
  }
  try {
    const resp = await fetch('/api/config');
    if (!resp.ok) return;
    const payload = await resp.json();
    renderConfigModal(payload.defaults || {}, payload.config || {});
    hideSettingsOverrideNotice(payload.config || {});
  } catch {
    // Ignore config load errors.
  }
}

async function loadSyncStatus() {
  try {
    const diag = isSyncDiagnosticsOpen();
    const diagParam = diag ? '?includeDiagnostics=1' : '';
    const resp = await fetch(`/api/sync/status${diagParam}`);
    if (!resp.ok) return;
    const payload = await resp.json();
    lastSyncStatus = payload.status || null;
    lastSyncPeers = payload.peers || [];
    lastSyncAttempts = payload.attempts || [];
    renderSyncStatus(lastSyncStatus);
    renderSyncPeers(lastSyncPeers);
    renderSyncAttempts(lastSyncAttempts);
    if (syncMeta) {
      const last =
        lastSyncStatus?.last_sync_at || lastSyncStatus?.last_sync_at_utc || '';
      syncMeta.textContent = last
        ? `Last sync: ${formatTimestamp(last)}`
        : 'Sync ready';
    }
    renderSyncHealth({
      status: lastSyncStatus?.daemon_state || 'unknown',
      details: lastSyncStatus?.daemon_state === 'error' ? 'daemon error' : '',
    });
  } catch {
    if (syncMeta) syncMeta.textContent = 'Sync unavailable';
  }
}

async function loadPairing() {
  try {
    const diag = isSyncDiagnosticsOpen();
    const diagParam = diag ? '?includeDiagnostics=1' : '';
    const resp = await fetch(`/api/sync/pairing${diagParam}`);
    if (!resp.ok) return;
    const payload = await resp.json();
    pairingPayloadRaw = payload || null;
    renderPairing(payload || null);
  } catch {
    renderPairing(null);
  }
}

async function loadProjects() {
  try {
    const resp = await fetch('/api/projects');
    if (!resp.ok) return;
    const payload = await resp.json();
    const projects = payload.projects || [];
    if (!projectFilter) return;
    projectFilter.textContent = '';
    const allOption = createElement(
      'option',
      null,
      'All Projects',
    ) as HTMLOptionElement;
    allOption.value = '';
    projectFilter.appendChild(allOption);
    projects.forEach((project: string) => {
      const option = createElement(
        'option',
        null,
        project,
      ) as HTMLOptionElement;
      option.value = project;
      projectFilter.appendChild(option);
    });
  } catch {
    // Ignore project load errors.
  }
}

projectFilter?.addEventListener('change', () => {
  currentProject = projectFilter.value || '';
  refresh();
});

async function refresh() {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  refreshInFlight = true;
  try {
    await Promise.all([
      loadStats(),
      loadFeed(),
      loadConfig(),
      loadSyncStatus(),
    ]);

    if (isSyncPairingOpen()) {
      loadPairing();
    } else {
      pairingPayloadRaw = null;
      pairingCommandRaw = '';
      if (syncPairing) (syncPairing as any).hidden = true;
    }
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      refresh();
    }
  }
}

loadProjects();
refresh();
startPolling();
