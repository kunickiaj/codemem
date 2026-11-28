import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../../../lib/state";
import {
	deriveSyncViewModel,
	deriveTeamSyncPrimaryStatus,
	type UiTeamSyncPrimaryStatus,
} from "../../view-model";
import { teamSyncState } from "../data/state";
import { renderTeamSync, renderTeamSyncPrimaryStatus } from "./render-team-sync";

vi.mock("../../../../lib/api", () => ({
	acceptDiscoveredPeer: vi.fn(),
	renamePeer: vi.fn(),
	deletePeer: vi.fn(),
}));

vi.mock("../../sync-dialogs", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../sync-dialogs")>()),
	openSyncConfirmDialog: vi.fn(async () => true),
}));

beforeEach(() => {
	vi.clearAllMocks();
	state.pendingCoordinatorApprovalsByDeviceId.clear();
	state.pendingAcceptedSyncPeers = [];
	teamSyncState.loadSyncData = vi.fn(async () => {});
});

afterEach(() => {
	document.body.innerHTML = "";
});

function renderStatus(primaryStatus: UiTeamSyncPrimaryStatus) {
	const badge = document.createElement("span");
	const meta = document.createElement("div");
	renderTeamSyncPrimaryStatus(badge, meta, primaryStatus);
	return { badge, meta };
}

describe("renderTeamSyncPrimaryStatus", () => {
	it.each([
		[
			"disabled",
			{
				state: "disabled",
				badgeLabel: "Sync off",
				meta: "Team: Acme. Coordinator presence does not move Project data while sync is off.",
				nextAction: "Open Settings and turn on sync.",
			},
			"sync-online-badge sync-online-offline",
		],
		[
			"reachable",
			{
				state: "reachable",
				badgeLabel: "Reachable",
				meta: "Team: Acme. The coordinator is reachable, but healthy sync is not confirmed.",
				nextAction: "Pair and approve a device.",
			},
			"sync-online-badge sync-online-offline",
		],
		[
			"healthy",
			{
				state: "healthy",
				badgeLabel: "Healthy",
				meta: "Team: Acme. Sync is healthy.",
				nextAction: null,
			},
			"sync-online-badge",
		],
		[
			"needs attention",
			{
				state: "needs-attention",
				badgeLabel: "Needs attention",
				meta: "Team: Acme. Exact-Project setup has not converged.",
				nextAction: "Open Project sharing below and retry setup for Roadmap.",
			},
			"sync-online-badge sync-online-error",
		],
		[
			"pending setup",
			{
				state: "pending-setup",
				badgeLabel: "Setup pending",
				meta: "Team: Acme. Exact-Project setup is still pending.",
				nextAction: "Keep both devices online, then sync again.",
			},
			"sync-online-badge sync-online-offline",
		],
		[
			"trust blocked",
			{
				state: "trust-blocked",
				badgeLabel: "Pairing needed",
				meta: "Team: Acme. A device still needs two-way trust.",
				nextAction: "Finish pairing or approval on both devices.",
			},
			"sync-online-badge sync-online-error",
		],
		[
			"not enrolled",
			{
				state: "not-enrolled",
				badgeLabel: "Not enrolled",
				meta: "Team: Acme. This device is not enrolled with the coordinator.",
				nextAction: "Accept a Team invitation in Sharing.",
			},
			"sync-online-badge sync-online-offline",
		],
		[
			"configured unreachable",
			{
				state: "unreachable",
				badgeLabel: "Unreachable",
				meta: "Team: Acme. The coordinator is not currently reachable.",
				nextAction: "Check the coordinator connection.",
			},
			"sync-online-badge sync-online-error",
		],
		[
			"unconfigured setup needed",
			{
				state: "unreachable",
				badgeLabel: "Setup needed",
				meta: "Configure or join a Team before expecting Project data to sync.",
				nextAction: "Set a coordinator URL in Settings → Device Sync.",
			},
			"sync-online-badge sync-online-error",
		],
	] as const)("renders %s badge and metadata", (_name, status, expectedClass) => {
		const { badge, meta } = renderStatus(status);

		expect(badge.textContent).toBe(status.badgeLabel);
		expect(badge.className).toBe(expectedClass);
		expect(meta.textContent).toBe(status.meta);
		expect(meta.textContent).not.toContain(status.nextAction ?? "__no_action__");
	});
});

describe("renderTeamSync team devices", () => {
	function configuredCard() {
		document.body.innerHTML = `
			<div id="syncTeamMeta"></div>
			<div id="syncSetupPanel"></div>
			<div id="syncTeamActions"></div>
		`;
		state.lastSyncStatus = { enabled: true, daemon_state: "ok", daemon_running: true };
		state.lastSyncPeers = [];
		state.lastSyncCoordinator = {
			configured: true,
			coordinator_url: "https://coord.example.test",
			sync_enabled: true,
			groups: ["Acme"],
			presence_status: "posted",
			discovered_devices: [
				{
					device_id: "device-a",
					display_name: "Desk Mini",
					fingerprint: "fingerprint-a",
					groups: ["Acme"],
					addresses: ["10.0.0.2:7337"],
					stale: false,
				},
			],
		};
	}

	it("leaves discovered team devices to Devices", () => {
		configuredCard();
		state.lastSyncViewModel = deriveSyncViewModel({
			coordinator: state.lastSyncCoordinator,
			peers: state.lastSyncPeers,
			status: state.lastSyncStatus,
		});

		act(() => renderTeamSync());

		expect(document.querySelector("[data-discovered-device-id]")).toBeNull();
		expect(document.getElementById("syncTeamActions")?.textContent).not.toContain(
			"Pair with this device",
		);
	});

	it.each(["review-team-device", "name-device"] as const)(
		"sends the %s attention action to Devices",
		async (kind) => {
			configuredCard();
			window.location.hash = "";
			state.lastSyncViewModel = {
				attentionItems: [
					{
						actionLabel: "Open Devices",
						deviceId: "device-a",
						id: `${kind}:device-a`,
						kind,
						priority: 20,
						summary: "Check this device.",
						title: "Desk Mini needs a look",
					},
				],
				duplicatePeople: [],
				primaryStatus: deriveTeamSyncPrimaryStatus({
					status: state.lastSyncStatus,
					coordinator: state.lastSyncCoordinator,
					peers: state.lastSyncPeers,
				}),
				summary: { connectedDeviceCount: 0, offlineTeamDeviceCount: 0, seenOnTeamCount: 1 },
			};

			act(() => renderTeamSync());
			const action = [...document.querySelectorAll("button")].find(
				(button) => button.textContent === "Open Devices",
			);
			await act(async () => action?.click());

			expect(window.location.hash).toBe("#devices");
		},
	);
});
