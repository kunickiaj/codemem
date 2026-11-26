import { describe, expect, it } from "vitest";
import type { DeviceIdentityInventoryItemV1, DeviceIdentityInventoryV1 } from "./api/sync";
import { withoutServiceDevices } from "./device-identity-inventory";

function item(
	deviceId: string,
	state: DeviceIdentityInventoryItemV1["state"],
	evidenceDeviceIds: string[] = [deviceId],
): DeviceIdentityInventoryItemV1 {
	return {
		version: 1,
		deviceId,
		evidenceDeviceIds,
		displayName: deviceId,
		state,
		identityId: null,
		suggestedIdentityId: null,
		validatedFingerprint: null,
		isLocal: false,
		sources: ["coordinator_enrollment"],
		conflictCodes: [],
	};
}

function inventory(...items: DeviceIdentityInventoryItemV1[]): DeviceIdentityInventoryV1 {
	return {
		version: 1,
		items,
		coordinatorEvidence: { availability: "available", safeErrorCode: null },
		truncated: false,
	};
}

const coordinator = {
	configured: true,
	discovered_devices: [
		{ device_id: "relay-probe", display_name: "Relay health probe" },
		{ device_id: "laptop", display_name: "Laptop" },
	],
};

describe("withoutServiceDevices", () => {
	it("drops a discovered device the inventory classifies as a service", () => {
		const result = withoutServiceDevices(
			coordinator,
			inventory(item("relay-probe", "service"), item("laptop", "configured")),
		);

		expect(result.discovered_devices?.map((device) => device.device_id)).toEqual(["laptop"]);
		expect(result.configured).toBe(true);
	});

	it("matches a service item's evidence device ids too", () => {
		const result = withoutServiceDevices(
			coordinator,
			inventory(item("service-identity", "service", ["relay-probe"])),
		);

		expect(result.discovered_devices?.map((device) => device.device_id)).toEqual(["laptop"]);
	});

	it("keeps every device while the inventory has not loaded", () => {
		expect(withoutServiceDevices(coordinator, null)).toBe(coordinator);
		expect(withoutServiceDevices(coordinator, undefined)).toBe(coordinator);
	});

	it("does not decide from the device name or id", () => {
		const result = withoutServiceDevices(coordinator, inventory(item("laptop", "configured")));

		expect(result.discovered_devices).toHaveLength(2);
	});

	it("passes through a missing coordinator", () => {
		expect(withoutServiceDevices(null, inventory(item("relay-probe", "service")))).toBeNull();
	});
});
