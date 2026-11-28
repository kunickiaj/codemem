import { expect, it, vi } from "vitest";
import { confirmAndDisconnectDevice } from "./device-disconnect";

const device = { deviceId: "fixture-peer", displayName: "Desk" };

it("does nothing when the person keeps the pairing", async () => {
	const disconnect = vi.fn();

	const feedback = await confirmAndDisconnectDevice(device, {
		confirm: vi.fn(async () => false),
		disconnect,
	});

	expect(feedback).toBeNull();
	expect(disconnect).not.toHaveBeenCalled();
});

it("says sync can resume and where to stop it everywhere, and focuses the safe choice", async () => {
	const confirm = vi.fn(async (_options: { description: string }) => false);

	await confirmAndDisconnectDevice(device, { confirm, disconnect: vi.fn() });

	expect(confirm).toHaveBeenCalledExactlyOnceWith({
		title: "Unpair Desk?",
		description:
			"This device stops syncing with Desk until they pair again. If both devices are in a Team, codemem pairs them again automatically. To stop syncing with Desk on every device, use Remove device.",
		confirmLabel: "Unpair",
		cancelLabel: "Keep paired",
		autoFocusAction: "cancel",
		tone: "danger",
	});
});

it("reports the unpairing", async () => {
	const feedback = await confirmAndDisconnectDevice(device, {
		confirm: vi.fn(async () => true),
		disconnect: vi.fn(async () => ({ binding: "kept" })),
	});

	expect(feedback).toEqual({
		message: "Unpaired this device from Desk.",
		tone: "success",
	});
});

it("says the pairing is still there when unpairing fails", async () => {
	const feedback = await confirmAndDisconnectDevice(device, {
		confirm: vi.fn(async () => true),
		disconnect: vi.fn(() => Promise.reject(null)),
	});

	expect(feedback).toEqual({
		message: "Could not unpair Desk. This device is still paired with it.",
		tone: "warning",
	});
});
