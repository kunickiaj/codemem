import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { deriveTeamSyncPrimaryStatus } from "../view-model";
import { TeamSyncPanel } from "./team-sync-panel";

let mount: HTMLDivElement | null = null;

function renderPrimaryStatus(primaryStatus: ReturnType<typeof deriveTeamSyncPrimaryStatus>) {
	mount = document.createElement("div");
	document.body.appendChild(mount);
	act(() => {
		render(
			<TeamSyncPanel
				actionItems={[]}
				actionableCount={0}
				discoveredListMount={null}
				discoveredRows={[]}
				joinRequestsMount={null}
				onApproveJoinRequest={async () => null}
				onAttentionAction={async () => {}}
				onDenyJoinRequest={async () => null}
				onInspectConflict={() => {}}
				onRemoveConflict={async () => null}
				onReviewDiscoveredDevice={async () => null}
				pendingJoinRequests={[]}
				presenceStatus="posted"
				primaryStatus={primaryStatus}
			/>,
			mount as HTMLDivElement,
		);
	});
	return mount;
}

afterEach(() => {
	if (mount) {
		act(() => render(null, mount as HTMLDivElement));
		mount.remove();
		mount = null;
	}
	document.body.innerHTML = "";
});

describe("TeamSyncPanel primary status", () => {
	const coordinator: NonNullable<Parameters<typeof deriveTeamSyncPrimaryStatus>[0]["coordinator"]> =
		{
			configured: true,
			sync_enabled: true,
			groups: ["Acme"],
			presence_status: "posted",
		};
	const healthyPeer = {
		peer_device_id: "peer-healthy",
		status: { peer_state: "online", sync_status: "ok" },
	};
	const cases: Array<[string, Parameters<typeof deriveTeamSyncPrimaryStatus>[0], string, string]> =
		[
			[
				"posted presence with sync disabled",
				{
					status: { enabled: false, daemon_state: "disabled" },
					coordinator,
					peers: [healthyPeer],
				},
				"Sync off",
				"turn on sync",
			],
			[
				"pending_setup",
				{
					status: { enabled: true, daemon_state: "ok" },
					coordinator,
					shareOperations: [
						{ projects: [{ display_name: "Roadmap" }], lifecycle: { state: "pending_setup" } },
					],
				},
				"Setup pending",
				"Roadmap",
			],
			[
				"owner needs_attention",
				{
					status: { enabled: true, daemon_state: "ok" },
					coordinator,
					shareOperations: [
						{ projects: [{ display_name: "Roadmap" }], lifecycle: { state: "needs_attention" } },
					],
				},
				"Needs attention",
				"retry setup",
			],
			[
				"trust pending",
				{
					status: { enabled: true, daemon_state: "ok" },
					coordinator,
					peers: [{ peer_device_id: "peer-pending", status: { peer_state: "waiting" } }],
				},
				"Pairing needed",
				"both devices",
			],
			[
				"enrolled and reachable only",
				{ status: { enabled: true, daemon_state: "ok" }, coordinator },
				"Reachable",
				"Pair and approve",
			],
			[
				"not enrolled",
				{
					status: { enabled: true, daemon_state: "ok" },
					coordinator: { ...coordinator, presence_status: "not_enrolled" },
				},
				"Not enrolled",
				"Paste a Team invite",
			],
			[
				"configured unreachable",
				{
					status: { enabled: true, daemon_state: "ok" },
					coordinator: { ...coordinator, presence_status: "unknown" },
				},
				"Unreachable",
				"Check the coordinator connection",
			],
			[
				"unconfigured setup",
				{
					status: { enabled: true, daemon_state: "ok" },
					coordinator: { configured: false, sync_enabled: true, groups: [] },
				},
				"Setup needed",
				"configure a coordinator",
			],
		];

	it.each(cases)("renders one concrete next action for %s", (_name, input, badge, action) => {
		const root = renderPrimaryStatus(deriveTeamSyncPrimaryStatus(input));

		expect(root.textContent).toContain(badge);
		expect(root.textContent).toContain(action);
		expect(root.querySelectorAll("[data-primary-sync-state]")).toHaveLength(1);
		expect(root.textContent).not.toContain("No urgent team work");
		expect(root.textContent).not.toContain(deriveTeamSyncPrimaryStatus(input).meta);
	});

	it("reserves no-urgent copy for healthy enabled data-plane sync", () => {
		const root = renderPrimaryStatus(
			deriveTeamSyncPrimaryStatus({
				status: { enabled: true, daemon_state: "ok", daemon_running: true },
				coordinator,
				peers: [healthyPeer],
			}),
		);

		expect(root.textContent).toContain("No urgent team work right now.");
		expect(root.querySelector("[data-primary-sync-state]")).toBeNull();
	});
});
