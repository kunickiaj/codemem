/* Diagnostics card — sync status grid, attempts log, pairing. */

import { h } from 'preact';
import { RadixSwitch } from '../../components/primitives/radix-switch';
import { copyToClipboard } from '../../lib/dom';
import { formatAgeShort, formatTimestamp, secondsSince, titleCase } from '../../lib/format';
import { state, setSyncPairingOpen, isSyncRedactionEnabled, setSyncRedactionEnabled } from '../../lib/state';
import { clearSyncMount, renderIntoSyncMount } from './components/render-root';
import { renderPairingDisclosure } from './components/sync-disclosure';
import {
  renderAttemptsList,
  renderDiagnosticsGrid,
  renderPairingView,
  type PairingView,
  type SyncAttemptItem,
  type SyncStatItem,
} from './components/sync-diagnostics';
import { redactAddress, renderActionList, hideSkeleton } from './helpers';

type SyncRetention = {
  enabled?: boolean;
  last_deleted_ops?: number | string;
  last_error?: string;
  last_run_at?: string | null;
};

type SyncPayloadState = {
  seconds_since_last?: number;
};

type PingPayloadState = SyncPayloadState & {
  last_ping_at?: string | null;
};

type SyncStatusState = {
  daemon_detail?: string;
  daemon_state?: string;
  enabled?: boolean;
  last_ping_at?: string | null;
  last_ping_error?: string;
  last_sync_at?: string | null;
  last_sync_at_utc?: string | null;
  last_sync_error?: string;
  pending?: number | string;
  peers?: Record<string, unknown>;
  ping?: PingPayloadState;
  retention?: SyncRetention;
  sync?: SyncPayloadState;
};

type SyncAttemptState = {
  address?: string;
  started_at?: string;
  started_at_utc?: string;
  status?: string;
};

type PairingPayloadState = Record<string, unknown> & {
  addresses?: unknown[];
  redacted?: boolean;
};

const SYNC_REDACT_MOUNT_ID = 'syncRedactMount';
const SYNC_REDACT_LABEL_ID = 'syncRedactLabel';

/* ── Import render functions needed for redact toggle ────── */
// These are set by the index module to avoid circular imports.
let _renderSyncPeers: () => void = () => {};
export function setRenderSyncPeers(fn: () => void) {
  _renderSyncPeers = fn;
}

let _refreshPairing: () => void = () => {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pairingView(payload: unknown): PairingView {
  if (!isRecord(payload)) {
    state.pairingCommandRaw = '';
    return {
      payloadText: 'Pairing not available',
      hintText: 'Enable sync and retry.',
    };
  }

  const pairingPayload = payload as PairingPayloadState;
  if (pairingPayload.redacted) {
    state.pairingCommandRaw = '';
    return {
      payloadText: 'Pairing payload hidden',
      hintText: 'Diagnostics are required to view the pairing payload.',
    };
  }

  const safePayload = {
    ...pairingPayload,
    addresses: Array.isArray(pairingPayload.addresses) ? pairingPayload.addresses : [],
  };
  const compact = JSON.stringify(safePayload);
  const b64 = btoa(compact);
  const command = `echo '${b64}' | base64 -d | codemem sync pair --accept-file -`;
  state.pairingCommandRaw = command;
  return {
    payloadText: command,
    hintText:
      'Copy this command and run it on the other device. Use --include/--exclude to control which projects sync.',
  };
}

/* ── Sync status renderer ────────────────────────────────── */

export function renderSyncStatus() {
  const syncStatusGrid = document.getElementById('syncStatusGrid');
  const syncMeta = document.getElementById('syncMeta');
  const syncActions = document.getElementById('syncActions');
  if (!syncStatusGrid) return;

  hideSkeleton('syncDiagSkeleton');

  const status = state.lastSyncStatus as SyncStatusState | null;
  if (!status) {
    clearSyncMount(syncStatusGrid);
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
  const retention = status.retention || {};
  const retentionEnabled = retention.enabled === true;
  const retentionDeleted = Number(retention.last_deleted_ops || 0);
  const retentionLastRunAt = retention.last_run_at || null;
  const retentionLastError = String(retention.last_error || '');
  const daemonStateLabel =
    daemonState === 'offline-peers'
      ? 'Offline peers'
      : daemonState === 'needs_attention'
        ? 'Needs attention'
        : daemonState === 'rebootstrapping'
          ? 'Rebootstrapping'
          : titleCase(daemonState);
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
    if (daemonState === 'offline-peers') {
      parts.push('All peers are currently offline; sync will resume automatically');
    }
    if (daemonDetail && daemonState === 'stopped') {
      parts.push(`Detail: ${daemonDetail}`);
    }
    if (daemonDetail && (daemonState === 'needs_attention' || daemonState === 'rebootstrapping')) {
      parts.push(`Detail: ${daemonDetail}`);
    }
    if (retentionEnabled) {
      parts.push(
        retentionLastRunAt
          ? `Retention last ran ${formatAgeShort(secondsSince(retentionLastRunAt))} ago (approx oldest-first)`
          : 'Retention enabled',
      );
    }
    syncMeta.textContent = parts.join(' · ');
  }

  const items: SyncStatItem[] = syncDisabled
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
          {
            label: 'Retention',
            value: retentionEnabled
              ? retentionLastRunAt
                ? `${retentionDeleted.toLocaleString()} ops last run (approx)`
                : 'Enabled'
              : 'Disabled',
          },
        ];

  if (!syncDisabled && !syncNoPeers && (syncError || pingError)) {
    items.push({
      label: [syncError, pingError].filter(Boolean).join(' · '),
      value: 'Errors',
    });
  }

  if (!syncDisabled && !syncNoPeers && syncPayload.seconds_since_last) {
    items.push({
      label: 'Since last sync',
      value: `${syncPayload.seconds_since_last}s`,
    });
  }

  if (!syncDisabled && !syncNoPeers && pingPayload.seconds_since_last) {
    items.push({
      label: 'Since last ping',
      value: `${pingPayload.seconds_since_last}s`,
    });
  }

  if (!syncDisabled && retentionEnabled && retentionLastError) {
    items.push({
      label: retentionLastError,
      value: 'Retention',
    });
  }

  renderDiagnosticsGrid(syncStatusGrid, items);

  const actions: Array<{ label: string; command: string }> = [];
  if (syncNoPeers) {
    /* no action */
  } else if (daemonState === 'offline-peers') {
    /* informational */
  } else if (daemonState === 'stopped') {
    actions.push({ label: 'Sync daemon is stopped. Start it.', command: 'codemem sync start' });
    actions.push({ label: 'Then run one immediate sync pass.', command: 'codemem sync once' });
  } else if (daemonState === 'needs_attention') {
    actions.push({
      label: 'Sync needs manual attention before reset can continue.',
      command: 'codemem sync doctor',
    });
  } else if (daemonState === 'rebootstrapping') {
    actions.push({ label: 'Sync is rebuilding state in the background.', command: 'codemem sync status' });
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

  const attempts = state.lastSyncAttempts as SyncAttemptState[];
  if (!Array.isArray(attempts) || !attempts.length) {
    clearSyncMount(syncAttempts);
    return;
  }

  const items: SyncAttemptItem[] = attempts.slice(0, 5).map((attempt) => {
    const time = attempt.started_at || attempt.started_at_utc || '';
    return {
      status: attempt.status || 'unknown',
      address: isSyncRedactionEnabled() ? redactAddress(attempt.address) : attempt.address || 'n/a',
      startedAt: time ? formatTimestamp(time) : '',
    };
  });

  renderAttemptsList(syncAttempts, items);
}

/* ── Pairing renderer ────────────────────────────────────── */

function renderPairingCollapsible() {
  const mount = document.getElementById('syncPairingDisclosureMount') as HTMLElement | null;
  const contentHost = document.getElementById('syncPairingPanelMount') as HTMLElement | null;
  if (!mount || !contentHost) return;

  renderPairingDisclosure(mount, {
    contentHost,
    open: state.syncPairingOpen,
    onOpenChange: (open) => {
      setSyncPairingOpen(open);
      renderPairingCollapsible();
      if (open) {
        const pairingPayloadEl = document.getElementById('pairingPayload');
        const pairingHint = document.getElementById('pairingHint');
        if (pairingPayloadEl) {
          renderPairingView(pairingPayloadEl, pairingHint, {
            payloadText: 'Loading…',
            hintText: 'Fetching pairing payload…',
          });
        }
      }
      _refreshPairing();
    },
  });

  const pairingCopy = document.getElementById('pairingCopy') as HTMLButtonElement | null;
  if (pairingCopy) {
    pairingCopy.onclick = async () => {
      const text = state.pairingCommandRaw || document.getElementById('pairingPayload')?.textContent || '';
      if (text) await copyToClipboard(text, pairingCopy);
    };
  }
}

export function renderPairing() {
  renderPairingCollapsible();
  const pairingPayloadEl = document.getElementById('pairingPayload');
  const pairingHint = document.getElementById('pairingHint');
  if (!pairingPayloadEl) return;

  renderPairingView(pairingPayloadEl, pairingHint, pairingView(state.pairingPayloadRaw));
}

function renderRedactControl() {
  const mount = document.getElementById(SYNC_REDACT_MOUNT_ID) as HTMLElement | null;
  if (!mount) return;

  renderIntoSyncMount(
    mount,
    h(RadixSwitch, {
      'aria-labelledby': SYNC_REDACT_LABEL_ID,
      checked: isSyncRedactionEnabled(),
      className: 'sync-redact-switch',
      id: 'syncRedact',
      onCheckedChange: (checked: boolean) => {
        setSyncRedactionEnabled(checked);
        renderRedactControl();
        renderSyncStatus();
        _renderSyncPeers();
        renderSyncAttempts();
        renderPairing();
      },
      thumbClassName: 'sync-redact-switch-thumb',
    }),
  );
}

/* ── Event wiring ────────────────────────────────────────── */

export function initDiagnosticsEvents(refreshCallback: () => void) {
  _refreshPairing = refreshCallback;
  renderPairingCollapsible();
  renderRedactControl();
}
