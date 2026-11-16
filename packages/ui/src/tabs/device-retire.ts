import {
	DeviceRetirementError,
	type DeviceRetirementPreview,
	previewDeviceRetirement,
	retireDevice,
} from "../lib/api/sync";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

export interface DeviceRetirementApi {
	preview: (deviceId: string) => Promise<DeviceRetirementPreview>;
	commit: (preview: DeviceRetirementPreview) => Promise<{ unpaired_here: boolean }>;
	confirm: typeof openSyncConfirmDialog;
}

export const defaultDeviceRetirementApi: DeviceRetirementApi = {
	preview: previewDeviceRetirement,
	commit: retireDevice,
	confirm: openSyncConfirmDialog,
};

const FAILURE_COPY: Record<string, string> = {
	coordinator_admin_required:
		"Retiring a device needs the coordinator admin secret in this viewer's coordinator settings.",
	device_not_enrolled:
		"The coordinator doesn't list this device, so it can't be retired. Unpair it on each device instead.",
	device_enrollment_conflict:
		"The coordinator lists this device with different keys, or its key under another device. Review it in Advanced before retiring it.",
	device_already_retired: "This device is already retired. Refresh Devices.",
	cannot_retire_this_device: "This is the device you're using, so it can't be retired from here.",
	device_key_unrecognized:
		"The coordinator has a key for this device that codemem can't read, so it can't be retired from here. Retire it with the coordinator device revoke command instead.",
	local_identity_unverified:
		"This viewer can't confirm its own device identity, so retiring could affect this device. Restart the viewer and try again.",
	coordinator_evidence_too_large:
		"The coordinator has too many groups or devices to find this device's enrollment. Retire it with the coordinator device revoke command instead.",
	retire_preview_stale: "The device changed while you were confirming. Try again.",
	retire_target_unavailable: "The coordinator no longer lists this device. Refresh Devices.",
	retire_outcome_unknown:
		"The coordinator didn't confirm the retirement. Refresh Devices to check whether it finished before trying again.",
};

export interface DeviceRetirementOutcome {
	message: string;
	tone: "success" | "warning";
	retired: boolean;
	/** Devices should reload, because the device was or may have been retired. */
	refresh: boolean;
}

/** Commit failures where the server stopped before or was refused by the coordinator. */
const COMMIT_REJECTIONS = new Set([
	"device_id_required",
	"retire_preview_required",
	"coordinator_admin_required",
	"retire_unavailable",
	"retire_preview_stale",
	"retire_target_unavailable",
	"device_not_enrolled",
	"device_enrollment_conflict",
	"device_already_retired",
	"cannot_retire_this_device",
	"device_key_unrecognized",
	"local_identity_unverified",
	"coordinator_evidence_too_large",
]);

/** Anything but a known refusal, including a lost response, may have retired the device. */
function commitFailure(error: unknown): DeviceRetirementOutcome {
	if (error instanceof DeviceRetirementError && COMMIT_REJECTIONS.has(error.code))
		return { message: failureMessage(error), tone: "warning", retired: false, refresh: false };
	return {
		message: FAILURE_COPY.retire_outcome_unknown ?? "",
		tone: "warning",
		retired: false,
		refresh: true,
	};
}

function failureMessage(error: unknown): string {
	const code = error instanceof DeviceRetirementError ? error.code : "";
	return (
		FAILURE_COPY[code] ??
		"The coordinator can't retire devices right now. Its operator may need to turn on device revocation."
	);
}

function confirmDescription(preview: DeviceRetirementPreview): string {
	const otherIds = preview.alias_device_ids.filter((id) => id !== preview.enrollment_device_id);
	const scope =
		otherIds.length > 0
			? `Its key is revoked across the coordinator under all ${otherIds.length + 1} of its device IDs, along with device ID ${preview.enrollment_device_id}.`
			: "Its device ID and key are revoked across the coordinator.";
	return `${scope} Every device that uses the coordinator stops syncing with it at its next refresh, including direct pairings. It can't rejoin with this key. Memories already on it stay there.`;
}

/**
 * Previews a retirement, asks the person to confirm the exact scope, then commits it.
 * Returns null when the person cancels.
 */
export async function runDeviceRetirement(
	device: { deviceId: string; displayName: string },
	api: DeviceRetirementApi = defaultDeviceRetirementApi,
): Promise<DeviceRetirementOutcome | null> {
	let preview: DeviceRetirementPreview;
	try {
		preview = await api.preview(device.deviceId);
	} catch (error) {
		return { message: failureMessage(error), tone: "warning", retired: false, refresh: false };
	}
	const name = preview.display_name || device.displayName;
	const confirmed = await api.confirm({
		title: `Retire ${name}?`,
		description: confirmDescription(preview),
		confirmLabel: "Retire device",
		cancelLabel: "Keep device",
		autoFocusAction: "cancel",
		tone: "danger",
	});
	if (!confirmed) return null;
	try {
		await api.commit(preview);
	} catch (error) {
		return commitFailure(error);
	}
	return {
		message: `${name} is retired. Other devices drop it at their next coordinator refresh.`,
		tone: "success",
		retired: true,
		refresh: true,
	};
}
