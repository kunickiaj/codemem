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

function renderPanel() {
	mount = document.createElement("div");
	document.body.appendChild(mount);
	act(() => {
		render(
			renderJoinRequestsPanel({
				reviewJoinRequest: vi.fn(),
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
		vi.clearAllMocks();
	});

	it("shows friendly names with device identity as secondary diagnostics", () => {
		const root = renderPanel();

		expect(root.querySelector(".peer-title strong")?.textContent).toBe("Adam laptop");
		expect(root.querySelector(".peer-meta")?.textContent).toBe(
			"Advanced: Device ID dev-1 · Fingerprint fp-abc123",
		);
	});

	it("shows setup guidance when join requests are not applicable yet", () => {
		markSurfaceNotApplicable(coordinatorAdminState.recovery, "joinRequests");
		state.lastCoordinatorAdminJoinRequests = [];

		const root = renderPanel();

		expect(root.textContent).toContain("Complete legacy coordinator setup");
		expect(root.textContent).not.toContain("Join requests are unavailable");
	});
});
