import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { state } from "../../../lib/state";
import { completeSurfaceRefresh, markSurfaceNotApplicable } from "../data/recovery";
import { coordinatorAdminState } from "../data/state";
import { renderJoinRequestsPanel } from "./join-requests-panel";

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

function renderPanel(reviewJoinRequest = vi.fn()) {
	mount = document.createElement("div");
	document.body.appendChild(mount);
	act(() => {
		render(
			renderJoinRequestsPanel({
				reviewJoinRequest,
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

describe("JoinRequestsPanel", () => {
	beforeEach(() => {
		state.lastCoordinatorAdminJoinRequests = [
			{
				device_id: "dev-1",
				display_name: "Adam laptop",
				fingerprint: "fp-abc123",
				request_id: "req-1",
			},
		];
		coordinatorAdminState.joinReviewPendingId = null;
		coordinatorAdminState.joinReviewPendingAction = null;
		coordinatorAdminState.unnamedDeviceAliases.aliases.clear();
		coordinatorAdminState.unnamedDeviceAliases.duplicateDisplayNames.clear();
		coordinatorAdminState.unnamedDeviceAliases.reservedDisplayNames.clear();
		completeSurfaceRefresh(coordinatorAdminState.recovery, "joinRequests");
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
		state.lastCoordinatorAdminJoinRequests = [];
		coordinatorAdminState.joinReviewPendingId = null;
		coordinatorAdminState.joinReviewPendingAction = null;
		coordinatorAdminState.unnamedDeviceAliases.aliases.clear();
		coordinatorAdminState.unnamedDeviceAliases.duplicateDisplayNames.clear();
		coordinatorAdminState.unnamedDeviceAliases.reservedDisplayNames.clear();
		vi.clearAllMocks();
	});

	it("shows friendly names with device identity as secondary diagnostics", () => {
		const root = renderPanel();

		expect(root.querySelector(".peer-title strong")?.textContent).toBe("Adam laptop");
		const diagnostics = root.querySelector("details");
		expect(diagnostics?.open).toBe(false);
		expect(diagnostics?.querySelector(".peer-meta")?.textContent).toBe(
			"Advanced: Device ID dev-1 · Fingerprint fp-abc123",
		);
	});

	it("renders distinct privacy-safe aliases for unnamed join requests", () => {
		state.lastCoordinatorAdminJoinRequests = [
			{ device_id: "private-device-z", display_name: "", request_id: "req-z" },
			{ device_id: "private-device-a", display_name: "", request_id: "req-a" },
		];

		const root = renderPanel();
		const titles = Array.from(
			root.querySelectorAll(".peer-title strong"),
			(item) => item.textContent,
		);
		expect(titles).toEqual(["Unnamed device 2", "Unnamed device 1"]);
		expect(titles.join(" ")).not.toContain("private-device");
	});

	it("disambiguates duplicate named requests while keeping actions tied to their rows", () => {
		state.lastCoordinatorAdminJoinRequests = [
			{ device_id: "private-device-z", display_name: "Laptop", request_id: "req-z" },
			{ device_id: "private-device-a", display_name: "Laptop", request_id: "req-a" },
		];
		const reviewJoinRequest = vi.fn();

		const root = renderPanel(reviewJoinRequest);
		const titles = Array.from(
			root.querySelectorAll(".peer-title strong"),
			(item) => item.textContent,
		);
		expect(titles).toEqual(["Laptop · Device 2", "Laptop · Device 1"]);
		expect(titles.join(" ")).not.toContain("private-device");

		const approveButtons = Array.from(root.querySelectorAll("button")).filter(
			(button) => button.textContent === "Approve",
		);
		act(() => approveButtons[0]?.click());
		expect(reviewJoinRequest).toHaveBeenCalledWith("req-z", "approve");
	});

	it("shows setup guidance when join requests are not applicable yet", () => {
		markSurfaceNotApplicable(coordinatorAdminState.recovery, "joinRequests");
		state.lastCoordinatorAdminJoinRequests = [];

		const root = renderPanel();

		expect(root.textContent).toContain("Complete legacy coordinator setup");
		expect(root.textContent).not.toContain("Join requests are unavailable");
	});
});
