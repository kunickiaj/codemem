import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeviceHistoryApi,
	DeviceHistoryAttach,
	legacyDeviceHistories,
} from "./device-history-attach";

let mount: HTMLElement;

beforeEach(() => {
	mount = document.createElement("div");
	document.body.append(mount);
});

afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
});

function fakeApi(overrides: Partial<DeviceHistoryApi> = {}): DeviceHistoryApi {
	return {
		confirm: vi.fn(async () => true),
		attach: vi.fn(async () => ({})),
		...overrides,
	};
}

const old = { originDeviceId: "old-laptop", memoryCount: 12, lastSeenAt: "" };

async function show(devices = [old], api = fakeApi(), onAttached = vi.fn()) {
	await act(() =>
		render(<DeviceHistoryAttach api={api} devices={devices} onAttached={onAttached} />, mount),
	);
	return { api, onAttached };
}

describe("legacyDeviceHistories", () => {
	it("keeps devices with an id and cleans their counts", () => {
		expect(
			legacyDeviceHistories([
				{ origin_device_id: " old-laptop ", memory_count: "7", last_seen_at: " 2026-01-01 " },
				{ origin_device_id: "  " },
				{ memory_count: 3 },
				null,
			]),
		).toEqual([{ originDeviceId: "old-laptop", memoryCount: 7, lastSeenAt: "2026-01-01" }]);
	});

	it("returns nothing for a payload that is not a list", () => {
		expect(legacyDeviceHistories(undefined)).toEqual([]);
		expect(legacyDeviceHistories({})).toEqual([]);
	});
});

describe("DeviceHistoryAttach", () => {
	it("renders nothing without older devices", async () => {
		await show([]);
		expect(mount.textContent).toBe("");
	});

	it("lists each older device with its memory count", async () => {
		await show();
		expect(mount.querySelector("h3")?.textContent).toBe("Older device history");
		expect(mount.textContent).toContain("old-laptop");
		expect(mount.textContent).toContain("12 memories");
	});

	it("attaches after confirmation, refreshes Devices and keeps the result", async () => {
		const { api, onAttached } = await show();
		await act(async () => mount.querySelector("button")?.click());
		await act(async () => {});

		expect(api.attach).toHaveBeenCalledExactlyOnceWith("old-laptop");
		expect(onAttached).toHaveBeenCalledOnce();
		await act(() =>
			render(<DeviceHistoryAttach api={api} devices={[]} onAttached={onAttached} />, mount),
		);
		expect(mount.querySelector('[role="status"]')?.textContent).toContain(
			"Old device history attached to you.",
		);
	});

	it("changes nothing when the person cancels", async () => {
		const { api, onAttached } = await show([old], fakeApi({ confirm: vi.fn(async () => false) }));
		await act(async () => mount.querySelector("button")?.click());

		expect(api.attach).not.toHaveBeenCalled();
		expect(onAttached).not.toHaveBeenCalled();
	});

	it("offers a retry when attaching fails", async () => {
		const { onAttached } = await show(
			[old],
			fakeApi({
				attach: vi.fn(async () => {
					throw new Error("boom");
				}),
			}),
		);
		await act(async () => mount.querySelector("button")?.click());
		await act(async () => {});

		expect(mount.querySelector("button")?.textContent).toBe("Retry");
		expect(mount.querySelector('[role="alert"]')).not.toBeNull();
		expect(onAttached).not.toHaveBeenCalled();
	});
});
