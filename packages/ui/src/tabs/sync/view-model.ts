/* Derived sync view-model helpers. Keep these pure so UX logic is testable. */

import { deviceNeedsFriendlyName, resolveFriendlyDeviceName } from "./view-model/device-names";
import { cleanText, normalizeDisplayName } from "./view-model/internal";
import { derivePeerTrustSummary, derivePeerUiStatus } from "./view-model/peer-status";
import type {
	ActorLike,
	DiscoveredDeviceLike,
	PeerLike,
	UiCoordinatorApprovalSummary,
	UiDuplicatePersonCandidate,
	UiSyncAttentionItem,
	UiSyncRunResponse,
	UiSyncViewModel,
	VisiblePeopleResult,
} from "./view-model/types";

export {
	type ActorLike,
	type DiscoveredDeviceLike,
	type PeerLike,
	SYNC_TERMINOLOGY,
	type UiCoordinatorApprovalState,
	type UiCoordinatorApprovalSummary,
	type UiDuplicatePersonCandidate,
	type UiPeerTrustSummary,
	type UiSyncAttentionItem,
	type UiSyncRunItem,
	type UiSyncRunResponse,
	type UiSyncStatus,
	type UiSyncViewModel,
	type UiTrustState,
	type VisiblePeopleResult,
} from "./view-model/types";
export {
	derivePeerTrustSummary,
	derivePeerUiStatus,
	deviceNeedsFriendlyName,
	resolveFriendlyDeviceName,
};

interface MergedDevice {
	deviceId: string;
	localName: string;
	coordinatorName: string;
	peer: PeerLike | null;
	discovered: DiscoveredDeviceLike | null;
}

function isOfflineTeamDevice(device: MergedDevice): boolean {
	if (!device.discovered?.stale) return false;
	return device.peer ? derivePeerUiStatus(device.peer) !== "connected" : true;
}

export function deriveCoordinatorApprovalSummary(input: {
	device: DiscoveredDeviceLike;
	pairedLocally?: boolean;
}): UiCoordinatorApprovalSummary {
	if (input.device?.needs_local_approval) {
		return {
			state: "needs-your-approval",
			badgeLabel: "Needs your approval",
			description:
				"Another device already approved this pairing. Approve it here to finish the connection on both sides.",
			actionLabel: "Approve on this device",
		};
	}
	if (input.device?.waiting_for_peer_approval) {
		return {
			state: "waiting-for-other-device",
			badgeLabel: "Waiting on other device",
			description:
				"You already approved this pairing here. The other device still needs to approve this one before sync can work both ways.",
			actionLabel: null,
		};
	}
	return {
		state: "none",
		badgeLabel: null,
		description: null,
		actionLabel: null,
	};
}

export function shouldShowCoordinatorReviewAction(input: {
	device: DiscoveredDeviceLike;
	pairedLocally?: boolean;
	hasAmbiguousCoordinatorGroup?: boolean;
}): boolean {
	const approvalSummary = deriveCoordinatorApprovalSummary(input);
	const deviceId = cleanText(input.device?.device_id);
	const fingerprint = cleanText(input.device?.fingerprint);
	if (!deviceId || !fingerprint) return false;
	if (Boolean(input.device?.stale) || Boolean(input.hasAmbiguousCoordinatorGroup)) return false;
	if (!input.pairedLocally) return true;
	return approvalSummary.state === "needs-your-approval";
}

export function summarizeSyncRunResult(payload: UiSyncRunResponse): {
	ok: boolean;
	message: string;
	warning: boolean;
} {
	const items = Array.isArray(payload?.items) ? payload.items : [];
	if (!items.length) {
		return { ok: true, message: "Sync pass completed with no eligible devices.", warning: false };
	}
	const failedItems = items.filter((item) => item && item.ok === false);
	if (!failedItems.length) {
		return {
			ok: true,
			message: `Sync pass finished for ${items.length} device${items.length === 1 ? "" : "s"}.`,
			warning: false,
		};
	}
	const unauthorizedFailures = failedItems.filter(
		(item) =>
			cleanText(item.error).toLowerCase().includes("401") &&
			cleanText(item.error).toLowerCase().includes("unauthorized"),
	);
	if (unauthorizedFailures.length === failedItems.length) {
		return {
			ok: false,
			message:
				"This device no longer has two-way trust with the peer. Pair it again from the other device, or remove the stale local record if it should be gone.",
			warning: true,
		};
	}
	if (failedItems.length < items.length) {
		return {
			ok: false,
			message: `${failedItems.length} of ${items.length} device sync attempts failed. Open the affected device cards for the specific errors.`,
			warning: true,
		};
	}
	const error = cleanText(failedItems[0]?.error);
	return {
		ok: false,
		message: error || "Sync failed for at least one device.",
		warning: true,
	};
}

export function deriveDuplicatePeople(actors: ActorLike[]): UiDuplicatePersonCandidate[] {
	const groups = new Map<string, UiDuplicatePersonCandidate>();
	(Array.isArray(actors) ? actors : []).forEach((actor) => {
		const displayName = cleanText(actor?.display_name);
		const actorId = cleanText(actor?.actor_id);
		const normalized = normalizeDisplayName(displayName);
		if (!displayName || !actorId || !normalized) return;
		const current = groups.get(normalized) ?? {
			displayName,
			actorIds: [],
			includesLocal: false,
		};
		current.actorIds = [...current.actorIds, actorId];
		current.includesLocal = current.includesLocal || Boolean(actor?.is_local);
		groups.set(normalized, current);
	});
	return [...groups.values()]
		.filter((item) => item.actorIds.length > 1)
		.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function deriveVisiblePeopleActors(input: {
	actors?: ActorLike[];
	peers?: PeerLike[];
	duplicatePeople?: UiDuplicatePersonCandidate[];
}): VisiblePeopleResult {
	const actors = Array.isArray(input.actors) ? input.actors : [];
	const peers = Array.isArray(input.peers) ? input.peers : [];
	const duplicatePeople = Array.isArray(input.duplicatePeople) ? input.duplicatePeople : [];
	const assignedCounts = new Map<string, number>();
	peers.forEach((peer) => {
		const actorId = cleanText(peer?.actor_id);
		if (!actorId) return;
		assignedCounts.set(actorId, (assignedCounts.get(actorId) ?? 0) + 1);
	});

	const hiddenIds = new Set<string>();
	duplicatePeople.forEach((candidate) => {
		if (!candidate.includesLocal) return;
		candidate.actorIds.forEach((actorId) => {
			const actor = actors.find((item) => cleanText(item?.actor_id) === actorId);
			if (!actor || actor.is_local) return;
			if ((assignedCounts.get(actorId) ?? 0) > 0) return;
			hiddenIds.add(actorId);
		});
	});

	return {
		visibleActors: actors.filter((actor) => !hiddenIds.has(cleanText(actor?.actor_id))),
		hiddenLocalDuplicateCount: hiddenIds.size,
	};
}

function createRepairItem(device: {
	id: string;
	name: string;
	summary: string;
	title?: string;
}): UiSyncAttentionItem {
	return {
		id: `repair:${device.id}`,
		kind: "device-needs-repair",
		priority: 10,
		title: device.title || `${device.name} needs attention`,
		summary: device.summary,
		actionLabel: "Open device",
		deviceId: device.id,
	};
}

function createReviewItem(device: {
	id: string;
	name: string;
	summary: string;
	key?: string;
}): UiSyncAttentionItem {
	return {
		id: `review:${device.id}:${device.key || "default"}`,
		kind: "review-team-device",
		priority: 20,
		title: `${device.name} is available to review`,
		summary: device.summary,
		actionLabel: "Open device",
		deviceId: device.id,
	};
}

function createNamingItem(device: {
	id: string;
	name: string;
	summary: string;
}): UiSyncAttentionItem {
	return {
		id: `name:${device.id}`,
		kind: "name-device",
		priority: 30,
		title: `Name ${device.name}`,
		summary: device.summary,
		actionLabel: "Go to name field",
		deviceId: device.id,
	};
}

function mergeDevices(
	peers: PeerLike[],
	discoveredDevices: DiscoveredDeviceLike[],
): MergedDevice[] {
	const devices = new Map<string, MergedDevice>();
	const getOrCreate = (deviceId: string): MergedDevice => {
		const current = devices.get(deviceId) ?? {
			deviceId,
			localName: "",
			coordinatorName: "",
			peer: null,
			discovered: null,
		};
		devices.set(deviceId, current);
		return current;
	};

	peers.forEach((peer) => {
		const deviceId = cleanText(peer?.peer_device_id);
		if (!deviceId) return;
		const current = getOrCreate(deviceId);
		current.peer = peer;
		current.localName = cleanText(peer?.name);
	});

	discoveredDevices.forEach((device) => {
		const deviceId = cleanText(device?.device_id);
		if (!deviceId) return;
		const current = getOrCreate(deviceId);
		current.discovered = device;
		current.coordinatorName = cleanText(device?.display_name);
	});

	return [...devices.values()];
}

export function deriveSyncViewModel(input: {
	actors?: ActorLike[];
	peers?: PeerLike[];
	coordinator?: { discovered_devices?: DiscoveredDeviceLike[] };
	duplicatePersonDecisions?: Record<string, string>;
}): UiSyncViewModel {
	const actors = Array.isArray(input.actors) ? input.actors : [];
	const peers = Array.isArray(input.peers) ? input.peers : [];
	const discoveredDevices = Array.isArray(input.coordinator?.discovered_devices)
		? input.coordinator.discovered_devices
		: [];
	const mergedDevices = mergeDevices(peers, discoveredDevices);
	const duplicateDecisions = input.duplicatePersonDecisions ?? {};
	const duplicatePeople = deriveDuplicatePeople(actors).filter(
		(candidate) => !duplicateDecisions[[...candidate.actorIds].sort().join("::")],
	);
	const attentionItems: UiSyncAttentionItem[] = [];

	duplicatePeople.forEach((candidate) => {
		attentionItems.push({
			id: `duplicate:${candidate.actorIds.join(":")}`,
			kind: "possible-duplicate-person",
			priority: candidate.includesLocal ? 5 : 15,
			title: `Possible duplicate person: ${candidate.displayName}`,
			summary: candidate.includesLocal
				? "At least one entry is marked as you. Confirm whether these records represent the same person."
				: "Multiple people share this name. Confirm whether they should stay separate or be combined.",
			actionLabel: "Go to people",
			actorIds: candidate.actorIds,
		});
	});

	mergedDevices.forEach((device) => {
		const name = resolveFriendlyDeviceName({
			localName: device.localName,
			coordinatorName: device.coordinatorName,
			deviceId: device.deviceId,
		});
		const peerStatus = device.peer ? derivePeerUiStatus(device.peer) : "waiting";
		const trustSummary = device.peer ? derivePeerTrustSummary(device.peer) : null;
		const discoveredFingerprint = cleanText(device.discovered?.fingerprint);
		const peerFingerprint = cleanText(device.peer?.fingerprint);
		const hasConflict =
			Boolean(device.peer) &&
			Boolean(discoveredFingerprint) &&
			Boolean(peerFingerprint) &&
			discoveredFingerprint !== peerFingerprint;

		if (hasConflict) {
			attentionItems.push(
				createRepairItem({
					id: device.deviceId,
					name,
					title: `${name} needs review`,
					summary:
						"This device identity changed. Remove the older local record before reconnecting it.",
				}),
			);
			return;
		}

		if (device.peer && peerStatus === "needs-repair") {
			const detail =
				trustSummary?.description || cleanText(device.peer?.last_error) || "Sync needs review.";
			attentionItems.push(
				createRepairItem({
					id: device.deviceId,
					name,
					title:
						trustSummary?.state === "needs-repairing"
							? `${name} needs re-pairing`
							: `${name} needs review`,
					summary: detail,
				}),
			);
		} else if (device.peer && peerStatus === "offline") {
			attentionItems.push(
				createRepairItem({
					id: device.deviceId,
					name,
					title: `${name} is offline`,
					summary:
						"This device is offline or unreachable right now. Retry later, or review the local record if it should have been available.",
				}),
			);
		}

		if (device.peer && trustSummary?.state === "trusted-by-you") {
			attentionItems.push(
				createReviewItem({
					id: device.deviceId,
					key: "other-device-trust",
					name,
					summary:
						"You accepted this device. Finish onboarding on the other device so it trusts this one too.",
				}),
			);
		}

		if (!device.peer && device.discovered?.stale) {
			attentionItems.push(
				createReviewItem({
					id: device.deviceId,
					key: "stale-discovery",
					name,
					summary:
						"This device is no longer advertising fresh coordinator presence. Wait for it to check in again before connecting it here.",
				}),
			);
		}

		if (
			!device.peer &&
			Array.isArray(device.discovered?.groups) &&
			device.discovered.groups.length > 1
		) {
			attentionItems.push(
				createReviewItem({
					id: device.deviceId,
					key: "ambiguous-groups",
					name,
					summary:
						"This device appears in multiple coordinator groups. Review the team setup before approving it here.",
				}),
			);
		}

		if (
			device.peer &&
			deviceNeedsFriendlyName({
				localName: device.localName,
				coordinatorName: device.coordinatorName,
				deviceId: device.deviceId,
			})
		) {
			attentionItems.push(
				createNamingItem({
					id: device.deviceId,
					name,
					summary: "Give this device a friendly name so it is easier to recognize later.",
				}),
			);
		}
	});

	return {
		summary: {
			connectedDeviceCount: peers.filter((peer) => derivePeerUiStatus(peer) === "connected").length,
			seenOnTeamCount: discoveredDevices.length,
			offlineTeamDeviceCount: mergedDevices.filter((device) => isOfflineTeamDevice(device)).length,
		},
		duplicatePeople,
		attentionItems: attentionItems.sort(
			(a, b) => a.priority - b.priority || a.title.localeCompare(b.title),
		),
	};
}
