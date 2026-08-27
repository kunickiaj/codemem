import { describe, expect, it } from "vitest";

import { coordinatorAdminDeviceCardCopy } from "./device-card";

describe("coordinator admin device card copy", () => {
	it("demotes raw device and coordinator group IDs to advanced copy", () => {
		const copy = coordinatorAdminDeviceCardCopy(
			{ device_id: "dev-a", display_name: "Alice laptop", enabled: true, group_id: "team-a" },
			"fallback-team",
		);

		expect(copy.displayName).toBe("Alice laptop");
		expect(copy.statusLabel).toBe("Enabled in this coordinator group");
		expect(copy.statusLabel).not.toContain("dev-a");
		expect(copy.advancedDetail).toBe("Advanced: Device ID dev-a · Group ID team-a");
	});

	it("uses the active coordinator group as a fallback for older device payloads", () => {
		const copy = coordinatorAdminDeviceCardCopy(
			{ device_id: "dev-b", display_name: "", enabled: false },
			"active-team",
		);

		expect(copy.displayName).toBe("dev-b");
		expect(copy.statusLabel).toBe("Disabled in this coordinator group");
		expect(copy.teamId).toBe("active-team");
		expect(copy.advancedDetail).toContain("Group ID active-team");
	});
});
