/* Sync tab — peer sync status, diagnostics, pairing. */

import { el, copyToClipboard } from '../lib/dom';
import { formatAgeShort, formatTimestamp, secondsSince, titleCase } from '../lib/format';
import {
  state,
  isSyncPairingOpen,
  setFeedScopeFilter,
  setSyncPairingOpen,
  isSyncRedactionEnabled,
  setSyncRedactionEnabled,
} from '../lib/state';
import * as api from '../lib/api';
import { showGlobalNotice } from '../lib/notice';
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

function parseScopeList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function actorLabel(actor: any): string {
  if (!actor || typeof actor !== 'object') return 'Unknown actor';
  const displayName = String(actor.display_name || '').trim();
  if (!displayName) return String(actor.actor_id || 'Unknown actor');
  return displayName;
}

function assignedActorCount(actorId: string): number {
  const peers = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers : [];
  return peers.filter((peer) => String(peer?.actor_id || '') === actorId).length;
}

function assignmentNote(actorId: string): string {
  if (!actorId) return 'Unassigned peers keep legacy fallback attribution until you choose an actor.';
  const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
  const actor = actors.find((item) => String(item?.actor_id || '') === actorId);
  if (actor?.is_local) {
    return 'Local actor assignment keeps this peer in your same-person continuity path, including private sync.';
  }
  return 'This actor receives memories from allowed projects by default. Use Only me on a memory when it should stay local.';
}

function buildActorOptions(selectedActorId: string): HTMLOptionElement[] {
  const options: HTMLOptionElement[] = [];
  const unassigned = document.createElement('option');
  unassigned.value = '';
  unassigned.textContent = 'No actor assigned';
  options.push(unassigned);

  const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
  actors.forEach((actor) => {
    const option = document.createElement('option');
    option.value = String(actor.actor_id || '');
    option.textContent = actor.is_local ? `${actorLabel(actor)} (local)` : actorLabel(actor);
    option.selected = option.value === selectedActorId;
    options.push(option);
  });
  if (!selectedActorId) options[0].selected = true;
  return options;
}

function mergeTargetActors(actorId: string): any[] {
  const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
  return actors.filter((actor) => String(actor?.actor_id || '') !== actorId);
}

function actorMergeNote(targetActorId: string, secondaryActorId: string): string {
  const target = mergeTargetActors(secondaryActorId).find(
    (actor) => String(actor?.actor_id || '') === targetActorId,
  );
  if (!targetActorId || !target) {
    return 'Choose where this duplicate actor should collapse.';
  }
  return `Merge into ${actorLabel(target)}. Assigned peers move now; existing memories already stamped with this actor keep their current provenance for now.`;
}

function createChipEditor(initialValues: string[], placeholder: string, emptyLabel: string) {
  let values = [...initialValues];
  const container = el('div', 'peer-scope-editor');
  const chips = el('div', 'peer-scope-chips');
  const input = el('input', 'peer-scope-input') as HTMLInputElement;
  input.placeholder = placeholder;

  const syncChips = () => {
    chips.textContent = '';
    if (!values.length) {
      chips.appendChild(el('span', 'peer-scope-chip empty', emptyLabel));
      return;
    }
    values.forEach((value, index) => {
      const chip = el('span', 'peer-scope-chip');
      const label = el('span', null, value);
      const remove = el('button', 'peer-scope-chip-remove', 'x') as HTMLButtonElement;
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${value}`);
      remove.addEventListener('click', () => {
        values = values.filter((_, currentIndex) => currentIndex !== index);
        syncChips();
      });
      chip.append(label, remove);
      chips.appendChild(chip);
    });
  };

  const commitInput = () => {
    const incoming = parseScopeList(input.value);
    if (incoming.length) {
      values = Array.from(new Set([...values, ...incoming]));
      input.value = '';
      syncChips();
    }
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commitInput();
    }
    if (event.key === 'Backspace' && !input.value && values.length) {
      values = values.slice(0, -1);
      syncChips();
    }
  });
  input.addEventListener('blur', commitInput);

  syncChips();
  container.append(chips, input);
  return {
    element: container,
    values: () => [...values],
  };
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
    const identityMeta = el(
      'div',
      'peer-meta',
      peer.actor_display_name
        ? `Assigned to ${String(peer.actor_display_name)}${peer.claimed_local_actor ? ' · local actor' : ''}`
        : 'Unassigned actor',
    );

    const scope = peer.project_scope || {};
    const includeList = Array.isArray(scope.include) ? scope.include : [];
    const excludeList = Array.isArray(scope.exclude) ? scope.exclude : [];
    const effectiveInclude = Array.isArray(scope.effective_include) ? scope.effective_include : [];
    const effectiveExclude = Array.isArray(scope.effective_exclude) ? scope.effective_exclude : [];
    const inheritsGlobal = Boolean(scope.inherits_global);
    const scopePanel = el('div', 'peer-scope');
    const identityRow = el('div', 'peer-scope-summary');
    identityRow.textContent = 'Assigned actor';
    const actorRow = el('div', 'peer-actor-row');
    const actorSelect = document.createElement('select');
    actorSelect.className = 'sync-actor-select';
    actorSelect.setAttribute('aria-label', `Assigned actor for ${displayName}`);
    buildActorOptions(String(peer.actor_id || '')).forEach((option) => actorSelect.appendChild(option));
    const applyActorBtn = el('button', 'settings-button', 'Save actor') as HTMLButtonElement;
    const actorHint = el('div', 'peer-scope-effective', assignmentNote(String(peer.actor_id || '')));
    actorSelect.addEventListener('change', () => {
      actorHint.textContent = assignmentNote(actorSelect.value);
    });
    applyActorBtn.addEventListener('click', async () => {
      applyActorBtn.disabled = true;
      actorSelect.disabled = true;
      applyActorBtn.textContent = 'Applying...';
      try {
        await api.assignPeerActor(peerId, actorSelect.value || null);
        showGlobalNotice(actorSelect.value ? 'Peer actor updated.' : 'Peer actor cleared.');
        await loadSyncData();
      } catch (error) {
        showGlobalNotice(error instanceof Error ? error.message : 'Failed to update peer actor.', 'warning');
        applyActorBtn.textContent = 'Retry actor';
      } finally {
        actorSelect.disabled = false;
        applyActorBtn.disabled = false;
        if (applyActorBtn.textContent === 'Applying...') applyActorBtn.textContent = 'Save actor';
      }
    });
    actorRow.append(actorSelect, applyActorBtn);
    const scopeSummary = el(
      'div',
      'peer-scope-summary',
      inheritsGlobal
        ? 'Using global sync scope'
        : `Peer override · include: ${includeList.join(', ') || 'all'} · exclude: ${excludeList.join(', ') || 'none'}`,
    );
    const effectiveSummary = el(
      'div',
      'peer-scope-effective',
      `Effective scope · include: ${effectiveInclude.join(', ') || 'all'} · exclude: ${effectiveExclude.join(', ') || 'none'}`,
    );
    const includeEditor = createChipEditor(includeList, 'Add included project', 'All projects');
    const excludeEditor = createChipEditor(excludeList, 'Add excluded project', 'No exclusions');
    const inputRow = el('div', 'peer-scope-row');
    inputRow.append(includeEditor.element, excludeEditor.element);
    const scopeActions = el('div', 'peer-scope-actions');
    const saveScopeBtn = el('button', 'settings-button', 'Save scope') as HTMLButtonElement;
    const inheritBtn = el('button', 'settings-button', 'Reset to global scope') as HTMLButtonElement;
    saveScopeBtn.addEventListener('click', async () => {
      saveScopeBtn.disabled = true;
      saveScopeBtn.textContent = 'Saving...';
      try {
        await api.updatePeerScope(peerId, includeEditor.values(), excludeEditor.values());
        showGlobalNotice('Peer sync scope saved.');
        await loadSyncData();
      } catch (error) {
        showGlobalNotice(error instanceof Error ? error.message : 'Failed to save peer scope.', 'warning');
        saveScopeBtn.textContent = 'Retry save';
      } finally {
        saveScopeBtn.disabled = false;
        if (saveScopeBtn.textContent === 'Saving...') saveScopeBtn.textContent = 'Save scope';
      }
    });
    inheritBtn.addEventListener('click', async () => {
      inheritBtn.disabled = true;
      inheritBtn.textContent = 'Resetting...';
      try {
        await api.updatePeerScope(peerId, null, null, true);
        showGlobalNotice('Peer sync scope reset to global defaults.');
        await loadSyncData();
      } catch (error) {
        showGlobalNotice(error instanceof Error ? error.message : 'Failed to reset peer scope.', 'warning');
        inheritBtn.textContent = 'Retry reset';
      } finally {
        inheritBtn.disabled = false;
        if (inheritBtn.textContent === 'Resetting...') inheritBtn.textContent = 'Reset to global scope';
      }
    });
    scopeActions.append(saveScopeBtn, inheritBtn);
    scopePanel.append(identityRow, identityMeta, actorRow, actorHint, scopeSummary, effectiveSummary, inputRow, scopeActions);

    titleRow.append(name, actions);
    card.append(titleRow, addressLabel, meta, scopePanel);
    syncPeers.appendChild(card);
  });
}

export function renderSyncActors() {
  const actorList = document.getElementById('syncActorsList');
  const actorMeta = document.getElementById('syncActorsMeta');
  if (!actorList) return;
  actorList.textContent = '';

  const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
  if (actorMeta) {
    actorMeta.textContent = actors.length
      ? 'Create, rename, and merge actors here. Assign each peer below. Non-local actors receive memories from allowed projects unless you mark them Only me.'
      : 'No named actors yet. Create one here, then assign peers below.';
  }

  actors.forEach((actor) => {
    const row = el('div', 'actor-row');
    const details = el('div', 'actor-details');
    const title = el('div', 'actor-title');
    const name = el('strong', null, actorLabel(actor));
    const badge = el('span', `badge actor-badge${actor.is_local ? ' local' : ''}`, actor.is_local ? 'Local' : `${assignedActorCount(String(actor.actor_id || ''))} peer${assignedActorCount(String(actor.actor_id || '')) === 1 ? '' : 's'}`);
    title.append(name, badge);
    const note = el(
      'div',
      'peer-meta',
      actor.is_local
        ? 'Used for this device and same-person peers.'
        : `${assignedActorCount(String(actor.actor_id || ''))} assigned peer${assignedActorCount(String(actor.actor_id || '')) === 1 ? '' : 's'}`,
    );
    details.append(title, note);

    const actions = el('div', 'actor-actions');
    if (actor.is_local) {
      actions.appendChild(el('div', 'peer-meta', 'Rename in config')); 
    } else {
      const actorId = String(actor.actor_id || '');
      const input = document.createElement('input');
      input.className = 'peer-scope-input actor-name-input';
      input.value = actorLabel(actor);
      input.setAttribute('aria-label', `Rename ${actorLabel(actor)}`);
      const renameBtn = el('button', 'settings-button', 'Rename') as HTMLButtonElement;
      renameBtn.addEventListener('click', async () => {
        const nextName = input.value.trim();
        if (!nextName) return;
        renameBtn.disabled = true;
        input.disabled = true;
        renameBtn.textContent = 'Saving...';
        try {
          await api.renameActor(actorId, nextName);
          await loadSyncData();
        } catch {
          renameBtn.textContent = 'Retry rename';
        } finally {
          renameBtn.disabled = false;
          input.disabled = false;
          if (renameBtn.textContent === 'Saving...') renameBtn.textContent = 'Rename';
        }
      });
      const mergeTargets = mergeTargetActors(actorId);
      const mergeControls = el('div', 'actor-merge-controls');
      const mergeSelect = document.createElement('select');
      mergeSelect.className = 'sync-actor-select actor-merge-select';
      mergeSelect.setAttribute('aria-label', `Merge ${actorLabel(actor)} into another actor`);
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Merge into actor';
      placeholder.selected = true;
      mergeSelect.appendChild(placeholder);
      mergeTargets.forEach((target) => {
        const option = document.createElement('option');
        option.value = String(target.actor_id || '');
        option.textContent = target.is_local ? `${actorLabel(target)} (local)` : actorLabel(target);
        mergeSelect.appendChild(option);
      });
      const mergeBtn = el('button', 'settings-button', 'Merge into selected actor') as HTMLButtonElement;
      mergeBtn.disabled = mergeTargets.length === 0;
      const mergeNote = el(
        'div',
        'peer-meta actor-merge-note',
        mergeTargets.length
          ? actorMergeNote('', actorId)
          : 'No merge targets yet. Create another actor or use the local actor.',
      );
      mergeSelect.addEventListener('change', () => {
        mergeNote.textContent = actorMergeNote(mergeSelect.value, actorId);
      });
      mergeBtn.addEventListener('click', async () => {
        if (!mergeSelect.value) return;
        const target = mergeTargets.find((candidate) => String(candidate.actor_id || '') === mergeSelect.value);
        if (!window.confirm(`Merge ${actorLabel(actor)} into ${actorLabel(target)}? Assigned peers move now, but older memories keep their current stamped provenance for now.`)) {
          return;
        }
        mergeBtn.disabled = true;
        mergeSelect.disabled = true;
        input.disabled = true;
        renameBtn.disabled = true;
        mergeBtn.textContent = 'Merging...';
        try {
          await api.mergeActor(mergeSelect.value, actorId);
          showGlobalNotice('Actor merged. Assigned peers were moved to the selected actor.');
          await loadSyncData();
        } catch (error) {
          showGlobalNotice(error instanceof Error ? error.message : 'Failed to merge actor.', 'warning');
          mergeBtn.textContent = 'Retry merge';
        } finally {
          mergeBtn.disabled = mergeTargets.length === 0;
          mergeSelect.disabled = false;
          input.disabled = false;
          renameBtn.disabled = false;
          if (mergeBtn.textContent === 'Merging...') mergeBtn.textContent = 'Merge into selected actor';
        }
      });
      mergeControls.append(mergeSelect, mergeBtn);
      actions.append(input, renameBtn, mergeControls, mergeNote);
    }

    row.append(details, actions);
    actorList.appendChild(row);
  });
}

function openFeedSharingReview() {
  setFeedScopeFilter('mine');
  state.feedQuery = '';
  window.location.hash = 'feed';
}

export function renderSyncSharingReview() {
  const panel = document.getElementById('syncSharingReview');
  const meta = document.getElementById('syncSharingReviewMeta');
  const list = document.getElementById('syncSharingReviewList');
  if (!panel || !meta || !list) return;
  list.textContent = '';
  const items = Array.isArray(state.lastSyncSharingReview) ? state.lastSyncSharingReview : [];
  if (!items.length) {
    (panel as any).hidden = true;
    return;
  }
  (panel as any).hidden = false;
  const scopeLabel = state.currentProject ? `current project (${state.currentProject})` : 'all allowed projects';
  meta.textContent = `Teammate peers receive memories from ${scopeLabel} by default. Use Only me on a memory when it should stay local.`;
  items.forEach((item) => {
    const row = el('div', 'actor-row');
    const details = el('div', 'actor-details');
    const title = el('div', 'actor-title');
    title.append(
      el('strong', null, String(item.peer_name || item.peer_device_id || 'Peer')),
      el('span', 'badge actor-badge', `actor: ${String(item.actor_display_name || item.actor_id || 'unknown')}`),
    );
    const note = el(
      'div',
      'peer-meta',
      `${Number(item.shareable_count || 0)} share by default · ${Number(item.private_count || 0)} marked Only me · ${String(item.scope_label || 'All allowed projects')}`,
    );
    details.append(title, note);
    const actions = el('div', 'actor-actions');
    const reviewBtn = el('button', 'settings-button', 'Review my memories in Feed') as HTMLButtonElement;
    reviewBtn.addEventListener('click', () => {
      openFeedSharingReview();
    });
    actions.appendChild(reviewBtn);
    row.append(details, actions);
    list.appendChild(row);
  });
}

export function renderSyncCoordinatorOverview() {
  const panel = document.getElementById('syncCoordinatorOverview');
  const meta = document.getElementById('syncCoordinatorMeta');
  const list = document.getElementById('syncCoordinatorList');
  const actions = document.getElementById('syncCoordinatorActions');
  if (!panel || !meta || !list || !actions) return;
  list.textContent = '';
  const coordinator = state.lastSyncCoordinator;
  if (!coordinator || !coordinator.configured) {
    (panel as any).hidden = true;
    return;
  }
  (panel as any).hidden = false;
  meta.textContent = `${String(coordinator.coordinator_url || '')} · groups: ${(coordinator.groups || []).join(', ') || 'none'}`;
  const rows = [
    ['Enrollment', coordinator.presence_status === 'posted' ? 'Enrolled and posting presence' : coordinator.presence_status === 'not_enrolled' ? 'Not enrolled in coordinator' : 'Coordinator error'],
    ['Paired peers', String(coordinator.paired_peer_count || 0)],
    ['Fresh discovered peers', String(coordinator.fresh_peer_count || 0)],
    ['Stale discovered peers', String(coordinator.stale_peer_count || 0)],
    ['Advertised addresses', Array.isArray(coordinator.advertised_addresses) && coordinator.advertised_addresses.length ? coordinator.advertised_addresses.join(' · ') : 'None'],
  ];
  rows.forEach(([label, value]) => {
    const row = el('div', 'peer-meta', `${label}: ${value}`);
    list.appendChild(row);
  });
  const actionItems: Array<{ label: string; command: string }> = [];
  if (coordinator.presence_status === 'not_enrolled') {
    actionItems.push({ label: 'This device is not enrolled in the coordinator group.', command: 'Use invite import or remote admin enrollment for this device' });
  }
  if (!Number(coordinator.paired_peer_count || 0)) {
    actionItems.push({ label: 'No trusted sync peers are paired yet.', command: 'uv run codemem sync pair --payload-only' });
  }
  if (!Number(coordinator.fresh_peer_count || 0)) {
    actionItems.push({ label: 'No fresh peers were discovered from the coordinator.', command: 'uv run codemem sync once' });
  }
  renderActionList(actions, actionItems);
}

export function renderLegacyDeviceClaims() {
  const panel = document.getElementById('syncLegacyClaims');
  const select = document.getElementById('syncLegacyDeviceSelect') as HTMLSelectElement | null;
  const button = document.getElementById('syncLegacyClaimButton') as HTMLButtonElement | null;
  const meta = document.getElementById('syncLegacyClaimsMeta');
  if (!panel || !select || !button || !meta) return;

  const devices = Array.isArray(state.lastSyncLegacyDevices) ? state.lastSyncLegacyDevices : [];
  select.textContent = '';
  meta.textContent = '';
  if (!devices.length) {
    (panel as any).hidden = true;
    return;
  }

  (panel as any).hidden = false;
  devices.forEach((device, index) => {
    const option = document.createElement('option');
    const deviceId = String(device.origin_device_id || '').trim();
    if (!deviceId) return;
    const count = Number(device.memory_count || 0);
    const lastSeen = String(device.last_seen_at || '').trim();
    option.value = deviceId;
    option.textContent = count > 0 ? `${deviceId} (${count} memories)` : deviceId;
    if (index === 0) option.selected = true;
    select.appendChild(option);
    if (!meta.textContent && lastSeen) {
      meta.textContent = `Detected from older synced memories. Latest memory: ${formatTimestamp(lastSeen)}`;
    }
  });
  if (!meta.textContent) {
    meta.textContent = 'Detected from older synced memories that are not attached to a current peer.';
  }
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
    const payload = await api.loadSyncStatus(true, state.currentProject || '');
    let actorsPayload: any = null;
    let actorLoadError = false;
    try {
      actorsPayload = await api.loadSyncActors();
    } catch {
      actorLoadError = true;
    }
    const statusPayload = payload.status && typeof payload.status === 'object' ? payload.status : null;
    if (statusPayload) state.lastSyncStatus = statusPayload;
    state.lastSyncActors = Array.isArray(actorsPayload?.items) ? actorsPayload.items : [];
    state.lastSyncPeers = payload.peers || [];
    state.lastSyncSharingReview = payload.sharing_review || [];
    state.lastSyncCoordinator = payload.coordinator || null;
    state.lastSyncAttempts = payload.attempts || [];
    state.lastSyncLegacyDevices = payload.legacy_devices || [];
    renderSyncStatus();
    renderSyncCoordinatorOverview();
    renderSyncActors();
    renderSyncSharingReview();
    renderSyncPeers();
    renderLegacyDeviceClaims();
    renderSyncAttempts();
    // Re-render health indicators since they consume sync state (health dot, etc.)
    renderHealthOverview();
    if (actorLoadError) {
      const actorMeta = document.getElementById('syncActorsMeta');
      if (actorMeta) actorMeta.textContent = 'Actor controls are temporarily unavailable. Peer status and sync health still loaded.';
    }
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
  const syncActorCreateButton = document.getElementById('syncActorCreateButton') as HTMLButtonElement | null;
  const syncActorCreateInput = document.getElementById('syncActorCreateInput') as HTMLInputElement | null;
  const syncLegacyClaimButton = document.getElementById('syncLegacyClaimButton') as HTMLButtonElement | null;
  const syncLegacyDeviceSelect = document.getElementById('syncLegacyDeviceSelect') as HTMLSelectElement | null;
  const pairingCopy = document.getElementById('pairingCopy') as HTMLButtonElement | null;
  const syncPairing = document.getElementById('syncPairing');

  // Apply initial toggle states
  if (syncPairing) (syncPairing as any).hidden = !state.syncPairingOpen;
  if (syncPairingToggle) syncPairingToggle.textContent = state.syncPairingOpen ? 'Hide pairing' : 'Show pairing';
  if (syncRedact) syncRedact.checked = isSyncRedactionEnabled();

  syncPairingToggle?.addEventListener('click', () => {
    const next = !state.syncPairingOpen;
    setSyncPairingOpen(next);
    if (syncPairing) (syncPairing as any).hidden = !next;
    if (syncPairingToggle) syncPairingToggle.textContent = next ? 'Hide pairing' : 'Show pairing';
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

  syncActorCreateButton?.addEventListener('click', async () => {
    const displayName = String(syncActorCreateInput?.value || '').trim();
    if (!displayName || !syncActorCreateButton || !syncActorCreateInput) return;
    syncActorCreateButton.disabled = true;
    syncActorCreateInput.disabled = true;
    syncActorCreateButton.textContent = 'Creating...';
    try {
      await api.createActor(displayName);
      showGlobalNotice('Actor created.');
      syncActorCreateInput.value = '';
      await loadSyncData();
    } catch (error) {
      showGlobalNotice(error instanceof Error ? error.message : 'Failed to create actor.', 'warning');
      syncActorCreateButton.textContent = 'Retry create';
      syncActorCreateButton.disabled = false;
      syncActorCreateInput.disabled = false;
      return;
    }
    syncActorCreateButton.textContent = 'Create actor';
    syncActorCreateButton.disabled = false;
    syncActorCreateInput.disabled = false;
  });

  syncLegacyClaimButton?.addEventListener('click', async () => {
    const originDeviceId = String(syncLegacyDeviceSelect?.value || '').trim();
    if (!originDeviceId || !syncLegacyClaimButton) return;
    if (!window.confirm(`Attach old device history from ${originDeviceId} to your local actor? This updates legacy provenance for that device.`)) return;
    syncLegacyClaimButton.disabled = true;
    const originalText = syncLegacyClaimButton.textContent || 'Attach device history';
    syncLegacyClaimButton.textContent = 'Attaching...';
    try {
      await api.claimLegacyDeviceIdentity(originDeviceId);
      showGlobalNotice('Old device history attached to your local actor.');
      await loadSyncData();
    } catch (error) {
      showGlobalNotice(error instanceof Error ? error.message : 'Failed to attach old device history.', 'warning');
      syncLegacyClaimButton.textContent = 'Retry claim';
      syncLegacyClaimButton.disabled = false;
      return;
    }
    syncLegacyClaimButton.textContent = originalText;
    syncLegacyClaimButton.disabled = false;
  });

  syncNowButton?.addEventListener('click', async () => {
    if (!syncNowButton) return;
    syncNowButton.disabled = true;
    syncNowButton.textContent = 'Syncing...';
    try {
      await api.triggerSync();
      showGlobalNotice('Sync pass started.');
    } catch (error) {
      showGlobalNotice(error instanceof Error ? error.message : 'Failed to start sync.', 'warning');
    }
    syncNowButton.disabled = false;
    syncNowButton.textContent = 'Sync now';
    refreshCallback();
  });

  pairingCopy?.addEventListener('click', async () => {
    const text = state.pairingCommandRaw || document.getElementById('pairingPayload')?.textContent || '';
    if (text && pairingCopy) await copyToClipboard(text, pairingCopy);
  });
}
