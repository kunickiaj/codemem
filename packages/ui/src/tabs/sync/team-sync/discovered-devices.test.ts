import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../lib/api";
import { state } from "../../../lib/state";
import { teamSyncState } from "./data/state";
import {
	deriveDiscoveredRows,
	needsCoordinatorGroupReview,
	submitDiscoveredDeviceReview,
	type TeamSyncDiscoveredRow,
} from "./discovered-devices";

vi.mock("../../../lib/api", () => ({
	acceptDiscoveredPeer: vi.fn(),
	renamePeer: vi.fn(),
}));

beforeEach(() => {
	vi.clearAllMocks();
	state.pendingCoordinatorApprovalsByDeviceId.clear();
	state.pendingAcceptedSyncPeers = [];
	teamSyncState.loadSyncData = vi.fn(async () => {});
});

afterEach(() => {
	state.lastDeviceIdentityInventory = null;
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
	it("records request-bound approval state and tells the page before rename finishes", async () => {
		let finishRename!: () => void;
		const renamePending = new Promise<void>((resolve) => {
			finishRename = resolve;
		});
		vi.mocked(api.acceptDiscoveredPeer).mockResolvedValue({ name: "Desk Mini" } as never);
		vi.mocked(api.renamePeer).mockReturnValue(renamePending as never);
		const onApprovalSent = vi.fn();

		const submission = submitDiscoveredDeviceReview(reviewRow(), "Desk Mini Renamed", {
			onApprovalSent,
		});
		await vi.waitFor(() => expect(api.renamePeer).toHaveBeenCalled());

		expect(state.pendingCoordinatorApprovalsByDeviceId.get("device-a")).toEqual({
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-a",
		});
		expect(onApprovalSent).toHaveBeenCalledOnce();

		finishRename();
		const feedback = await submission;
		expect(feedback.message).toBe(
			"Approval sent for this device. This screen may take up to 30 seconds to confirm two-way trust.",
		);
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

function coordinatorWith(devices: unknown[], peers: unknown[] = []) {
	state.lastSyncStatus = { enabled: true, daemon_state: "ok", daemon_running: true };
	state.lastSyncPeers = peers as never;
	state.lastSyncCoordinator = {
		configured: true,
		coordinator_url: "https://coord.example.test",
		sync_enabled: true,
		groups: ["Acme"],
		presence_status: "posted",
		discovered_devices: devices as never,
	};
}

describe("deriveDiscoveredRows", () => {
	it("lists nothing without a configured coordinator", () => {
		state.lastSyncCoordinator = { configured: false };

		expect(deriveDiscoveredRows()).toEqual([]);
	});

	it("keeps a stale unpaired device visible and says to wait for fresh presence", () => {
		coordinatorWith([
			{
				device_id: "device-stale",
				display_name: "Desk Mini",
				fingerprint: "fingerprint-stale",
				groups: ["Acme"],
				addresses: [],
				address_count: 0,
				stale: true,
			},
		]);

		const [row] = deriveDiscoveredRows();

		expect(row).toMatchObject({
			availabilityLabel: "Offline",
			mode: "stale",
			note: "No fresh addresses · device id: device-stale",
			actionMessage:
				"Wait for a fresh coordinator presence update, then review this device again here.",
		});
	});

	it("keeps a fresh device without a usable address non-actionable", () => {
		coordinatorWith([
			{
				device_id: "device-no-address",
				display_name: "Desk Mini",
				fingerprint: "fingerprint-no-address",
				groups: ["Acme"],
				addresses: [],
				address_count: 0,
				stale: false,
			},
		]);

		const [row] = deriveDiscoveredRows();

		expect(row?.mode).toBe("waiting-address");
		expect(row?.actionMessage).toBe(
			"Wait for this device to publish a fresh address, then refresh and review it.",
		);
	});
});

describe("deriveDiscoveredRows approvals", () => {
	it.each([
		{ status: { peer_state: "online", sync_status: "ok" } },
		{ last_error: "401 unauthorized" },
		{},
	])("retains a stale paired approval with wait guidance, then offers approval: %j", (details) => {
		const device = {
			device_id: "device-stale",
			display_name: "Desk Mini",
			fingerprint: "fingerprint-a",
			groups: ["team-a"],
			needs_local_approval: true,
			incoming_reciprocal_request_id: "request-a",
			stale: true,
		};
		coordinatorWith(
			[device],
			[{ peer_device_id: "device-stale", fingerprint: "fingerprint-a", ...details }],
		);

		expect(deriveDiscoveredRows()[0]?.actionMessage).toContain(
			"Wait for a fresh coordinator presence update",
		);

		device.stale = false;
		const [row] = deriveDiscoveredRows();
		expect(row).toMatchObject({ mode: "accept", approvalState: "needs-local-approval" });
	});

	it("shows an approval already sent as pending", () => {
		coordinatorWith(
			[
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
			[
				{
					peer_device_id: "device-a",
					fingerprint: "fingerprint-a",
					status: { peer_state: "online", sync_status: "ok" },
				},
			],
		);
		state.pendingCoordinatorApprovalsByDeviceId.set("device-a", {
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-a",
		});

		const [row] = deriveDiscoveredRows();

		expect(row).toMatchObject({
			mode: "approval-pending",
			approvalBadgeLabel: "Approval sent",
			actionMessage: "Waiting for refreshed coordinator status. You do not need to approve again.",
		});
	});

	it("marks a pairing whose fingerprint differs from the coordinator's as a conflict", () => {
		coordinatorWith(
			[
				{
					device_id: "device-a",
					display_name: "Desk Mini",
					fingerprint: "fingerprint-new",
					groups: ["Acme"],
					addresses: ["10.0.0.2:7337"],
					stale: false,
				},
			],
			[{ peer_device_id: "device-a", fingerprint: "fingerprint-old" }],
		);

		expect(deriveDiscoveredRows()[0]).toMatchObject({
			mode: "conflict",
			connectionLabel: "Needs review",
		});
	});

	describe("coordinator service devices", () => {
		const serviceItem = {
			version: 1 as const,
			deviceId: "relay-health-probe",
			evidenceDeviceIds: ["relay-health-probe"],
			displayName: "Relay health probe",
			state: "service" as const,
			identityId: null,
			suggestedIdentityId: null,
			validatedFingerprint: null,
			isLocal: false,
			sources: ["coordinator_enrollment" as const],
			conflictCodes: [],
		};
		const discovered = (deviceId: string, displayName: string) => ({
			device_id: deviceId,
			display_name: displayName,
			fingerprint: `fingerprint-${deviceId}`,
			groups: ["Acme"],
			addresses: [],
			address_count: 0,
			stale: true,
		});

		it("lists only the real device when the inventory marks the other one as a service", () => {
			coordinatorWith([
				discovered("relay-health-probe", "Relay health probe"),
				discovered("laptop", "Laptop"),
			]);
			state.lastDeviceIdentityInventory = {
				version: 1,
				items: [serviceItem],
				coordinatorEvidence: { availability: "available", safeErrorCode: null },
				truncated: false,
			};

			expect(deriveDiscoveredRows().map((row) => row.deviceId)).toEqual(["laptop"]);
		});

		it("shows every discovered device until the inventory has loaded", () => {
			coordinatorWith([
				discovered("relay-health-probe", "Relay health probe"),
				discovered("laptop", "Laptop"),
			]);
			state.lastDeviceIdentityInventory = null;

			expect(deriveDiscoveredRows()).toHaveLength(2);
		});
	});
});
