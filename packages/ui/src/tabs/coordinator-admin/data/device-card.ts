import type { CachedCoordinatorAdminDevice } from "../../../lib/state";

export interface CoordinatorAdminDeviceCardCopy {
	deviceId: string;
	displayName: string;
	teamId: string;
	statusLabel: string;
	advancedDetail: string;
}

export function coordinatorAdminDeviceCardCopy(
	device: CachedCoordinatorAdminDevice,
	fallbackTeamId: string,
): CoordinatorAdminDeviceCardCopy {
	const deviceId = String(device.device_id || "").trim();
	const teamId = String(device.group_id || fallbackTeamId || "").trim();
	const displayName = String(device.display_name || deviceId || "Unnamed device");
	const enabled = device.enabled !== false && device.enabled !== 0;
	const advancedParts = [`Device ID ${deviceId || "unknown"}`];
	if (teamId) advancedParts.push(`Team ID ${teamId}`);
	return {
		advancedDetail: `Advanced: ${advancedParts.join(" · ")}`,
		deviceId,
		displayName,
		statusLabel: enabled ? "Enabled in this Team" : "Disabled in this Team",
		teamId,
	};
}
