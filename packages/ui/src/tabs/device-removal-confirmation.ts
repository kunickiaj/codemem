import { fetchJson } from "../lib/api/internal";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

export interface DeviceRemovalPreview {
	device_id: string;
	rejoin: "invitation" | "sign_in" | "none";
	expected_digest: string;
	key_id: string | null;
}

export interface DeviceRemovalConfirmationDependencies {
	preview: (deviceId: string) => Promise<unknown>;
	confirm: typeof openSyncConfirmDialog;
}

export class DeviceRemovalPreviewError extends Error {
	readonly code = "device_removal_preview_invalid";

	constructor() {
		super("The device removal preview is invalid.");
		this.name = "DeviceRemovalPreviewError";
	}
}

function validatePreview(value: unknown, deviceId: string): DeviceRemovalPreview {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new DeviceRemovalPreviewError();
	}
	const preview = value as Record<string, unknown>;
	if (
		preview.device_id !== deviceId ||
		(preview.rejoin !== "invitation" &&
			preview.rejoin !== "sign_in" &&
			preview.rejoin !== "none") ||
		typeof preview.expected_digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(preview.expected_digest) ||
		(preview.key_id !== null && typeof preview.key_id !== "string")
	) {
		throw new DeviceRemovalPreviewError();
	}
	return {
		device_id: deviceId,
		rejoin: preview.rejoin,
		expected_digest: preview.expected_digest,
		key_id: preview.key_id as string | null,
	};
}

function rejoinDescription(name: string, rejoin: DeviceRemovalPreview["rejoin"]): string {
	switch (rejoin) {
		case "invitation":
			return `To bring ${name} back, create a new invitation in Sharing and accept it on ${name}.`;
		case "sign_in":
			return `To bring ${name} back, sign in with Google on ${name}. Whoever can sign in to that account on ${name} can bring it back.`;
		case "none":
			return `${name} is linked to a Google account and cannot be added back after you remove it. It would have to be set up as a new device.`;
	}
}

function confirmDescription(
	name: string,
	rejoin: DeviceRemovalPreview["rejoin"],
	olderDeviceNames: readonly string[],
): string {
	const body = `Your devices stop syncing with ${name}. Devices that are online stop within a few minutes. A device that is offline stops when it next connects. Memories already on ${name} stay there, and memories it already sent stay on your devices. Your other devices keep syncing with each other. ${rejoinDescription(name, rejoin)}`;
	if (olderDeviceNames.length === 0) return body;
	return `${body}\n\n${olderDeviceNames.length} devices run an older version of codemem and keep syncing with ${name} until they update: ${olderDeviceNames.join(", ")}.`;
}

const defaultDependencies: DeviceRemovalConfirmationDependencies = {
	preview: (deviceId) =>
		fetchJson<unknown>(`/api/sync/devices/${encodeURIComponent(deviceId)}/remove/preview`, {
			method: "POST",
		}),
	confirm: openSyncConfirmDialog,
};

/** Reviews a read-only server preview. The caller owns any later removal request. */
export async function runDeviceRemovalConfirmation(
	device: { deviceId: string; displayName: string; olderDeviceNames?: readonly string[] },
	dependencies: Partial<DeviceRemovalConfirmationDependencies> = {},
): Promise<DeviceRemovalPreview | null> {
	if (!device.deviceId.trim()) throw new DeviceRemovalPreviewError();
	const { preview, confirm } = { ...defaultDependencies, ...dependencies };
	const reviewed = validatePreview(await preview(device.deviceId), device.deviceId);
	const confirmed = await confirm({
		title: `Remove ${device.displayName}?`,
		description: confirmDescription(
			device.displayName,
			reviewed.rejoin,
			device.olderDeviceNames ?? [],
		),
		confirmLabel: "Remove device",
		cancelLabel: "Keep device",
		autoFocusAction: "cancel",
		tone: "danger",
	});
	return confirmed === true ? reviewed : null;
}
