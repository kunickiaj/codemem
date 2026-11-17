import { describe, expect, it, vi } from "vitest";
import { DeviceRetirementError } from "../lib/api/sync";
import { runDeviceRetirement } from "./device-retire";

const device = { deviceId: "old-laptop", displayName: "Old laptop" };
const preview = {
	device_id: "old-laptop",
	display_name: "",
	enrollment_device_id: "old-laptop",
	alias_device_ids: ["old-laptop"],
	group_id: "group-a",
	coordinator_id: "https://coordinator.example.test",
	key_id: "b".repeat(64),
	expected_digest: "a".repeat(64),
};

function api(overrides: Partial<Parameters<typeof runDeviceRetirement>[1]> = {}) {
	return {
		preview: vi.fn(async () => preview),
		commit: vi.fn(async () => ({ unpaired_here: true })),
		confirm: vi.fn(async () => true),
		...overrides,
	};
}

describe("runDeviceRetirement", () => {
	it("does nothing when the person keeps the device", async () => {
		const calls = api({ confirm: vi.fn(async () => false) });

		expect(await runDeviceRetirement(device, calls)).toBeNull();
		expect(calls.commit).not.toHaveBeenCalled();
	});

	it("explains a missing admin secret before asking for confirmation", async () => {
		const calls = api({
			preview: vi.fn(async () => {
				throw new DeviceRetirementError("coordinator_admin_required");
			}),
		});

		const outcome = await runDeviceRetirement(device, calls);

		expect(outcome).toMatchObject({ retired: false, tone: "warning" });
		expect(outcome?.message).toContain("coordinator admin secret");
		expect(calls.confirm).not.toHaveBeenCalled();
	});

	it("names the server's device and every ID that loses its key", async () => {
		const calls = api({
			preview: vi.fn(async () => ({
				...preview,
				display_name: "Work laptop",
				enrollment_device_id: "coord-alias",
				alias_device_ids: ["coord-alias", "old-laptop"],
			})),
		});

		await runDeviceRetirement(device, calls);

		expect(calls.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Retire Work laptop?",
				description: expect.stringContaining(
					"under all 2 of its device IDs, along with device ID coord-alias",
				),
			}),
		);
	});

	it("reports an unconfirmed commit without claiming the device is retired", async () => {
		const calls = api({
			commit: vi.fn(async () => {
				throw new DeviceRetirementError("retire_outcome_unknown");
			}),
		});

		const outcome = await runDeviceRetirement(device, calls);

		expect(outcome).toMatchObject({ retired: false, refresh: true, tone: "warning" });
		expect(outcome?.message).toContain("didn't confirm the retirement");
	});

	it.each([
		{ name: "a lost response", error: new TypeError("Failed to fetch") },
		{ name: "an unreadable error", error: new DeviceRetirementError("retire_response_invalid") },
	])("treats $name from the commit as an unknown outcome and refreshes", async (row) => {
		const calls = api({
			commit: vi.fn(async () => {
				throw row.error;
			}),
		});

		const outcome = await runDeviceRetirement(device, calls);

		expect(outcome).toMatchObject({ retired: false, refresh: true, tone: "warning" });
		expect(outcome?.message).toContain("Refresh Devices to check whether it finished");
	});

	it("reports a refused commit without refreshing", async () => {
		const calls = api({
			commit: vi.fn(async () => {
				throw new DeviceRetirementError("retire_preview_stale");
			}),
		});

		expect(await runDeviceRetirement(device, calls)).toMatchObject({
			retired: false,
			refresh: false,
			message: "The device changed while you were confirming. Try again.",
		});
	});
});
