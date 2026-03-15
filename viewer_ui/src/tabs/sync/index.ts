/* Sync tab orchestrator — re-exports public API and coordinates sub-modules. */

import * as api from '../../lib/api';
import { state } from '../../lib/state';
import { renderHealthOverview } from '../health';

import { renderSyncStatus, renderSyncAttempts, renderPairing, initDiagnosticsEvents, setRenderSyncPeers } from './diagnostics';
import { renderTeamSync, renderSyncSharingReview, initTeamSyncEvents, setLoadSyncData as setTeamSyncLoadData } from './team-sync';
import { renderSyncActors, renderSyncPeers, renderLegacyDeviceClaims, initPeopleEvents, setLoadSyncData as setPeopleLoadData } from './people';
import { hideSkeleton } from './helpers';

/* ── Re-exports consumed by app.ts ───────────────────────── */

export { renderSyncStatus, renderSyncAttempts, renderPairing } from './diagnostics';
export { renderSyncPeers } from './people';

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
    const statusPayload =
      payload.status && typeof payload.status === 'object' ? payload.status : null;
    if (statusPayload) state.lastSyncStatus = statusPayload;
    state.lastSyncActors = Array.isArray(actorsPayload?.items) ? actorsPayload.items : [];
    state.lastSyncPeers = payload.peers || [];
    state.lastSyncSharingReview = payload.sharing_review || [];
    state.lastSyncCoordinator = payload.coordinator || null;
    state.lastSyncJoinRequests = payload.join_requests || [];
    state.lastSyncAttempts = payload.attempts || [];
    state.lastSyncLegacyDevices = payload.legacy_devices || [];
    renderSyncStatus();
    renderTeamSync();
    renderSyncActors();
    renderSyncSharingReview();
    renderSyncPeers();
    renderLegacyDeviceClaims();
    renderSyncAttempts();
    // Re-render health indicators since they consume sync state (health dot, etc.)
    renderHealthOverview();
    if (actorLoadError) {
      const actorMeta = document.getElementById('syncActorsMeta');
      if (actorMeta)
        actorMeta.textContent =
          'Actor controls are temporarily unavailable. Peer status and sync health still loaded.';
    }
  } catch {
    // Clear all skeletons so the error state is visible, not masked by loading placeholders
    hideSkeleton('syncTeamSkeleton');
    hideSkeleton('syncActorsSkeleton');
    hideSkeleton('syncPeersSkeleton');
    hideSkeleton('syncDiagSkeleton');
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
  // Wire cross-module callbacks to avoid circular imports
  setTeamSyncLoadData(loadSyncData);
  setPeopleLoadData(loadSyncData);
  setRenderSyncPeers(renderSyncPeers);

  initTeamSyncEvents(refreshCallback, loadSyncData);
  initPeopleEvents(loadSyncData);
  initDiagnosticsEvents(refreshCallback);
  // loadSyncData() is NOT called here — app.ts refresh() handles the initial load
  // to avoid duplicate requests and state races at startup.
}
