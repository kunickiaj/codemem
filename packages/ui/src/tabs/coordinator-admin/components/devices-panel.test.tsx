import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { state } from "../../../lib/state";
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

function renderPanel() {
	mount = document.createElement("div");
	document.body.appendChild(mount);
	act(() => {
		render(
			renderDevicesPanel({
				runDevice: vi.fn(),
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
});
