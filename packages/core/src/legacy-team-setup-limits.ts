import type { Database } from "./db.js";

export const LEGACY_TEAM_SETUP_MAX_DEVICES = 500;
export const LEGACY_TEAM_SETUP_MAX_PROJECTS = 500;

export function requireLegacyTeamSetupSnapshotWithinLimits(input: {
	devices: readonly unknown[];
	projects: readonly unknown[];
}): void {
	if (
		input.devices.length > LEGACY_TEAM_SETUP_MAX_DEVICES ||
		input.projects.length > LEGACY_TEAM_SETUP_MAX_PROJECTS
	) {
		throw new Error("legacy_team_setup_roster_too_large");
	}
}

export function requireLegacyTeamSetupEffectiveDevicesWithinLimit(
	db: Database,
	devices: readonly { deviceId: string }[],
	previousAttemptId: string | null,
): void {
	if (!previousAttemptId) return;
	const currentDeviceIds = [...new Set(devices.map((device) => device.deviceId))];
	const placeholders = currentDeviceIds.map(() => "?").join(", ");
	const excludeCurrent = placeholders ? `AND device_id NOT IN (${placeholders})` : "";
	const carriedDeviceCount = Number(
		db
			.prepare(
				`SELECT COUNT(*) FROM legacy_team_setup_draft_devices
				 WHERE attempt_id = ? ${excludeCurrent}`,
			)
			.pluck()
			.get(previousAttemptId, ...currentDeviceIds) ?? 0,
	);
	if (devices.length + carriedDeviceCount > LEGACY_TEAM_SETUP_MAX_DEVICES) {
		throw new Error("legacy_team_setup_roster_too_large");
	}
}
