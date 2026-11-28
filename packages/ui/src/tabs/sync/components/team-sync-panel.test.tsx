import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { deriveTeamSyncPrimaryStatus, type UiSyncAttentionItem } from "../view-model";
import { TeamSyncPanel } from "./team-sync-panel";

let mount: HTMLDivElement | null = null;

function renderPrimaryStatus(
	primaryStatus: ReturnType<typeof deriveTeamSyncPrimaryStatus>,
	actionItems: UiSyncAttentionItem[] = [],
) {
	mount = document.createElement("div");
	document.body.appendChild(mount);
	act(() => {
		render(
			<TeamSyncPanel
				actionItems={actionItems}
				actionableCount={actionItems.length}
				onAttentionAction={async () => {}}
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
				"Retry the stopped Project access update",
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
				"Not verified",
				"Review Sending and Receiving",
			],
			[
				"not enrolled",
				{
					status: { enabled: true, daemon_state: "ok" },
					coordinator: { ...coordinator, presence_status: "not_enrolled" },
				},
				"Not enrolled",
				"Accept a Team invitation",
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
				"set a coordinator URL",
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

	it("reserves no-urgent copy for server-confirmed recent exchanges", () => {
		// Arrange / Act
		const root = renderPrimaryStatus(
			deriveTeamSyncPrimaryStatus({
				status: {
					enabled: true,
					daemon_state: "ok",
					daemon_running: true,
					sync_health: {
						state: "exchange_succeeded",
						peer_count: 1,
						attention_count: 0,
						unverified_count: 0,
						stale_count: 0,
					},
				},
				coordinator,
				peers: [healthyPeer],
			}),
		);

		// Assert
		expect(root.textContent).toContain("No urgent team work right now.");
		expect(root.querySelector("[data-primary-sync-state]")).toBeNull();
	});
});

describe("TeamSyncPanel when Project access needs review", () => {
	const reviewStatus = (itemCount: number) =>
		deriveTeamSyncPrimaryStatus({
			status: { enabled: true, daemon_state: "ok", daemon_running: true },
			coordinator: {
				configured: true,
				sync_enabled: true,
				groups: ["Acme"],
				presence_status: "posted",
			},
			peers: [{ peer_device_id: "peer-healthy", status: { peer_state: "online" } }],
			reconciliation: {
				items: Array.from({ length: itemCount }, (_, index) => ({
					canonicalProjectIdentity: `git:project-${index}`,
					state: "needs_attention" as const,
				})),
			},
		});
	const attentionItem: UiSyncAttentionItem = {
		id: "name:device-a",
		kind: "name-device",
		priority: 30,
		title: "Name Desk Mini",
		summary: "Give this device a friendly name so it is easier to recognize later.",
		actionLabel: "Name device",
		deviceId: "device-a",
	};

	it("names the problem on the row and shows no repeated section label", () => {
		const root = renderPrimaryStatus(reviewStatus(1));

		const row = root.querySelector("[data-primary-sync-state]");
		expect(row?.querySelector(".sync-action-text")?.firstChild?.textContent).toBe(
			"Project access needs review",
		);
		expect(root.textContent).not.toContain("Needs attention");
		expect(root.querySelector(".sync-section-label")).toBeNull();
	});

	it("describes the guidance as text, not as a command", () => {
		const root = renderPrimaryStatus(reviewStatus(2));

		expect(root.querySelector(".sync-action-guidance")?.textContent).toBe(
			"Open Sharing, review the access decision for each of the 2 Projects, then sync again.",
		);
		expect(root.querySelector(".sync-action-command")).toBeNull();
	});

	it("labels the section only when attention rows follow", () => {
		const root = renderPrimaryStatus(reviewStatus(1), [attentionItem]);

		expect(root.querySelector(".sync-section-label")?.textContent).toBe("Needs attention");
		expect(root.querySelectorAll(".sync-action .sync-action-guidance")).toHaveLength(2);
		expect(root.querySelector(".sync-action-command")).toBeNull();
	});
});
