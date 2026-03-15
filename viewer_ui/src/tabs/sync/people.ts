/* People card — actors, devices/peers, sharing review, legacy device claims. */

import { el } from '../../lib/dom';
import { formatTimestamp } from '../../lib/format';
import { state, isSyncRedactionEnabled } from '../../lib/state';
import * as api from '../../lib/api';
import { showGlobalNotice } from '../../lib/notice';
import { markFieldError, clearFieldError, friendlyError } from '../../lib/form';
import {
  redactAddress,
  pickPrimaryAddress,
  actorLabel,
  assignedActorCount,
  assignmentNote,
  buildActorOptions,
  mergeTargetActors,
  actorMergeNote,
  createChipEditor,
  openPeerScopeEditors,
} from './helpers';

/* ── loadSyncData callback (set by index module) ─────────── */

let _loadSyncData: () => Promise<void> = async () => {};
export function setLoadSyncData(fn: () => Promise<void>) {
  _loadSyncData = fn;
}

/* ── Actors renderer ─────────────────────────────────────── */

export function renderSyncActors() {
  const actorList = document.getElementById('syncActorsList');
  const actorMeta = document.getElementById('syncActorsMeta');
  if (!actorList) return;
  actorList.textContent = '';

  const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
  if (actorMeta) {
    actorMeta.textContent = actors.length
      ? 'Create, rename, and merge actors here. Assign each device below. Non-local actors receive memories from allowed projects unless you mark them Only me.'
      : 'No named actors yet. Create one here, then assign devices below.';
  }

  if (!actors.length) {
    actorList.appendChild(
      el('div', 'sync-empty-state', 'No actors yet. Create one to represent yourself or a teammate.'),
    );
    return;
  }

  actors.forEach((actor) => {
    const row = el('div', 'actor-row');
    const details = el('div', 'actor-details');
    const title = el('div', 'actor-title');
    const name = el('strong', null, actorLabel(actor));
    const count = assignedActorCount(String(actor.actor_id || ''));
    const badge = el(
      'span',
      `badge actor-badge${actor.is_local ? ' local' : ''}`,
      actor.is_local ? 'Local' : `${count} device${count === 1 ? '' : 's'}`,
    );
    title.append(name, badge);
    const note = el(
      'div',
      'peer-meta',
      actor.is_local
        ? 'Used for this device and same-person devices.'
        : `${count} assigned device${count === 1 ? '' : 's'}`,
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
        renameBtn.textContent = 'Saving\u2026';
        try {
          await api.renameActor(actorId, nextName);
          await _loadSyncData();
        } catch {
          renameBtn.textContent = 'Retry rename';
        } finally {
          renameBtn.disabled = false;
          input.disabled = false;
          if (renameBtn.textContent === 'Saving\u2026') renameBtn.textContent = 'Rename';
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
      const mergeBtn = el(
        'button',
        'settings-button',
        'Merge into selected actor',
      ) as HTMLButtonElement;
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
        const target = mergeTargets.find(
          (candidate) => String(candidate.actor_id || '') === mergeSelect.value,
        );
        if (
          !window.confirm(
            `Merge ${actorLabel(actor)} into ${actorLabel(target)}? Assigned devices move now, but older memories keep their current stamped provenance for now.`,
          )
        ) {
          return;
        }
        mergeBtn.disabled = true;
        mergeSelect.disabled = true;
        input.disabled = true;
        renameBtn.disabled = true;
        mergeBtn.textContent = 'Merging\u2026';
        try {
          await api.mergeActor(mergeSelect.value, actorId);
          showGlobalNotice('Actor merged. Assigned devices moved to the selected actor.');
          await _loadSyncData();
        } catch (error) {
          showGlobalNotice(friendlyError(error, 'Failed to merge actor.'), 'warning');
          mergeBtn.textContent = 'Retry merge';
        } finally {
          mergeBtn.disabled = mergeTargets.length === 0;
          mergeSelect.disabled = false;
          input.disabled = false;
          renameBtn.disabled = false;
          if (mergeBtn.textContent === 'Merging\u2026')
            mergeBtn.textContent = 'Merge into selected actor';
        }
      });
      mergeControls.append(mergeSelect, mergeBtn);
      actions.append(input, renameBtn, mergeControls, mergeNote);
    }

    row.append(details, actions);
    actorList.appendChild(row);
  });
}

/* ── Devices renderer ────────────────────────────────────── */

export function renderSyncPeers() {
  const syncPeers = document.getElementById('syncPeers');
  if (!syncPeers) return;
  syncPeers.textContent = '';
  const peers = state.lastSyncPeers;
  if (!Array.isArray(peers) || !peers.length) {
    syncPeers.appendChild(
      el(
        'div',
        'sync-empty-state',
        'No devices paired yet. Use the pairing command in Diagnostics to connect another device.',
      ),
    );
    return;
  }

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
      syncBtn.textContent = 'Syncing\u2026';
      try {
        await api.triggerSync(primaryAddress);
      } catch {}
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync now';
    });
    actions.appendChild(syncBtn);
    const toggleScopeBtn = el('button', null, 'Edit scope') as HTMLButtonElement;
    actions.appendChild(toggleScopeBtn);

    const peerAddresses = Array.isArray(peer.addresses)
      ? Array.from(new Set(peer.addresses.filter(Boolean)))
      : [];
    const addressLine = peerAddresses.length
      ? peerAddresses
          .map((a: any) => (isSyncRedactionEnabled() ? redactAddress(a) : a))
          .join(' \u00b7 ')
      : 'No addresses';
    const addressLabel = el('div', 'peer-addresses', addressLine);

    const lastSyncAt = peerStatus.last_sync_at || peerStatus.last_sync_at_utc || '';
    const lastPingAt = peerStatus.last_ping_at || peerStatus.last_ping_at_utc || '';
    const meta = el(
      'div',
      'peer-meta',
      [
        lastSyncAt ? `Sync: ${formatTimestamp(lastSyncAt)}` : 'Sync: never',
        lastPingAt ? `Ping: ${formatTimestamp(lastPingAt)}` : 'Ping: never',
      ].join(' \u00b7 '),
    );
    const identityMeta = el(
      'div',
      'peer-meta',
      peer.actor_display_name
        ? `Assigned to ${String(peer.actor_display_name)}${peer.claimed_local_actor ? ' \u00b7 local actor' : ''}`
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
    buildActorOptions(String(peer.actor_id || '')).forEach((option) =>
      actorSelect.appendChild(option),
    );
    const applyActorBtn = el('button', 'settings-button', 'Save actor') as HTMLButtonElement;
    const actorHint = el(
      'div',
      'peer-scope-effective',
      assignmentNote(String(peer.actor_id || '')),
    );
    actorSelect.addEventListener('change', () => {
      actorHint.textContent = assignmentNote(actorSelect.value);
    });
    applyActorBtn.addEventListener('click', async () => {
      applyActorBtn.disabled = true;
      actorSelect.disabled = true;
      applyActorBtn.textContent = 'Applying\u2026';
      try {
        await api.assignPeerActor(peerId, actorSelect.value || null);
        showGlobalNotice(actorSelect.value ? 'Device actor updated.' : 'Device actor cleared.');
        await _loadSyncData();
      } catch (error) {
        showGlobalNotice(friendlyError(error, 'Failed to update device actor.'), 'warning');
        applyActorBtn.textContent = 'Retry';
      } finally {
        actorSelect.disabled = false;
        applyActorBtn.disabled = false;
        if (applyActorBtn.textContent === 'Applying\u2026')
          applyActorBtn.textContent = 'Save actor';
      }
    });
    actorRow.append(actorSelect, applyActorBtn);
    const scopeSummary = el(
      'div',
      'peer-scope-summary',
      inheritsGlobal
        ? 'Using global sync scope'
        : `Device override \u00b7 include: ${includeList.join(', ') || 'all'} \u00b7 exclude: ${excludeList.join(', ') || 'none'}`,
    );
    const effectiveSummary = el(
      'div',
      'peer-scope-effective',
      `Effective scope \u00b7 include: ${effectiveInclude.join(', ') || 'all'} \u00b7 exclude: ${effectiveExclude.join(', ') || 'none'}`,
    );
    const includeEditor = createChipEditor(includeList, 'Add included project', 'All projects');
    const excludeEditor = createChipEditor(excludeList, 'Add excluded project', 'No exclusions');
    const editorWrap = el('div', 'peer-scope-editor-wrap');
    const scopeEditorOpen = openPeerScopeEditors.has(peerId);
    (editorWrap as any).hidden = !scopeEditorOpen;
    const inputRow = el('div', 'peer-scope-row');
    inputRow.append(includeEditor.element, excludeEditor.element);
    const scopeActions = el('div', 'peer-scope-actions');
    const saveScopeBtn = el('button', 'settings-button', 'Save scope') as HTMLButtonElement;
    const inheritBtn = el(
      'button',
      'settings-button',
      'Reset to global scope',
    ) as HTMLButtonElement;
    saveScopeBtn.addEventListener('click', async () => {
      saveScopeBtn.disabled = true;
      saveScopeBtn.textContent = 'Saving\u2026';
      try {
        await api.updatePeerScope(peerId, includeEditor.values(), excludeEditor.values());
        showGlobalNotice('Device sync scope saved.');
        await _loadSyncData();
      } catch (error) {
        showGlobalNotice(friendlyError(error, 'Failed to save device scope.'), 'warning');
        saveScopeBtn.textContent = 'Retry save';
      } finally {
        saveScopeBtn.disabled = false;
        if (saveScopeBtn.textContent === 'Saving\u2026') saveScopeBtn.textContent = 'Save scope';
      }
    });
    inheritBtn.addEventListener('click', async () => {
      inheritBtn.disabled = true;
      inheritBtn.textContent = 'Resetting\u2026';
      try {
        await api.updatePeerScope(peerId, null, null, true);
        showGlobalNotice('Device sync scope reset to global defaults.');
        await _loadSyncData();
      } catch (error) {
        showGlobalNotice(friendlyError(error, 'Failed to reset device scope.'), 'warning');
        inheritBtn.textContent = 'Retry reset';
      } finally {
        inheritBtn.disabled = false;
        if (inheritBtn.textContent === 'Resetting\u2026')
          inheritBtn.textContent = 'Reset to global scope';
      }
    });
    scopeActions.append(saveScopeBtn, inheritBtn);
    editorWrap.append(inputRow, scopeActions);
    toggleScopeBtn.textContent = scopeEditorOpen ? 'Hide scope editor' : 'Edit scope';
    toggleScopeBtn.addEventListener('click', () => {
      const nextHidden = !(editorWrap as any).hidden;
      (editorWrap as any).hidden = nextHidden;
      if (nextHidden) openPeerScopeEditors.delete(peerId);
      else openPeerScopeEditors.add(peerId);
      toggleScopeBtn.textContent = nextHidden ? 'Edit scope' : 'Hide scope editor';
    });
    scopePanel.append(identityRow, identityMeta, actorRow, actorHint, scopeSummary, effectiveSummary, editorWrap);

    titleRow.append(name, actions);
    card.append(titleRow, addressLabel, meta, scopePanel);
    syncPeers.appendChild(card);
  });
}

/* ── Legacy device claims renderer ───────────────────────── */

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
    meta.textContent = 'Detected from older synced memories not yet attached to a current device.';
  }
}

/* ── Event wiring ────────────────────────────────────────── */

export function initPeopleEvents(loadSyncData: () => Promise<void>) {
  const syncActorCreateButton = document.getElementById(
    'syncActorCreateButton',
  ) as HTMLButtonElement | null;
  const syncActorCreateInput = document.getElementById(
    'syncActorCreateInput',
  ) as HTMLInputElement | null;
  const syncLegacyClaimButton = document.getElementById(
    'syncLegacyClaimButton',
  ) as HTMLButtonElement | null;
  const syncLegacyDeviceSelect = document.getElementById(
    'syncLegacyDeviceSelect',
  ) as HTMLSelectElement | null;

  syncActorCreateButton?.addEventListener('click', async () => {
    if (!syncActorCreateButton || !syncActorCreateInput) return;
    const displayName = String(syncActorCreateInput.value || '').trim();
    if (!displayName) {
      markFieldError(syncActorCreateInput, 'Enter a name for the actor.');
      return;
    }
    clearFieldError(syncActorCreateInput);
    syncActorCreateButton.disabled = true;
    syncActorCreateInput.disabled = true;
    syncActorCreateButton.textContent = 'Creating\u2026';
    try {
      await api.createActor(displayName);
      showGlobalNotice('Actor created.');
      syncActorCreateInput.value = '';
      await loadSyncData();
    } catch (error) {
      showGlobalNotice(friendlyError(error, 'Failed to create actor.'), 'warning');
      syncActorCreateButton.textContent = 'Retry';
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
    if (
      !window.confirm(
        `Attach old device history from ${originDeviceId} to your local actor? This updates legacy provenance for that device.`,
      )
    )
      return;
    syncLegacyClaimButton.disabled = true;
    const originalText = syncLegacyClaimButton.textContent || 'Attach device history';
    syncLegacyClaimButton.textContent = 'Attaching\u2026';
    try {
      await api.claimLegacyDeviceIdentity(originDeviceId);
      showGlobalNotice('Old device history attached to your local actor.');
      await loadSyncData();
    } catch (error) {
      showGlobalNotice(friendlyError(error, 'Failed to attach old device history.'), 'warning');
      syncLegacyClaimButton.textContent = 'Retry';
      syncLegacyClaimButton.disabled = false;
      return;
    }
    syncLegacyClaimButton.textContent = originalText;
    syncLegacyClaimButton.disabled = false;
  });
}
