import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({
	loadSyncStatus: vi.fn(),
	loadSyncActors: vi.fn(),
	loadShareOperations: vi.fn(),
	loadCoordinatorAdminStatus: vi.fn(),
	loadDeviceIdentityInventory: vi.fn(),
}));

vi.mock("../health", () => ({ renderHealthOverview: vi.fn() }));
vi.mock("./diagnostics", () => ({
	renderSyncStatus: vi.fn(),
	renderSyncAttempts: vi.fn(),
	renderSyncDiagnosticsUnavailable: vi.fn(),
	renderPairing: vi.fn(),
	initDiagnosticsEvents: vi.fn(),
	setRenderSyncPeers: vi.fn(),
}));
vi.mock("./team-sync", () => ({
	renderTeamSync: vi.fn(),
	renderSyncSharingReview: vi.fn(),
	initTeamSyncEvents: vi.fn(),
	setLoadSyncData: vi.fn(),
}));
vi.mock("./people", () => ({
	renderSyncActors: vi.fn(),
	renderSyncPeers: vi.fn(),
	renderSyncPeopleUnavailable: vi.fn(),
	renderLegacyDeviceClaims: vi.fn(),
	renderProjectSharingOperations: vi.fn(),
	initPeopleEvents: vi.fn(),
	setLoadSyncData: vi.fn(),
}));
vi.mock("./components/render-root", () => ({ ensureSyncRenderBoundary: vi.fn() }));
vi.mock("./sync-dialogs", () => ({ ensureSyncDialogHost: vi.fn() }));
vi.mock("./helpers", () => ({
	hideSkeleton: vi.fn(),
	readDuplicatePersonDecisions: vi.fn(() => ({})),
}));

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("loadSyncData", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		const { state } = await import("../../lib/state");
		const { resetSyncLoadStateForTests } = await import("./index");
		resetSyncLoadStateForTests();
		state.activeTab = "advanced";
		state.currentProject = "";
		state.lastSyncPeers = [];
		state.pendingAcceptedSyncPeers = [];
		state.lastSyncActors = [];
		state.lastShareOperations = [];
		state.shareOperationsLoadError = false;
		state.lastSyncCoordinator = null;
		state.pendingCoordinatorApprovalsByDeviceId.clear();
		state.lastSyncViewModel = null;
		state.lastDeviceIdentityInventory = null;
		state.deviceIdentityInventoryLoadError = false;
	});

	it("retains pending approval when the matching device still needs local approval", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		state.pendingCoordinatorApprovalsByDeviceId.set("device-a", {
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-a",
		});
		vi.mocked(api.loadSyncStatus).mockResolvedValue({
			coordinator: {
				coordinator_url: "https://coord.example.test",
				groups: ["team-a"],
				discovered_devices: [
					{
						device_id: "device-a",
						fingerprint: null,
						groups: ["team-a"],
						needs_local_approval: true,
						incoming_reciprocal_request_id: "request-a",
					},
				],
			},
			peers: [],
		} as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });

		await loadSyncData();

		expect(state.pendingCoordinatorApprovalsByDeviceId.get("device-a")).toEqual({
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-a",
		});
	});

	it("clears pending approval when the matching device no longer needs local approval", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		state.pendingCoordinatorApprovalsByDeviceId.set("device-a", {
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-a",
		});
		vi.mocked(api.loadSyncStatus).mockResolvedValue({
			coordinator: {
				coordinator_url: "https://coord.example.test",
				groups: ["team-a"],
				discovered_devices: [
					{
						device_id: "device-a",
						fingerprint: "fingerprint-a",
						groups: ["team-a"],
						needs_local_approval: false,
						incoming_reciprocal_request_id: "request-a",
					},
				],
			},
			peers: [],
		} as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });

		await loadSyncData();

		expect(state.pendingCoordinatorApprovalsByDeviceId.has("device-a")).toBe(false);
	});

	it("retains pending approval when the device is absent from the snapshot", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		state.pendingCoordinatorApprovalsByDeviceId.set("device-a", {
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-a",
		});
		vi.mocked(api.loadSyncStatus).mockResolvedValue({
			coordinator: {
				coordinator_url: "https://coord.example.test",
				groups: ["team-a"],
				discovered_devices: [],
			},
			peers: [],
		} as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });

		await loadSyncData();

		expect(state.pendingCoordinatorApprovalsByDeviceId.has("device-a")).toBe(true);
	});

	it("retains pending approval when reciprocal approval data is incomplete", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		state.pendingCoordinatorApprovalsByDeviceId.set("device-a", {
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-a",
		});
		vi.mocked(api.loadSyncStatus).mockResolvedValue({
			coordinator: {
				coordinator_url: "https://coord.example.test",
				reciprocal_approval_error: "coordinator request timed out",
				discovered_devices: [
					{
						device_id: "device-a",
						needs_local_approval: false,
						incoming_reciprocal_request_id: null,
					},
				],
			},
			peers: [],
		} as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });

		await loadSyncData();

		expect(state.pendingCoordinatorApprovalsByDeviceId.has("device-a")).toBe(true);
	});

	it("clears pending approval when the device ID has a replacement request", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		state.pendingCoordinatorApprovalsByDeviceId.set("device-a", {
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-reviewed",
		});
		vi.mocked(api.loadSyncStatus).mockResolvedValue({
			coordinator: {
				coordinator_url: "https://coord.example.test",
				groups: ["team-a"],
				discovered_devices: [
					{
						device_id: "device-a",
						fingerprint: "fingerprint-replacement",
						groups: ["team-a"],
						needs_local_approval: true,
						incoming_reciprocal_request_id: "request-replacement",
					},
				],
			},
			peers: [],
		} as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });

		await loadSyncData();

		expect(state.pendingCoordinatorApprovalsByDeviceId.has("device-a")).toBe(false);
	});

	it("retains pending approval when one duplicate device entry still matches", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		state.pendingCoordinatorApprovalsByDeviceId.set("device-a", {
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-reviewed",
		});
		vi.mocked(api.loadSyncStatus).mockResolvedValue({
			coordinator: {
				coordinator_url: "https://coord.example.test",
				groups: ["team-a"],
				discovered_devices: [
					{
						device_id: "device-a",
						fingerprint: "fingerprint-reviewed",
						groups: ["team-a"],
						needs_local_approval: true,
						incoming_reciprocal_request_id: "request-reviewed",
					},
					{
						device_id: "device-a",
						fingerprint: "fingerprint-replacement",
						groups: ["team-a"],
						needs_local_approval: true,
						incoming_reciprocal_request_id: "request-replacement",
					},
				],
			},
			peers: [],
		} as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });

		await loadSyncData();

		expect(state.pendingCoordinatorApprovalsByDeviceId.has("device-a")).toBe(true);
	});

	it.each([
		["coordinator URL", "https://other-coord.example.test", "request-a"],
		["reciprocal request", "https://coord.example.test", "request-b"],
	])("clears pending approval when the %s changes", async (_label, coordinatorUrl, requestId) => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		state.pendingCoordinatorApprovalsByDeviceId.set("device-a", {
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-a",
		});
		vi.mocked(api.loadSyncStatus).mockResolvedValue({
			coordinator: {
				coordinator_url: coordinatorUrl,
				groups: ["team-a"],
				discovered_devices: [
					{
						device_id: "device-a",
						fingerprint: "fingerprint-a",
						groups: ["team-a"],
						needs_local_approval: true,
						incoming_reciprocal_request_id: requestId,
					},
				],
			},
			peers: [],
		} as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });

		await loadSyncData();

		expect(state.pendingCoordinatorApprovalsByDeviceId.has("device-a")).toBe(false);
	});

	it("rerenders when local pending approval state changes without a payload change", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		const { renderTeamSync } = await import("./team-sync");
		vi.mocked(api.loadSyncStatus).mockResolvedValue({
			coordinator: {
				coordinator_url: "https://coord.example.test",
				groups: ["team-a"],
				discovered_devices: [
					{
						device_id: "device-a",
						fingerprint: "fingerprint-a",
						groups: ["team-a"],
						needs_local_approval: true,
						incoming_reciprocal_request_id: "request-a",
					},
				],
			},
			peers: [],
		} as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });

		await loadSyncData();
		state.pendingCoordinatorApprovalsByDeviceId.set("device-a", {
			coordinatorUrl: "https://coord.example.test",
			incomingRequestId: "request-a",
		});
		await loadSyncData();

		expect(renderTeamSync).toHaveBeenCalledTimes(2);
	});

	it("ignores stale out-of-order sync payloads from older refreshes", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });
		vi.mocked(api.loadDeviceIdentityInventory).mockResolvedValue({
			version: 1,
			items: [],
			coordinatorEvidence: { availability: "available", safeErrorCode: null },
			truncated: false,
		});

		const first = deferred<{
			peers: Array<{ peer_device_id: string }>;
			sharing_review: [];
			attempts: [];
			legacy_devices: [];
		}>();
		const second = deferred<{
			peers: Array<{ peer_device_id: string }>;
			sharing_review: [];
			attempts: [];
			legacy_devices: [];
		}>();

		vi.mocked(api.loadSyncStatus)
			.mockReturnValueOnce(first.promise as never)
			.mockReturnValueOnce(second.promise as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });
		const firstLoad = loadSyncData();
		const secondLoad = loadSyncData();

		second.resolve({
			peers: [{ peer_device_id: "peer-new" }],
			sharing_review: [],
			attempts: [],
			legacy_devices: [],
		});
		await secondLoad;
		expect(state.lastSyncPeers.map((peer) => peer.peer_device_id)).toEqual(["peer-new"]);
		expect(api.loadSyncStatus).toHaveBeenNthCalledWith(1, false, "", {
			includeJoinRequests: false,
		});
		expect(api.loadSyncStatus).toHaveBeenNthCalledWith(2, false, "", {
			includeJoinRequests: false,
		});

		first.resolve({
			peers: [{ peer_device_id: "peer-old" }],
			sharing_review: [],
			attempts: [],
			legacy_devices: [],
		});
		await firstLoad;
		expect(state.lastSyncPeers.map((peer) => peer.peer_device_id)).toEqual(["peer-new"]);
	});

	it("does not extend the health-tab cache ttl on cache hits", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");

		state.activeTab = "health";

		vi.mocked(api.loadSyncStatus).mockResolvedValue({
			peers: [{ peer_device_id: "peer-cached" }],
			sharing_review: [],
			attempts: [],
			legacy_devices: [],
		} as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		await loadSyncData();
		await loadSyncData();

		expect(api.loadSyncStatus).toHaveBeenCalledTimes(1);
		expect(api.loadSyncStatus).toHaveBeenCalledWith(false, "", {
			includeJoinRequests: false,
		});
	});

	it("does not request secondary sync data when status fails", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");

		state.activeTab = "devices";
		state.lastDeviceIdentityInventory = {
			version: 1,
			items: [],
			coordinatorEvidence: { availability: "available", safeErrorCode: null },
			truncated: false,
		};
		state.deviceIdentityInventoryLoadError = false;
		vi.mocked(api.loadSyncStatus).mockRejectedValue(new Error("status unavailable"));
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });

		await loadSyncData();

		expect(api.loadSyncActors).not.toHaveBeenCalled();
		expect(api.loadDeviceIdentityInventory).not.toHaveBeenCalled();
		expect(state.lastDeviceIdentityInventory).not.toBeNull();
		expect(state.deviceIdentityInventoryLoadError).toBe(true);
	});

	it("keeps peer diagnostics when project sharing lifecycle loading fails", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		vi.mocked(api.loadSyncStatus).mockResolvedValue({
			status: { enabled: true, daemon_state: "ok", daemon_running: true },
			coordinator: {
				configured: true,
				sync_enabled: true,
				groups: ["Acme"],
				presence_status: "posted",
			},
			peers: [
				{
					peer_device_id: "peer-still-visible",
					status: { peer_state: "online", sync_status: "ok" },
				},
			],
			sharing_review: [],
			attempts: [],
			legacy_devices: [],
		} as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockRejectedValue(new Error("lifecycle unavailable"));

		await loadSyncData();

		expect(state.lastSyncPeers.map((peer) => peer.peer_device_id)).toEqual(["peer-still-visible"]);
		expect(state.shareOperationsLoadError).toBe(true);
		expect(state.lastSyncViewModel?.primaryStatus).toMatchObject({
			state: "needs-attention",
			badgeLabel: "Refresh needed",
			nextAction: expect.stringMatching(/Refresh.*retry/),
		});
	});

	it("refreshes authoritative device Identity inventory for Advanced", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		state.deviceIdentityInventoryLoadError = true;
		vi.mocked(api.loadSyncStatus).mockResolvedValue({ peers: [] } as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });
		vi.mocked(api.loadDeviceIdentityInventory).mockResolvedValue({
			version: 1,
			items: [
				{
					version: 1,
					deviceId: "peer-bound",
					evidenceDeviceIds: ["peer-bound"],
					displayName: "Bound peer",
					state: "configured",
					identityId: "identity-reviewed",
					suggestedIdentityId: null,
					validatedFingerprint: null,
					isLocal: false,
					sources: ["identity_binding"],
					conflictCodes: [],
				},
			],
			coordinatorEvidence: { availability: "available", safeErrorCode: null },
			truncated: false,
		});

		await loadSyncData();

		expect(state.lastDeviceIdentityInventory?.items[0]).toMatchObject({
			deviceId: "peer-bound",
			state: "configured",
			identityId: "identity-reviewed",
		});
		expect(state.deviceIdentityInventoryLoadError).toBe(false);
	});

	it("leaves device Identity inventory refreshes to the Devices loader on Devices", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		state.activeTab = "devices";
		state.lastDeviceIdentityInventory = {
			version: 1,
			items: [],
			coordinatorEvidence: { availability: "available", safeErrorCode: null },
			truncated: false,
		};
		vi.mocked(api.loadSyncStatus).mockResolvedValue({ peers: [] } as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });

		await loadSyncData();

		expect(api.loadDeviceIdentityInventory).not.toHaveBeenCalled();
		expect(state.lastDeviceIdentityInventory).not.toBeNull();
	});

	it("marks authoritative ownership unavailable when its refresh fails", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		state.lastDeviceIdentityInventory = {
			version: 1,
			items: [],
			coordinatorEvidence: { availability: "available", safeErrorCode: null },
			truncated: false,
		};
		vi.mocked(api.loadSyncStatus).mockResolvedValue({ peers: [] } as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });
		vi.mocked(api.loadDeviceIdentityInventory).mockRejectedValue(
			new Error("inventory unavailable"),
		);

		await loadSyncData();

		expect(state.deviceIdentityInventoryLoadError).toBe(true);
		expect(state.lastDeviceIdentityInventory).not.toBeNull();
	});

	it("does not load device Identity inventory for Health-only sync refreshes", async () => {
		const api = await import("../../lib/api");
		const { state } = await import("../../lib/state");
		const { loadSyncData } = await import("./index");
		state.activeTab = "health";
		state.deviceIdentityInventoryLoadError = true;
		vi.mocked(api.loadSyncStatus).mockResolvedValue({ peers: [] } as never);
		vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
		vi.mocked(api.loadCoordinatorAdminStatus).mockResolvedValue({});
		vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });

		await loadSyncData();

		expect(api.loadDeviceIdentityInventory).not.toHaveBeenCalled();
		expect(state.deviceIdentityInventoryLoadError).toBe(true);
	});
});
