import { expect, it, vi } from "vitest";
import { confirmAndDisconnectDevice } from "./device-disconnect";

const device = { deviceId: "fixture-peer", displayName: "Desk" };

it("does nothing when the person keeps the connection", async () => {
	const disconnect = vi.fn();

	const feedback = await confirmAndDisconnectDevice(device, {
		confirm: vi.fn(async () => false),
		disconnect,
	});

	expect(feedback).toBeNull();
	expect(disconnect).not.toHaveBeenCalled();
});

it("explains that only this device changes and focuses the safe choice", async () => {
	const confirm = vi.fn(async (_options: { description: string }) => false);

	await confirmAndDisconnectDevice(device, { confirm, disconnect: vi.fn() });

	expect(confirm).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			title: "Disconnect from Desk?",
			confirmLabel: "Disconnect",
			autoFocusAction: "cancel",
		}),
	);
	expect(confirm.mock.calls[0]?.[0]?.description).toContain(
		"The coordinator and your other devices are not changed",
	);
});

it("shows administrator guidance when the device stays in Projects", async () => {
	const feedback = await confirmAndDisconnectDevice(device, {
		confirm: vi.fn(async () => true),
		disconnect: vi.fn(async () => ({ binding: "kept" })),
	});

	expect(feedback?.message).toBe(
		"Disconnected this device from Desk. The device stays in Projects. An administrator's device can remove it.",
	);
	expect(feedback?.tone).toBe("success");
});

it("reports a plain disconnect when the binding ended", async () => {
	const feedback = await confirmAndDisconnectDevice(device, {
		confirm: vi.fn(async () => true),
		disconnect: vi.fn(async () => ({ binding: "ended" })),
	});

	expect(feedback?.message).toBe("Disconnected this device from Desk.");
});

it("says the pairing is still there when disconnecting fails", async () => {
	const feedback = await confirmAndDisconnectDevice(device, {
		confirm: vi.fn(async () => true),
		disconnect: vi.fn(() => Promise.reject(null)),
	});

	expect(feedback).toEqual({
		message: "Could not disconnect from Desk. This device is still paired with it.",
		tone: "warning",
	});
});
