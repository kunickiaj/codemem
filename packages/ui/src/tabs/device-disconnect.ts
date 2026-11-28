import { deletePeer } from "../lib/api/sync";
import { friendlyError } from "../lib/form";
import { state } from "../lib/state";
import type { SyncActionFeedback } from "./sync/components/sync-inline-feedback";
import { peerRemovalFeedback } from "./sync/peer-removal-feedback";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

export interface DeviceDisconnectDependencies {
	confirm: typeof openSyncConfirmDialog;
	disconnect: (deviceId: string) => Promise<unknown>;
}

const defaults: DeviceDisconnectDependencies = {
	confirm: openSyncConfirmDialog,
	disconnect: deletePeer,
};

/**
 * What the confirmation says. With a coordinator, devices that share a Team Project can be
 * paired again automatically, so it names Remove device as the way to stop everywhere.
 * Without one, nothing pairs them again, and the only other change to name is that the
 * device keeps syncing with this person's other devices.
 */
export function unpairDescription(name: string, coordinatorConfigured: boolean): string {
	if (coordinatorConfigured) {
		return `This device stops syncing with ${name}. If both devices share a Team Project, codemem can pair them again automatically. To stop syncing with ${name} on all your devices, use Remove device.`;
	}
	return `This device stops syncing with ${name}. ${name} keeps syncing with your other devices.`;
}

/** Whether a coordinator is configured, as the last sync status read reported it. */
export function coordinatorIsConfigured(): boolean {
	return state.lastSyncCoordinator?.configured === true;
}

/**
 * Unpairs this device from a paired device, on every device and whatever the coordinator says
 * about it. It deletes only this device's pairing and sync progress for that peer. It never
 * changes the peer's Identity binding or Project access. Remove device does that and needs
 * the admin secret. Returns null when the person cancels.
 */
export async function confirmAndDisconnectDevice(
	device: { deviceId: string; displayName: string },
	dependencies: Partial<DeviceDisconnectDependencies> = {},
): Promise<SyncActionFeedback | null> {
	const { confirm, disconnect } = { ...defaults, ...dependencies };
	const name = device.displayName;
	const confirmed = await confirm({
		title: `Unpair ${name}?`,
		description: unpairDescription(name, coordinatorIsConfigured()),
		confirmLabel: "Unpair",
		cancelLabel: "Keep paired",
		autoFocusAction: "cancel",
		tone: "danger",
	});
	if (!confirmed) return null;
	try {
		const result = await disconnect(device.deviceId);
		return peerRemovalFeedback(result, { label: name });
	} catch (error) {
		return {
			message: friendlyError(
				error,
				`Could not unpair ${name}. This device is still paired with it.`,
			),
			tone: "warning",
		};
	}
}
