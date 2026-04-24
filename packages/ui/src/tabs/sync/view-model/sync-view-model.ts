/* Top-level sync view-model derivation — merges local peer records
 * with coordinator-discovered devices, runs the per-device status /
 * trust / approval checks, and builds the prioritised attention-items
 * list consumed by the Sync card. This is the single aggregator the
 * Sync tab calls on every state refresh. */

import { deviceNeedsFriendlyName, resolveFriendlyDeviceName } from "./device-names";
import { cleanText } from "./internal";
import { derivePeerTrustSummary, derivePeerUiStatus } from "./peer-status";
import { deriveDuplicatePeople } from "./people-derivations";
import type {
	ActorLike,
	DiscoveredDeviceLike,
	PeerLike,
	UiSyncAttentionItem,
	UiSyncViewModel,
} from "./types";

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
		}
		// Peers that are merely offline are NOT pushed into Needs attention.
		// Device rows already surface the offline state via their presence pip
		// and the "Offline" badge, which is enough signal — computers turn off
		// and on regularly and this doesn't warrant a separate action item.
		// Auth/trust/repair failures (handled in the branch above) still do.

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
