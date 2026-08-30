import type { LegacyTeamSetupDeviceV1, LegacyTeamSetupProjectV1 } from "../lib/api";

export function orderedSetupDevices(
	devices: readonly LegacyTeamSetupDeviceV1[],
): LegacyTeamSetupDeviceV1[] {
	return [...devices].sort(
		(left, right) =>
			Number(right.decision === "unresolved") - Number(left.decision === "unresolved"),
	);
}

export function orderedSetupProjects(
	projects: readonly LegacyTeamSetupProjectV1[],
): LegacyTeamSetupProjectV1[] {
	return [...projects].sort(
		(left, right) =>
			Number(right.resolution === "unresolved") - Number(left.resolution === "unresolved"),
	);
}
