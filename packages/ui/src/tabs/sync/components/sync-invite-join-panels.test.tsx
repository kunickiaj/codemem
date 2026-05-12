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
				joinPanel={null}
				joinPanelOpen={false}
				joinRestoreParent={null}
				pairedPeerCount={1}
				presenceStatus="posted"
				onToggleInvitePanel={() => {}}
				onToggleJoinPanel={() => {}}
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
	it("guides always-on peer setup without implying special access", () => {
		const root = renderPanels();

		expect(root.textContent).toContain("Set up an always-on peer");
		expect(root.textContent).toContain("normal paired device that stays online");
		expect(root.textContent).toContain("not a coordinator, relay, or special protocol role");
		expect(root.textContent).toContain("Grant only the explicit Sharing domains");
		expect(root.textContent).toContain("domains absent from its Authorized Sharing domains list");
		expect(root.textContent).toContain("project filters only to narrow those authorized domains");
		expect(root.textContent).toContain("Coordinator discovery only helps devices find each other");
		expect(root.textContent).toContain("codemem sync enable");
		expect(root.textContent).toContain("codemem sync pair --payload-only");
		expect(root.textContent).toContain("codemem coordinator grant-scope-member");
		expect(root.textContent).toContain("codemem coordinator list-scope-members");
		expect(root.textContent).toContain("Open anchor-peer deployment guide");
	});
});
