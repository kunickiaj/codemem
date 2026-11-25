// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeviceBlockApi } from "./device-block-confirmation";
import { RemovedDevicesPanel, refreshRemovedDevices } from "./device-removal-list";

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

async function openPanel(blockApi?: DeviceBlockApi) {
	await act(() => render(<RemovedDevicesPanel blockApi={blockApi} />, mount));
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
		expect(
			[...mount.querySelectorAll("li")].map((row) => [
				row.querySelector("strong")?.textContent,
				row.querySelector(".removed-devices-group")?.textContent,
			]),
		).toEqual([
			["Travel laptop", "Removed from group-a"],
			["laptop", "Removed from group-b"],
		]),
	);
	expect(mount.querySelector("button")).toBeNull();
});

it("refreshes an open removed list after the enrolled-device action without moving focus", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ items: [] }))
		.mockResolvedValueOnce(
			Response.json({
				items: [
					{
						device_id: "laptop",
						group_id: "group-a",
						display_name: "Travel laptop",
						removal_seq: 9,
						removal_id: "fixture-removal",
					},
				],
			}),
		);
	vi.stubGlobal("fetch", fetch);
	await openPanel();
	await vi.waitFor(() => expect(mount.textContent).toContain("No removed devices"));
	const heading = mount.querySelector("summary");
	heading?.focus();
	await act(() => refreshRemovedDevices());
	await vi.waitFor(() =>
		expect(
			mount.querySelector('button[aria-label="Block Travel laptop permanently"]'),
		).not.toBeNull(),
	);
	expect(document.activeElement).toBe(heading);
	expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
	"requires the distinct permanent Block confirmation (%s)",
	async (approved) => {
		const target = {
			device_id: "laptop",
			group_id: "group-a",
			display_name: "Travel laptop",
			removal_seq: 9,
		};
		const preview: Awaited<ReturnType<DeviceBlockApi["preview"]>> = {
			state: "ready",
			version: 1,
			device_id: target.device_id,
			group_id: target.group_id,
			coordinator_id: "fixture",
			key_id: "a".repeat(64),
			expected_digest: "b".repeat(64),
			scope: "whole_database_device_id_any_key_and_canonical_key_any_device_all_groups",
		};
		const confirm = vi.fn(async () => approved);
		const previewBlock = vi.fn(async () => preview);
		const commit = vi.fn<DeviceBlockApi["commit"]>().mockResolvedValue({
			...preview,
			state: "revoked",
			revocations: [
				{
					subject_kind: "device_id",
					subject_value: target.device_id,
					revocation_id: "id-a",
					created_at: "then",
				},
				{
					subject_kind: "ed25519_key",
					subject_value: preview.key_id,
					revocation_id: "key-a",
					created_at: "then",
				},
			],
		});
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ items: [target] }))
			.mockResolvedValueOnce(Response.json({ items: [] }));
		vi.stubGlobal("fetch", fetch);
		await openPanel({ preview: previewBlock, confirm, commit });
		const button = await vi.waitFor(() => {
			const button = mount.querySelector<HTMLButtonElement>(
				'[aria-label="Block Travel laptop permanently"]',
			);
			if (!button) throw new Error("Expected permanent Block action");
			return button;
		});
		await act(async () => button.click());
		expect(previewBlock).toHaveBeenCalledExactlyOnceWith({
			groupId: "group-a",
			deviceId: "laptop",
		});
		expect(confirm).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				title: "Block Travel laptop permanently?",
				description: expect.stringContaining("This cannot be undone."),
				confirmLabel: "Block permanently",
				cancelLabel: "Keep device",
				autoFocusAction: "cancel",
			}),
		);
		if (approved) {
			expect(commit).toHaveBeenCalledExactlyOnceWith(preview);
			await vi.waitFor(() => expect(mount.textContent).toContain("No removed devices"));
		} else {
			expect(commit).not.toHaveBeenCalled();
			expect(mount.textContent).toContain("Travel laptop");
		}
	},
);

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
