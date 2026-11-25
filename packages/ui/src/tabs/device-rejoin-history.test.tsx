import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeviceIdentityInventoryV1 } from "../lib/api/sync";
import { DeviceRejoinHistory } from "./device-rejoin-history";

const scope = "a".repeat(64);
const path = "/api/sync/devices/rejoin-events";
const key = 'codemem.device-rejoin-history.cursor.v1:["viewer",""]';
const page = {
	scope,
	localDeviceId: "viewer",
	items: [{ eventId: "event-a", deviceId: "offline-device", finalizedAtMs: 1_700_000_000_000 }],
	nextCursor: "event-a",
};

beforeEach(() => {
	localStorage.clear();
});

const host = document.createElement("div");
afterEach(() => {
	act(() => render(null, host));
	host.hidden = false;
	vi.unstubAllGlobals();
	localStorage.clear();
});

function mount(revision: number, inventory?: DeviceIdentityInventoryV1) {
	act(() =>
		render(
			<DeviceRejoinHistory
				localDeviceId="viewer"
				refreshRevision={revision}
				inventory={inventory}
			/>,
			host,
		),
	);
}

it("shows a missed rejoin, remembers it, resumes on refresh, and does not show it after dismissal and reload", async () => {
	const remote = vi.fn<typeof fetch>();
	remote.mockResolvedValueOnce(Response.json(page));
	remote.mockImplementation(async () => Response.json({ ...page, items: [] }));
	vi.stubGlobal("fetch", remote);

	mount(1);
	await vi.waitFor(() => expect(host.textContent).toContain("A device rejoined by Google sign-in"));
	await vi.waitFor(() =>
		expect(localStorage.getItem(key)).toBe(JSON.stringify({ scope, nextCursor: "event-a" })),
	);
	expect(remote.mock.calls[0]?.[0]).toBe(path);
	mount(2);
	const resumed = `${path}?scope=${scope}&after=event-a`;
	await vi.waitFor(() => expect(remote.mock.calls.at(-1)?.[0]).toBe(resumed));
	expect(host.textContent).toContain("rejoined by Google sign-in");
	act(() => host.querySelector("button")?.click());
	expect(host.textContent).not.toContain("rejoined by Google sign-in");

	act(() => render(null, host));
	mount(3);
	await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(3));
	expect(remote.mock.calls.at(-1)?.[0]).toBe(resumed);
	expect(host.textContent).toBe("");
});

it("never persists a malformed page or a page from another local device", async () => {
	const remote = vi.fn<typeof fetch>();
	remote.mockResolvedValueOnce(Response.json({ ...page, localDeviceId: "other" }));
	remote.mockResolvedValueOnce(Response.json({ ...page, items: [null] }));
	vi.stubGlobal("fetch", remote);
	mount(1);
	await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(1));
	mount(2);
	await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(2));
	expect(localStorage.getItem(key)).toBeNull();
	expect(host.textContent).toBe("");
});

it("does not advance the historical cursor while the Devices tab is hidden", async () => {
	const remote = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(page));
	vi.stubGlobal("fetch", remote);
	host.hidden = true;
	mount(1);
	await vi.waitFor(() => expect(host.textContent).toContain("rejoined by Google sign-in"));
	expect(localStorage.getItem(key)).toBeNull();
	host.hidden = false;
	mount(2);
	await vi.waitFor(() => expect(localStorage.getItem(key)).toContain("event-a"));
	expect(remote.mock.calls.at(-1)?.[0]).toBe(path);
});

it("does not acknowledge a pending request that finishes in a hidden browser tab until it becomes visible", async () => {
	let deliver: (response: Response) => void = () => {
		throw new Error("No pending request");
	};
	const remote = vi.fn<typeof fetch>(
		() =>
			new Promise<Response>((resolve) => {
				deliver = resolve;
			}),
	);
	const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	vi.stubGlobal("fetch", remote);
	try {
		mount(1);
		await vi.waitFor(() => expect(remote).toHaveBeenCalledOnce());
		visibility.mockReturnValue("hidden");
		document.dispatchEvent(new Event("visibilitychange"));
		deliver(Response.json(page));
		await vi.waitFor(() => expect(host.textContent).toContain("rejoined by Google sign-in"));
		expect(localStorage.getItem(key)).toBeNull();

		visibility.mockReturnValue("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.waitFor(() => expect(localStorage.getItem(key)).toContain("event-a"));
		expect(remote).toHaveBeenCalledOnce();
	} finally {
		visibility.mockRestore();
	}
});

it("removes the deferred acknowledgement when the profile changes", async () => {
	const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
	const remove = vi.spyOn(document, "removeEventListener");
	const remote = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(page));
	remote.mockImplementation(() => new Promise<Response>(() => {}));
	vi.stubGlobal("fetch", remote);
	try {
		mount(1);
		await vi.waitFor(() => expect(host.textContent).toContain("rejoined by Google sign-in"));
		act(() =>
			render(
				<DeviceRejoinHistory
					localDeviceId="viewer"
					profile="another-profile"
					refreshRevision={2}
				/>,
				host,
			),
		);
		expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
		visibility.mockReturnValue("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		expect(localStorage.getItem(key)).toBeNull();
		expect(
			localStorage.getItem('codemem.device-rejoin-history.cursor.v1:["viewer","another-profile"]'),
		).toBeNull();
		expect(host.textContent).not.toContain("rejoined by Google sign-in");
	} finally {
		remove.mockRestore();
		visibility.mockRestore();
	}
});

it("does not move the stored cursor backward when another tab displays a later page", async () => {
	const later = JSON.stringify({ scope, nextCursor: "event-b" });
	const remote = vi.fn<typeof fetch>().mockImplementation(async () => {
		localStorage.setItem(key, later);
		return Response.json(page);
	});
	vi.stubGlobal("fetch", remote);
	mount(1);
	await vi.waitFor(() => expect(host.textContent).toContain("rejoined by Google sign-in"));
	expect(localStorage.getItem(key)).toBe(later);
});

it("does not duplicate live row markers or show a notice for conflicting keys", async () => {
	const visible = page.items[0];
	if (!visible) throw new Error("Missing event");
	const inventory: DeviceIdentityInventoryV1 = {
		version: 1,
		items: [
			{
				version: 1,
				deviceId: visible.deviceId,
				evidenceDeviceIds: [visible.deviceId],
				displayName: "Office laptop",
				isLocal: false,
				state: "configured",
				identityId: null,
				suggestedIdentityId: null,
				validatedFingerprint: "fingerprint",
				sources: [],
				conflictCodes: [],
				rejoin: { deviceId: visible.deviceId, rejoinedAtMs: visible.finalizedAtMs },
			},
		],
		coordinatorEvidence: { availability: "available", safeErrorCode: null },
		truncated: false,
	};
	const remote = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(page));
	vi.stubGlobal("fetch", remote);
	mount(1, inventory);
	await vi.waitFor(() => expect(localStorage.getItem(key)).toContain("event-a"));
	expect(host.textContent).toBe("");
	const item = inventory.items[0];
	if (!item) throw new Error("Missing inventory row");
	mount(1, { ...inventory, items: [{ ...item, rejoin: undefined, state: "conflicted" }] });
	expect(host.textContent).toBe("");
});
