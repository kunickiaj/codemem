import { describe, expect, it } from "vitest";

import {
	coordinatorAdminDeviceCardCopy,
	createUnnamedDeviceAliasRegistry,
	stableDeviceDisplayNames,
	stableUnnamedDeviceAliases,
} from "./device-card";

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
			"Unnamed device 1",
		);

		expect(copy.displayName).toBe("Unnamed device 1");
		expect(copy.displayName).not.toContain("dev-b");
		expect(copy.statusLabel).toBe("Disabled in this coordinator group");
		expect(copy.teamId).toBe("active-team");
		expect(copy.advancedDetail).toContain("Group ID active-team");
	});

	it("assigns stable distinct aliases to unnamed devices without exposing their ids", () => {
		const registry = createUnnamedDeviceAliasRegistry();
		const aliases = stableUnnamedDeviceAliases(
			[
				{ device_id: "private-device-z", display_name: "" },
				{ device_id: "private-device-a", display_name: null },
				{ device_id: "named-device", display_name: "Laptop" },
			],
			registry,
		);

		expect(aliases.get("private-device-a")).toBe("Unnamed device 1");
		expect(aliases.get("private-device-z")).toBe("Unnamed device 2");
		expect([...aliases.values()].join(" ")).not.toContain("private-device");
		expect(aliases.has("named-device")).toBe(false);

		stableUnnamedDeviceAliases(
			[
				{ device_id: "private-device-0", display_name: "" },
				{ device_id: "private-device-z", display_name: "" },
			],
			registry,
		);
		expect(aliases.get("private-device-z")).toBe("Unnamed device 2");
		expect(aliases.get("private-device-0")).toBe("Unnamed device 3");
	});

	it("reserves explicit device names before allocating aliases", () => {
		const aliases = stableUnnamedDeviceAliases([
			{ device_id: "named-device", display_name: "Unnamed device 1" },
			{ device_id: "private-device-a", display_name: null },
			{ device_id: "private-device-b", display_name: "" },
		]);

		expect(aliases.get("private-device-a")).toBe("Unnamed device 2");
		expect(aliases.get("private-device-b")).toBe("Unnamed device 3");
	});

	it("reallocates an alias when a later surface reserves its display name", () => {
		const registry = createUnnamedDeviceAliasRegistry();
		stableUnnamedDeviceAliases([{ device_id: "join-unnamed", display_name: null }], registry);
		expect(registry.aliases.get("join-unnamed")).toBe("Unnamed device 1");

		stableUnnamedDeviceAliases(
			[
				{ device_id: "enrolled-named", display_name: "Unnamed device 1" },
				{ device_id: "join-unnamed", display_name: null },
			],
			registry,
		);

		expect(registry.aliases.get("join-unnamed")).toBe("Unnamed device 2");
	});

	it("keeps duplicate-name labels stable as devices are added", () => {
		const registry = createUnnamedDeviceAliasRegistry();
		const initial = stableDeviceDisplayNames(
			[
				{ device_id: "private-device-a", display_name: "NAS" },
				{ device_id: "private-device-z", display_name: "NAS" },
			],
			registry,
		);
		expect(initial.get("private-device-z")).toBe("NAS · Device 2");

		const updated = stableDeviceDisplayNames(
			[
				{ device_id: "private-device-a", display_name: "NAS" },
				{ device_id: "private-device-b", display_name: "NAS" },
				{ device_id: "private-device-z", display_name: "NAS" },
			],
			registry,
		);
		expect(updated.get("private-device-a")).toBe("NAS · Device 1");
		expect(updated.get("private-device-b")).toBe("NAS · Device 3");
		expect(updated.get("private-device-z")).toBe("NAS · Device 2");
	});

	it("avoids collisions with explicit names while mixing named and unnamed devices", () => {
		const names = stableDeviceDisplayNames([
			{ device_id: "private-device-a", display_name: "NAS" },
			{ device_id: "private-device-z", display_name: "NAS" },
			{ device_id: "private-device-m", display_name: "NAS · Device 1" },
			{ device_id: "private-device-u", display_name: "" },
		]);

		expect(names.get("private-device-a")).toBe("NAS · Device 2");
		expect(names.get("private-device-z")).toBe("NAS · Device 3");
		expect(names.get("private-device-m")).toBe("NAS · Device 1");
		expect(names.get("private-device-u")).toBe("Unnamed device 1");
		expect(new Set(names.values())).toHaveLength(4);
		expect([...names.values()].join(" ")).not.toContain("private-device");
	});
});
