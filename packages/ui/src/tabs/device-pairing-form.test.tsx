// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hasPendingPairingCode, setPendingPairingCode } from "../lib/pairing-handoff";
import { DevicePairingForm, defaultDevicePairingApi } from "./device-pairing-form";

const mocks = vi.hoisted(() => ({
	importCoordinatorInvite: vi.fn(),
	inspectCoordinatorInvite: vi.fn(),
}));

vi.mock("../lib/api/sync", () => mocks);

let mount: HTMLElement;

beforeEach(() => {
	vi.resetAllMocks();
	mount = document.createElement("div");
	document.body.append(mount);
});

afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
});

function typeCode(value: string) {
	const field = mount.querySelector("textarea");
	if (!field) throw new Error("field missing");
	act(() => {
		field.value = value;
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

const submit = () => mount.querySelector<HTMLButtonElement>("button");

/** Clicks the submit button and lets the review or save settle. */
async function press() {
	await act(async () => submit()?.click());
	await act(async () => {});
}

it("reads only pairing codes as a device to review", async () => {
	mocks.inspectCoordinatorInvite.mockResolvedValueOnce({
		kind: "pair",
		device_id: "peer",
		fingerprint: "fp",
		addresses: ["a:1"],
	});
	await expect(defaultDevicePairingApi.review("code")).resolves.toEqual({
		deviceId: "peer",
		fingerprint: "fp",
		addresses: ["a:1"],
	});
	mocks.inspectCoordinatorInvite.mockResolvedValueOnce({ kind: "legacy_team_invite" });
	await expect(defaultDevicePairingApi.review("code")).resolves.toBeNull();
});

it("saves a pairing as a device pairing, never as a Team join", async () => {
	await defaultDevicePairingApi.save("code");

	expect(mocks.importCoordinatorInvite).toHaveBeenCalledExactlyOnceWith("code", undefined, "pair");
});

it("asks for a code before reviewing", async () => {
	const api = { review: vi.fn(), save: vi.fn() };
	await act(() => render(<DevicePairingForm api={api} />, mount));

	await press();

	expect(mount.querySelector('[role="status"]')?.textContent).toBe("Paste a device pairing code.");
	expect(api.review).not.toHaveBeenCalled();
});

it("drops a review when the code changes, so a different code is never saved unreviewed", async () => {
	const api = {
		review: vi.fn(async () => ({ deviceId: "peer", fingerprint: "fp", addresses: [] })),
		save: vi.fn(),
	};
	await act(() => render(<DevicePairingForm api={api} />, mount));
	typeCode("first");
	await press();
	expect(submit()?.textContent).toBe("Save pairing");

	typeCode("second");

	expect(submit()?.textContent).toBe("Review pairing");
	expect(mount.textContent).not.toContain("Device ID");
	expect(api.save).not.toHaveBeenCalled();
});

it("keeps the code and says what failed when saving fails", async () => {
	const api = {
		review: vi.fn(async () => ({ deviceId: "peer", fingerprint: "fp", addresses: [] })),
		save: vi.fn(async () => {
			throw new Error("peer_unreachable");
		}),
	};
	await act(() => render(<DevicePairingForm api={api} />, mount));
	typeCode("code");
	await press();

	await press();

	expect(mount.querySelector("textarea")?.value).toBe("code");
	expect(mount.querySelector('[role="status"]')?.textContent).toContain("peer_unreachable");
	expect(submit()?.textContent).toBe("Save pairing");
});

it("consumes a handed-over code once", async () => {
	setPendingPairingCode("  handed-code  ");
	await act(() => render(<DevicePairingForm api={{ review: vi.fn(), save: vi.fn() }} />, mount));

	expect(mount.querySelector("textarea")?.value).toBe("handed-code");
	expect(hasPendingPairingCode()).toBe(false);
});

it("takes a code handed over while the form is already open and drops the old review", async () => {
	const api = {
		review: vi.fn(async () => ({ deviceId: "peer", fingerprint: "fp", addresses: [] })),
		save: vi.fn(),
	};
	await act(() => render(<DevicePairingForm api={api} />, mount));
	typeCode("old-code");
	await press();
	expect(submit()?.textContent).toBe("Save pairing");

	await act(async () => setPendingPairingCode("new-code"));

	expect(mount.querySelector("textarea")?.value).toBe("new-code");
	expect(submit()?.textContent).toBe("Review pairing");
	expect(hasPendingPairingCode()).toBe(false);
});

it("keeps a newer code handed over while a save is pending, and still refreshes Devices", async () => {
	let finishSave: () => void = () => {};
	const api = {
		review: vi.fn(async () => ({ deviceId: "peer", fingerprint: "fp", addresses: [] })),
		save: vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishSave = resolve;
				}),
		),
	};
	const onPaired = vi.fn();
	await act(() => render(<DevicePairingForm api={api} onPaired={onPaired} />, mount));
	typeCode("old-code");
	await press();
	await press();
	expect(api.save).toHaveBeenCalledOnce();

	await act(async () => setPendingPairingCode("new-code"));
	await act(async () => finishSave());

	expect(mount.querySelector("textarea")?.value).toBe("new-code");
	expect(mount.textContent).not.toContain("Pairing saved");
	expect(onPaired).toHaveBeenCalledOnce();
});
