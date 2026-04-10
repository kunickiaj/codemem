/* People card — people, devices, sharing review, legacy device claims. */

import * as api from "../../lib/api";
import { clearFieldError, friendlyError, markFieldError } from "../../lib/form";
import { showGlobalNotice } from "../../lib/notice";
import { state } from "../../lib/state";
import { renderSyncActorsList } from "./components/sync-actors";
import { renderSyncEmptyState } from "./components/sync-diagnostics";
import type { SyncActionFeedback } from "./components/sync-inline-feedback";
import { renderLegacyClaimsSlice } from "./components/sync-legacy-claims";
import { renderSyncPeersList } from "./components/sync-peers";
import { clearPeerScopeReview, hideSkeleton, isPeerScopeReviewPending } from "./helpers";
import { openSyncConfirmDialog } from "./sync-dialogs";
import {
	deriveVisiblePeopleActors,
	summarizeSyncRunResult,
	type VisiblePeopleResult,
} from "./view-model";

/* ── loadSyncData callback (set by index module) ─────────── */

let _loadSyncData: () => Promise<void> = async () => {};
let legacyDeviceValue = "";

function setPeopleCreateControlsDisabled(disabled: boolean) {
	const createButton = document.getElementById("syncActorCreateButton") as HTMLButtonElement | null;
	const createInput = document.getElementById("syncActorCreateInput") as HTMLInputElement | null;
	if (createButton) createButton.disabled = disabled;
	if (createInput) createInput.disabled = disabled;
}

export function setLoadSyncData(fn: () => Promise<void>) {
	_loadSyncData = fn;
}

/* ── Actors renderer ─────────────────────────────────────── */

export function renderSyncActors() {
	const actorList = document.getElementById("syncActorsList");
	const actorMeta = document.getElementById("syncActorsMeta");
	if (!actorList) return;
	hideSkeleton("syncActorsSkeleton");
	setPeopleCreateControlsDisabled(false);

	const actorVisibility: VisiblePeopleResult = deriveVisiblePeopleActors({
		actors: state.lastSyncActors,
		peers: state.lastSyncPeers,
		duplicatePeople: state.lastSyncViewModel?.duplicatePeople,
	});
	const actors = actorVisibility.visibleActors;
	if (actorMeta) {
		actorMeta.textContent = actors.length
			? "Manage people here, then assign devices below."
			: "No named people yet. Create a person here, then assign devices below so sync ownership is easier to review.";
		if (actorVisibility.hiddenLocalDuplicateCount > 0) {
			actorMeta.textContent += ` ${actorVisibility.hiddenLocalDuplicateCount} unresolved duplicate ${actorVisibility.hiddenLocalDuplicateCount === 1 ? "entry is" : "entries are"} hidden here until reviewed in Needs attention.`;
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
				showGlobalNotice("People combined. Assigned devices moved to the selected person.");
				await _loadSyncData();
			} catch (error) {
				showGlobalNotice(friendlyError(error, "Failed to combine people."), "warning");
				throw error;
			}
		},
		onDeactivate: async (actorId) => {
			try {
				await api.deactivateActor(actorId);
				showGlobalNotice("Person removed. Assigned devices have been unassigned.");
				await _loadSyncData();
			} catch (error) {
				showGlobalNotice(friendlyError(error, "Failed to remove person."), "warning");
				throw error;
			}
		},
	});
}

export function renderSyncActorsUnavailable() {
	const actorList = document.getElementById("syncActorsList");
	const actorMeta = document.getElementById("syncActorsMeta");
	setPeopleCreateControlsDisabled(true);
	if (actorMeta) {
		actorMeta.textContent =
			"People controls are temporarily unavailable. Refresh this page to retry, but device status and sync health are still available below.";
	}
	if (actorList) {
		renderSyncEmptyState(actorList, {
			title: "People unavailable right now.",
			detail:
				"Refresh this page to reload named people once the people endpoint is responding again.",
		});
	}
}

/* ── Devices renderer ────────────────────────────────────── */

export function renderSyncPeers() {
	const syncPeers = document.getElementById("syncPeers");
	if (!syncPeers) return;
	hideSkeleton("syncPeersSkeleton");
	const peers = state.lastSyncPeers;
	renderSyncPeersList(syncPeers, {
		peers: Array.isArray(peers) ? peers : [],
		onRename: async (peerId, nextName) => {
			try {
				await api.renamePeer(peerId, nextName);
				await _loadSyncData();
				return { message: "Device name saved.", tone: "success" } satisfies SyncActionFeedback;
			} catch (error) {
				return {
					message: friendlyError(error, "Failed to save device name."),
					tone: "warning",
				} satisfies SyncActionFeedback;
			}
		},
		onSync: async (peer, address) => {
			try {
				const result = await api.triggerSync(address);
				const summary = summarizeSyncRunResult(result);
				const peerId = String(peer?.peer_device_id || "");
				let feedback: SyncActionFeedback | null;
				if (!summary.ok) {
					feedback = { message: summary.message, tone: "warning" };
				} else if (peerId && isPeerScopeReviewPending(peerId)) {
					const displayName = peer?.name || (peerId ? peerId.slice(0, 8) : "unknown");
					feedback = {
						message: `Triggered sync for ${displayName}. Review scope in this card if you want tighter sharing rules.`,
						tone: "warning",
					};
				} else {
					feedback = { message: summary.message, tone: "success" };
				}
				try {
					await _loadSyncData();
				} catch {
					feedback = {
						message:
							"Sync started, but this view has not refreshed yet. Refresh the page or use Sync now again before retrying.",
						tone: "warning",
					};
				}
				return feedback;
			} catch (error) {
				return {
					message: friendlyError(error, "Failed to trigger sync."),
					tone: "warning",
				} satisfies SyncActionFeedback;
			}
		},
		onRemove: async (peerId, label) => {
			try {
				await api.deletePeer(peerId);
				const feedback = {
					message: `Removed peer ${label}.`,
					tone: "success",
				} satisfies SyncActionFeedback;
				state.syncPeerFeedbackById.delete(peerId);
				state.syncPeersSectionFeedback = feedback;
				await _loadSyncData();
				return feedback;
			} catch (error) {
				return {
					message: friendlyError(
						error,
						"Failed to remove peer. The local peer entry is still here.",
					),
					tone: "warning",
				} satisfies SyncActionFeedback;
			}
		},
		onAssignActor: async (peerId, actorId) => {
			try {
				await api.assignPeerActor(peerId, actorId);
				await _loadSyncData();
				return {
					message: actorId ? "Device person updated." : "Device person cleared.",
					tone: "success",
				} satisfies SyncActionFeedback;
			} catch (error) {
				return {
					message: friendlyError(
						error,
						"Failed to update device person. The current assignment is unchanged.",
					),
					tone: "warning",
				} satisfies SyncActionFeedback;
			}
		},
		onSaveScope: async (peerId, include, exclude) => {
			try {
				await api.updatePeerScope(peerId, include, exclude);
				clearPeerScopeReview(peerId);
				await _loadSyncData();
				return {
					message: "Device sync scope saved.",
					tone: "success",
				} satisfies SyncActionFeedback;
			} catch (error) {
				return {
					message: friendlyError(
						error,
						"Failed to save device scope. The current sharing rules are still active.",
					),
					tone: "warning",
				} satisfies SyncActionFeedback;
			}
		},
		onResetScope: async (peerId) => {
			try {
				await api.updatePeerScope(peerId, null, null, true);
				clearPeerScopeReview(peerId);
				await _loadSyncData();
				return {
					message: "Device sync scope reset to global defaults.",
					tone: "success",
				} satisfies SyncActionFeedback;
			} catch (error) {
				return {
					message: friendlyError(
						error,
						"Failed to reset device scope. The current sharing rules are still active.",
					),
					tone: "warning",
				} satisfies SyncActionFeedback;
			}
		},
	});
}

export function renderSyncPeopleUnavailable() {
	const actorList = document.getElementById("syncActorsList");
	const actorMeta = document.getElementById("syncActorsMeta");
	const syncPeers = document.getElementById("syncPeers");
	setPeopleCreateControlsDisabled(true);
	if (actorMeta) {
		actorMeta.textContent =
			"People and device details are unavailable right now. Refresh this page to retry once local sync status is reachable again.";
	}
	if (actorList) {
		renderSyncEmptyState(actorList, {
			title: "People unavailable right now.",
			detail:
				"Refresh this page to reload named people once the local sync status endpoint is responding again.",
		});
	}
	if (syncPeers) {
		renderSyncEmptyState(syncPeers, {
			title: "Devices unavailable right now.",
			detail:
				"Refresh this page to reload paired devices. When sync is reachable again, you can rename, assign, or pair devices here.",
		});
	}
}

/* ── Legacy device claims renderer ───────────────────────── */

export function renderLegacyDeviceClaims() {
	const panel = document.getElementById("syncLegacyClaims");
	const mount = document.getElementById("syncLegacyDeviceSelectMount") as HTMLElement | null;
	const meta = document.getElementById("syncLegacyClaimsMeta");
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
		"syncActorCreateButton",
	) as HTMLButtonElement | null;
	const syncActorCreateInput = document.getElementById(
		"syncActorCreateInput",
	) as HTMLInputElement | null;
	const syncLegacyClaimButton = document.getElementById(
		"syncLegacyClaimButton",
	) as HTMLButtonElement | null;

	syncActorCreateButton?.addEventListener("click", async () => {
		if (!syncActorCreateButton || !syncActorCreateInput) return;
		const displayName = String(syncActorCreateInput.value || "").trim();
		if (!displayName) {
			markFieldError(syncActorCreateInput, "Enter a name for the person.");
			return;
		}
		clearFieldError(syncActorCreateInput);
		syncActorCreateButton.disabled = true;
		syncActorCreateInput.disabled = true;
		syncActorCreateButton.textContent = "Creating\u2026";
		try {
			await api.createActor(displayName);
			showGlobalNotice("Person created.");
			syncActorCreateInput.value = "";
			await loadSyncData();
		} catch (error) {
			showGlobalNotice(friendlyError(error, "Failed to create person."), "warning");
			syncActorCreateButton.textContent = "Retry";
			syncActorCreateButton.disabled = false;
			syncActorCreateInput.disabled = false;
			return;
		}
		syncActorCreateButton.textContent = "Create person";
		syncActorCreateButton.disabled = false;
		syncActorCreateInput.disabled = false;
	});

	syncLegacyClaimButton?.addEventListener("click", async () => {
		const originDeviceId = String(legacyDeviceValue || "").trim();
		if (!originDeviceId || !syncLegacyClaimButton) return;
		const confirmed = await openSyncConfirmDialog({
			title: `Attach history from ${originDeviceId}?`,
			description:
				"This updates legacy provenance so the older device history is attached to you on this device.",
			confirmLabel: "Attach history",
			cancelLabel: "Cancel",
			tone: "danger",
		});
		if (!confirmed) return;
		syncLegacyClaimButton.disabled = true;
		const originalText = syncLegacyClaimButton.textContent || "Attach device history";
		syncLegacyClaimButton.textContent = "Attaching\u2026";
		try {
			await api.claimLegacyDeviceIdentity(originDeviceId);
			showGlobalNotice("Old device history attached to you.");
			await loadSyncData();
		} catch (error) {
			showGlobalNotice(friendlyError(error, "Failed to attach old device history."), "warning");
			syncLegacyClaimButton.textContent = "Retry";
			syncLegacyClaimButton.disabled = false;
			return;
		}
		syncLegacyClaimButton.textContent = originalText;
		syncLegacyClaimButton.disabled = false;
	});
}
