/* Team devices the coordinator lists: which of them this device can pair with or approve,
 * and what to tell the person about each. Devices shows them. */

import * as api from "../../../lib/api";
import { withoutServiceDevices } from "../../../lib/device-identity-inventory";
import { friendlyError } from "../../../lib/form";
import { type DiscoveredDevice, isSyncRedactionEnabled, state } from "../../../lib/state";
import type { SyncActionFeedback } from "../components/sync-inline-feedback";
import { isPeerScopeReviewPending, redactAddress, requestPeerScopeReview } from "../helpers";
import {
	deriveCoordinatorApprovalSummary,
	deriveCoordinatorSetupBlocker,
	resolveFriendlyDeviceName,
	SYNC_TERMINOLOGY,
	shouldShowCoordinatorReviewAction,
} from "../view-model";
import { teamSyncState } from "./data/state";

const APPROVAL_SENT_MESSAGE =
	"Approval sent for this device. This screen may take up to 30 seconds to confirm two-way trust.";

export interface TeamSyncDiscoveredRow
	extends Record<"actionMessage" | "actionLabel", string | null> {
	approvalState: "needs-local-approval" | "approval-pending" | "not-required";
	approvalBadgeLabel: string | null;
	availabilityLabel: string;
	coordinatorUrl: string;
	deviceId: string;
	displayName: string;
	displayTitle: string | null;
	fingerprint: string;
	groupId: string;
	incomingRequestId: string;
	mode:
		| "accept"
		| "approval-pending"
		| "ambiguous"
		| "conflict"
		| "none"
		| "paired"
		| "scope-pending"
		| "setup-blocked"
		| "stale"
		| "waiting-address";
	note: string;
	pairedMessage: string | null;
	connectionLabel: string;
}

export function needsCoordinatorGroupReview(
	groupIds: string[],
	pairedLocally: boolean,
	needsLocalApproval = false,
): boolean {
	return groupIds.length > 1 && (!pairedLocally || needsLocalApproval);
}

/**
 * Discovered devices a person can review. Coordinator service devices are left out
 * once the device inventory has loaded; before that nothing is known to be a service.
 */
function devicesToReview(coordinator: NonNullable<typeof state.lastSyncCoordinator>) {
	const { discovered_devices: devices } = withoutServiceDevices(
		coordinator,
		state.lastDeviceIdentityInventory,
	);
	return Array.isArray(devices) ? devices : [];
}

type Peer = NonNullable<typeof state.lastSyncPeers>[number];
type ApprovalSummary = ReturnType<typeof deriveCoordinatorApprovalSummary>;

interface RowFacts {
	approvalPending: boolean;
	approvalSummary: ApprovalSummary;
	canAccept: boolean;
	device: DiscoveredDevice;
	deviceId: string;
	hasAmbiguousCoordinatorGroup: boolean;
	hasConflict: boolean;
	pairedPeer: Peer | undefined;
	setupBlocker: ReturnType<typeof deriveCoordinatorSetupBlocker>;
}

type Outcome = Pick<TeamSyncDiscoveredRow, "mode" | "actionMessage">;

function addressNote(device: DiscoveredDevice, deviceId: string, showId: boolean) {
	const addresses = Array.isArray(device.addresses) ? device.addresses : [];
	const rawHidden = Number(device.address_count ?? 0);
	const hiddenCount = Number.isFinite(rawHidden) && rawHidden > 0 ? rawHidden : 0;
	const shown = addresses
		.map((address) =>
			isSyncRedactionEnabled() ? redactAddress(String(address || "")) : String(address || ""),
		)
		.filter(Boolean);
	let label = "No fresh addresses";
	if (addresses.length) label = shown.join(" · ");
	else if (hiddenCount > 0) {
		const age = device.stale ? "last-known" : "fresh";
		label = `${hiddenCount} ${age} ${hiddenCount === 1 ? "address" : "addresses"} hidden`;
	}
	const parts = [label];
	if (!addresses.length && showId) parts.push(`device id: ${deviceId}`);
	return { addressCount: addresses.length + hiddenCount, parts };
}

function approvalStateOf(
	device: DiscoveredDevice,
	approvalPending: boolean,
): TeamSyncDiscoveredRow["approvalState"] {
	if (approvalPending) return "approval-pending";
	return device.needs_local_approval === true ? "needs-local-approval" : "not-required";
}

/** What blocks or defers acting on this device now, or null when nothing does. */
function blockedOutcome(facts: RowFacts, addressCount: number): Outcome | null {
	const { approvalSummary, device, deviceId, pairedPeer, setupBlocker } = facts;
	if (facts.hasConflict) return { mode: "conflict", actionMessage: null };
	if (facts.approvalPending) {
		return {
			mode: "approval-pending",
			actionMessage: "Waiting for refreshed coordinator status. You do not need to approve again.",
		};
	}
	if (setupBlocker && (!pairedPeer || approvalSummary.state === "needs-your-approval")) {
		return { mode: "setup-blocked", actionMessage: setupBlocker.message };
	}
	if (facts.hasAmbiguousCoordinatorGroup) {
		return {
			mode: "ambiguous",
			actionMessage:
				"This device appears in multiple coordinator groups. Review legacy Team/Space setup before approving it here.",
		};
	}
	const waitState = deviceWaitState({ pairedLocally: Boolean(pairedPeer), device, addressCount });
	if (waitState) return waitState;
	if (pairedPeer && isPeerScopeReviewPending(deviceId)) {
		return {
			mode: "scope-pending",
			actionMessage:
				"Review this device's legacy Space access and advanced rules in Coordinator Administration before you sync it.",
		};
	}
	return null;
}

/** How an already paired device that nothing blocks should read. */
function pairedOutcome(facts: RowFacts): { mode: TeamSyncDiscoveredRow["mode"]; note?: string } {
	const { canAccept, pairedPeer } = facts;
	const fallback = canAccept ? "accept" : "none";
	const settled = canAccept ? "accept" : "paired";
	if (pairedPeer?.last_error) {
		return { mode: settled, note: `error: ${String(pairedPeer.last_error)}` };
	}
	if (pairedPeer?.status?.peer_state) {
		return { mode: settled, note: `status: ${String(pairedPeer.status.peer_state)}` };
	}
	return { mode: pairedPeer ? settled : fallback };
}

interface RowContext {
	coordinatorUrl: string;
	localPeers: Peer[];
	setupBlocker: RowFacts["setupBlocker"];
}

function identityOf(device: DiscoveredDevice) {
	const deviceId = String(device.device_id || "").trim();
	const displayName =
		resolveFriendlyDeviceName({
			coordinatorName: String(device.display_name || "").trim(),
			deviceId,
		}) || "Discovered device";
	return {
		deviceId,
		displayName,
		displayTitle: deviceId && displayName !== deviceId ? deviceId : null,
		fingerprint: String(device.fingerprint || "").trim(),
		incomingRequestId: String(device.incoming_reciprocal_request_id || "").trim(),
		groupIds: Array.isArray(device.groups)
			? device.groups.map((value) => String(value || "").trim()).filter(Boolean)
			: [],
	};
}

function factsOf(
	device: DiscoveredDevice,
	identity: ReturnType<typeof identityOf>,
	context: RowContext,
): RowFacts {
	const { deviceId, fingerprint, groupIds, incomingRequestId } = identity;
	const pairedPeer = context.localPeers.find(
		(peer) => String(peer?.peer_device_id || "") === deviceId,
	);
	const pairedLocally = Boolean(pairedPeer);
	const hasAmbiguousCoordinatorGroup = needsCoordinatorGroupReview(
		groupIds,
		pairedLocally,
		device.needs_local_approval === true,
	);
	const pairedFingerprint = String(pairedPeer?.fingerprint || "").trim();
	const pendingApproval = state.pendingCoordinatorApprovalsByDeviceId.get(deviceId);
	const approvalPending =
		device.needs_local_approval === true &&
		pendingApproval?.coordinatorUrl === context.coordinatorUrl &&
		pendingApproval?.incomingRequestId === incomingRequestId;
	return {
		approvalPending,
		approvalSummary: deriveCoordinatorApprovalSummary({ device, pairedLocally }),
		canAccept:
			!approvalPending &&
			!context.setupBlocker &&
			shouldShowCoordinatorReviewAction({ device, hasAmbiguousCoordinatorGroup, pairedLocally }),
		device,
		deviceId,
		hasAmbiguousCoordinatorGroup,
		hasConflict:
			pairedLocally &&
			Boolean(fingerprint) &&
			Boolean(pairedFingerprint) &&
			pairedFingerprint !== fingerprint,
		pairedPeer,
		setupBlocker: context.setupBlocker,
	};
}

function discoveredRow(device: DiscoveredDevice, context: RowContext): TeamSyncDiscoveredRow {
	const identity = identityOf(device);
	const facts = factsOf(device, identity, context);
	const { approvalPending, approvalSummary, hasConflict, pairedPeer } = facts;
	const pairedLocally = Boolean(pairedPeer);
	const address = addressNote(device, identity.deviceId, Boolean(identity.displayTitle));
	const blocked = blockedOutcome(facts, address.addressCount);
	const paired = blocked ? null : pairedOutcome(facts);
	const mode = blocked?.mode ?? paired?.mode ?? "none";
	if (paired?.note) address.parts.push(paired.note);
	return {
		actionMessage: blocked?.actionMessage ?? null,
		// Unpaired team devices get the direct "Pair with this device" affordance. Devices that
		// already need explicit approval keep their approval-specific label.
		actionLabel:
			approvalSummary.actionLabel || (pairedLocally ? "Review device" : "Pair with this device"),
		approvalBadgeLabel: approvalPending ? "Approval sent" : approvalSummary.badgeLabel,
		approvalState: approvalStateOf(device, approvalPending),
		availabilityLabel: device.stale ? "Offline" : "Available",
		connectionLabel: deviceConnectionLabel(hasConflict, pairedLocally),
		coordinatorUrl: context.coordinatorUrl,
		deviceId: identity.deviceId,
		displayName: identity.displayName,
		displayTitle: identity.displayTitle,
		fingerprint: identity.fingerprint,
		groupId: identity.groupIds[0] ?? "",
		incomingRequestId: identity.incomingRequestId,
		mode,
		note: address.parts.join(" · "),
		pairedMessage:
			mode === "paired"
				? pairedDeviceMessage(
						approvalSummary.state,
						approvalSummary.description,
						pairedPeer?.last_error,
					)
				: null,
	};
}

/** Team devices the coordinator lists that this device can pair with, approve, or has a conflict with. */
export function deriveDiscoveredRows(): TeamSyncDiscoveredRow[] {
	const coordinator = state.lastSyncCoordinator;
	if (!coordinator?.configured) return [];
	const context = {
		coordinatorUrl: String(coordinator.coordinator_url || "").trim(),
		localPeers: Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers : [],
		setupBlocker: deriveCoordinatorSetupBlocker(coordinator),
	};
	return devicesToReview(coordinator).map((device) => discoveredRow(device, context));
}

/** Refuses an approval that is missing what it must be bound to. */
function assertReviewable(row: TeamSyncDiscoveredRow, finalLocalApproval: boolean): void {
	if (!finalLocalApproval) return;
	if (!row.deviceId.trim() || !row.coordinatorUrl.trim()) throw incompleteIdentity();
	if (!row.groupId.trim() || !row.incomingRequestId.trim()) throw incompleteIdentity();
}

function incompleteIdentity(): Error {
	return new Error("Device identity is incomplete. Refresh the screen and try approval again.");
}

/** Shows the device as a pending pairing until the next status read confirms it. */
function recordPendingPeer(row: TeamSyncDiscoveredRow, name: string): void {
	const others = Array.isArray(state.pendingAcceptedSyncPeers)
		? state.pendingAcceptedSyncPeers.filter(
				(peer) => String(peer?.peer_device_id || "").trim() !== row.deviceId,
			)
		: [];
	state.pendingAcceptedSyncPeers = [
		...others,
		{
			peer_device_id: row.deviceId,
			name,
			fingerprint: row.fingerprint,
			addresses: [],
			claimed_local_actor: false,
			status: { peer_state: "degraded" },
			last_error: "Waiting for the other device to approve this one.",
		},
	];
}

/** Saves the name the person chose when it differs from the one the pairing carried. */
async function saveReviewedName(
	row: TeamSyncDiscoveredRow,
	reviewedName: string,
	currentName: string,
	finalLocalApproval: boolean,
): Promise<SyncActionFeedback | null> {
	const name = reviewedName.trim();
	if (name === currentName.trim()) return null;
	try {
		await api.renamePeer(row.deviceId, name);
		state.pendingAcceptedSyncPeers = state.pendingAcceptedSyncPeers.map((peer) =>
			String(peer?.peer_device_id || "").trim() === row.deviceId ? { ...peer, name } : peer,
		);
		if (finalLocalApproval) return null;
		return { message: `Connected ${name} and saved its name.`, tone: "success" };
	} catch (error) {
		return {
			message: finalLocalApproval
				? "Approval was sent, but naming did not finish. You do not need to approve again."
				: friendlyError(error, "Device connected, but naming did not finish."),
			tone: "warning",
		};
	}
}

async function refreshAfterReview(finalLocalApproval: boolean): Promise<SyncActionFeedback | null> {
	try {
		await teamSyncState.loadSyncData();
		return null;
	} catch (error) {
		return {
			message: finalLocalApproval
				? "Approval was sent. Confirmation may take up to 30 seconds, and you do not need to approve again."
				: friendlyError(
						error,
						"Device connected, but the screen did not refresh yet. Refresh this page before trying the next step.",
					),
			tone: "warning",
		};
	}
}

export async function submitDiscoveredDeviceReview(
	row: TeamSyncDiscoveredRow,
	reviewedName: string,
	hooks: { onApprovalSent?: () => void } = {},
): Promise<SyncActionFeedback> {
	const finalLocalApproval = row.approvalState === "needs-local-approval";
	assertReviewable(row, finalLocalApproval);
	const groupId = row.groupId.trim();
	const incomingRequestId = row.incomingRequestId.trim();
	const result = await api.acceptDiscoveredPeer(row.deviceId, {
		fingerprint: row.fingerprint,
		expectedGroupId: groupId || undefined,
		expectedIncomingRequestId: finalLocalApproval ? incomingRequestId : undefined,
	});
	const optimisticName = String(result?.name || row.displayName || "").trim() || row.displayName;
	if (finalLocalApproval) {
		state.pendingCoordinatorApprovalsByDeviceId.set(row.deviceId.trim(), {
			coordinatorUrl: row.coordinatorUrl.trim(),
			incomingRequestId,
		});
	}
	recordPendingPeer(row, optimisticName);
	requestPeerScopeReview(row.deviceId);
	if (finalLocalApproval) hooks.onApprovalSent?.();
	const naming = await saveReviewedName(row, reviewedName, optimisticName, finalLocalApproval);
	const refresh = await refreshAfterReview(finalLocalApproval);
	if (refresh) return refresh;
	if (naming) return naming;
	if (finalLocalApproval) return { message: APPROVAL_SENT_MESSAGE, tone: "success" };
	return {
		message: `Step 1 complete on this device for ${row.displayName}. Finish onboarding on the other device so both sides trust each other for sync.`,
		tone: "success",
	};
}

function deviceWaitState({
	pairedLocally,
	device,
	addressCount,
}: {
	pairedLocally: boolean;
	device: DiscoveredDevice;
	addressCount: number;
}): Pick<TeamSyncDiscoveredRow, "actionMessage" | "mode"> | null {
	if (pairedLocally && device.needs_local_approval !== true) return null;
	if (device.stale) {
		return {
			actionMessage:
				"Wait for a fresh coordinator presence update, then review this device again here.",
			mode: "stale",
		};
	}
	if (pairedLocally || addressCount > 0) return null;
	return {
		actionMessage: "Wait for this device to publish a fresh address, then refresh and review it.",
		mode: "waiting-address",
	};
}

function pairedDeviceMessage(
	approvalState: string,
	approvalDescription: string | null,
	lastError: unknown,
): string | null {
	if (approvalState === "waiting-for-other-device") {
		return approvalDescription || "Waiting on the other device.";
	}
	const normalizedError = String(lastError || "").toLowerCase();
	if (normalizedError.includes("401") && normalizedError.includes("unauthorized")) {
		return "Waiting for the other device to trust this one before sync can work.";
	}
	return null;
}

function deviceConnectionLabel(hasConflict: boolean, pairedLocally: boolean): string {
	if (hasConflict) return SYNC_TERMINOLOGY.conflicts;
	if (pairedLocally) return SYNC_TERMINOLOGY.pairedLocally;
	return "Not connected on this device";
}
