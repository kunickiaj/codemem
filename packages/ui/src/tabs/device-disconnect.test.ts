import { afterEach, expect, it, vi } from "vitest";
import { state } from "../lib/state";
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

afterEach(() => {
	state.lastSyncCoordinator = null;
});

it.each([
	[
		"with a coordinator, says codemem can pair the devices again and where to stop on all devices",
		true,
		"This device stops syncing with Desk. If both devices share a Team Project, codemem can pair them again automatically. To stop syncing with Desk on all your devices, use Remove device.",
	],
	[
		"without a coordinator, says the device keeps syncing with the other devices",
		false,
		"This device stops syncing with Desk. Desk keeps syncing with your other devices.",
	],
])("%s, and focuses the safe choice", async (_name, configured, description) => {
	state.lastSyncCoordinator = configured ? { configured: true } : null;
	const confirm = vi.fn(async (_options: { description: string }) => false);

	await confirmAndDisconnectDevice(device, { confirm, disconnect: vi.fn() });

	expect(confirm).toHaveBeenCalledExactlyOnceWith({
		title: "Unpair Desk?",
		description,
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
