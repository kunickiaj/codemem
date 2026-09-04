import type { Database } from "./db.js";

export const LEGACY_TEAM_SETUP_MAX_DEVICES = 500;
export const LEGACY_TEAM_SETUP_MAX_PROJECTS = 500;
export const LEGACY_TEAM_SETUP_MAX_PROJECT_DEVICE_PAIRS = 10_000;

export function requireLegacyTeamSetupSnapshotWithinLimits(input: {
	devices: readonly unknown[];
	projects: readonly unknown[];
}): void {
	if (
		input.devices.length > LEGACY_TEAM_SETUP_MAX_DEVICES ||
		input.projects.length > LEGACY_TEAM_SETUP_MAX_PROJECTS ||
		input.devices.length * input.projects.length > LEGACY_TEAM_SETUP_MAX_PROJECT_DEVICE_PAIRS
	) {
		throw new Error("legacy_team_setup_roster_too_large");
	}
}

/**
 * Bounds the access-delta derivation itself. Activation recomputes effective
 * devices for every Project the Team touches plus every Project with an
 * active recipient edge, across every assigned device, so a tiny draft can
 * still fan out past the pair budget when the installation already holds many
 * recipients or assignments.
 */
export function requireLegacyTeamSetupAccessDeltaTraversalWithinLimit(input: {
	projectIdentities: ReadonlySet<string>;
	deviceCount: number;
}): void {
	if (
		input.projectIdentities.size * input.deviceCount >
		LEGACY_TEAM_SETUP_MAX_PROJECT_DEVICE_PAIRS
	) {
		throw new Error("legacy_team_setup_roster_too_large");
	}
}

/**
 * Readiness checks re-derive effective devices for every completed Project,
 * and that derivation walks every persisted assignment row. Bound that fan-out
 * so a small roster cannot hide an unbounded Project-by-assignment traversal.
 */
export function requireLegacyTeamSetupReachableDevicesWithinLimit(
	db: Database,
	devices: readonly unknown[],
	projects: readonly unknown[],
): void {
	if (projects.length === 0) return;
	const assignmentRows = Number(
		db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get() ?? 0,
	);
	if (
		(devices.length + assignmentRows) * projects.length >
		LEGACY_TEAM_SETUP_MAX_PROJECT_DEVICE_PAIRS
	) {
		throw new Error("legacy_team_setup_roster_too_large");
	}
}

export function requireLegacyTeamSetupEffectiveDevicesWithinLimit(
	db: Database,
	devices: readonly { deviceId: string }[],
	projects: readonly unknown[],
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
	const effectiveDeviceCount = devices.length + carriedDeviceCount;
	if (
		effectiveDeviceCount > LEGACY_TEAM_SETUP_MAX_DEVICES ||
		effectiveDeviceCount * projects.length > LEGACY_TEAM_SETUP_MAX_PROJECT_DEVICE_PAIRS
	) {
		throw new Error("legacy_team_setup_roster_too_large");
	}
}
