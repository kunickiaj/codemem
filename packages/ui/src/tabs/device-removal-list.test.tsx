// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemovedDevicesPanel } from "./device-removal-list";

let mount: HTMLElement;

beforeEach(() => {
	mount = document.createElement("div");
	document.body.append(mount);
});

afterEach(() => {
	render(null, mount);
	mount.remove();
	vi.unstubAllGlobals();
});

async function openPanel() {
	await act(() => render(<RemovedDevicesPanel />, mount));
	const details = mount.querySelector("details");
	if (!details) throw new Error("Expected removed devices details");
	await act(() => {
		details.open = true;
		details.dispatchEvent(new Event("toggle"));
	});
}

it("reads the listing on demand and shows each removed enrollment", async () => {
	const fetch = vi.fn().mockResolvedValue(
		Response.json({
			items: [
				{ device_id: "laptop", group_id: "group-a", display_name: "Travel laptop", removal_seq: 9 },
				{ device_id: "laptop", group_id: "group-b", display_name: null, removal_seq: 7 },
			],
		}),
	);
	vi.stubGlobal("fetch", fetch);
	await act(() => render(<RemovedDevicesPanel />, mount));
	expect(fetch).not.toHaveBeenCalled();
	await openPanel();
	expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/sync/devices/removals", expect.anything());
	await vi.waitFor(() =>
		expect([...mount.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
			"Travel laptop · group-a",
			"laptop · group-b",
		]),
	);
});

it("distinguishes an empty listing from a coordinator error", async () => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ items: [] })));
	await openPanel();
	await vi.waitFor(() => expect(mount.textContent).toContain("No removed devices"));
	await act(() => render(null, mount));

	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ error: "device_removal_unavailable" }, { status: 503 }),
			),
	);
	await openPanel();
	await vi.waitFor(() => expect(mount.textContent).toContain("Could not list removed devices"));
	expect(mount.textContent).not.toContain("No removed devices");
});

it("keeps keyboard focus in the panel when retrying a failed request", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(new Response(null, { status: 503 }))
		.mockResolvedValueOnce(Response.json({ items: [] }));
	vi.stubGlobal("fetch", fetch);
	await openPanel();
	const retry = await vi.waitFor(() => {
		const button = mount.querySelector("button");
		if (!button) throw new Error("Expected retry button");
		return button;
	});
	retry.focus();
	await act(() => retry.click());
	expect(document.activeElement).toBe(mount.querySelector("summary"));
	await vi.waitFor(() => expect(mount.textContent).toContain("No removed devices"));
});
