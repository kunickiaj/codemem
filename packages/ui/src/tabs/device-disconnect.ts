import { deletePeer } from "../lib/api/sync";
import { friendlyError } from "../lib/form";
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
		description: `This device stops syncing with ${name}. ${name} stays in your Teams and keeps syncing with your other devices. Memories already synced stay on both devices.`,
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
