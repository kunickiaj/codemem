/* Sync tab — peer sync status, diagnostics, pairing. */

import { el, copyToClipboard } from '../lib/dom';
import { formatAgeShort, formatTimestamp, secondsSince, titleCase } from '../lib/format';
import {
  state,
  isSyncPairingOpen,
  setSyncPairingOpen,
  isSyncRedactionEnabled,
  setSyncRedactionEnabled,
} from '../lib/state';
import * as api from '../lib/api';
import { renderHealthOverview } from './health';

const PAIRING_FILTER_HINT =
  "Run this on another device with codemem sync pair --accept '<payload>'. " +
  'On that accepting device, --include/--exclude only control what it sends to peers. ' +
  'This device does not yet enforce incoming project filters.';

/* ── Helpers ─────────────────────────────────────────────── */

/** Redact the last two octets of IPv4 addresses while keeping the network prefix visible. */
function redactIpOctets(text: string): string {
  // Match IPv4 addresses and replace the last two octets with #
  return text.replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, '$1.#.#');
}

function redactAddress(address: any): string {
  const raw = String(address || '');
  if (!raw) return '';
  return redactIpOctets(raw);
}

function pickPrimaryAddress(addresses: unknown): string {
  if (!Array.isArray(addresses)) return '';
  const unique = Array.from(new Set(addresses.filter(Boolean)));
  return typeof unique[0] === 'string' ? unique[0] : '';
}

function renderActionList(container: HTMLElement | null, actions: Array<{ label: string; command: string }>) {
  if (!container) return;
  container.textContent = '';
  if (!actions.length) { (container as any).hidden = true; return; }
  (container as any).hidden = false;
  actions.slice(0, 2).forEach((item) => {
    const row = el('div', 'sync-action');
    const textWrap = el('div', 'sync-action-text');
    textWrap.textContent = item.label;
    textWrap.appendChild(el('span', 'sync-action-command', item.command));
    const btn = el('button', 'settings-button sync-action-copy', 'Copy') as HTMLButtonElement;
    btn.addEventListener('click', () => copyToClipboard(item.command, btn));
    row.append(textWrap, btn);
    container.appendChild(row);
  });
}

/* ── Sync status renderer ────────────────────────────────── */

export function renderSyncStatus() {
  const syncStatusGrid = document.getElementById('syncStatusGrid');
  const syncMeta = document.getElementById('syncMeta');
  const syncActions = document.getElementById('syncActions');
  if (!syncStatusGrid) return;
  syncStatusGrid.textContent = '';

  const status = state.lastSyncStatus;
  if (!status) {
    renderActionList(syncActions, []);
    if (syncMeta) syncMeta.textContent = 'Loading sync status…';
    return;
  }

  const peers = status.peers || {};
  const pingPayload = status.ping || {};
  const syncPayload = status.sync || {};
  const lastSync = status.last_sync_at || status.last_sync_at_utc || null;
  const lastPing = pingPayload.last_ping_at || status.last_ping_at || null;
  const syncError = status.last_sync_error || '';
  const pingError = status.last_ping_error || '';
  const pending = Number(status.pending || 0);
  const daemonDetail = String(status.daemon_detail || '');
  const daemonState = String(status.daemon_state || 'unknown');
  const daemonStateLabel = daemonState === 'offline-peers' ? 'Offline peers' : titleCase(daemonState);
  const syncDisabled = daemonState === 'disabled' || status.enabled === false;
  const peerCount = Object.keys(peers).length;
  const syncNoPeers = !syncDisabled && peerCount === 0;

  if (syncMeta) {
    const parts = syncDisabled
      ? ['State: Disabled', 'Sync is optional and currently off']
      : syncNoPeers
        ? ['State: No peers', 'Add peers to enable replication']
        : [
            `State: ${daemonStateLabel}`,
            `Peers: ${peerCount}`,
            lastSync ? `Last sync: ${formatAgeShort(secondsSince(lastSync))} ago` : 'Last sync: never',
          ];
    if (daemonState === 'offline-peers') parts.push('All peers are currently offline; sync will resume automatically');
    if (daemonDetail && daemonState === 'stopped') parts.push(`Detail: ${daemonDetail}`);
    syncMeta.textContent = parts.join(' · ');
  }

  // Status grid
  const diagItems = syncDisabled
    ? [{ label: 'State', value: 'Disabled' }, { label: 'Mode', value: 'Optional' }, { label: 'Pending events', value: pending }, { label: 'Last sync', value: 'n/a' }]
    : syncNoPeers
      ? [{ label: 'State', value: 'No peers' }, { label: 'Mode', value: 'Idle' }, { label: 'Pending events', value: pending }, { label: 'Last sync', value: 'n/a' }]
      : [
          { label: 'State', value: daemonStateLabel },
          { label: 'Pending events', value: pending },
          { label: 'Last sync', value: lastSync ? `${formatAgeShort(secondsSince(lastSync))} ago` : 'never' },
          { label: 'Last ping', value: lastPing ? `${formatAgeShort(secondsSince(lastPing))} ago` : 'never' },
        ];

  diagItems.forEach((item) => {
    const block = el('div', 'stat');
    const content = el('div', 'stat-content');
    content.append(el('div', 'value', item.value), el('div', 'label', item.label));
    block.appendChild(content);
    syncStatusGrid.appendChild(block);
  });

  if (!syncDisabled && !syncNoPeers && (syncError || pingError)) {
    const block = el('div', 'stat');
    const content = el('div', 'stat-content');
    content.append(el('div', 'value', 'Errors'), el('div', 'label', [syncError, pingError].filter(Boolean).join(' · ')));
    block.appendChild(content);
    syncStatusGrid.appendChild(block);
  }

  if (!syncDisabled && !syncNoPeers && syncPayload?.seconds_since_last) {
    const block = el('div', 'stat');
    const content = el('div', 'stat-content');
    content.append(el('div', 'value', `${syncPayload.seconds_since_last}s`), el('div', 'label', 'Since last sync'));
    block.appendChild(content);
    syncStatusGrid.appendChild(block);
  }

  if (!syncDisabled && !syncNoPeers && pingPayload?.seconds_since_last) {
    const block = el('div', 'stat');
    const content = el('div', 'stat-content');
    content.append(el('div', 'value', `${pingPayload.seconds_since_last}s`), el('div', 'label', 'Since last ping'));
    block.appendChild(content);
    syncStatusGrid.appendChild(block);
  }

  // Actions
  const actions: Array<{ label: string; command: string }> = [];
  if (syncNoPeers) { /* no action */ }
  else if (daemonState === 'offline-peers') { /* informational */ }
  else if (daemonState === 'stopped') {
    actions.push({ label: 'Sync daemon is stopped. Start it.', command: 'uv run codemem sync start' });
    actions.push({ label: 'Then run one immediate sync pass.', command: 'uv run codemem sync once' });
  } else if (syncError || pingError || daemonState === 'error') {
    actions.push({ label: 'Sync reports errors. Restart now.', command: 'uv run codemem sync restart && uv run codemem sync once' });
    actions.push({ label: 'Then run doctor for root cause.', command: 'uv run codemem sync doctor' });
  } else if (!syncDisabled && !syncNoPeers && pending > 0) {
    actions.push({ label: 'Pending sync work detected. Run one pass now.', command: 'uv run codemem sync once' });
  }
  renderActionList(syncActions, actions);
}

/* ── Peers renderer ──────────────────────────────────────── */

export function renderSyncPeers() {
  const syncPeers = document.getElementById('syncPeers');
  if (!syncPeers) return;
  syncPeers.textContent = '';
  const peers = state.lastSyncPeers;
  if (!Array.isArray(peers) || !peers.length) return;

  peers.forEach((peer) => {
    const card = el('div', 'peer-card');
    const titleRow = el('div', 'peer-title');
    const peerId = peer.peer_device_id ? String(peer.peer_device_id) : '';
    const displayName = peer.name || (peerId ? peerId.slice(0, 8) : 'unknown');
    const name = el('strong', null, displayName);
    if (peerId) (name as any).title = peerId;

    const peerStatus = peer.status || {};
    const online = peerStatus.sync_status === 'ok' || peerStatus.ping_status === 'ok';
    const badge = el('span', 'badge', online ? 'Online' : 'Offline');
    (badge as any).style.background = online ? 'rgba(31, 111, 92, 0.12)' : 'rgba(230, 126, 77, 0.15)';
    (badge as any).style.color = online ? 'var(--accent)' : 'var(--accent-warm)';
    name.append(' ', badge);

    const actions = el('div', 'peer-actions');
    const primaryAddress = pickPrimaryAddress(peer.addresses);
    const syncBtn = el('button', null, 'Sync now') as HTMLButtonElement;
    syncBtn.disabled = !primaryAddress;
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing...';
      try { await api.triggerSync(primaryAddress); } catch {}
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync now';
    });
    actions.appendChild(syncBtn);

    const peerAddresses = Array.isArray(peer.addresses) ? Array.from(new Set(peer.addresses.filter(Boolean))) : [];
    const addressLine = peerAddresses.length
      ? peerAddresses.map((a: any) => isSyncRedactionEnabled() ? redactAddress(a) : a).join(' · ')
      : 'No addresses';
    const addressLabel = el('div', 'peer-addresses', addressLine);

    const lastSyncAt = peerStatus.last_sync_at || peerStatus.last_sync_at_utc || '';
    const lastPingAt = peerStatus.last_ping_at || peerStatus.last_ping_at_utc || '';
    const meta = el('div', 'peer-meta', [
      lastSyncAt ? `Sync: ${formatTimestamp(lastSyncAt)}` : 'Sync: never',
      lastPingAt ? `Ping: ${formatTimestamp(lastPingAt)}` : 'Ping: never',
    ].join(' · '));

    titleRow.append(name, actions);
    card.append(titleRow, addressLabel, meta);
    syncPeers.appendChild(card);
  });
}

/* ── Attempts renderer ───────────────────────────────────── */

export function renderSyncAttempts() {
  const syncAttempts = document.getElementById('syncAttempts');
  if (!syncAttempts) return;
  syncAttempts.textContent = '';
  const attempts = state.lastSyncAttempts;
  if (!Array.isArray(attempts) || !attempts.length) return;

  attempts.forEach((attempt) => {
    const line = el('div', 'diag-line');
    const left = el('div', 'left');
    left.append(
      el('div', null, attempt.status || 'unknown'),
      el('div', 'small', isSyncRedactionEnabled() ? redactAddress(attempt.address) : (attempt.address || 'n/a')),
    );
    const right = el('div', 'right');
    const time = attempt.started_at || attempt.started_at_utc || '';
    right.textContent = time ? formatTimestamp(time) : '';
    line.append(left, right);
    syncAttempts.appendChild(line);
  });
}

/* ── Pairing renderer ────────────────────────────────────── */

export function renderPairing() {
  const pairingPayloadEl = document.getElementById('pairingPayload');
  const pairingHint = document.getElementById('pairingHint');
  if (!pairingPayloadEl) return;

  const payload = state.pairingPayloadRaw;
  if (!payload || typeof payload !== 'object') {
    pairingPayloadEl.textContent = 'Pairing not available';
    if (pairingHint) pairingHint.textContent = 'Enable sync and retry.';
    state.pairingCommandRaw = '';
    return;
  }
  if (payload.redacted) {
    pairingPayloadEl.textContent = 'Pairing payload hidden';
    if (pairingHint) pairingHint.textContent = 'Diagnostics are required to view the pairing payload.';
    state.pairingCommandRaw = '';
    return;
  }

  const safePayload = { ...payload, addresses: Array.isArray(payload.addresses) ? payload.addresses : [] };
  const compact = JSON.stringify(safePayload);
  const b64 = btoa(compact);
  const command = `echo '${b64}' | base64 -d | codemem sync pair --accept-file -`;
  pairingPayloadEl.textContent = command;
  state.pairingCommandRaw = command;
  if (pairingHint) {
    pairingHint.textContent = 'Copy this command and run it on the other device. Use --include/--exclude to control which projects sync.';
  }
}

/* ── Data loading ────────────────────────────────────────── */

export async function loadSyncData() {
  try {
    const payload = await api.loadSyncStatus(true);
    const statusPayload = payload.status && typeof payload.status === 'object' ? payload.status : null;
    if (statusPayload) state.lastSyncStatus = statusPayload;
    state.lastSyncPeers = payload.peers || [];
    state.lastSyncAttempts = payload.attempts || [];
    renderSyncStatus();
    renderSyncPeers();
    renderSyncAttempts();
    // Re-render health indicators since they consume sync state (health dot, etc.)
    renderHealthOverview();
  } catch {
    const syncMeta = document.getElementById('syncMeta');
    if (syncMeta) syncMeta.textContent = 'Sync unavailable';
  }
}

export async function loadPairingData() {
  try {
    const payload = await api.loadPairing();
    state.pairingPayloadRaw = payload || null;
    renderPairing();
  } catch {
    renderPairing();
  }
}

/* ── Init ────────────────────────────────────────────────── */

export function initSyncTab(refreshCallback: () => void) {
  const syncPairingToggle = document.getElementById('syncPairingToggle') as HTMLButtonElement | null;
  const syncNowButton = document.getElementById('syncNowButton') as HTMLButtonElement | null;
  const syncRedact = document.getElementById('syncRedact') as HTMLInputElement | null;
  const pairingCopy = document.getElementById('pairingCopy') as HTMLButtonElement | null;
  const syncPairing = document.getElementById('syncPairing');

  // Apply initial toggle states
  if (syncPairing) (syncPairing as any).hidden = !state.syncPairingOpen;
  if (syncPairingToggle) syncPairingToggle.textContent = state.syncPairingOpen ? 'Close' : 'Pair';
  if (syncRedact) syncRedact.checked = isSyncRedactionEnabled();

  syncPairingToggle?.addEventListener('click', () => {
    const next = !state.syncPairingOpen;
    setSyncPairingOpen(next);
    if (syncPairing) (syncPairing as any).hidden = !next;
    if (syncPairingToggle) syncPairingToggle.textContent = next ? 'Close' : 'Pair';
    if (next) {
      const pairingPayloadEl = document.getElementById('pairingPayload');
      const pairingHint = document.getElementById('pairingHint');
      if (pairingPayloadEl) pairingPayloadEl.textContent = 'Loading…';
      if (pairingHint) pairingHint.textContent = 'Fetching pairing payload…';
    }
    refreshCallback();
  });

  syncRedact?.addEventListener('change', () => {
    setSyncRedactionEnabled(Boolean(syncRedact.checked));
    renderSyncStatus();
    renderSyncPeers();
    renderSyncAttempts();
    renderPairing();
  });

  syncNowButton?.addEventListener('click', async () => {
    if (!syncNowButton) return;
    syncNowButton.disabled = true;
    syncNowButton.textContent = 'Syncing...';
    try { await api.triggerSync(); } catch {}
    syncNowButton.disabled = false;
    syncNowButton.textContent = 'Sync now';
    refreshCallback();
  });

  pairingCopy?.addEventListener('click', async () => {
    const text = state.pairingCommandRaw || document.getElementById('pairingPayload')?.textContent || '';
    if (text && pairingCopy) await copyToClipboard(text, pairingCopy);
  });
}
