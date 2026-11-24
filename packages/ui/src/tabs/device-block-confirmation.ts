import type {
	CoordinatorDeviceRevocationCommit,
	CoordinatorDeviceRevocationPreview,
} from "@codemem/core";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

type Target = { groupId: string; deviceId: string; displayName: string };

/** The Viewer must supply its existing operator-approved Block transport. */
export interface DeviceBlockApi {
	preview(
		target: Pick<Target, "groupId" | "deviceId">,
	): Promise<CoordinatorDeviceRevocationPreview>;
	commit(preview: CoordinatorDeviceRevocationPreview): Promise<CoordinatorDeviceRevocationCommit>;
	confirm?: typeof openSyncConfirmDialog;
}

export function permanentBlockConfirmation(name: string) {
	return {
		title: `Block ${name} permanently?`,
		description: `This cannot be undone. Use it for a lost, stolen, or compromised machine. Every device stops syncing with ${name}, including devices paired with it directly. Devices that are online stop within a few minutes, and an offline device stops when it next connects. No invitation brings ${name} back. That machine can only return if it is set up again as a new device. Memories already on ${name} stay there, because blocking cannot erase them. Your other devices and their memories are not affected.`,
		confirmLabel: "Block permanently",
		cancelLabel: "Keep device",
		autoFocusAction: "cancel",
		tone: "danger",
	} as const;
}

/** The removed-device path never calls Remove or reuses an enrollment preview. */
export async function confirmAndBlockRemovedDevice(target: Target, api: DeviceBlockApi) {
	const { groupId, deviceId, displayName: name } = target;
	const { preview, confirm = openSyncConfirmDialog, commit } = api;
	const evidence = await preview({ groupId, deviceId });
	if (
		evidence.state !== "ready" ||
		evidence.group_id !== groupId ||
		evidence.device_id !== deviceId
	)
		throw new Error("Block preview does not match the selected device");
	const reviewed = { ...evidence };
	const approved = await confirm(permanentBlockConfirmation(name));
	if (approved !== true) return null;
	const result = await commit(reviewed);
	if (
		result.state !== "revoked" ||
		result.group_id !== groupId ||
		result.device_id !== deviceId ||
		result.coordinator_id !== reviewed.coordinator_id ||
		result.key_id !== reviewed.key_id
	)
		throw new Error("Block outcome could not be verified");
	return result;
}
