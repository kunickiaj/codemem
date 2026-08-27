import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { state } from "../../../lib/state";
import {
	completeSurfaceRefresh,
	failSurfaceRefresh,
	markSurfaceNotApplicable,
} from "../data/recovery";
import { coordinatorAdminState } from "../data/state";
import { renderDevicesPanel } from "./devices-panel";

vi.mock("../../../components/primitives/radix-tabs", () => ({
	RadixTabsContent: ({
		children,
		className,
	}: {
		children?: ComponentChildren;
		className?: string;
	}) => <div className={className}>{children}</div>,
}));

let mount: HTMLDivElement | null = null;

function renderPanel(runDevice = vi.fn()) {
	mount = document.createElement("div");
	document.body.appendChild(mount);
	act(() => {
		render(
			renderDevicesPanel({
				runDevice,
				fresh: true,
				snapshotMatchesTarget: true,
				summary: {
					detail: "Ready",
					readiness: "ready",
					title: "Ready",
				},
			}),
			mount as HTMLDivElement,
		);
	});
	return mount;
}

describe("DevicesPanel", () => {
	beforeEach(() => {
		state.lastCoordinatorAdminStatus = { active_group: "team-a", readiness: "ready" };
		state.lastCoordinatorAdminDevices = [
			{ device_id: "dev-1", display_name: "NAS", enabled: true, group_id: "team-a" },
		];
		coordinatorAdminState.deviceRenameDrafts.clear();
		coordinatorAdminState.deviceRenameServerNames.clear();
		coordinatorAdminState.unnamedDeviceAliases.aliases.clear();
		coordinatorAdminState.unnamedDeviceAliases.duplicateDisplayNames.clear();
		coordinatorAdminState.unnamedDeviceAliases.reservedDisplayNames.clear();
		completeSurfaceRefresh(coordinatorAdminState.recovery, "devices");
	});

	afterEach(() => {
		if (mount) {
			act(() => {
				render(null, mount as HTMLDivElement);
			});
			mount.remove();
			mount = null;
		}
		document.body.innerHTML = "";
		state.lastCoordinatorAdminStatus = null;
		state.lastCoordinatorAdminDevices = [];
		coordinatorAdminState.deviceRenameDrafts.clear();
		coordinatorAdminState.deviceRenameServerNames.clear();
		coordinatorAdminState.unnamedDeviceAliases.aliases.clear();
		coordinatorAdminState.unnamedDeviceAliases.duplicateDisplayNames.clear();
		coordinatorAdminState.unnamedDeviceAliases.reservedDisplayNames.clear();
		vi.clearAllMocks();
	});

	it("keeps the device title on the saved display name while editing a rename draft", () => {
		const root = renderPanel();
		const title = root.querySelector(".peer-title strong");
		const input = root.querySelector("input") as HTMLInputElement | null;
		if (!title || !input) throw new Error("device row did not render");

		expect(title.textContent).toBe("NAS");

		act(() => {
			input.value = "NAS storage box";
			input.dispatchEvent(new InputEvent("input", { bubbles: true }));
			render(
				renderDevicesPanel({
					runDevice: vi.fn(),
					fresh: true,
					snapshotMatchesTarget: true,
					summary: {
						detail: "Ready",
						readiness: "ready",
						title: "Ready",
					},
				}),
				root,
			);
		});

		expect(root.querySelector("input")?.value).toBe("NAS storage box");
		expect(root.querySelector(".peer-title strong")?.textContent).toBe("NAS");
	});

	it("retains technical details but disables coordinator mutations while device data is stale", () => {
		completeSurfaceRefresh(coordinatorAdminState.recovery, "status");
		failSurfaceRefresh(coordinatorAdminState.recovery, "devices");
		mount = document.createElement("div");
		document.body.appendChild(mount);

		act(() => {
			render(
				renderDevicesPanel({
					fresh: false,
					snapshotMatchesTarget: true,
					runDevice: vi.fn(),
					summary: { detail: "Ready", readiness: "ready", title: "Ready" },
				}),
				mount as HTMLDivElement,
			);
		});

		const diagnostics = mount.querySelector("details");
		expect(diagnostics?.open).toBe(false);
		expect(diagnostics?.textContent).toContain("Advanced: Device ID dev-1");
		expect(Array.from(mount.querySelectorAll("button"))).not.toHaveLength(0);
		expect(Array.from(mount.querySelectorAll("button")).every((button) => button.disabled)).toBe(
			true,
		);
		expect(mount.textContent).not.toContain("deleted");
	});

	it("renders distinct privacy-safe aliases for unnamed devices", () => {
		state.lastCoordinatorAdminDevices = [
			{ device_id: "private-device-z", display_name: "", enabled: true, group_id: "team-a" },
			{ device_id: "private-device-a", display_name: null, enabled: true, group_id: "team-a" },
		];

		const root = renderPanel();
		const titles = Array.from(
			root.querySelectorAll(".peer-title strong"),
			(item) => item.textContent,
		);
		expect(titles).toEqual(["Unnamed device 2", "Unnamed device 1"]);
		expect(titles.join(" ")).not.toContain("private-device");
	});

	it("disambiguates duplicate names in rows and action confirmations without exposing ids", () => {
		state.lastCoordinatorAdminDevices = [
			{ device_id: "private-device-z", display_name: "NAS", enabled: true, group_id: "team-a" },
			{ device_id: "private-device-a", display_name: "NAS", enabled: true, group_id: "team-a" },
		];
		const runDevice = vi.fn();

		const root = renderPanel(runDevice);
		const titles = Array.from(
			root.querySelectorAll(".peer-title strong"),
			(item) => item.textContent,
		);
		expect(titles).toEqual(["NAS · Device 2", "NAS · Device 1"]);
		expect(titles.join(" ")).not.toContain("private-device");

		const disableButtons = Array.from(root.querySelectorAll("button")).filter(
			(button) => button.textContent === "Disable",
		);
		act(() => disableButtons[0]?.click());
		expect(runDevice).toHaveBeenCalledWith(
			"private-device-z",
			"team-a",
			"NAS · Device 2",
			"disable",
		);
	});

	it("shows setup guidance when devices are not applicable yet", () => {
		markSurfaceNotApplicable(coordinatorAdminState.recovery, "devices");
		state.lastCoordinatorAdminDevices = [];

		const root = renderPanel();

		expect(root.textContent).toContain("Complete legacy coordinator setup");
		expect(root.textContent).not.toContain("devices are unavailable");
	});
});
