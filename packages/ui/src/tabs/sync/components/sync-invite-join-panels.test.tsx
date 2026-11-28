import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncInviteJoinPanels } from "./sync-invite-join-panels";

let mount: HTMLDivElement | null = null;

function renderPanels(overrides: Partial<Parameters<typeof SyncInviteJoinPanels>[0]> = {}) {
	mount = document.createElement("div");
	document.body.appendChild(mount);
	act(() => {
		render(
			<SyncInviteJoinPanels
				invitePanel={null}
				invitePanelOpen={false}
				inviteRestoreParent={null}
				presenceStatus="posted"
				onToggleInvitePanel={() => {}}
				{...overrides}
			/>,
			mount as HTMLDivElement,
		);
	});
	return mount;
}

afterEach(() => {
	if (mount) {
		act(() => {
			render(null, mount as HTMLDivElement);
		});
		mount.remove();
		mount = null;
	}
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

describe("SyncInviteJoinPanels", () => {
	it("keeps anchor-peer setup out of the primary invite/join flow", () => {
		const root = renderPanels();

		expect(root.textContent).toContain("Set up a new team instead");
		expect(root.textContent).not.toContain("Set up an always-on peer");
		expect(root.textContent).not.toContain("Open anchor-peer deployment guide");
		expect(root.textContent).not.toContain("Copy pairing command");
	});

	it("offers no invitation form, because Sharing accepts invitations", () => {
		const root = renderPanels();

		expect(root.textContent).not.toContain("Invite or pairing code");
		expect(root.querySelector("textarea")).toBeNull();
	});

	it("shows nothing for a device that is not enrolled yet", () => {
		const root = renderPanels({ presenceStatus: "not_enrolled" });

		expect(root.textContent).toBe("");
	});
});
