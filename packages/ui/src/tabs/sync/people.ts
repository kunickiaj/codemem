/* People card — people, devices, sharing review, legacy device claims. */

import { state } from '../../lib/state';
import * as api from '../../lib/api';
import { showGlobalNotice } from '../../lib/notice';
import { markFieldError, clearFieldError, friendlyError } from '../../lib/form';
import {
  summarizeSyncRunResult,
  deriveVisiblePeopleActors,
  type VisiblePeopleResult,
} from './view-model';
import {
  clearPeerScopeReview,
  isPeerScopeReviewPending,
  hideSkeleton,
} from './helpers';
import { openSyncConfirmDialog } from './sync-dialogs';
import { renderSyncActorsList } from './components/sync-actors';
import { renderSyncPeersList } from './components/sync-peers';
import { renderLegacyClaimsSlice } from './components/sync-legacy-claims';

/* ── loadSyncData callback (set by index module) ─────────── */

let _loadSyncData: () => Promise<void> = async () => {};
let legacyDeviceValue = '';

export function setLoadSyncData(fn: () => Promise<void>) {
  _loadSyncData = fn;
}

/* ── Actors renderer ─────────────────────────────────────── */

export function renderSyncActors() {
  const actorList = document.getElementById('syncActorsList');
  const actorMeta = document.getElementById('syncActorsMeta');
  if (!actorList) return;
  hideSkeleton('syncActorsSkeleton');

  const actorVisibility: VisiblePeopleResult = deriveVisiblePeopleActors({
    actors: state.lastSyncActors,
    peers: state.lastSyncPeers,
    duplicatePeople: state.lastSyncViewModel?.duplicatePeople,
  });
  const actors = actorVisibility.visibleActors;
  if (actorMeta) {
    actorMeta.textContent = actors.length
      ? 'Create, rename, and combine people here. Assign each device below. Non-local people receive memories from allowed projects unless you mark them Only me.'
      : 'No named people yet. Create one here, then assign devices below.';
    if (actorVisibility.hiddenLocalDuplicateCount > 0) {
      actorMeta.textContent += ` ${actorVisibility.hiddenLocalDuplicateCount} unresolved duplicate ${actorVisibility.hiddenLocalDuplicateCount === 1 ? 'entry is' : 'entries are'} hidden here until reviewed in Needs attention.`;
    }
  }

  renderSyncActorsList(actorList, {
    actors,
    hiddenLocalDuplicateCount: actorVisibility.hiddenLocalDuplicateCount,
    onRename: async (actorId, nextName) => {
      await api.renameActor(actorId, nextName);
      await _loadSyncData();
    },
    onMerge: async (primaryActorId, secondaryActorId) => {
      try {
        await api.mergeActor(primaryActorId, secondaryActorId);
        showGlobalNotice('People combined. Assigned devices moved to the selected person.');
        await _loadSyncData();
      } catch (error) {
        showGlobalNotice(friendlyError(error, 'Failed to combine people.'), 'warning');
        throw error;
      }
    },
  });
}

/* ── Devices renderer ────────────────────────────────────── */

export function renderSyncPeers() {
  const syncPeers = document.getElementById('syncPeers');
  if (!syncPeers) return;
  hideSkeleton('syncPeersSkeleton');
  const peers = state.lastSyncPeers;
  renderSyncPeersList(syncPeers, {
    peers: Array.isArray(peers) ? peers : [],
    onRename: async (peerId, nextName) => {
      try {
        await api.renamePeer(peerId, nextName);
        showGlobalNotice('Device name saved.');
        await _loadSyncData();
      } catch (error) {
        showGlobalNotice(friendlyError(error, 'Failed to save device name.'), 'warning');
        throw error;
      }
    },
    onSync: async (peer, address) => {
      try {
        const result = await api.triggerSync(address);
        const summary = summarizeSyncRunResult(result);
        const peerId = String(peer?.peer_device_id || '');
        if (!summary.ok) {
          showGlobalNotice(summary.message, 'warning');
        } else if (peerId && isPeerScopeReviewPending(peerId)) {
          const displayName = peer?.name || (peerId ? peerId.slice(0, 8) : 'unknown');
          showGlobalNotice(
            `Triggered sync for ${displayName} before scope review was finished. Review scope in this card if you want tighter sharing rules.`,
            'warning',
          );
        } else {
          showGlobalNotice(summary.message);
        }
      } catch (error) {
        showGlobalNotice(friendlyError(error, 'Failed to trigger sync.'), 'warning');
        throw error;
      }
      try {
        await _loadSyncData();
      } catch {
        showGlobalNotice('Sync started, but the local status view did not refresh yet.', 'warning');
      }
      return null;
    },
    onRemove: async (peerId, label) => {
      try {
        await api.deletePeer(peerId);
        showGlobalNotice(`Removed peer ${label}.`);
        await _loadSyncData();
      } catch (error) {
        showGlobalNotice(friendlyError(error, 'Failed to remove peer.'), 'warning');
        throw error;
      }
    },
    onAssignActor: async (peerId, actorId) => {
      try {
        await api.assignPeerActor(peerId, actorId);
        showGlobalNotice(actorId ? 'Device person updated.' : 'Device person cleared.');
        await _loadSyncData();
      } catch (error) {
        showGlobalNotice(friendlyError(error, 'Failed to update device person.'), 'warning');
        throw error;
      }
    },
    onSaveScope: async (peerId, include, exclude) => {
      try {
        await api.updatePeerScope(peerId, include, exclude);
        clearPeerScopeReview(peerId);
        showGlobalNotice('Device sync scope saved.');
        await _loadSyncData();
      } catch (error) {
        showGlobalNotice(friendlyError(error, 'Failed to save device scope.'), 'warning');
        throw error;
      }
    },
    onResetScope: async (peerId) => {
      try {
        await api.updatePeerScope(peerId, null, null, true);
        clearPeerScopeReview(peerId);
        showGlobalNotice('Device sync scope reset to global defaults.');
        await _loadSyncData();
      } catch (error) {
        showGlobalNotice(friendlyError(error, 'Failed to reset device scope.'), 'warning');
        throw error;
      }
    },
  });
}

/* ── Legacy device claims renderer ───────────────────────── */

export function renderLegacyDeviceClaims() {
  const panel = document.getElementById('syncLegacyClaims');
  const mount = document.getElementById('syncLegacyDeviceSelectMount') as HTMLElement | null;
  const meta = document.getElementById('syncLegacyClaimsMeta');
  if (!panel || !mount || !meta) return;

  const devices = Array.isArray(state.lastSyncLegacyDevices) ? state.lastSyncLegacyDevices : [];
  renderLegacyClaimsSlice({
    devices,
    meta,
    mount,
    onValueChange: (value) => {
      if (value === legacyDeviceValue) return;
      legacyDeviceValue = value;
      renderLegacyDeviceClaims();
    },
    panel,
    value: legacyDeviceValue,
  });
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

  syncActorCreateButton?.addEventListener('click', async () => {
    if (!syncActorCreateButton || !syncActorCreateInput) return;
    const displayName = String(syncActorCreateInput.value || '').trim();
    if (!displayName) {
      markFieldError(syncActorCreateInput, 'Enter a name for the person.');
      return;
    }
    clearFieldError(syncActorCreateInput);
    syncActorCreateButton.disabled = true;
    syncActorCreateInput.disabled = true;
    syncActorCreateButton.textContent = 'Creating\u2026';
    try {
      await api.createActor(displayName);
      showGlobalNotice('Person created.');
      syncActorCreateInput.value = '';
      await loadSyncData();
    } catch (error) {
      showGlobalNotice(friendlyError(error, 'Failed to create person.'), 'warning');
      syncActorCreateButton.textContent = 'Retry';
      syncActorCreateButton.disabled = false;
      syncActorCreateInput.disabled = false;
      return;
    }
    syncActorCreateButton.textContent = 'Create person';
    syncActorCreateButton.disabled = false;
    syncActorCreateInput.disabled = false;
  });

  syncLegacyClaimButton?.addEventListener('click', async () => {
    const originDeviceId = String(legacyDeviceValue || '').trim();
    if (!originDeviceId || !syncLegacyClaimButton) return;
    const confirmed = await openSyncConfirmDialog({
      title: `Attach history from ${originDeviceId}?`,
      description: 'This updates legacy provenance so the older device history is attached to you on this device.',
      confirmLabel: 'Attach history',
      cancelLabel: 'Cancel',
      tone: 'danger',
    });
    if (!confirmed) return;
    syncLegacyClaimButton.disabled = true;
    const originalText = syncLegacyClaimButton.textContent || 'Attach device history';
    syncLegacyClaimButton.textContent = 'Attaching\u2026';
    try {
      await api.claimLegacyDeviceIdentity(originDeviceId);
      showGlobalNotice('Old device history attached to you.');
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
