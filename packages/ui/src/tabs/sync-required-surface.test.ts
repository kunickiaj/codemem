import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { state } from "../lib/state";
import { renderHealthOverview } from "./health";
import { loadSyncData, resetSyncLoadStateForTests } from "./sync/index";
import { renderTeamSync } from "./sync/team-sync";

vi.mock("../lib/api", () => ({
	loadSyncStatus: vi.fn(),
	loadSyncActors: vi.fn(),
	loadCoordinatorAdminStatus: vi.fn(),
	loadShareOperations: vi.fn(),
	loadDeviceIdentityInventory: vi.fn(),
}));
vi.mock("./health", () => ({ markHealthStatusUnchecked: vi.fn(), renderHealthOverview: vi.fn() }));
vi.mock("./sync/diagnostics", () => ({
	renderSyncStatus: vi.fn(),
	renderSyncAttempts: vi.fn(),
	renderSyncDiagnosticsUnavailable: vi.fn(),
	renderPairing: vi.fn(),
	initDiagnosticsEvents: vi.fn(),
	setRenderSyncPeers: vi.fn(),
}));
vi.mock("./sync/team-sync", () => ({
	renderTeamSync: vi.fn(),
	renderSyncSharingReview: vi.fn(),
	initTeamSyncEvents: vi.fn(),
	setLoadSyncData: vi.fn(),
}));
vi.mock("./sync/people", () => ({
	renderSyncActors: vi.fn(),
	renderSyncActorsUnavailable: vi.fn(),
	renderSyncPeers: vi.fn(),
	renderSyncPeopleUnavailable: vi.fn(),
	renderLegacyDeviceClaims: vi.fn(),
	renderProjectSharingOperations: vi.fn(),
	initPeopleEvents: vi.fn(),
	setLoadSyncData: vi.fn(),
}));
vi.mock("./sync/components/render-root", () => ({ ensureSyncRenderBoundary: vi.fn() }));
vi.mock("./sync/sync-dialogs", () => ({ ensureSyncDialogHost: vi.fn() }));
vi.mock("./sync/helpers", () => ({
	hideSkeleton: vi.fn(),
	readDuplicatePersonDecisions: vi.fn(() => ({})),
}));

const auxiliaryReads = [
	api.loadSyncActors,
	api.loadCoordinatorAdminStatus,
	api.loadShareOperations,
	api.loadDeviceIdentityInventory,
] as const;
const primary = { status: { enabled: true }, peers: [{ peer_device_id: "fresh-peer" }] };

function deferredStatus() {
	let resolve!: (value: Awaited<ReturnType<typeof api.loadSyncStatus>>) => void;
	const promise = new Promise<Awaited<ReturnType<typeof api.loadSyncStatus>>>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function retainedAuxiliaryState() {
	return {
		actors: state.lastSyncActors,
		admin: state.lastSyncCoordinatorAdminStatus,
		operations: state.lastShareOperations,
		inventory: state.lastDeviceIdentityInventory,
		operationsError: state.shareOperationsLoadError,
		inventoryError: state.deviceIdentityInventoryLoadError,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	resetSyncLoadStateForTests();
	document.body.innerHTML = "";
	state.activeTab = "advanced";
	state.currentProject = "";
	state.lastSyncStatus = null;
	state.lastSyncPeers = [];
	state.pendingAcceptedSyncPeers = [];
	state.pendingCoordinatorApprovalsByDeviceId.clear();
	state.lastSyncViewModel = null;
	state.lastSyncCoordinator = null;
	state.lastSyncActors = [];
	state.lastSyncCoordinatorAdminStatus = { readiness: "partial" };
	state.lastShareOperations = [];
	state.lastDeviceIdentityInventory = { version: 1, devices: [] } as never;
	state.shareOperationsLoadError = false;
	state.deviceIdentityInventoryLoadError = false;
	vi.mocked(api.loadSyncStatus).mockResolvedValue(primary as never);
	vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });
	vi.mocked(api.loadCoordinatorAdminStatus).mockResolvedValue({});
	vi.mocked(api.loadShareOperations).mockResolvedValue({ items: [] });
	vi.mocked(api.loadDeviceIdentityInventory).mockResolvedValue({} as never);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("required sync surfaces", () => {
	// Health and Devices must become ready without starting Advanced reads.
	it.each(["health", "devices"] as const)(
		"renders %s primary data without waiting for pending auxiliary reads",
		async (requiredSurface) => {
			// Arrange: leave Advanced active to prove caller intent controls reads.
			vi.useFakeTimers();
			for (const read of auxiliaryReads)
				vi.mocked(read).mockReturnValue(new Promise<never>(() => {}));
			const retained = retainedAuxiliaryState();
			// Act: a settled sentinel avoids a test timeout if auxiliary work blocks readiness.
			const completion = Promise.race([
				loadSyncData({ requiredSurface }),
				new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 0)),
			]);
			await vi.advanceTimersByTimeAsync(0);
			const outcome = await completion;
			// Assert
			expect(outcome).toBe(true);
			expect(api.loadSyncStatus).toHaveBeenCalledOnce();
			expect(state.lastSyncStatus).toMatchObject(primary.status);
			expect(state.lastSyncPeers).toEqual(primary.peers);
			expect(renderTeamSync).toHaveBeenCalledOnce();
			expect(retainedAuxiliaryState()).toEqual(retained);
			for (const read of auxiliaryReads) expect(read).not.toHaveBeenCalled();
		},
	);

	it.each(["health", "devices"] as const)(
		"retains auxiliary data and error flags on a %s refresh with failing auxiliary mocks",
		async (requiredSurface) => {
			// Arrange
			state.lastSyncActors = [{ actor_id: "retained-actor" }];
			state.lastShareOperations = [{ operation_id: "retained-operation" }] as never;
			state.shareOperationsLoadError = true;
			state.deviceIdentityInventoryLoadError = true;
			const retained = retainedAuxiliaryState();
			for (const read of auxiliaryReads)
				vi.mocked(read).mockRejectedValue(new Error("unavailable"));
			// Act
			const result = await loadSyncData({ requiredSurface });
			// Assert
			expect(result).toBe(true);
			expect(retainedAuxiliaryState()).toEqual(retained);
			for (const read of auxiliaryReads) expect(read).not.toHaveBeenCalled();
		},
	);

	it.each(["health", "devices"] as const)(
		"fails %s when primary status fails",
		async (requiredSurface) => {
			// Arrange
			vi.mocked(api.loadSyncStatus).mockRejectedValue(new Error("primary unavailable"));
			// Act
			const result = await loadSyncData({ requiredSurface });
			// Assert
			expect(result).toBe(false);
			expect(state.lastSyncPeers).toEqual([]);
			for (const read of auxiliaryReads) expect(read).not.toHaveBeenCalled();
		},
	);
});

describe("sync cache and full-load compatibility", () => {
	it("reuses Health status before 15 seconds and fetches again at expiry", async () => {
		// Arrange
		state.activeTab = "health";
		const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		// Act
		const initial = await loadSyncData({ requiredSurface: "health" });
		now.mockReturnValue(1_800_000_014_999);
		const cached = await loadSyncData({ requiredSurface: "health" });
		const callsBeforeExpiry = vi.mocked(api.loadSyncStatus).mock.calls.length;
		now.mockReturnValue(1_800_000_015_000);
		const expired = await loadSyncData({ requiredSurface: "health" });
		// Assert
		expect([initial, cached, expired]).toEqual([true, true, true]);
		expect(callsBeforeExpiry).toBe(1);
		expect(api.loadSyncStatus).toHaveBeenCalledTimes(2);
		expect(renderHealthOverview).toHaveBeenCalled();
		for (const read of auxiliaryReads) expect(read).not.toHaveBeenCalled();
	});

	it.each([undefined, "all"] as const)(
		"loads all Advanced reads for requiredSurface=%s",
		async (requiredSurface) => {
			// Arrange
			const options = { requiredSurface };
			// Act
			const result = await loadSyncData(options);
			// Assert
			expect(result).toBe(true);
			for (const read of auxiliaryReads) expect(read).toHaveBeenCalledOnce();
		},
	);

	it.each(auxiliaryReads)("keeps full-load failure semantics when %s rejects", async (read) => {
		// Arrange
		vi.mocked(read).mockRejectedValue(new Error("auxiliary unavailable"));
		// Act
		const result = await loadSyncData();
		// Assert
		expect(result).toBe(false);
		expect(state.lastSyncPeers).toEqual(primary.peers);
		for (const auxiliary of auxiliaryReads) expect(auxiliary).toHaveBeenCalledOnce();
	});
});

describe("sync refresh ownership", () => {
	it.each(["health", "devices"] as const)("ignores aborted %s status", async (requiredSurface) => {
		// Arrange
		const pending = deferredStatus();
		const controller = new AbortController();
		vi.mocked(api.loadSyncStatus).mockReturnValueOnce(pending.promise);
		// Act
		const load = loadSyncData({ requiredSurface, signal: controller.signal });
		controller.abort();
		pending.resolve(primary as never);
		const result = await load;
		// Assert
		expect(result).toBe(false);
		expect(state.lastSyncStatus).toBeNull();
		expect(renderTeamSync).not.toHaveBeenCalled();
	});

	it.each(["health", "devices"] as const)("ignores replaced %s status", async (requiredSurface) => {
		// Arrange
		const pending = deferredStatus();
		vi.mocked(api.loadSyncStatus).mockReturnValueOnce(pending.promise);
		// Act
		const oldLoad = loadSyncData({ requiredSurface });
		const currentResult = await loadSyncData({ requiredSurface });
		pending.resolve({ status: { enabled: false }, peers: [] } as never);
		await oldLoad;
		// Assert
		expect(currentResult).toBe(true);
		expect(state.lastSyncStatus).toMatchObject(primary.status);
		expect(state.lastSyncPeers).toEqual(primary.peers);
		expect(renderTeamSync).toHaveBeenCalledOnce();
	});
});
