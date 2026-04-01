/* Sync tab orchestrator — re-exports public API and coordinates sub-modules. */

import * as api from '../../lib/api';
import { state } from '../../lib/state';
import { renderHealthOverview } from '../health';
import { deriveSyncViewModel } from './view-model';

import { renderSyncStatus, renderSyncAttempts, renderPairing, initDiagnosticsEvents, setRenderSyncPeers } from './diagnostics';
import { renderTeamSync, renderSyncSharingReview, initTeamSyncEvents, setLoadSyncData as setTeamSyncLoadData } from './team-sync';
import { renderSyncActors, renderSyncPeers, renderLegacyDeviceClaims, initPeopleEvents, setLoadSyncData as setPeopleLoadData } from './people';
import { ensureSyncRenderBoundary } from './components/render-root';
import { ensureSyncDialogHost } from './sync-dialogs';
import { hideSkeleton, readDuplicatePersonDecisions } from './helpers';

/* ── Re-exports consumed by app.ts ───────────────────────── */

export { renderSyncStatus, renderSyncAttempts, renderPairing } from './diagnostics';
export { renderSyncPeers } from './people';

/* ── Data loading ────────────────────────────────────────── */

let lastSyncHash = '';
type SyncStatusResponseLike = {
  status?: Record<string, unknown> | null;
  peers?: Array<{ peer_device_id?: string }>;
  coordinator?: Record<string, unknown> | null;
  join_requests?: unknown[];
  sharing_review?: unknown[];
  attempts?: unknown[];
  legacy_devices?: unknown[];
};

type SyncActorListResponseLike = {
  items?: unknown[];
};

type SyncPeerSummaryLike = {
  peer_device_id?: string;
};

let cachedSyncStatus: { key: string; expiresAtMs: number; payload: SyncStatusResponseLike } | null = null;
let latestSyncLoadRequestId = 0;

const HEALTH_SYNC_STATUS_CACHE_TTL_MS = 15_000;

function syncStatusCacheKey(project: string): string {
  return `project:${project || ''}|includeJoinRequests:false`;
}

function readCachedSyncStatus(project: string): SyncStatusResponseLike | null {
  const key = syncStatusCacheKey(project);
  if (!cachedSyncStatus) return null;
  if (cachedSyncStatus.key !== key) return null;
  if (Date.now() >= cachedSyncStatus.expiresAtMs) return null;
  return cachedSyncStatus.payload;
}

function writeCachedSyncStatus(project: string, payload: SyncStatusResponseLike): void {
  cachedSyncStatus = {
    key: syncStatusCacheKey(project),
    expiresAtMs: Date.now() + HEALTH_SYNC_STATUS_CACHE_TTL_MS,
    payload,
  };
}

function normalizeSyncStatusForCache(payload: SyncStatusResponseLike): SyncStatusResponseLike {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    join_requests: [],
  };
}

export async function loadSyncData() {
  const requestId = ++latestSyncLoadRequestId;
  try {
    const project = state.currentProject || '';
    const includeJoinRequests = state.activeTab === 'sync';
    const useCache = state.activeTab === 'health';
    let fetchedFreshSyncStatus = false;

    let payload: SyncStatusResponseLike;
    if (useCache) {
      payload = readCachedSyncStatus(project);
      if (!payload) {
        payload = await api.loadSyncStatus(true, project, { includeJoinRequests: false });
        fetchedFreshSyncStatus = true;
      }
    } else {
      payload = await api.loadSyncStatus(true, project, { includeJoinRequests });
      fetchedFreshSyncStatus = true;
    }

    let actorsPayload: SyncActorListResponseLike | null = null;
    let actorLoadError = false;
    const duplicatePersonDecisions = readDuplicatePersonDecisions();
    try {
      actorsPayload = await api.loadSyncActors();
    } catch {
      actorLoadError = true;
    }

    if (requestId !== latestSyncLoadRequestId) return;

    if (fetchedFreshSyncStatus) {
      writeCachedSyncStatus(project, normalizeSyncStatusForCache(payload));
    }

    // Skip re-render if data hasn't changed since last poll
    const hash = JSON.stringify([payload, actorsPayload, duplicatePersonDecisions]);
    if (hash === lastSyncHash) return;
    lastSyncHash = hash;

    const statusPayload =
      payload.status && typeof payload.status === 'object' ? payload.status : null;
    if (statusPayload) state.lastSyncStatus = statusPayload;
    if (Array.isArray(actorsPayload?.items)) {
      state.lastSyncActors = actorsPayload.items;
    } else if (!actorLoadError) {
      state.lastSyncActors = [];
    }
    const payloadPeers = Array.isArray(payload.peers) ? payload.peers : [];
    const realPeerIds = new Set(payloadPeers.map((peer: SyncPeerSummaryLike) => String(peer?.peer_device_id || '').trim()).filter(Boolean));
    const pendingPeers = Array.isArray(state.pendingAcceptedSyncPeers)
      ? state.pendingAcceptedSyncPeers.filter((peer: SyncPeerSummaryLike) => {
          const peerId = String(peer?.peer_device_id || '').trim();
          return peerId && !realPeerIds.has(peerId);
        })
      : [];
    state.pendingAcceptedSyncPeers = pendingPeers;
    state.lastSyncPeers = [...payloadPeers, ...pendingPeers];
    state.lastSyncSharingReview = payload.sharing_review || [];
    state.lastSyncCoordinator = payload.coordinator || null;
    if (Array.isArray(payload.join_requests)) {
      state.lastSyncJoinRequests = payload.join_requests;
    }
    state.lastSyncAttempts = payload.attempts || [];
    state.lastSyncLegacyDevices = payload.legacy_devices || [];
    state.lastSyncDuplicatePersonDecisions = duplicatePersonDecisions;
    state.lastSyncViewModel = deriveSyncViewModel({
      actors: state.lastSyncActors,
      peers: state.lastSyncPeers,
      coordinator: state.lastSyncCoordinator,
      duplicatePersonDecisions: state.lastSyncDuplicatePersonDecisions,
    });
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
          'People controls are temporarily unavailable. Device status and sync health still loaded.';
    }
  } catch {
    if (requestId !== latestSyncLoadRequestId) return;
    // Clear all skeletons so the error state is visible, not masked by loading placeholders
    hideSkeleton('syncTeamSkeleton');
    hideSkeleton('syncActorsSkeleton');
    hideSkeleton('syncPeersSkeleton');
    hideSkeleton('syncDiagSkeleton');
    const syncMeta = document.getElementById('syncMeta');
    if (syncMeta) syncMeta.textContent = 'Sync unavailable';
  }
}

export function resetSyncLoadStateForTests() {
  lastSyncHash = '';
  cachedSyncStatus = null;
  latestSyncLoadRequestId = 0;
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
  ensureSyncRenderBoundary();
  ensureSyncDialogHost();
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
