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
 * Stops this device from syncing with a paired device, whatever the coordinator says about
 * it. Remove device acts on the coordinator and needs the admin secret. This acts only here,
 * so a device without that secret can still withdraw its own pairing. Returns null when the
 * person cancels.
 */
export async function confirmAndDisconnectDevice(
	device: { deviceId: string; displayName: string },
	dependencies: Partial<DeviceDisconnectDependencies> = {},
): Promise<SyncActionFeedback | null> {
	const { confirm, disconnect } = { ...defaults, ...dependencies };
	const name = device.displayName;
	const confirmed = await confirm({
		title: `Disconnect from ${name}?`,
		description: `This device stops syncing with ${name}. The coordinator and your other devices are not changed, so they keep syncing with it. To stop sharing with it everywhere, use Remove device.`,
		confirmLabel: "Disconnect",
		cancelLabel: "Keep connected",
		autoFocusAction: "cancel",
		tone: "danger",
	});
	if (!confirmed) return null;
	try {
		const result = await disconnect(device.deviceId);
		return peerRemovalFeedback(result, {
			label: name,
			removedMessage: `Disconnected this device from ${name}.`,
		});
	} catch (error) {
		return {
			message: friendlyError(
				error,
				`Could not disconnect from ${name}. This device is still paired with it.`,
			),
			tone: "warning",
		};
	}
}
