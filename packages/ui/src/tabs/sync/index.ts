/* Sync tab orchestrator — re-exports public API and coordinates sub-modules. */

import * as api from "../../lib/api";
import { isSyncRedactionEnabled, state } from "../../lib/state";
import { renderHealthOverview } from "../health";
import { ensureSyncRenderBoundary } from "./components/render-root";

import {
	initDiagnosticsEvents,
	renderPairing,
	renderSyncAttempts,
	renderSyncDiagnosticsUnavailable,
	renderSyncStatus,
	setRenderSyncPeers,
} from "./diagnostics";
import { hideSkeleton, readDuplicatePersonDecisions } from "./helpers";
import {
	initPeopleEvents,
	renderLegacyDeviceClaims,
	renderSyncActors,
	renderSyncActorsUnavailable,
	renderSyncPeers,
	renderSyncPeopleUnavailable,
	setLoadSyncData as setPeopleLoadData,
} from "./people";
import { ensureSyncDialogHost } from "./sync-dialogs";
import { applySyncSubView, ensureSyncSubViewListener } from "./sync-view-controller";
import {
	initTeamSyncEvents,
	renderSyncSharingReview,
	renderTeamSync,
	setLoadSyncData as setTeamSyncLoadData,
} from "./team-sync";
import { deriveSyncViewModel } from "./view-model";

/* ── Re-exports consumed by app.ts ───────────────────────── */

export { renderPairing, renderSyncAttempts, renderSyncStatus } from "./diagnostics";
export { renderSyncPeers } from "./people";

/* ── Data loading ────────────────────────────────────────── */

let lastSyncHash = "";
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

let cachedSyncStatus: { key: string; expiresAtMs: number; payload: SyncStatusResponseLike } | null =
	null;
let latestSyncLoadRequestId = 0;

const HEALTH_SYNC_STATUS_CACHE_TTL_MS = 15_000;

function syncStatusCacheKey(project: string): string {
	return `project:${project || ""}|includeJoinRequests:false`;
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
	if (!payload || typeof payload !== "object") return payload;
	return {
		...payload,
		join_requests: [],
	};
}

function hideStaleSyncSecondarySections() {
	const sharingReview = document.getElementById("syncSharingReview");
	const sharingReviewList = document.getElementById("syncSharingReviewList");
	const sharingReviewMeta = document.getElementById("syncSharingReviewMeta");
	const legacyClaims = document.getElementById("syncLegacyClaims");
	const legacyClaimsMeta = document.getElementById("syncLegacyClaimsMeta");
	if (sharingReview) sharingReview.hidden = true;
	if (sharingReviewList) sharingReviewList.textContent = "";
	if (sharingReviewMeta) sharingReviewMeta.textContent = "";
	if (legacyClaims) legacyClaims.hidden = true;
	if (legacyClaimsMeta) legacyClaimsMeta.textContent = "";
}

export async function loadSyncData() {
	const requestId = ++latestSyncLoadRequestId;
	try {
		const project = state.currentProject || "";
		const includeJoinRequests = false;
		const useCache = state.activeTab === "health";
		let fetchedFreshSyncStatus = false;

		// When the Advanced diagnostics "Redact" toggle is OFF the user is
		// opting into raw diagnostics — pass includeDiagnostics=true so the
		// server returns real addresses, pairing payload, and peer errors.
		const includeDiagnostics = !isSyncRedactionEnabled();
		let payload: SyncStatusResponseLike;
		if (useCache) {
			payload = readCachedSyncStatus(project);
			if (!payload) {
				payload = await api.loadSyncStatus(includeDiagnostics, project, {
					includeJoinRequests: false,
				});
				fetchedFreshSyncStatus = true;
			}
		} else {
			payload = await api.loadSyncStatus(includeDiagnostics, project, { includeJoinRequests });
			fetchedFreshSyncStatus = true;
		}

		let actorsPayload: SyncActorListResponseLike | null = null;
		let coordinatorAdminStatus: Record<string, unknown> | null = null;
		let actorLoadError = false;
		let coordinatorAdminLoadError = false;
		const duplicatePersonDecisions = readDuplicatePersonDecisions();
		try {
			actorsPayload = await api.loadSyncActors();
		} catch {
			actorLoadError = true;
		}
		try {
			coordinatorAdminStatus = (await api.loadCoordinatorAdminStatus()) as Record<string, unknown>;
		} catch {
			coordinatorAdminLoadError = true;
		}

		if (requestId !== latestSyncLoadRequestId) return;

		if (fetchedFreshSyncStatus) {
			writeCachedSyncStatus(project, normalizeSyncStatusForCache(payload));
		}

		// Skip re-render if data hasn't changed since last poll
		const hash = JSON.stringify([
			payload,
			actorsPayload,
			coordinatorAdminStatus,
			duplicatePersonDecisions,
		]);
		if (hash === lastSyncHash) return;
		lastSyncHash = hash;

		const statusPayload =
			payload.status && typeof payload.status === "object" ? payload.status : null;
		if (statusPayload) state.lastSyncStatus = statusPayload;
		if (Array.isArray(actorsPayload?.items)) {
			state.lastSyncActors = actorsPayload.items;
		} else {
			state.lastSyncActors = [];
		}
		const payloadPeers = Array.isArray(payload.peers) ? payload.peers : [];
		const realPeerIds = new Set(
			payloadPeers
				.map((peer: SyncPeerSummaryLike) => String(peer?.peer_device_id || "").trim())
				.filter(Boolean),
		);
		const pendingPeers = Array.isArray(state.pendingAcceptedSyncPeers)
			? state.pendingAcceptedSyncPeers.filter((peer: SyncPeerSummaryLike) => {
					const peerId = String(peer?.peer_device_id || "").trim();
					return peerId && !realPeerIds.has(peerId);
				})
			: [];
		state.pendingAcceptedSyncPeers = pendingPeers;
		state.lastSyncPeers = [...payloadPeers, ...pendingPeers];
		state.lastSyncSharingReview = payload.sharing_review || [];
		state.lastSyncCoordinator = payload.coordinator || null;
		state.lastCoordinatorAdminStatus =
			coordinatorAdminStatus && typeof coordinatorAdminStatus === "object"
				? coordinatorAdminStatus
				: null;
		state.lastSyncJoinRequests = Array.isArray(payload.join_requests) ? payload.join_requests : [];
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
			renderSyncActorsUnavailable();
		}
		if (coordinatorAdminLoadError) {
			state.lastCoordinatorAdminStatus = null;
			renderTeamSync();
		}
	} catch {
		if (requestId !== latestSyncLoadRequestId) return;
		lastSyncHash = "";
		// Clear all skeletons so the error state is visible, not masked by loading placeholders
		hideSkeleton("syncTeamSkeleton");
		hideSkeleton("syncActorsSkeleton");
		hideSkeleton("syncPeersSkeleton");
		hideSkeleton("syncDiagSkeleton");
		hideStaleSyncSecondarySections();
		renderSyncPeopleUnavailable();
		renderSyncDiagnosticsUnavailable();
	}
}

/**
 * Called after `/api/projects` resolves (see app.ts loadProjects) so the
 * Sync peer-scope picker rerenders with the freshly-cached project names.
 * Without this, loadSyncData's dedup hash would skip the next render when
 * the underlying sync payload hasn't changed, leaving the scope picker's
 * clickable project list stuck on whatever was cached at first paint.
 */
export function invalidateSyncPeerScopeCache() {
	lastSyncHash = "";
	// Re-render immediately if we already have sync data; otherwise the
	// next loadSyncData tick will hydrate the picker naturally.
	if (state.lastSyncPeers?.length) renderSyncPeers();
}

export function resetSyncLoadStateForTests() {
	lastSyncHash = "";
	cachedSyncStatus = null;
	latestSyncLoadRequestId = 0;
}

export async function loadPairingData() {
	try {
		// Pairing payload is always returned in full — it's the actual
		// command the user shares, not a diagnostic. The "Show pairing
		// command" disclosure in the UI is the user-facing exposure gate.
		const payload = await api.loadPairing();
		state.pairingPayloadRaw = payload || null;
		renderPairing();
	} catch {
		state.pairingPayloadRaw = null;
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

	// Apply the current #sync vs #sync/diagnostics sub-view and keep it in
	// sync with future hash changes. See docs/plans/2026-04-23-sync-tab-redesign.md.
	applySyncSubView();
	ensureSyncSubViewListener();
	// loadSyncData() is NOT called here — app.ts refresh() handles the initial load
	// to avoid duplicate requests and state races at startup.
}
