/* Team sync card — coordinator onboarding, invites, join requests. */

import { h } from "preact";
import { RadixSelect, type RadixSelectOption } from "../../components/primitives/radix-select";
import * as api from "../../lib/api";
import { clearFieldError, friendlyError, markFieldError } from "../../lib/form";
import { showGlobalNotice } from "../../lib/notice";
import { isSyncRedactionEnabled, setFeedScopeFilter, state } from "../../lib/state";
import { clearSyncMount, renderIntoSyncMount } from "./components/render-root";
import { renderTeamSetupDisclosure } from "./components/sync-disclosure";
import type { SyncActionFeedback } from "./components/sync-inline-feedback";
import { SyncInviteJoinPanels } from "./components/sync-invite-join-panels";
import { SyncSharingReview, type SyncSharingReviewItem } from "./components/sync-sharing-review";
import {
	type TeamSyncDiscoveredRow,
	TeamSyncPanel,
	type TeamSyncPendingJoinRequest,
	type TeamSyncStatusSummary,
} from "./components/team-sync-panel";
import {
	adminSetupExpanded,
	clearDuplicatePersonDecision,
	hideSkeleton,
	isPeerScopeReviewPending,
	redactAddress,
	requestPeerScopeReview,
	saveDuplicatePersonDecision,
	setAdminSetupExpanded,
	setTeamInvitePanelOpen,
	teamInvitePanelOpen,
} from "./helpers";
import {
	openDuplicatePersonDialog,
	openSyncConfirmDialog,
	openSyncInputDialog,
} from "./sync-dialogs";
import {
	deriveCoordinatorApprovalSummary,
	resolveFriendlyDeviceName,
	SYNC_TERMINOLOGY,
	summarizeSyncRunResult,
} from "./view-model";

const TEAM_SYNC_ACTIONS_MOUNT_ID = "syncTeamActionsMount";
const INVITE_POLICY_OPTIONS: RadixSelectOption[] = [
	{ value: "auto_admit", label: "Auto-admit" },
	{ value: "approval_required", label: "Approval required" },
];

let invitePolicyValue: "auto_admit" | "approval_required" = "auto_admit";

function applySyncInviteReadinessState() {
	const syncCreateInviteButton = document.getElementById(
		"syncCreateInviteButton",
	) as HTMLButtonElement | null;
	const hint = document.getElementById("syncInviteAdminHint") as HTMLParagraphElement | null;
	if (!syncCreateInviteButton || !hint) return;
	const readiness = state.lastCoordinatorAdminStatus?.readiness;
	const activeGroup = String(state.lastCoordinatorAdminStatus?.active_group || "").trim();
	if (readiness === "ready") {
		syncCreateInviteButton.disabled = false;
		hint.hidden = false;
		hint.textContent = activeGroup
			? `Remote coordinator admin is ready for ${activeGroup}. Advanced admin tools now live in Coordinator Admin.`
			: "Remote coordinator admin is ready. Advanced admin tools now live in Coordinator Admin.";
		return;
	}
	const message =
		readiness === "partial"
			? "Finish coordinator admin setup before creating remote invites. Use Coordinator Admin to check what is missing."
			: "Configure a coordinator URL, group, and admin secret before creating remote invites. Use Coordinator Admin to finish setup.";
	syncCreateInviteButton.disabled = true;
	hint.hidden = false;
	hint.textContent = message;
}

function renderAdminSetupDisclosure() {
	const mount = document.getElementById("syncAdminDisclosureMount") as HTMLElement | null;
	if (!mount) return;
	renderTeamSetupDisclosure(mount, {
		open: adminSetupExpanded,
		onOpenChange: (open) => {
			setAdminSetupExpanded(open);
			renderAdminSetupDisclosure();
			renderInvitePolicySelect();
			setInviteOutputVisibility();
		},
	});
}

/* ── DOM placement helpers ───────────────────────────────── */

function ensureInvitePanelInAdminSection() {
	// Team setup disclosure now renders in-place through Radix collapsible.
}

function ensureJoinPanelInSetupSection() {
	const joinPanel = document.getElementById("syncJoinPanel");
	const joinSection = document.getElementById("syncJoinSection");
	if (!joinPanel || !joinSection) return;
	if (joinPanel.parentElement !== joinSection) joinSection.appendChild(joinPanel);
}

function setInviteOutputVisibility() {
	const syncInviteOutput = document.getElementById(
		"syncInviteOutput",
	) as HTMLTextAreaElement | null;
	const syncInviteWarnings = document.getElementById("syncInviteWarnings") as HTMLDivElement | null;
	if (!syncInviteOutput) return;
	const encoded = String(state.lastTeamInvite?.encoded || "").trim();
	syncInviteOutput.value = encoded;
	syncInviteOutput.hidden = !encoded;
	if (syncInviteWarnings) {
		const warnings = Array.isArray(state.lastTeamInvite?.warnings)
			? state.lastTeamInvite.warnings
			: [];
		syncInviteWarnings.textContent = warnings.join(" · ");
		syncInviteWarnings.hidden = warnings.length === 0;
	}
}

function setJoinFeedbackVisibility() {
	const syncJoinFeedback = document.getElementById("syncJoinFeedback") as HTMLDivElement | null;
	if (!syncJoinFeedback) return;
	const feedback = state.syncJoinFlowFeedback;
	syncJoinFeedback.textContent = feedback?.message || "";
	syncJoinFeedback.hidden = !feedback?.message;
	syncJoinFeedback.setAttribute("role", feedback?.tone === "warning" ? "alert" : "status");
	syncJoinFeedback.setAttribute("aria-live", feedback?.tone === "warning" ? "assertive" : "polite");
	syncJoinFeedback.className = `peer-meta${feedback ? ` ${feedback.tone === "warning" ? "sync-inline-feedback warning" : "sync-inline-feedback success"}` : ""}`;
}

function clearContent(node: HTMLElement | null) {
	if (node) node.textContent = "";
}

function pulseAttentionTarget(target: HTMLElement | null) {
	if (!(target instanceof HTMLElement)) return;
	target.classList.remove("sync-attention-target");
	void target.offsetWidth;
	target.classList.add("sync-attention-target");
	window.setTimeout(() => target.classList.remove("sync-attention-target"), 900);
}

function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

function syncScrollBehavior(): ScrollBehavior {
	return prefersReducedMotion() ? "auto" : "smooth";
}

function renderInvitePolicySelect() {
	const mount = document.getElementById("syncInvitePolicyMount") as HTMLElement | null;
	if (!mount) return;
	renderIntoSyncMount(
		mount,
		h(RadixSelect, {
			ariaLabel: "Join policy",
			contentClassName: "sync-radix-select-content sync-actor-select-content",
			id: "syncInvitePolicy",
			itemClassName: "sync-radix-select-item",
			onValueChange: (value) => {
				const nextValue = value === "approval_required" ? "approval_required" : "auto_admit";
				if (nextValue === invitePolicyValue) return;
				invitePolicyValue = nextValue;
				renderInvitePolicySelect();
			},
			options: INVITE_POLICY_OPTIONS,
			triggerClassName: "sync-radix-select-trigger sync-actor-select",
			value: invitePolicyValue,
			viewportClassName: "sync-radix-select-viewport",
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

/* ── Sharing review renderer ─────────────────────────────── */

function openFeedSharingReview() {
	setFeedScopeFilter("mine");
	state.feedQuery = "";
	window.location.hash = "feed";
}

export function renderSyncSharingReview() {
	const panel = document.getElementById("syncSharingReview");
	const meta = document.getElementById("syncSharingReviewMeta");
	const list = document.getElementById("syncSharingReviewList") as HTMLElement | null;
	if (!panel || !meta || !list) return;
	const items = Array.isArray(state.lastSyncSharingReview) ? state.lastSyncSharingReview : [];
	if (!items.length) {
		clearSyncMount(list);
		panel.hidden = true;
		return;
	}
	panel.hidden = false;
	const scopeLabel = state.currentProject
		? `current project (${state.currentProject})`
		: "all allowed projects";
	meta.textContent = `Teammates receive memories from ${scopeLabel} by default. Use Only me on a memory when it should stay local.`;
	const reviewItems: SyncSharingReviewItem[] = items.map((item) => ({
		actorDisplayName: String(item.actor_display_name || item.actor_id || "unknown"),
		actorId: String(item.actor_id || "unknown"),
		peerName: String(item.peer_name || item.peer_device_id || "Device"),
		privateCount: Number(item.private_count || 0),
		scopeLabel: String(item.scope_label || "All allowed projects"),
		shareableCount: Number(item.shareable_count || 0),
	}));
	renderIntoSyncMount(
		list,
		h(SyncSharingReview, { items: reviewItems, onReview: openFeedSharingReview }),
	);
}

/* ── Team sync renderer ──────────────────────────────────── */

// loadSyncData is set by the index module after both are loaded.
let _loadSyncData: () => Promise<void> = async () => {};
export function setLoadSyncData(fn: () => Promise<void>) {
	_loadSyncData = fn;
}

export function renderTeamSync() {
	const meta = document.getElementById("syncTeamMeta");
	const setupPanel = document.getElementById("syncSetupPanel");
	const list = document.getElementById("syncTeamStatus");
	const listHeading = list?.previousElementSibling as HTMLElement | null;
	const actions = document.getElementById("syncTeamActions");
	if (!meta || !setupPanel || !list || !actions) return;

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
	ensureInvitePanelInAdminSection();
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
			await _loadSyncData();
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
			await _loadSyncData();
		} catch (error) {
			try {
				await _loadSyncData();
			} catch {}
			showGlobalNotice(friendlyError(error, "Failed to combine these people."), "warning");
		}
	};

	const reviewDiscoveredDeviceName = async (suggestedName: string) => {
		return await openSyncInputDialog({
			title: "Review device",
			description: "Choose a friendly name for this device before connecting it on this machine.",
			initialValue: suggestedName,
			placeholder: "Desk Mini",
			confirmLabel: "Connect device",
			cancelLabel: "Cancel",
			validate: (nextValue) =>
				nextValue.trim() ? null : "Enter a device name to connect this device.",
		});
	};

	const configured = Boolean(coordinator?.configured);
	meta.textContent = configured
		? `Team: ${(coordinator.groups || []).join(", ") || "none"}`
		: "Start by joining an existing team or creating one, then connect people and devices.";
	meta.title = configured ? String(coordinator.coordinator_url || "").trim() : "";

	if (!configured) {
		teardownTeamSyncRender(actions, [list, joinRequests, discoveredList]);
		setupPanel.hidden = false;
		list.hidden = true;
		if (listHeading) listHeading.hidden = true;
		actions.hidden = true;
		if (joinRequests) joinRequests.hidden = true;
		if (discoveredPanel) discoveredPanel.hidden = true;
		return;
	}

	setupPanel.hidden = true;
	list.hidden = false;
	if (listHeading) listHeading.hidden = false;
	actions.hidden = false;

	const presenceStatus = String(coordinator.presence_status || "");
	const presenceLabel =
		presenceStatus === "posted"
			? "Connected"
			: presenceStatus === "not_enrolled"
				? "Needs enrollment"
				: "Connection error";
	const localPeers = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers : [];
	const attentionItems = Array.isArray(syncView.attentionItems) ? syncView.attentionItems : [];
	const connectedCount = Number(syncView.summary?.connectedDeviceCount || 0);
	const seenOnTeamCount = Number(syncView.summary?.seenOnTeamCount || 0);
	const offlineTeamDeviceCount = Number(syncView.summary?.offlineTeamDeviceCount || 0);
	const metricParts = [`Connected ${connectedCount}`, `Team ${seenOnTeamCount}`];
	if (offlineTeamDeviceCount > 0) {
		metricParts.push(`Offline ${offlineTeamDeviceCount}`);
	}

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
		const canAccept =
			Boolean(deviceId) &&
			Boolean(fingerprint) &&
			!pairedPeer &&
			!device.stale &&
			!hasAmbiguousCoordinatorGroup;
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
			mode = "paired";
		} else if (pairedPeer?.status?.peer_state) {
			noteParts.push(`status: ${String(pairedPeer.status.peer_state)}`);
			mode = "paired";
		} else if (!pairedPeer && device.stale) {
			actionMessage =
				"Wait for a fresh coordinator presence update, then review this device again here.";
			mode = "stale";
		} else if (pairedPeer) {
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
			actionLabel: approvalSummary.actionLabel || "Review device",
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

	const pending = Array.isArray(state.lastSyncJoinRequests) ? state.lastSyncJoinRequests : [];
	const pendingJoinRequests: TeamSyncPendingJoinRequest[] = pending.map((request) => ({
		displayName: String(request.display_name || request.device_id || "Pending device"),
		requestId: String(request.request_id || ""),
	}));
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
	const attentionParts: string[] = [];
	if (attentionItems.length > 0) {
		const repairItems = attentionItems.filter((item) => item.kind === "device-needs-repair");
		const nameItems = attentionItems.filter((item) => item.kind === "name-device");
		const reviewItems = attentionItems.filter((item) => item.kind === "review-team-device");
		const duplicateItems = attentionItems.filter(
			(item) => item.kind === "possible-duplicate-person",
		);
		if (repairItems.length > 0)
			attentionParts.push(
				`${repairItems.length} device${repairItems.length === 1 ? "" : "s"} to repair`,
			);
		if (nameItems.length > 0)
			attentionParts.push(`${nameItems.length} device${nameItems.length === 1 ? "" : "s"} to name`);
		if (reviewItems.length > 0)
			attentionParts.push(
				`${reviewItems.length} device${reviewItems.length === 1 ? "" : "s"} to review`,
			);
		if (duplicateItems.length > 0)
			attentionParts.push(
				`${duplicateItems.length} possible duplicate${duplicateItems.length === 1 ? "" : "s"}`,
			);
	}
	if (pendingJoinRequests.length > 0)
		attentionParts.push(
			`${pendingJoinRequests.length} join request${pendingJoinRequests.length === 1 ? "" : "s"} to review`,
		);
	if (discoveredActionableCount > 0)
		attentionParts.push(
			`${discoveredActionableCount} discovered device${discoveredActionableCount === 1 ? "" : "s"}`,
		);
	const attentionDetail = attentionParts.join(", ");
	const teamLabel = (coordinator.groups || []).join(", ") || "none";
	const statusSummary: TeamSyncStatusSummary = {
		badgeClassName: `pill ${presenceStatus === "posted" ? "pill-success" : presenceStatus === "not_enrolled" ? "pill-warning" : "pill-error"}`,
		headline:
			presenceStatus === "posted"
				? actionableCount > 0
					? attentionDetail
					: "Everything is healthy"
				: presenceStatus === "not_enrolled"
					? "This device is not enrolled in the team yet"
					: "Sync needs attention",
		metricsText: metricParts.join(" · "),
		presenceLabel,
	};
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
			? "Review anything here that still needs trust, repair, or approval."
			: "";
	}
	if (joinRequests) {
		joinRequests.hidden = pendingJoinRequests.length === 0 && !state.syncJoinRequestsFeedback;
	}

	teardownTeamSyncRender(actions, [list, joinRequests, discoveredList]);
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
				joinRestoreParent,
				onToggleInvitePanel: () => {
					if (!invitePanel) return;
					setTeamInvitePanelOpen(!teamInvitePanelOpen);
					renderTeamSync();
				},
				pairedPeerCount: Number(coordinator.paired_peer_count || 0),
				presenceStatus,
			}),
			discoveredListMount: discoveredList,
			discoveredRows: visibleDiscoveredRows,
			joinRequestsMount: joinRequests,
			listMount: list,
			onApproveJoinRequest: async (request) => {
				try {
					await api.reviewJoinRequest(request.requestId, "approve");
					const feedback = {
						message: `Approved ${request.displayName}. They can now sync with the team.`,
						tone: "success",
					} satisfies SyncActionFeedback;
					state.syncJoinRequestsFeedback = feedback;
					await _loadSyncData();
					return feedback;
				} catch (error) {
					return {
						message: friendlyError(
							error,
							"Failed to approve join request. Keep it pending and try again after the coordinator refreshes.",
						),
						tone: "warning",
					} satisfies SyncActionFeedback;
				}
			},
			onAttentionAction: async (item) => {
				if (item.kind === "possible-duplicate-person") {
					await reviewDuplicatePeople(item);
					return;
				}
				focusAttentionTarget(item);
			},
			onDenyJoinRequest: async (request) => {
				const confirmed = await openSyncConfirmDialog({
					title: `Deny join request from ${request.displayName}?`,
					description: "They will need a new invite to try joining this team again.",
					confirmLabel: "Deny request",
					cancelLabel: "Keep request pending",
					tone: "danger",
				});
				if (!confirmed) return null;
				try {
					await api.reviewJoinRequest(request.requestId, "deny");
					const feedback = {
						message: `Denied join request from ${request.displayName}.`,
						tone: "success",
					} satisfies SyncActionFeedback;
					state.syncJoinRequestsFeedback = feedback;
					await _loadSyncData();
					return feedback;
				} catch (error) {
					return {
						message: friendlyError(
							error,
							"Failed to deny join request. Leave it pending for now, then retry after the coordinator refreshes.",
						),
						tone: "warning",
					} satisfies SyncActionFeedback;
				}
			},
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
					await _loadSyncData();
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
						await _loadSyncData();
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
			statusSummary,
		}),
	);
}

/* ── Event wiring ────────────────────────────────────────── */

export function initTeamSyncEvents(refreshCallback: () => void, loadSyncData: () => Promise<void>) {
	renderAdminSetupDisclosure();
	renderInvitePolicySelect();

	const syncNowButton = document.getElementById("syncNowButton") as HTMLButtonElement | null;
	const syncCreateInviteButton = document.getElementById(
		"syncCreateInviteButton",
	) as HTMLButtonElement | null;
	const syncInviteGroup = document.getElementById("syncInviteGroup") as HTMLInputElement | null;
	const syncInviteTtl = document.getElementById("syncInviteTtl") as HTMLInputElement | null;
	const syncInviteOutput = document.getElementById(
		"syncInviteOutput",
	) as HTMLTextAreaElement | null;
	const syncJoinButton = document.getElementById("syncJoinButton") as HTMLButtonElement | null;
	const syncJoinInvite = document.getElementById("syncJoinInvite") as HTMLTextAreaElement | null;

	syncCreateInviteButton?.addEventListener("click", async () => {
		if (!syncCreateInviteButton || !syncInviteGroup || !syncInviteTtl || !syncInviteOutput) return;
		if (syncCreateInviteButton.disabled) return;
		const groupName = syncInviteGroup.value.trim();
		const ttlValue = Number(syncInviteTtl.value);
		let valid = true;
		if (!groupName) {
			valid = markFieldError(syncInviteGroup, "Team name is required.");
		} else {
			clearFieldError(syncInviteGroup);
		}
		if (!ttlValue || ttlValue < 1) {
			valid = markFieldError(syncInviteTtl, "Must be at least 1 hour.");
		} else {
			clearFieldError(syncInviteTtl);
		}
		if (!valid) return;
		syncCreateInviteButton.disabled = true;
		syncCreateInviteButton.textContent = "Creating\u2026";
		try {
			const result = await api.createCoordinatorInvite({
				group_id: groupName,
				policy: invitePolicyValue,
				ttl_hours: ttlValue || 24,
			});
			state.lastTeamInvite = result;
			setInviteOutputVisibility();
			syncInviteOutput.value = String(result.encoded || "");
			syncInviteOutput.hidden = false;
			syncInviteOutput.focus();
			syncInviteOutput.select();
			const warnings = Array.isArray(result.warnings) ? result.warnings : [];
			showGlobalNotice(
				warnings.length
					? `Invite created. Copy it above and review ${warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}.`
					: "Invite created. Copy the text above and share it with your teammate.",
				warnings.length ? "warning" : "success",
			);
		} catch (error) {
			showGlobalNotice(
				friendlyError(
					error,
					"Failed to create invite. Check the team name, invite lifetime, and coordinator reachability, then try again.",
				),
				"warning",
			);
			syncCreateInviteButton.textContent = "Retry";
			syncCreateInviteButton.disabled = false;
			return;
		} finally {
			if (syncCreateInviteButton.disabled) {
				syncCreateInviteButton.disabled = false;
				syncCreateInviteButton.textContent = "Create invite";
			}
		}
	});

	syncJoinButton?.addEventListener("click", async () => {
		if (!syncJoinButton || !syncJoinInvite) return;
		const inviteValue = syncJoinInvite.value.trim();
		if (!inviteValue) {
			markFieldError(syncJoinInvite, "Paste a team invite to join.");
			return;
		}
		clearFieldError(syncJoinInvite);
		syncJoinButton.disabled = true;
		syncJoinButton.textContent = "Joining\u2026";
		try {
			const result = await api.importCoordinatorInvite(inviteValue);
			state.lastTeamJoin = result;
			let feedback: SyncActionFeedback = {
				message:
					result.status === "pending"
						? "Join request sent. Waiting for admin approval."
						: "Joined the team.",
				tone: "success",
			};
			state.syncJoinFlowFeedback = feedback;
			setJoinFeedbackVisibility();
			syncJoinInvite.value = "";
			try {
				await loadSyncData();
			} catch (error) {
				feedback = {
					message: friendlyError(error, "Joined the team, but this view has not refreshed yet."),
					tone: "warning",
				};
				state.syncJoinFlowFeedback = feedback;
				setJoinFeedbackVisibility();
			}
		} catch (error) {
			state.syncJoinFlowFeedback = {
				message: friendlyError(
					error,
					"Failed to import invite. Check that the invite is complete, current, and meant for this team, then try again.",
				),
				tone: "warning",
			};
			setJoinFeedbackVisibility();
			syncJoinButton.textContent = "Retry";
			syncJoinButton.disabled = false;
			return;
		} finally {
			if (syncJoinButton.disabled) {
				syncJoinButton.disabled = false;
				syncJoinButton.textContent = "Join team";
			}
		}
	});

	syncNowButton?.addEventListener("click", async () => {
		if (!syncNowButton) return;
		syncNowButton.disabled = true;
		syncNowButton.textContent = "Syncing\u2026";
		try {
			const result = await api.triggerSync();
			const summary = summarizeSyncRunResult(result);
			showGlobalNotice(summary.message, summary.warning ? "warning" : undefined);
		} catch (error) {
			showGlobalNotice(
				friendlyError(
					error,
					"Failed to start sync. Retry once, then run codemem sync doctor if the problem keeps coming back.",
				),
				"warning",
			);
			syncNowButton.textContent = "Retry";
			syncNowButton.disabled = false;
			return;
		}
		syncNowButton.disabled = false;
		syncNowButton.textContent = "Sync now";
		refreshCallback();
	});
}
