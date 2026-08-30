import { describe, expect, it } from "vitest";
import type { LegacyTeamSetupDeviceV1, LegacyTeamSetupProjectV1 } from "../lib/api";
import { orderedSetupDevices, orderedSetupProjects } from "./legacy-team-setup-order";

describe("legacy Team setup ordering", () => {
	it("puts unresolved devices first without mutating the server view", () => {
		const included = { deviceRef: "included", displayName: "Alpha", decision: "included" };
		const unresolved = { deviceRef: "unresolved", displayName: "Sarvar", decision: "unresolved" };
		const devices = [included, unresolved] as LegacyTeamSetupDeviceV1[];

		expect(orderedSetupDevices(devices).map((device) => device.deviceRef)).toEqual([
			"unresolved",
			"included",
		]);
		expect(devices.map((device) => device.deviceRef)).toEqual(["included", "unresolved"]);
	});

	it("puts unresolved Projects before automatic mappings", () => {
		const automatic = {
			projectRef: "automatic",
			displayName: "Alpha",
			resolution: "deterministic",
		};
		const unresolved = {
			projectRef: "unresolved",
			displayName: "Zulu",
			resolution: "unresolved",
		};

		expect(
			orderedSetupProjects([automatic, unresolved] as LegacyTeamSetupProjectV1[]).map(
				(project) => project.projectRef,
			),
		).toEqual(["unresolved", "automatic"]);
	});

	it("preserves server order within unresolved and reviewed groups", () => {
		const devices = [
			{ deviceRef: "included-a", decision: "included" },
			{ deviceRef: "unresolved-a", decision: "unresolved" },
			{ deviceRef: "included-b", decision: "included" },
			{ deviceRef: "unresolved-b", decision: "unresolved" },
		] as LegacyTeamSetupDeviceV1[];

		expect(orderedSetupDevices(devices).map((device) => device.deviceRef)).toEqual([
			"unresolved-a",
			"unresolved-b",
			"included-a",
			"included-b",
		]);
	});
});
