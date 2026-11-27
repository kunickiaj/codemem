/* Team sync card render pipeline. Reads sync state off the global
 * store, derives the TeamSyncPanel props (attention counts, status summary), wires up the per-row action handlers, and
 * re-renders the Radix-backed TeamSyncPanel into the #syncTeamActions
 * mount. Re-render is self-recursive via the invite panel toggle. */

import { h } from "preact";
import * as api from "../../../../lib/api";
import { friendlyError } from "../../../../lib/form";
import { showGlobalNotice } from "../../../../lib/notice";
import { state } from "../../../../lib/state";
import { AdvancedSyncStatus } from "../../components/advanced-sync-status";
import { clearSyncMount, renderIntoSyncMount } from "../../components/render-root";
import { SyncInviteJoinPanels } from "../../components/sync-invite-join-panels";
import { TeamSyncPanel, type TeamSyncPendingJoinRequest } from "../../components/team-sync-panel";
import {
	clearDuplicatePersonDecision,
	hideSkeleton,
	saveDuplicatePersonDecision,
	setTeamInvitePanelOpen,
	teamInvitePanelOpen,
} from "../../helpers";
import { openDuplicatePersonDialog } from "../../sync-dialogs";
import { deriveTeamSyncPrimaryStatus, type UiTeamSyncPrimaryStatus } from "../../view-model";
import { teamSyncState } from "../data/state";
import { deriveDiscoveredRows } from "../discovered-devices";
import { clearContent, pulseAttentionTarget, syncScrollBehavior } from "../helpers/dom";
import {
	applySyncInviteReadinessState,
	ensureJoinPanelInSetupSection,
	renderAdminSetupDisclosure,
	renderInvitePolicySelect,
	setInviteOutputVisibility,
	setJoinFeedbackVisibility,
} from "../helpers/invite-panel-dom";

const TEAM_SYNC_ACTIONS_MOUNT_ID = "syncTeamActionsMount";

export function renderTeamSyncPrimaryStatus(
	badge: HTMLElement,
	meta: HTMLElement,
	primaryStatus: UiTeamSyncPrimaryStatus,
) {
	badge.hidden = false;
	badge.textContent = primaryStatus.badgeLabel;
	meta.textContent = primaryStatus.meta;
	if (primaryStatus.state === "healthy") {
		badge.className = "sync-online-badge";
	} else if (
		primaryStatus.state === "disabled" ||
		primaryStatus.state === "pending-setup" ||
		primaryStatus.state === "not-enrolled" ||
		primaryStatus.state === "reachable"
	) {
		badge.className = "sync-online-badge sync-online-offline";
	} else {
		badge.className = "sync-online-badge sync-online-error";
	}
}

function renderPrimaryActionOnly(actions: HTMLElement, primaryStatus: UiTeamSyncPrimaryStatus) {
	const actionMount = document.createElement("div");
	actionMount.id = TEAM_SYNC_ACTIONS_MOUNT_ID;
	actions.appendChild(actionMount);
	renderIntoSyncMount(
		actionMount,
		h(TeamSyncPanel, {
			actionItems: [],
			actionableCount: 0,
			joinRequestsMount: null,
			onApproveJoinRequest: async () => null,
			onAttentionAction: async () => {},
			onDenyJoinRequest: async () => null,
			pendingJoinRequests: [],
			presenceStatus: "unknown",
			primaryStatus,
		}),
	);
}

function teardownTeamSyncRender(actions: HTMLElement | null, targets: Array<HTMLElement | null>) {
	const mount = document.getElementById(TEAM_SYNC_ACTIONS_MOUNT_ID) as HTMLElement | null;
	if (mount) {
		clearSyncMount(mount);
		mount.remove();
	}
	clearContent(actions);
	targets.forEach((target) => {
		clearContent(target);
	});
}

function renderUnconfiguredSetup(input: {
	actions: HTMLElement;
	setupPanel: HTMLElement;
	primaryStatus: UiTeamSyncPrimaryStatus;
}) {
	const joinPanel = document.getElementById("syncJoinPanel");
	const joinRequests = document.getElementById("syncJoinRequests");
	teardownTeamSyncRender(input.actions, [joinRequests]);
	input.setupPanel.hidden = false;
	if (joinPanel) joinPanel.hidden = false;
	input.actions.hidden = false;
	renderPrimaryActionOnly(input.actions, input.primaryStatus);
	if (joinRequests) joinRequests.hidden = true;
}

export function renderTeamSync() {
	const meta = document.getElementById("syncTeamMeta");
	const setupPanel = document.getElementById("syncSetupPanel");
	const actions = document.getElementById("syncTeamActions");
	if (!meta || !setupPanel || !actions) return;

	renderAdminSetupDisclosure();
	renderInvitePolicySelect();
	setInviteOutputVisibility();
	setJoinFeedbackVisibility();
	applySyncInviteReadinessState();

	const invitePanel = document.getElementById("syncInvitePanel");
	const inviteRestoreParent = document.getElementById("syncAdminSection");
	const joinPanel = document.getElementById("syncJoinPanel");
	const joinRestoreParent = document.getElementById("syncJoinSection");
	const joinRequests = document.getElementById("syncJoinRequests");

	hideSkeleton("syncTeamSkeleton");
	ensureJoinPanelInSetupSection();

	const coordinator = state.lastSyncCoordinator;
	const syncView = currentSyncView();
	renderAdvancedSyncStatus(syncView.primaryStatus);
	const revealManualDeviceIdentityControls = () => {
		const controls = document.getElementById("manualDeviceIdentityControls");
		if (controls instanceof HTMLDetailsElement) controls.open = true;
	};

	const focusAttentionTarget = (item: { kind?: string; deviceId?: string }) => {
		revealManualDeviceIdentityControls();
		if (item.kind === "possible-duplicate-person") {
			const actorList = document.getElementById("syncActorsList");
			if (actorList instanceof HTMLElement) {
				actorList.scrollIntoView({ block: "center", behavior: syncScrollBehavior() });
				pulseAttentionTarget(actorList);
			}
			return;
		}
		const deviceId = String(item.deviceId || "").trim();
		if (!deviceId) return;
		if (item.kind === "name-device" || item.kind === "review-team-device") {
			// Devices names a device and approves a device the team lists.
			window.location.hash = "devices";
			return;
		}
		const peerCard = document.querySelector(`[data-peer-device-id="${CSS.escape(deviceId)}"]`);
		if (peerCard instanceof HTMLElement) {
			peerCard.scrollIntoView({ block: "center", behavior: syncScrollBehavior() });
			pulseAttentionTarget(peerCard);
			return;
		}
	};

	const reviewDuplicatePeople = async (item: { actorIds?: unknown[]; title: string }) => {
		const actorIds = Array.isArray(item.actorIds)
			? item.actorIds.map((value: unknown) => String(value || "").trim()).filter(Boolean)
			: [];
		const actors = (Array.isArray(state.lastSyncActors) ? state.lastSyncActors : []).filter(
			(actor) => actorIds.includes(String(actor?.actor_id || "").trim()),
		);
		if (actors.length < 2) {
			showGlobalNotice(
				"This duplicate review is outdated. Refresh the card and review the remaining people entries.",
				"warning",
			);
			return;
		}
		const result = await openDuplicatePersonDialog({
			title: "Review possible duplicate people",
			summary: item.title.replace(/^Possible duplicate person:\s*/, ""),
			actors: actors.map((actor) => ({
				actorId: String(actor?.actor_id || ""),
				label: String(actor?.display_name || actor?.actor_id || "Unknown person"),
				isLocal: Boolean(actor?.is_local),
			})),
		});
		if (result.action === "different-people") {
			saveDuplicatePersonDecision(actorIds, "different-people");
			showGlobalNotice("Okay. I will keep these people separate on this device.");
			await teamSyncState.loadSyncData();
			return;
		}
		if (result.action !== "merge") return;
		const primary = actors.find((actor) => String(actor?.actor_id || "") === result.primaryActorId);
		const secondary = actors.find(
			(actor) => String(actor?.actor_id || "") === result.secondaryActorId,
		);
		if (!primary?.actor_id || !secondary?.actor_id) {
			showGlobalNotice(
				"Could not determine which people to combine. Refresh People & devices and try the review again.",
				"warning",
			);
			return;
		}
		try {
			await api.mergeActor(String(primary.actor_id), String(secondary.actor_id));
			clearDuplicatePersonDecision(actorIds);
			showGlobalNotice(
				`Combined duplicate people into ${String(primary.display_name || primary.actor_id)}.`,
			);
			await teamSyncState.loadSyncData();
		} catch (error) {
			try {
				await teamSyncState.loadSyncData();
			} catch {}
			showGlobalNotice(friendlyError(error, "Failed to combine these people."), "warning");
		}
	};

	const configured = Boolean(coordinator?.configured);
	meta.title = configured ? String(coordinator.coordinator_url || "").trim() : "";

	const onlineBadge = document.getElementById("syncOnlineBadge");
	if (onlineBadge) {
		renderTeamSyncPrimaryStatus(onlineBadge, meta, syncView.primaryStatus);
	} else {
		meta.textContent = syncView.primaryStatus.meta;
	}

	if (!configured) {
		renderUnconfiguredSetup({
			actions,
			setupPanel,
			primaryStatus: syncView.primaryStatus,
		});
		return;
	}

	setupPanel.hidden = true;
	actions.hidden = false;

	const presenceStatus = String(coordinator.presence_status || "");
	const attentionItems = Array.isArray(syncView.attentionItems) ? syncView.attentionItems : [];

	// Devices lists the team devices to approve, so an approval already sent is not a task here.
	const pendingApprovalDeviceIds = new Set(
		deriveDiscoveredRows()
			.filter((row) => row.approvalState === "approval-pending")
			.map((row) => row.deviceId),
	);
	const visibleAttentionItems = attentionItems.filter(
		(item) => !item.deviceId || !pendingApprovalDeviceIds.has(item.deviceId),
	);

	const pendingJoinRequests: TeamSyncPendingJoinRequest[] = [];
	const actionableCount = visibleAttentionItems.length + pendingJoinRequests.length;
	if (joinRequests) {
		joinRequests.hidden = pendingJoinRequests.length === 0 && !state.syncJoinRequestsFeedback;
	}

	teardownTeamSyncRender(actions, [joinRequests]);
	const actionMount = document.createElement("div");
	actionMount.id = TEAM_SYNC_ACTIONS_MOUNT_ID;
	actions.appendChild(actionMount);

	renderIntoSyncMount(
		actionMount,
		h(TeamSyncPanel, {
			actionItems: visibleAttentionItems,
			actionableCount,
			children: h(SyncInviteJoinPanels, {
				invitePanel,
				invitePanelOpen: teamInvitePanelOpen,
				inviteRestoreParent,
				joinPanel,
				joinRestoreParent,
				onToggleInvitePanel: () => {
					if (!invitePanel) return;
					setTeamInvitePanelOpen(!teamInvitePanelOpen);
					renderTeamSync();
				},
				presenceStatus,
			}),
			joinRequestsMount: joinRequests,
			onApproveJoinRequest: async () => null,
			onAttentionAction: async (item) => {
				if (item.kind === "possible-duplicate-person") {
					await reviewDuplicatePeople(item);
					return;
				}
				focusAttentionTarget(item);
			},
			onDenyJoinRequest: async () => null,
			pendingJoinRequests,
			presenceStatus,
			primaryStatus: syncView.primaryStatus,
		}),
	);
}

function renderAdvancedSyncStatus(primaryStatus: UiTeamSyncPrimaryStatus) {
	const mount = document.getElementById("syncAdvancedStatusMount");
	if (mount) renderIntoSyncMount(mount, h(AdvancedSyncStatus, { status: primaryStatus }));
	const toggle = document.getElementById("syncTurnOnButton");
	if (toggle) {
		toggle.hidden = primaryStatus.state !== "disabled";
	}
	const detail = document.getElementById("syncPrimaryStatusDetail");
	if (detail) detail.textContent = primaryStatus.meta;
}

function currentSyncView() {
	return (
		state.lastSyncViewModel || {
			primaryStatus: deriveTeamSyncPrimaryStatus({
				status: state.lastSyncStatus,
				coordinator: state.lastSyncCoordinator,
				peers: state.lastSyncPeers,
				shareOperations: state.lastShareOperations,
				shareOperationsLoadError: state.shareOperationsLoadError,
			}),
			summary: { connectedDeviceCount: 0, seenOnTeamCount: 0, offlineTeamDeviceCount: 0 },
			duplicatePeople: [],
			attentionItems: [],
		}
	);
}
