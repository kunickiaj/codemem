/* Top-level sync view-model derivation — merges local peer records
 * with coordinator-discovered devices, runs the per-device status /
 * trust / approval checks, and builds the prioritised attention-items
 * list consumed by the Sync card. This is the single aggregator the
 * Sync tab calls on every state refresh. */

import { deviceNeedsFriendlyName, resolveFriendlyDeviceName } from "./device-names";
import { cleanText } from "./internal";
import { derivePeerTrustSummary, derivePeerUiStatus } from "./peer-status";
import { deriveDuplicatePeople } from "./people-derivations";
import { deriveTeamSyncPrimaryStatus } from "./primary-status";
import type {
	ActorLike,
	CoordinatorSetupBlocker,
	DiscoveredDeviceLike,
	PeerLike,
	ProjectShareOperationLike,
	RecipientPolicyReconciliationLike,
	TeamSyncDaemonState,
	TeamSyncPresenceState,
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

export function deriveCoordinatorSetupBlocker(
	coordinator:
		| {
				configured?: boolean;
				coordinator_url?: string | null;
				groups?: unknown[];
				sync_enabled?: boolean;
		  }
		| null
		| undefined,
): CoordinatorSetupBlocker | null {
	const coordinatorUrl = cleanText(coordinator?.coordinator_url);
	const groups = Array.isArray(coordinator?.groups) ? coordinator.groups : [];
	if (!coordinatorUrl) {
		return {
			reason: "coordinator_url_missing",
			message: "Configure a coordinator URL before pairing team devices.",
		};
	}
	if (!groups.some((group) => cleanText(group))) {
		return {
			reason: "coordinator_groups_empty",
			message: "Join or configure a team before pairing team devices.",
		};
	}
	if (coordinator?.sync_enabled === false) {
		return {
			reason: "sync_disabled",
			message: "Enable sync before pairing team devices.",
		};
	}
	return null;
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

function duplicateAttentionItems(
	duplicatePeople: ReturnType<typeof deriveDuplicatePeople>,
): UiSyncAttentionItem[] {
	return duplicatePeople.map((candidate) => ({
		id: `duplicate:${candidate.actorIds.join(":")}`,
		kind: "possible-duplicate-person",
		priority: candidate.includesLocal ? 5 : 15,
		title: `Possible duplicate person: ${candidate.displayName}`,
		summary: candidate.includesLocal
			? "At least one entry is marked as you. Confirm whether these records represent the same person."
			: "Multiple people share this name. Confirm whether they should stay separate or be combined.",
		actionLabel: "Go to people",
		actorIds: candidate.actorIds,
	}));
}

function identityConflictItem(device: MergedDevice, name: string): UiSyncAttentionItem | null {
	const discoveredFingerprint = cleanText(device.discovered?.fingerprint);
	const peerFingerprint = cleanText(device.peer?.fingerprint);
	if (!device.peer || !discoveredFingerprint || !peerFingerprint) return null;
	if (discoveredFingerprint === peerFingerprint) return null;
	return createRepairItem({
		id: device.deviceId,
		name,
		title: `${name} needs review`,
		summary: "This device identity changed. Remove the older local record before reconnecting it.",
	});
}

function peerAttentionItems(device: MergedDevice, name: string): UiSyncAttentionItem[] {
	if (!device.peer) return [];
	const items: UiSyncAttentionItem[] = [];
	const peerStatus = derivePeerUiStatus(device.peer);
	const trustSummary = derivePeerTrustSummary(device.peer);
	if (peerStatus === "needs-repair") {
		items.push(
			createRepairItem({
				id: device.deviceId,
				name,
				title:
					trustSummary.state === "needs-repairing"
						? `${name} needs re-pairing`
						: `${name} needs review`,
				summary:
					trustSummary.description || cleanText(device.peer.last_error) || "Sync needs review.",
			}),
		);
	}
	if (trustSummary.state === "trusted-by-you") {
		items.push(
			createReviewItem({
				id: device.deviceId,
				key: "other-device-trust",
				name,
				summary:
					"You accepted this device. Finish onboarding on the other device so it trusts this one too.",
			}),
		);
	}
	if (
		deviceNeedsFriendlyName({
			localName: device.localName,
			coordinatorName: device.coordinatorName,
			deviceId: device.deviceId,
		})
	) {
		items.push(
			createNamingItem({
				id: device.deviceId,
				name,
				summary: "Give this device a friendly name so it is easier to recognize later.",
			}),
		);
	}
	return items;
}

function deviceAttentionItems(device: MergedDevice): UiSyncAttentionItem[] {
	const name = resolveFriendlyDeviceName({
		localName: device.localName,
		coordinatorName: device.coordinatorName,
		deviceId: device.deviceId,
	});
	const conflict = identityConflictItem(device, name);
	if (conflict) return [conflict];
	// Offline devices remain visible in their device row without becoming a
	// second task. Only repair, trust, and naming work belongs in attention.
	return peerAttentionItems(device, name);
}

export function deriveSyncViewModel(input: {
	actors?: ActorLike[];
	peers?: PeerLike[];
	coordinator?: {
		configured?: boolean;
		sync_enabled?: boolean;
		presence_status?: TeamSyncPresenceState;
		groups?: unknown[];
		discovered_devices?: DiscoveredDeviceLike[];
	};
	status?: {
		enabled?: boolean;
		daemon_state?: TeamSyncDaemonState;
		daemon_running?: boolean;
	} | null;
	shareOperations?: ProjectShareOperationLike[];
	shareOperationsLoadError?: boolean;
	reconciliation?: RecipientPolicyReconciliationLike | null;
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
	const attentionItems = [
		...duplicateAttentionItems(duplicatePeople),
		...mergedDevices.flatMap(deviceAttentionItems),
	];

	return {
		primaryStatus: deriveTeamSyncPrimaryStatus({
			status: input.status,
			coordinator: input.coordinator,
			peers,
			shareOperations: input.shareOperations,
			shareOperationsLoadError: input.shareOperationsLoadError,
			reconciliation: input.reconciliation,
		}),
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
