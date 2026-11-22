import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeviceRemovalPreview,
	DeviceRemovalPreviewError,
	runDeviceRemovalConfirmation,
} from "./device-removal-confirmation";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

vi.mock("./sync/sync-dialogs", () => ({ openSyncConfirmDialog: vi.fn() }));

const device = { deviceId: "old/laptop ?#", displayName: "Old laptop" };
const preview: DeviceRemovalPreview = {
	device_id: device.deviceId,
	rejoin: "invitation",
	expected_digest: "a".repeat(64),
	key_id: null,
};
const body =
	"Your devices stop syncing with Old laptop. Devices that are online stop within a few minutes. A device that is offline stops when it next connects. Memories already on Old laptop stay there, and memories it already sent stay on your devices. Your other devices keep syncing with each other.";
const invitationAdvice =
	"To bring Old laptop back, create a new invitation in Sharing and accept it on Old laptop.";

describe("runDeviceRemovalConfirmation", () => {
	beforeEach(() => {
		vi.mocked(openSyncConfirmDialog).mockReset().mockResolvedValue(true);
		// Every test replaces fetch so even an unexpected request cannot reach a service.
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected request")));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("posts only the encoded read-only preview route and returns the validated fields", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ ...preview, extra_server_field: "ignored" })),
			);
		vi.stubGlobal("fetch", fetch);

		expect(await runDeviceRemovalConfirmation(device)).toEqual(preview);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(
			"/api/sync/devices/old%2Flaptop%20%3F%23/remove/preview",
			{ method: "POST", signal: expect.any(AbortSignal) },
		);
		expect(openSyncConfirmDialog).toHaveBeenCalledExactlyOnceWith({
			title: "Remove Old laptop?",
			description: `${body} ${invitationAdvice}`,
			confirmLabel: "Remove device",
			cancelLabel: "Keep device",
			autoFocusAction: "cancel",
			tone: "danger",
		});
	});

	it("returns null on cancellation without sending a removal request", async () => {
		const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(preview)));
		vi.stubGlobal("fetch", fetch);
		vi.mocked(openSyncConfirmDialog).mockResolvedValue(false);

		expect(await runDeviceRemovalConfirmation(device)).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[0]).toBe("/api/sync/devices/old%2Flaptop%20%3F%23/remove/preview");
	});

	it.each([
		["invitation", invitationAdvice],
		[
			"sign_in",
			"To bring Old laptop back, sign in with Google on Old laptop. Whoever can sign in to that account on Old laptop can bring it back.",
		],
		[
			"none",
			"Old laptop is linked to a Google account and cannot be added back after you remove it. It would have to be set up as a new device.",
		],
	] as const)("uses only the server's %s advice", async (rejoin, advice) => {
		const read = vi.fn().mockResolvedValue({ ...preview, rejoin, key_id: "server-key" });

		expect(await runDeviceRemovalConfirmation(device, { preview: read })).toEqual({
			...preview,
			rejoin,
			key_id: "server-key",
		});
		expect(read).toHaveBeenCalledWith(device.deviceId);
		expect(openSyncConfirmDialog).toHaveBeenCalledWith(
			expect.objectContaining({ description: `${body} ${advice}` }),
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("names older devices only when supplied", async () => {
		const read = vi.fn().mockResolvedValue(preview);
		await runDeviceRemovalConfirmation(
			{ ...device, olderDeviceNames: ["Desk Mac", "Travel laptop"] },
			{ preview: read },
		);
		expect(openSyncConfirmDialog).toHaveBeenLastCalledWith(
			expect.objectContaining({
				description: `${body} ${invitationAdvice}\n\n2 devices run an older version of codemem and keep syncing with Old laptop until they update: Desk Mac, Travel laptop.`,
			}),
		);

		await runDeviceRemovalConfirmation({ ...device, olderDeviceNames: [] }, { preview: read });
		expect(openSyncConfirmDialog).toHaveBeenLastCalledWith(
			expect.objectContaining({ description: `${body} ${invitationAdvice}` }),
		);
	});

	it.each([
		null,
		[],
		"invalid",
		{},
		{ ...preview, device_id: "other-device" },
		{ ...preview, device_id: undefined },
		{ ...preview, rejoin: "google" },
		{ ...preview, rejoin: undefined },
		{ ...preview, expected_digest: "A".repeat(64) },
		{ ...preview, expected_digest: "a".repeat(63) },
		{ ...preview, expected_digest: "g".repeat(64) },
		{ ...preview, expected_digest: 123 },
		{ ...preview, key_id: undefined },
		{ ...preview, key_id: 123 },
	])("rejects malformed or mismatched previews before confirmation: %j", async (value) => {
		await expect(
			runDeviceRemovalConfirmation(device, { preview: vi.fn().mockResolvedValue(value) }),
		).rejects.toBeInstanceOf(DeviceRemovalPreviewError);
		expect(openSyncConfirmDialog).not.toHaveBeenCalled();
	});

	it("rejects an empty target before reading", async () => {
		const read = vi.fn();
		await expect(
			runDeviceRemovalConfirmation({ ...device, deviceId: " " }, { preview: read }),
		).rejects.toBeInstanceOf(DeviceRemovalPreviewError);
		expect(read).not.toHaveBeenCalled();
		expect(openSyncConfirmDialog).not.toHaveBeenCalled();
	});

	it("surfaces read errors without opening the dialog", async () => {
		const fetch = vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 }));
		vi.stubGlobal("fetch", fetch);

		await expect(runDeviceRemovalConfirmation(device)).rejects.toThrow("503");
		expect(openSyncConfirmDialog).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
