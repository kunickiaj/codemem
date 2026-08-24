import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../../lib/api";
import { state } from "../../../../lib/state";
import type { TeamSyncDiscoveredRow } from "../../components/team-sync-panel";
import { deriveTeamSyncPrimaryStatus, type UiTeamSyncPrimaryStatus } from "../../view-model";
import { teamSyncState } from "../data/state";
import {
	needsCoordinatorGroupReview,
	renderTeamSync,
	renderTeamSyncPrimaryStatus,
	submitDiscoveredDeviceReview,
} from "./render-team-sync";

vi.mock("../../../../lib/api", () => ({
	acceptDiscoveredPeer: vi.fn(),
	renamePeer: vi.fn(),
}));

beforeEach(() => {
	vi.clearAllMocks();
	state.pendingCoordinatorApprovalsByDeviceId.clear();
	state.pendingAcceptedSyncPeers = [];
	state.syncDiscoveredFeedback = null;
	teamSyncState.loadSyncData = vi.fn(async () => {});
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("needsCoordinatorGroupReview", () => {
	it("keeps a paired device out of review when it belongs to multiple groups", () => {
		expect(needsCoordinatorGroupReview(["sre", "oss"], true)).toBe(false);
	});

	it("keeps an unpaired multi-group device in review", () => {
		expect(needsCoordinatorGroupReview(["sre", "oss"], false)).toBe(true);
	});

	it("keeps a paired multi-group device in review when local approval is pending", () => {
		expect(needsCoordinatorGroupReview(["sre", "oss"], true, true)).toBe(true);
	});
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
				nextAction: "Paste a Team invite below.",
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
				nextAction: "Configure a coordinator in Advanced settings.",
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

function reviewRow(overrides: Partial<TeamSyncDiscoveredRow> = {}): TeamSyncDiscoveredRow {
	return {
		actionMessage: null,
		actionLabel: "Approve on this device",
		approvalBadgeLabel: "Needs your approval",
		approvalState: "needs-local-approval",
		availabilityLabel: "Available",
		connectionLabel: "Paired on this device",
		coordinatorUrl: "https://coord.example.test",
		deviceId: "device-a",
		displayName: "Desk Mini",
		displayTitle: "device-a",
		fingerprint: "fingerprint-a",
		groupId: "team-a",
		incomingRequestId: "request-a",
		mode: "accept",
		note: "No fresh addresses",
		pairedMessage: null,
		...overrides,
	};
}

describe("submitDiscoveredDeviceReview", () => {
	it("records request-bound approval state and feedback before rename finishes", async () => {
		let finishRename!: () => void;
		const renamePending = new Promise<void>((resolve) => {
			finishRename = resolve;
		});
		vi.mocked(api.acceptDiscoveredPeer).mockResolvedValue({ name: "Desk Mini" } as never);
		vi.mocked(api.renamePeer).mockReturnValue(renamePending as never);

		const submission = submitDiscoveredDeviceReview(reviewRow(), "Desk Mini Renamed");
		await vi.waitFor(() => expect(api.renamePeer).toHaveBeenCalled());

		expect(state.pendingCoordinatorApprovalsByDeviceId.get("device-a")).toEqual({
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-a",
		});
		expect(state.syncDiscoveredFeedback).toEqual({
			message:
				"Approval sent for this device. This screen may take up to 30 seconds to confirm two-way trust.",
			tone: "success",
		});

		finishRename();
		await submission;
	});

	it("does not create a marker when approval fails before success", async () => {
		vi.mocked(api.acceptDiscoveredPeer).mockRejectedValue(new Error("approval rejected"));

		await expect(submitDiscoveredDeviceReview(reviewRow(), "Desk Mini")).rejects.toThrow(
			"approval rejected",
		);

		expect(state.pendingCoordinatorApprovalsByDeviceId.has("device-a")).toBe(false);
	});

	it("approves and records a safe marker when the fingerprint is redacted", async () => {
		vi.mocked(api.acceptDiscoveredPeer).mockResolvedValue({ name: "Desk Mini" } as never);

		await submitDiscoveredDeviceReview(reviewRow({ fingerprint: "" }), "Desk Mini");

		expect(api.acceptDiscoveredPeer).toHaveBeenCalledWith("device-a", {
			fingerprint: "",
			expectedGroupId: "team-a",
			expectedIncomingRequestId: "request-a",
		});
		expect(state.pendingCoordinatorApprovalsByDeviceId.get("device-a")).toEqual({
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-a",
		});
	});

	it("does not create an unsafe marker without an incoming request ID", async () => {
		await expect(
			submitDiscoveredDeviceReview(reviewRow({ incomingRequestId: "" }), "Desk Mini"),
		).rejects.toThrow("Device identity is incomplete");

		expect(state.pendingCoordinatorApprovalsByDeviceId.has("device-a")).toBe(false);
		expect(api.acceptDiscoveredPeer).not.toHaveBeenCalled();
	});

	it("does not approve without the reviewed coordinator group", async () => {
		await expect(
			submitDiscoveredDeviceReview(reviewRow({ groupId: "" }), "Desk Mini"),
		).rejects.toThrow("Device identity is incomplete");

		expect(api.acceptDiscoveredPeer).not.toHaveBeenCalled();
	});

	it("preserves the marker and avoids retry-approval guidance after refresh failure", async () => {
		vi.mocked(api.acceptDiscoveredPeer).mockResolvedValue({ name: "Desk Mini" } as never);
		teamSyncState.loadSyncData = vi.fn(async () => {
			throw new Error("refresh failed");
		});

		const feedback = await submitDiscoveredDeviceReview(reviewRow(), "Desk Mini");

		expect(state.pendingCoordinatorApprovalsByDeviceId.has("device-a")).toBe(true);
		expect(feedback.message).toContain("Approval was sent");
		expect(feedback.message).toContain("up to 30 seconds");
		expect(feedback.message).toContain("do not need to approve again");
		expect(feedback.message.toLowerCase()).not.toContain("retry approval");
	});
});

describe("renderTeamSync pending coordinator approval", () => {
	it("keeps a stale authoritative approval row visible without counting it as actionable", () => {
		document.body.innerHTML = `
			<div id="syncTeamMeta"></div>
			<div id="syncSetupPanel"></div>
			<div id="syncTeamActions"></div>
			<div id="syncCoordinatorDiscovered"></div>
			<div id="syncCoordinatorDiscoveredMeta"></div>
			<div id="syncCoordinatorDiscoveredList"></div>
		`;
		state.lastSyncStatus = { enabled: true, daemon_state: "ok", daemon_running: true };
		state.lastSyncPeers = [
			{
				peer_device_id: "device-a",
				fingerprint: "fingerprint-a",
				status: { peer_state: "online", sync_status: "ok" },
			},
		];
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
					fingerprint: null,
					groups: ["Acme"],
					needs_local_approval: true,
					incoming_reciprocal_request_id: "request-a",
					stale: true,
				},
			],
		};
		state.lastSyncViewModel = {
			attentionItems: [
				{
					actionLabel: "Open device",
					deviceId: "device-a",
					id: "repair:device-a",
					kind: "device-needs-repair",
					priority: 10,
					summary: "Repair this device.",
					title: "Desk Mini needs attention",
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
		state.pendingCoordinatorApprovalsByDeviceId.set("device-a", {
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-a",
		});

		act(() => renderTeamSync());

		const discovered = document.getElementById("syncCoordinatorDiscoveredList") as HTMLElement;
		expect(discovered.textContent).toContain("Approval sent");
		expect(discovered.textContent).toContain("You do not need to approve again");
		expect(discovered.querySelector("button")).toBeNull();
		expect(document.getElementById("syncTeamActions")?.textContent).not.toContain(
			"More team follow-up is listed below",
		);
		expect(document.getElementById("syncTeamActions")?.textContent).not.toContain(
			"Desk Mini needs attention",
		);
	});
});
