/* Sync tab orchestrator — re-exports public API and coordinates sub-modules. */

import * as api from "../../lib/api";
import {
	type CachedSyncCoordinator,
	type DiscoveredDevice,
	isSyncRedactionEnabled,
	state,
} from "../../lib/state";
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
	renderProjectSharingOperations,
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
import { deriveSyncViewModel, type TeamSyncReconciliationState } from "./view-model";

/* ── Re-exports consumed by app.ts ───────────────────────── */

export { renderPairing, renderSyncAttempts, renderSyncStatus } from "./diagnostics";
export { renderSyncPeers } from "./people";

/* ── Data loading ────────────────────────────────────────── */

let lastSyncHash = "";
type SyncStatusResponseLike = {
	status?: Record<string, unknown> | null;
	peers?: Array<{ peer_device_id?: string }>;
	coordinator?: CachedSyncCoordinator | null;
	join_requests?: unknown[];
	sharing_review?: unknown[];
	legacy_shared_review?: Record<string, unknown> | null;
	attempts?: unknown[];
	legacy_devices?: unknown[];
	recipient_policy_reconciliation?: {
		items?: Array<{
			canonicalProjectIdentity?: string;
			state?: TeamSyncReconciliationState;
		}>;
	} | null;
};

type SyncActorListResponseLike = {
	items?: unknown[];
};

type SyncPeerSummaryLike = {
	peer_device_id?: string;
};

function reconcilePendingCoordinatorApprovals(
	coordinator: CachedSyncCoordinator | null | undefined,
): void {
	if (!coordinator) return;
	const coordinatorUrl = String(coordinator?.coordinator_url || "").trim();
	const approvalDataIncomplete = Boolean(
		coordinator.lookup_error || coordinator.reciprocal_approval_error,
	);
	const discoveredDevices = Array.isArray(coordinator?.discovered_devices)
		? coordinator.discovered_devices
		: [];
	const devicesById = new Map<string, DiscoveredDevice[]>();
	for (const device of discoveredDevices) {
		const deviceId = String(device.device_id || "").trim();
		if (!deviceId) continue;
		devicesById.set(deviceId, [...(devicesById.get(deviceId) || []), device]);
	}

	for (const [deviceId, pendingApproval] of state.pendingCoordinatorApprovalsByDeviceId) {
		if (pendingApproval.coordinatorUrl !== coordinatorUrl) {
			state.pendingCoordinatorApprovalsByDeviceId.delete(deviceId);
			continue;
		}
		if (approvalDataIncomplete) continue;
		const observedDevices = devicesById.get(deviceId);
		if (!observedDevices) continue;

		const matchingRequestStillNeedsLocalApproval = observedDevices.some(
			(device) =>
				String(device.incoming_reciprocal_request_id || "").trim() ===
					pendingApproval.incomingRequestId && device.needs_local_approval === true,
		);
		if (!matchingRequestStillNeedsLocalApproval) {
			state.pendingCoordinatorApprovalsByDeviceId.delete(deviceId);
		}
	}
}

function pendingCoordinatorApprovalHashInput(): Array<readonly [string, string, string]> {
	return [...state.pendingCoordinatorApprovalsByDeviceId]
		.map(
			([deviceId, pendingApproval]) =>
				[deviceId, pendingApproval.coordinatorUrl, pendingApproval.incomingRequestId] as const,
		)
		.sort(([leftDeviceId], [rightDeviceId]) => leftDeviceId.localeCompare(rightDeviceId));
}

let cachedSyncStatus: { key: string; expiresAtMs: number; payload: SyncStatusResponseLike } | null =
	null;
let latestSyncLoadRequestId = 0;
let latestSyncLoad: Promise<boolean> | null = null;
let latestPairingLoadRequestId = 0;
let latestPairingLoad: Promise<boolean> | null = null;

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

export interface SyncDataLoadOptions {
	requiredSurface?: "all" | "health" | "devices";
	requireFreshSyncStatus?: boolean;
}

async function fetchSyncStatusPayload(
	project: string,
	options: Required<SyncDataLoadOptions>,
): Promise<{ payload: SyncStatusResponseLike; fetchedFreshSyncStatus: boolean }> {
	const useCache = state.activeTab === "health" && !options.requireFreshSyncStatus;
	if (useCache) {
		const payload = readCachedSyncStatus(project);
		if (payload) return { payload, fetchedFreshSyncStatus: false };
	}

	// Raw diagnostics remain an explicit Advanced-view choice.
	const includeDiagnostics = !isSyncRedactionEnabled();
	const payload = await api.loadSyncStatus(includeDiagnostics, project, {
		includeJoinRequests: false,
	});
	return { payload, fetchedFreshSyncStatus: true };
}

function didRequiredSyncSurfacesRefresh(input: {
	requiredSurface: "all" | "health" | "devices";
	actorLoadError: boolean;
	coordinatorAdminLoadError: boolean;
	shareOperationsLoadError: boolean;
	requiresDeviceIdentityInventory: boolean;
	deviceIdentityInventoryLoadError: boolean;
}): boolean {
	// Health and Devices consume only the primary sync status, which has
	// already loaded by the time this runs; auxiliary surfaces are Advanced-only.
	if (input.requiredSurface !== "all") return true;
	if (input.actorLoadError || input.coordinatorAdminLoadError || input.shareOperationsLoadError) {
		return false;
	}
	return !input.requiresDeviceIdentityInventory || !input.deviceIdentityInventoryLoadError;
}

export function loadSyncData(options: SyncDataLoadOptions = {}): Promise<boolean> {
	const operation = runLoadSyncData(++latestSyncLoadRequestId, {
		requiredSurface: options.requiredSurface ?? "all",
		requireFreshSyncStatus: options.requireFreshSyncStatus ?? false,
	});
	latestSyncLoad = operation;
	return operation;
}

async function runLoadSyncData(
	requestId: number,
	options: Required<SyncDataLoadOptions>,
): Promise<boolean> {
	try {
		const project = state.currentProject || "";
		const { payload, fetchedFreshSyncStatus } = await fetchSyncStatusPayload(project, options);

		let actorsPayload: SyncActorListResponseLike | null = null;
		let coordinatorAdminStatus: Record<string, unknown> | null = null;
		let deviceIdentityInventory = state.lastDeviceIdentityInventory;
		let shareOperations = state.lastShareOperations;
		let actorLoadError = false;
		let coordinatorAdminLoadError = false;
		let deviceIdentityInventoryLoadError = state.deviceIdentityInventoryLoadError;
		let shareOperationsLoadError = false;
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
		if (state.activeTab === "advanced") {
			deviceIdentityInventoryLoadError = false;
			try {
				deviceIdentityInventory = await api.loadDeviceIdentityInventory();
			} catch {
				deviceIdentityInventoryLoadError = true;
			}
		}
		try {
			const sharePayload = await api.loadShareOperations();
			shareOperations = Array.isArray(sharePayload.items) ? sharePayload.items : [];
		} catch {
			shareOperationsLoadError = true;
		}

		if (requestId !== latestSyncLoadRequestId) return latestSyncLoad ?? false;
		const refreshSucceeded = didRequiredSyncSurfacesRefresh({
			requiredSurface: options.requiredSurface,
			actorLoadError,
			coordinatorAdminLoadError,
			shareOperationsLoadError,
			requiresDeviceIdentityInventory: state.activeTab === "advanced",
			deviceIdentityInventoryLoadError,
		});

		if (fetchedFreshSyncStatus) {
			writeCachedSyncStatus(project, normalizeSyncStatusForCache(payload));
		}
		reconcilePendingCoordinatorApprovals(payload.coordinator);

		// Skip re-render if data hasn't changed since last poll
		const hash = JSON.stringify([
			payload,
			actorsPayload,
			coordinatorAdminStatus,
			deviceIdentityInventory,
			deviceIdentityInventoryLoadError,
			shareOperations,
			shareOperationsLoadError,
			duplicatePersonDecisions,
			pendingCoordinatorApprovalHashInput(),
		]);
		if (hash === lastSyncHash) return refreshSucceeded;
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
		if (!deviceIdentityInventoryLoadError) {
			state.lastDeviceIdentityInventory = deviceIdentityInventory;
		}
		state.deviceIdentityInventoryLoadError = deviceIdentityInventoryLoadError;
		state.lastShareOperations = shareOperations;
		state.shareOperationsLoadError = shareOperationsLoadError;
		state.lastSyncSharingReview = payload.sharing_review || [];
		state.lastSyncLegacySharedReview =
			payload.legacy_shared_review && typeof payload.legacy_shared_review === "object"
				? payload.legacy_shared_review
				: null;
		state.lastSyncCoordinator = payload.coordinator || null;
		state.lastSyncCoordinatorAdminStatus =
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
			status: statusPayload,
			shareOperations: state.lastShareOperations,
			shareOperationsLoadError,
			reconciliation: payload.recipient_policy_reconciliation,
			duplicatePersonDecisions: state.lastSyncDuplicatePersonDecisions,
		});
		renderSyncStatus();
		renderTeamSync();
		renderSyncActors();
		renderProjectSharingOperations();
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
			state.lastSyncCoordinatorAdminStatus = null;
			renderTeamSync();
		}
		return refreshSucceeded;
	} catch {
		if (requestId !== latestSyncLoadRequestId) return latestSyncLoad ?? false;
		lastSyncHash = "";
		state.deviceIdentityInventoryLoadError = true;
		// Clear all skeletons so the error state is visible, not masked by loading placeholders
		hideSkeleton("syncTeamSkeleton");
		hideSkeleton("syncActorsSkeleton");
		hideSkeleton("syncPeersSkeleton");
		hideSkeleton("syncDiagSkeleton");
		hideStaleSyncSecondarySections();
		renderSyncPeopleUnavailable();
		renderSyncDiagnosticsUnavailable();
		return false;
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
	latestSyncLoad = null;
	latestPairingLoadRequestId = 0;
	latestPairingLoad = null;
}

async function reloadSyncData(): Promise<void> {
	await loadSyncData();
}

export function loadPairingData(): Promise<boolean> {
	const operation = runLoadPairingData(++latestPairingLoadRequestId);
	latestPairingLoad = operation;
	return operation;
}

async function runLoadPairingData(requestId: number): Promise<boolean> {
	try {
		// Pairing payload is always returned in full — it's the actual
		// command the user shares, not a diagnostic. The "Show pairing
		// command" disclosure in the UI is the user-facing exposure gate.
		const payload = await api.loadPairing();
		if (requestId !== latestPairingLoadRequestId) return latestPairingLoad ?? false;
		state.pairingPayloadRaw = payload || null;
		renderPairing();
		return true;
	} catch {
		if (requestId !== latestPairingLoadRequestId) return latestPairingLoad ?? false;
		state.pairingPayloadRaw = null;
		renderPairing();
		return false;
	}
}

/* ── Init ────────────────────────────────────────────────── */

export function initSyncTab(refreshCallback: () => void) {
	ensureSyncRenderBoundary();
	ensureSyncDialogHost();
	// Wire cross-module callbacks to avoid circular imports
	setTeamSyncLoadData(reloadSyncData);
	setPeopleLoadData(reloadSyncData);
	setRenderSyncPeers(renderSyncPeers);

	initTeamSyncEvents(refreshCallback, reloadSyncData);
	initPeopleEvents(reloadSyncData);
	initDiagnosticsEvents(refreshCallback);

	// Apply the current #sync vs #sync/diagnostics sub-view and keep it in
	// sync with future hash changes. See docs/plans/2026-04-23-sync-tab-redesign.md.
	applySyncSubView();
	ensureSyncSubViewListener();
	// loadSyncData() is NOT called here — app.ts refresh() handles the initial load
	// to avoid duplicate requests and state races at startup.
}
