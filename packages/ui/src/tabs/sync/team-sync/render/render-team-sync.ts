/* Team sync card render pipeline. Reads sync state off the global
 * store, derives the TeamSyncPanel props (discovered rows, attention
 * counts, status summary), wires up the per-row action handlers, and
 * re-renders the Radix-backed TeamSyncPanel into the #syncTeamActions
 * mount. Re-render is self-recursive via the invite panel toggle. */

import { h } from "preact";
import * as api from "../../../../lib/api";
import { friendlyError } from "../../../../lib/form";
import { showGlobalNotice } from "../../../../lib/notice";
import { isSyncRedactionEnabled, state } from "../../../../lib/state";
import { clearSyncMount, renderIntoSyncMount } from "../../components/render-root";
import type { SyncActionFeedback } from "../../components/sync-inline-feedback";
import { SyncInviteJoinPanels } from "../../components/sync-invite-join-panels";
import {
	type TeamSyncDiscoveredRow,
	TeamSyncPanel,
	type TeamSyncPendingJoinRequest,
} from "../../components/team-sync-panel";
import {
	clearDuplicatePersonDecision,
	hideSkeleton,
	isPeerScopeReviewPending,
	redactAddress,
	requestPeerScopeReview,
	saveDuplicatePersonDecision,
	setTeamInvitePanelOpen,
	setTeamJoinPanelOpen,
	teamInvitePanelOpen,
	teamJoinPanelOpen,
} from "../../helpers";
import {
	openDuplicatePersonDialog,
	openSyncConfirmDialog,
	openSyncInputDialog,
} from "../../sync-dialogs";
import {
	deriveCoordinatorApprovalSummary,
	resolveFriendlyDeviceName,
	SYNC_TERMINOLOGY,
	shouldShowCoordinatorReviewAction,
} from "../../view-model";
import { teamSyncState } from "../data/state";
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

// Top-of-card online badge. Hidden when the coordinator isn't configured yet,
// otherwise mirrors the coordinator presence_status so operators can see at a
// glance whether this device is reaching the coordinator.
function updateSyncOnlineBadge(badge: HTMLElement, configured: boolean, presenceStatus: string) {
	if (!configured) {
		badge.hidden = true;
		badge.textContent = "";
		badge.className = "sync-online-badge";
		return;
	}
	badge.hidden = false;
	if (presenceStatus === "posted") {
		badge.className = "sync-online-badge";
		badge.textContent = "Online";
	} else if (presenceStatus === "not_enrolled") {
		badge.className = "sync-online-badge sync-online-offline";
		badge.textContent = "Not enrolled";
	} else {
		badge.className = "sync-online-badge sync-online-error";
		badge.textContent = "Offline";
	}
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
	const discoveredPanel = document.getElementById("syncCoordinatorDiscovered");
	const discoveredMeta = document.getElementById("syncCoordinatorDiscoveredMeta");
	const discoveredList = document.getElementById("syncCoordinatorDiscoveredList");

	hideSkeleton("syncTeamSkeleton");
	ensureJoinPanelInSetupSection();

	const coordinator = state.lastSyncCoordinator;
	const syncView = state.lastSyncViewModel || {
		summary: { connectedDeviceCount: 0, seenOnTeamCount: 0, offlineTeamDeviceCount: 0 },
		duplicatePeople: [],
		attentionItems: [],
	};

	const focusAttentionTarget = (item: { kind?: string; deviceId?: string }) => {
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
		if (item.kind === "name-device") {
			const renameInput = document.querySelector(
				`[data-device-name-input="${CSS.escape(deviceId)}"]`,
			);
			if (renameInput instanceof HTMLInputElement) {
				renameInput.scrollIntoView({ block: "center", behavior: syncScrollBehavior() });
				renameInput.focus();
				renameInput.select();
				pulseAttentionTarget(renameInput);
				return;
			}
		}
		const peerCard = document.querySelector(`[data-peer-device-id="${CSS.escape(deviceId)}"]`);
		if (peerCard instanceof HTMLElement) {
			peerCard.scrollIntoView({ block: "center", behavior: syncScrollBehavior() });
			pulseAttentionTarget(peerCard);
			return;
		}
		const discoveredRow = document.querySelector(
			`[data-discovered-device-id="${CSS.escape(deviceId)}"]`,
		);
		if (discoveredRow instanceof HTMLElement) {
			discoveredRow.scrollIntoView({ block: "center", behavior: syncScrollBehavior() });
			pulseAttentionTarget(discoveredRow);
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

	const reviewDiscoveredDeviceName = async (suggestedName: string) => {
		return await openSyncInputDialog({
			title: "Pair with this device",
			description: "Choose a friendly name for this device before pairing it on this machine.",
			initialValue: suggestedName,
			placeholder: "Desk Mini",
			confirmLabel: "Pair",
			cancelLabel: "Cancel",
			validate: (nextValue) =>
				nextValue.trim() ? null : "Enter a device name to pair this device.",
		});
	};

	const configured = Boolean(coordinator?.configured);
	meta.textContent = configured
		? `Team: ${(coordinator.groups || []).join(", ") || "none"}`
		: "Start by joining an existing team or creating one, then connect people and devices.";
	meta.title = configured ? String(coordinator.coordinator_url || "").trim() : "";

	const onlineBadge = document.getElementById("syncOnlineBadge");
	if (onlineBadge) {
		updateSyncOnlineBadge(onlineBadge, configured, String(coordinator?.presence_status || ""));
	}

	if (!configured) {
		teardownTeamSyncRender(actions, [joinRequests, discoveredList]);
		setupPanel.hidden = false;
		actions.hidden = true;
		if (joinRequests) joinRequests.hidden = true;
		if (discoveredPanel) discoveredPanel.hidden = true;
		return;
	}

	setupPanel.hidden = true;
	actions.hidden = false;

	const presenceStatus = String(coordinator.presence_status || "");
	const localPeers = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers : [];
	const attentionItems = Array.isArray(syncView.attentionItems) ? syncView.attentionItems : [];

	const discoveredDevices = Array.isArray(coordinator.discovered_devices)
		? coordinator.discovered_devices
		: [];
	const discoveredRows: TeamSyncDiscoveredRow[] = discoveredDevices.map((device) => {
		const deviceId = String(device.device_id || "").trim();
		const rawCoordinatorName = String(device.display_name || "").trim();
		const displayName =
			resolveFriendlyDeviceName({ coordinatorName: rawCoordinatorName, deviceId }) ||
			"Discovered device";
		const displayTitle = deviceId && displayName !== deviceId ? deviceId : null;
		const fingerprint = String(device.fingerprint || "").trim();
		const groupIds = Array.isArray(device.groups)
			? device.groups.map((value) => String(value || "").trim()).filter(Boolean)
			: [];
		const hasAmbiguousCoordinatorGroup = groupIds.length > 1;
		const pairedPeer = localPeers.find((peer) => String(peer?.peer_device_id || "") === deviceId);
		const approvalSummary = deriveCoordinatorApprovalSummary({
			device,
			pairedLocally: Boolean(pairedPeer),
		});
		const pairedFingerprint = String(pairedPeer?.fingerprint || "").trim();
		const hasConflict =
			Boolean(pairedPeer) &&
			Boolean(fingerprint) &&
			Boolean(pairedFingerprint) &&
			pairedFingerprint !== fingerprint;
		const canAccept = shouldShowCoordinatorReviewAction({
			device,
			hasAmbiguousCoordinatorGroup,
			pairedLocally: Boolean(pairedPeer),
		});
		const addresses = Array.isArray(device.addresses) ? device.addresses : [];
		const addressLabel = addresses.length
			? addresses
					.map((address) =>
						isSyncRedactionEnabled() ? redactAddress(String(address || "")) : String(address || ""),
					)
					.filter(Boolean)
					.join(" · ")
			: "No fresh addresses";
		const noteParts = [addressLabel];
		if (!addresses.length && displayTitle) noteParts.push(`device id: ${deviceId}`);
		let actionMessage: string | null = null;
		let mode: TeamSyncDiscoveredRow["mode"] = canAccept ? "accept" : "none";
		let pairedMessage: string | null = null;

		if (hasConflict) {
			mode = "conflict";
		} else if (hasAmbiguousCoordinatorGroup) {
			actionMessage =
				"This device appears in multiple coordinator groups. Review team setup first or ask an admin to clean up the duplicate enrollment before approving it here.";
			mode = "ambiguous";
		} else if (pairedPeer && isPeerScopeReviewPending(deviceId)) {
			actionMessage = `Finish this device's scope review in People & devices before you sync it.`;
			mode = "scope-pending";
		} else if (pairedPeer?.last_error) {
			noteParts.push(`error: ${String(pairedPeer.last_error)}`);
			if (!canAccept) mode = "paired";
		} else if (pairedPeer?.status?.peer_state) {
			noteParts.push(`status: ${String(pairedPeer.status.peer_state)}`);
			if (!canAccept) mode = "paired";
		} else if (!pairedPeer && device.stale) {
			actionMessage =
				"Wait for a fresh coordinator presence update, then review this device again here.";
			mode = "stale";
		} else if (pairedPeer && !canAccept) {
			mode = "paired";
		}
		if (mode === "paired") {
			pairedMessage =
				approvalSummary.state === "waiting-for-other-device"
					? approvalSummary.description || "Waiting on the other device."
					: String(pairedPeer?.last_error || "")
								.toLowerCase()
								.includes("401") &&
							String(pairedPeer?.last_error || "")
								.toLowerCase()
								.includes("unauthorized")
						? "Waiting for the other device to trust this one before sync can work."
						: null;
		}

		return {
			actionMessage,
			// Unpaired team devices get the direct "Pair with this device"
			// affordance. Devices that already need explicit approval keep
			// their approval-specific label (e.g. "Approve on this device").
			actionLabel:
				approvalSummary.actionLabel || (pairedPeer ? "Review device" : "Pair with this device"),
			approvalBadgeLabel: approvalSummary.badgeLabel,
			availabilityLabel: device.stale ? "Offline" : "Available",
			connectionLabel: hasConflict
				? SYNC_TERMINOLOGY.conflicts
				: pairedPeer
					? SYNC_TERMINOLOGY.pairedLocally
					: "Not connected on this device",
			deviceId,
			displayName,
			displayTitle,
			fingerprint,
			mode,
			note: noteParts.join(" · "),
			pairedMessage,
		};
	});

	const pendingJoinRequests: TeamSyncPendingJoinRequest[] = [];
	const visibleDiscoveredRows = discoveredRows.filter(
		(row) => row.mode !== "paired" && row.mode !== "none" && row.mode !== "scope-pending",
	);
	// Count actionable items from the unfiltered list so scope-pending devices
	// still contribute to the attention count even though they are hidden from
	// the discovered section (they already appear in the devices section).
	const discoveredActionableCount = discoveredRows.filter(
		(row) => row.mode === "accept" || row.mode === "scope-pending",
	).length;
	const actionableCount =
		attentionItems.length + pendingJoinRequests.length + discoveredActionableCount;
	const teamLabel = (coordinator.groups || []).join(", ") || "none";
	meta.textContent =
		presenceStatus === "posted"
			? actionableCount > 0
				? `Team: ${teamLabel}. Start with the next step below, then scan the current team status.`
				: `Team: ${teamLabel}. Team status and device details are below.`
			: presenceStatus === "not_enrolled"
				? `Team: ${teamLabel}. Enroll this device first, then return here to review the rest of the team.`
				: `Team: ${teamLabel}. Fix the current sync issue first, then use the rest of this card to verify the team state.`;

	if (discoveredPanel) {
		discoveredPanel.hidden = visibleDiscoveredRows.length === 0 && !state.syncDiscoveredFeedback;
	}
	if (discoveredMeta) {
		discoveredMeta.textContent = visibleDiscoveredRows.length
			? "Pair with a teammate's device to see it appear in People & devices and start syncing."
			: "";
	}
	if (joinRequests) {
		joinRequests.hidden = pendingJoinRequests.length === 0 && !state.syncJoinRequestsFeedback;
	}

	teardownTeamSyncRender(actions, [joinRequests, discoveredList]);
	const actionMount = document.createElement("div");
	actionMount.id = TEAM_SYNC_ACTIONS_MOUNT_ID;
	actions.appendChild(actionMount);

	renderIntoSyncMount(
		actionMount,
		h(TeamSyncPanel, {
			actionItems: attentionItems,
			actionableCount,
			children: h(SyncInviteJoinPanels, {
				invitePanel,
				invitePanelOpen: teamInvitePanelOpen,
				inviteRestoreParent,
				joinPanel,
				joinPanelOpen: teamJoinPanelOpen,
				joinRestoreParent,
				onToggleInvitePanel: () => {
					if (!invitePanel) return;
					setTeamInvitePanelOpen(!teamInvitePanelOpen);
					renderTeamSync();
				},
				onToggleJoinPanel: () => {
					if (!joinPanel) return;
					setTeamJoinPanelOpen(!teamJoinPanelOpen);
					renderTeamSync();
				},
				pairedPeerCount: Number(coordinator.paired_peer_count || 0),
				presenceStatus,
			}),
			discoveredListMount: discoveredList,
			discoveredRows: visibleDiscoveredRows,
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
			onInspectConflict: (row) => {
				const peerCard = document.querySelector(
					`[data-peer-device-id="${CSS.escape(row.deviceId)}"]`,
				);
				if (peerCard instanceof HTMLElement) {
					peerCard.scrollIntoView({ block: "center", behavior: syncScrollBehavior() });
					showGlobalNotice(
						`Opened the conflicting local device record for ${row.displayName}.`,
						"warning",
					);
					return;
				}
				showGlobalNotice(
					"The conflicting local device record is not visible yet. Scroll to People & devices and try again.",
					"warning",
				);
			},
			onRemoveConflict: async (row) => {
				const confirmed = await openSyncConfirmDialog({
					title: `Remove ${row.displayName}?`,
					description:
						"This deletes the broken local device record. You can review this device again after the screen refreshes.",
					confirmLabel: "Remove device record",
					cancelLabel: "Keep device record",
					tone: "danger",
				});
				if (!confirmed) return null;
				try {
					await api.deletePeer(row.deviceId);
					const feedback = {
						message: `Removed the broken local device record for ${row.displayName}. If it is still available, review it again from Next steps or Devices seen on team.`,
						tone: "success",
					} satisfies SyncActionFeedback;
					state.syncDiscoveredFeedback = feedback;
					await teamSyncState.loadSyncData();
					return feedback;
				} catch (error) {
					return {
						message: friendlyError(
							error,
							"Failed to remove the broken local device record. The old local record is still present in People & devices.",
						),
						tone: "warning",
					} satisfies SyncActionFeedback;
				}
			},
			onReviewDiscoveredDevice: async (row) => {
				try {
					const reviewedName = await reviewDiscoveredDeviceName(row.displayName);
					if (!reviewedName) return null;
					const result = await api.acceptDiscoveredPeer(row.deviceId, row.fingerprint);
					const optimisticName =
						String(result?.name || row.displayName || "").trim() || row.displayName;
					const pendingPeers = Array.isArray(state.pendingAcceptedSyncPeers)
						? state.pendingAcceptedSyncPeers.filter(
								(peer) => String(peer?.peer_device_id || "").trim() !== row.deviceId,
							)
						: [];
					state.pendingAcceptedSyncPeers = [
						...pendingPeers,
						{
							peer_device_id: row.deviceId,
							name: optimisticName,
							fingerprint: row.fingerprint,
							addresses: [],
							claimed_local_actor: false,
							status: { peer_state: "degraded" },
							last_error: "Waiting for the other device to approve this one.",
						},
					];
					requestPeerScopeReview(row.deviceId);
					let feedback: SyncActionFeedback = {
						message:
							row.approvalBadgeLabel === "Needs your approval"
								? `Approved ${row.displayName} on this device. Two-way trust should be ready once both devices refresh.`
								: `Step 1 complete on this device for ${row.displayName}. Finish onboarding on the other device so both sides trust each other for sync.`,
						tone: "success",
					};
					try {
						if (reviewedName.trim() !== optimisticName.trim()) {
							await api.renamePeer(row.deviceId, reviewedName.trim());
							state.pendingAcceptedSyncPeers = state.pendingAcceptedSyncPeers.map((peer) =>
								String(peer?.peer_device_id || "").trim() === row.deviceId
									? { ...peer, name: reviewedName.trim() }
									: peer,
							);
							feedback = {
								message: `Connected ${reviewedName.trim()} and saved its name.`,
								tone: "success",
							};
						}
					} catch (error) {
						feedback = {
							message: friendlyError(error, "Device connected, but naming did not finish."),
							tone: "warning",
						};
					}
					state.syncDiscoveredFeedback = feedback;
					try {
						await teamSyncState.loadSyncData();
					} catch (error) {
						feedback = {
							message: friendlyError(
								error,
								"Device connected, but the screen did not refresh yet. Refresh this page before trying the next step.",
							),
							tone: "warning",
						};
						state.syncDiscoveredFeedback = feedback;
					}
					return feedback;
				} catch (error) {
					return {
						message: friendlyError(
							error,
							"Failed to review this device. Wait for a fresh presence update and try again.",
						),
						tone: "warning",
					} satisfies SyncActionFeedback;
				}
			},
			pendingJoinRequests,
			presenceStatus,
		}),
	);
}
