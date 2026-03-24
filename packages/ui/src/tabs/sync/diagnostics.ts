/* Diagnostics card — sync status grid, attempts log, pairing. */

import { el, copyToClipboard } from '../../lib/dom';
import { formatAgeShort, formatTimestamp, secondsSince, titleCase } from '../../lib/format';
import {
  state,
  isSyncPairingOpen,
  setSyncPairingOpen,
  isSyncRedactionEnabled,
  setSyncRedactionEnabled,
} from '../../lib/state';
import { redactAddress, renderActionList, hideSkeleton } from './helpers';

/* ── Import render functions needed for redact toggle ────── */
// These are set by the index module to avoid circular imports.
let _renderSyncPeers: () => void = () => {};
export function setRenderSyncPeers(fn: () => void) {
  _renderSyncPeers = fn;
}

/* ── Sync status renderer ────────────────────────────────── */

export function renderSyncStatus() {
  const syncStatusGrid = document.getElementById('syncStatusGrid');
  const syncMeta = document.getElementById('syncMeta');
  const syncActions = document.getElementById('syncActions');
  if (!syncStatusGrid) return;
  hideSkeleton('syncDiagSkeleton');
  syncStatusGrid.textContent = '';

  const status = state.lastSyncStatus;
  if (!status) {
    renderActionList(syncActions, []);
    if (syncMeta) syncMeta.textContent = 'Loading sync status\u2026';
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
    if (daemonState === 'offline-peers')
      parts.push('All peers are currently offline; sync will resume automatically');
    if (daemonDetail && daemonState === 'stopped') parts.push(`Detail: ${daemonDetail}`);
    syncMeta.textContent = parts.join(' \u00b7 ');
  }

  // Status grid
  const diagItems = syncDisabled
    ? [
        { label: 'State', value: 'Disabled' },
        { label: 'Mode', value: 'Optional' },
        { label: 'Pending events', value: pending },
        { label: 'Last sync', value: 'n/a' },
      ]
    : syncNoPeers
      ? [
          { label: 'State', value: 'No peers' },
          { label: 'Mode', value: 'Idle' },
          { label: 'Pending events', value: pending },
          { label: 'Last sync', value: 'n/a' },
        ]
      : [
          { label: 'State', value: daemonStateLabel },
          { label: 'Pending events', value: pending },
          {
            label: 'Last sync',
            value: lastSync ? `${formatAgeShort(secondsSince(lastSync))} ago` : 'never',
          },
          {
            label: 'Last ping',
            value: lastPing ? `${formatAgeShort(secondsSince(lastPing))} ago` : 'never',
          },
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
    content.append(
      el('div', 'value', 'Errors'),
      el('div', 'label', [syncError, pingError].filter(Boolean).join(' \u00b7 ')),
    );
    block.appendChild(content);
    syncStatusGrid.appendChild(block);
  }

  if (!syncDisabled && !syncNoPeers && syncPayload?.seconds_since_last) {
    const block = el('div', 'stat');
    const content = el('div', 'stat-content');
    content.append(
      el('div', 'value', `${syncPayload.seconds_since_last}s`),
      el('div', 'label', 'Since last sync'),
    );
    block.appendChild(content);
    syncStatusGrid.appendChild(block);
  }

  if (!syncDisabled && !syncNoPeers && pingPayload?.seconds_since_last) {
    const block = el('div', 'stat');
    const content = el('div', 'stat-content');
    content.append(
      el('div', 'value', `${pingPayload.seconds_since_last}s`),
      el('div', 'label', 'Since last ping'),
    );
    block.appendChild(content);
    syncStatusGrid.appendChild(block);
  }

  // Actions
  const actions: Array<{ label: string; command: string }> = [];
  if (syncNoPeers) {
    /* no action */
  } else if (daemonState === 'offline-peers') {
    /* informational */
  } else if (daemonState === 'stopped') {
    actions.push({ label: 'Sync daemon is stopped. Start it.', command: 'codemem sync start' });
    actions.push({ label: 'Then run one immediate sync pass.', command: 'codemem sync once' });
  } else if (syncError || pingError || daemonState === 'error') {
    actions.push({
      label: 'Sync reports errors. Restart now.',
      command: 'codemem sync restart && codemem sync once',
    });
    actions.push({
      label: 'Then run doctor for root cause.',
      command: 'codemem sync doctor',
    });
  } else if (!syncDisabled && !syncNoPeers && pending > 0) {
    actions.push({
      label: 'Pending sync work detected. Run one pass now.',
      command: 'codemem sync once',
    });
  }
  renderActionList(syncActions, actions);
}

/* ── Attempts renderer ───────────────────────────────────── */

export function renderSyncAttempts() {
  const syncAttempts = document.getElementById('syncAttempts');
  if (!syncAttempts) return;
  syncAttempts.textContent = '';
  const attempts = state.lastSyncAttempts;
  if (!Array.isArray(attempts) || !attempts.length) return;

  attempts.slice(0, 5).forEach((attempt) => {
    const line = el('div', 'diag-line');
    const left = el('div', 'left');
    left.append(
      el('div', null, attempt.status || 'unknown'),
      el(
        'div',
        'small',
        isSyncRedactionEnabled() ? redactAddress(attempt.address) : attempt.address || 'n/a',
      ),
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
    if (pairingHint)
      pairingHint.textContent = 'Diagnostics are required to view the pairing payload.';
    state.pairingCommandRaw = '';
    return;
  }

  const safePayload = {
    ...payload,
    addresses: Array.isArray(payload.addresses) ? payload.addresses : [],
  };
  const compact = JSON.stringify(safePayload);
  const b64 = btoa(compact);
  const command = `echo '${b64}' | base64 -d | codemem sync pair --accept-file -`;
  pairingPayloadEl.textContent = command;
  state.pairingCommandRaw = command;
  if (pairingHint) {
    pairingHint.textContent =
      'Copy this command and run it on the other device. Use --include/--exclude to control which projects sync.';
  }
}

/* ── Event wiring ────────────────────────────────────────── */

export function initDiagnosticsEvents(refreshCallback: () => void) {
  const syncPairingToggle = document.getElementById(
    'syncPairingToggle',
  ) as HTMLButtonElement | null;
  const syncRedact = document.getElementById('syncRedact') as HTMLInputElement | null;
  const pairingCopy = document.getElementById('pairingCopy') as HTMLButtonElement | null;
  const syncPairing = document.getElementById('syncPairing');

  // Apply initial toggle states
  if (syncPairing) syncPairing.hidden = !state.syncPairingOpen;
  if (syncPairingToggle) {
    syncPairingToggle.textContent = state.syncPairingOpen ? 'Hide pairing' : 'Show pairing';
    syncPairingToggle.setAttribute('aria-expanded', String(state.syncPairingOpen));
  }
  if (syncRedact) syncRedact.checked = isSyncRedactionEnabled();

  syncPairingToggle?.addEventListener('click', () => {
    const next = !state.syncPairingOpen;
    setSyncPairingOpen(next);
    if (syncPairing) syncPairing.hidden = !next;
    if (syncPairingToggle) {
      syncPairingToggle.textContent = next ? 'Hide pairing' : 'Show pairing';
      syncPairingToggle.setAttribute('aria-expanded', String(next));
    }
    if (next) {
      const pairingPayloadEl = document.getElementById('pairingPayload');
      const pairingHint = document.getElementById('pairingHint');
      if (pairingPayloadEl) pairingPayloadEl.textContent = 'Loading\u2026';
      if (pairingHint) pairingHint.textContent = 'Fetching pairing payload\u2026';
    }
    refreshCallback();
  });

  syncRedact?.addEventListener('change', () => {
    setSyncRedactionEnabled(Boolean(syncRedact.checked));
    renderSyncStatus();
    _renderSyncPeers();
    renderSyncAttempts();
    renderPairing();
  });

  pairingCopy?.addEventListener('click', async () => {
    const text =
      state.pairingCommandRaw || document.getElementById('pairingPayload')?.textContent || '';
    if (text && pairingCopy) await copyToClipboard(text, pairingCopy);
  });
}
