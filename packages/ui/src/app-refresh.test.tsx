/// <reference types="vite/client" />

import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../static/index.html?raw";

const mocks = vi.hoisted(() => ({
	loadConfigData: vi.fn(),
	loadCoordinatorAdminData: vi.fn(),
	loadFeedData: vi.fn(),
	loadHealthData: vi.fn(),
	loadPairingData: vi.fn(),
	loadProjectsData: vi.fn(),
	loadRecipientPolicySharingData: vi.fn(),
	loadSyncData: vi.fn(),
	pingViewerReady: vi.fn(),
	refreshDiagnostics: vi.fn(),
	stopPolling: null as null | (() => void),
}));

vi.mock("./app-sharing", () => ({
	createRecipientPolicySharingLoader: vi.fn(() => mocks.loadRecipientPolicySharingData),
}));
vi.mock("./components/diagnostics", () => ({
	closeDiagnosticsDrawer: vi.fn(),
	coordinatedRefreshDiagnosticsDrawer: mocks.refreshDiagnostics,
	initDiagnosticsEntryPoints: vi.fn(),
	mountDiagnosticsDrawer: vi.fn(),
	recordViewerConnectionEvent: vi.fn(),
}));
vi.mock("./components/primitives/toast", () => ({ mountToastHost: vi.fn() }));
vi.mock("./lib/api", () => ({
	loadDeviceIdentityInventory: vi.fn(async () => ({ version: 1, items: [] })),
	loadProjectScopeInventory: vi.fn(async () => ({
		projects: [],
		has_more: false,
		limit: 250,
		offset: 0,
	})),
	loadProjects: vi.fn(async () => ["Codemem"]),
	loadRecipientPolicyIntent: vi.fn(async () => ({
		version: 1,
		identities: [],
		teams: [],
		teamMemberships: [],
		identityDevices: [],
		projectRecipients: [],
	})),
	loadRecipientPolicyReconciliationStatus: vi.fn(async () => ({ version: 1, items: [] })),
	loadRuntimeInfo: vi.fn(async () => ({ version: "test" })),
	loadSyncStatus: vi.fn(async () => ({})),
	pingViewerReady: mocks.pingViewerReady,
}));
vi.mock("./tabs/coordinator-admin", () => ({
	initCoordinatorAdminTab: vi.fn(),
	loadCoordinatorAdminData: mocks.loadCoordinatorAdminData,
}));
vi.mock("./tabs/coordinator-admin/data/status-refresh", () => ({
	beginStandaloneCoordinatorAdminStatusRefresh: vi.fn(() => 1),
	refreshCoordinatorAdminStatusForGeneration: vi.fn(async () => undefined),
}));
vi.mock("./tabs/devices", () => ({ mountDevices: vi.fn() }));
vi.mock("./tabs/feed", () => ({
	initFeedTab: vi.fn(),
	loadFeedData: mocks.loadFeedData,
	updateFeedView: vi.fn(),
}));
vi.mock("./tabs/health", () => ({
	initHealthTab: vi.fn(),
	loadHealthData: mocks.loadHealthData,
}));
vi.mock("./tabs/legacy-team-setup-dialog", () => ({
	mountLegacyTeamSetupDialog: vi.fn(),
	openLegacyTeamSetup: vi.fn(() => true),
}));
vi.mock("./tabs/projects", () => ({
	initProjectsTab: vi.fn(),
	loadProjectsData: mocks.loadProjectsData,
}));
vi.mock("./tabs/recipient-policy-projects", () => ({
	toRecipientPolicyManagementProjects: vi.fn(() => []),
}));
vi.mock("./tabs/settings", () => ({
	initSettings: vi.fn((stopPolling: () => void) => {
		mocks.stopPolling = stopPolling;
	}),
	isSettingsOpen: vi.fn(() => false),
	loadConfigData: mocks.loadConfigData,
}));
vi.mock("./tabs/sync", () => ({
	initSyncTab: vi.fn(),
	invalidateSyncPeerScopeCache: vi.fn(),
	loadPairingData: mocks.loadPairingData,
	loadSyncData: mocks.loadSyncData,
}));
vi.mock("./tabs/sync/sync-view-controller", () => ({ applySyncSubView: vi.fn() }));
vi.mock("./tabs/sync/view-model/peer-status", () => ({
	derivePeerUiStatus: vi.fn(() => "available"),
}));

function bodyMarkup(): string {
	return html.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1] ?? "";
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

function rejectOnAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(resolve, reject);
	});
}

let visibilityState: DocumentVisibilityState;

async function setupRefreshAppTest() {
	vi.useFakeTimers();
	vi.clearAllMocks();
	vi.resetModules();
	mocks.stopPolling = null;
	visibilityState = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
	localStorage.clear();
	localStorage.setItem("codemem-theme", "light");
	document.body.innerHTML = bodyMarkup();
	window.location.hash = "projects";
	mocks.loadConfigData.mockResolvedValue(undefined);
	mocks.loadCoordinatorAdminData.mockResolvedValue(true);
	mocks.loadFeedData.mockResolvedValue(undefined);
	mocks.loadHealthData.mockResolvedValue(undefined);
	mocks.loadPairingData.mockResolvedValue(true);
	mocks.loadProjectsData.mockResolvedValue(true);
	mocks.loadRecipientPolicySharingData.mockResolvedValue(true);
	mocks.loadSyncData.mockResolvedValue(true);
	mocks.pingViewerReady.mockResolvedValue(true);
	mocks.refreshDiagnostics.mockResolvedValue(undefined);
	await import("./app");
	await act(async () => {
		await vi.advanceTimersByTimeAsync(100);
	});
	mocks.loadProjectsData.mockClear();
}

describe("app refresh session wiring", () => {
	beforeEach(setupRefreshAppTest);
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		document.body.innerHTML = "";
		window.location.hash = "";
	});

	it("cancels a hidden-tab refresh and starts a fresh refresh when visibility returns", async () => {
		// Objective: hidden tabs must cancel active work, ignore its late result, and resume successfully.
		// Arrange
		const staleRefresh = deferred<boolean>();
		mocks.loadProjectsData.mockReturnValueOnce(staleRefresh.promise).mockResolvedValueOnce(true);

		// Act
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});
		const staleSignal = mocks.loadProjectsData.mock.calls[0]?.[0]?.signal as AbortSignal;
		visibilityState = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		staleRefresh.resolve(false);
		await act(async () => {
			await staleRefresh.promise;
			await vi.advanceTimersByTimeAsync(0);
		});

		visibilityState = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Assert
		expect(staleSignal.aborted).toBe(true);
		expect(mocks.loadProjectsData).toHaveBeenCalledTimes(2);
		expect(document.getElementById("refreshStatus")?.dataset.refreshState).toBe("idle");
	});

	it.each(["tab switch", "project change"] as const)(
		"cancels an active refresh on %s and ignores its late completion",
		async (cancellation) => {
			// Objective: navigation and project changes must prevent stale refreshes from owning UI state.
			// Arrange
			const staleRefresh = deferred<boolean>();
			mocks.loadProjectsData.mockReturnValueOnce(staleRefresh.promise).mockResolvedValueOnce(true);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(5_100);
			});
			const staleSignal = mocks.loadProjectsData.mock.calls[0]?.[0]?.signal as AbortSignal;

			// Act
			if (cancellation === "tab switch") {
				document.getElementById("tabBtn-health")?.click();
			} else {
				const projectFilter = document.getElementById("projectFilter") as HTMLSelectElement;
				projectFilter.value = "Codemem";
				projectFilter.dispatchEvent(new Event("change"));
			}
			staleRefresh.resolve(false);
			await act(async () => {
				await staleRefresh.promise;
				await vi.advanceTimersByTimeAsync(100);
			});

			// Assert
			expect(staleSignal.aborted).toBe(true);
			expect(document.getElementById("refreshStatus")?.dataset.refreshState).toBe("idle");
			if (cancellation === "tab switch") {
				expect(mocks.loadSyncData).toHaveBeenCalled();
			} else {
				expect(mocks.loadProjectsData).toHaveBeenCalledTimes(2);
			}
		},
	);

	it.each([
		["projects", mocks.loadProjectsData],
		["sharing", mocks.loadRecipientPolicySharingData],
	] as const)("keeps the %s Team summary inside the refresh session", async (tab, loader) => {
		document.getElementById(`tabBtn-${tab}`)?.click();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		expect(loader).toHaveBeenLastCalledWith(
			expect.objectContaining({ awaitTeamSetupSummary: true, signal: expect.any(AbortSignal) }),
		);
	});
});

describe("app refresh deadlines", () => {
	beforeEach(setupRefreshAppTest);
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		document.body.innerHTML = "";
		window.location.hash = "";
	});

	it("reports a timed-out refresh and permits a later refresh to succeed", async () => {
		// Objective: a 15-second deadline must fail one session without poisoning a later session.
		// Arrange
		mocks.stopPolling?.();
		const timedOutRefresh = deferred<boolean>();
		mocks.loadProjectsData
			.mockImplementationOnce(({ signal }) => rejectOnAbort(timedOutRefresh.promise, signal))
			.mockResolvedValueOnce(true);

		// Act
		document.getElementById("tabBtn-projects")?.click();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});
		const timedOutSignal = mocks.loadProjectsData.mock.calls[0]?.[0]?.signal as AbortSignal;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(15_000);
		});

		// Assert
		expect(timedOutSignal.aborted).toBe(true);
		expect(document.getElementById("refreshStatus")?.dataset.refreshState).toBe("error");

		// Arrange
		// The next request is already mocked as successful.

		// Act
		document.getElementById("tabBtn-projects")?.click();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Assert
		expect(mocks.loadProjectsData).toHaveBeenCalledTimes(2);
		expect(document.getElementById("refreshStatus")?.dataset.refreshState).toBe("idle");
	});

	it("releases the refresh gate when diagnostics never settles", async () => {
		// Objective: every participant in a refresh shares the aggregate deadline.
		// Arrange
		mocks.stopPolling?.();
		const stalledDiagnostics = deferred<void>();
		mocks.refreshDiagnostics
			.mockReturnValueOnce(stalledDiagnostics.promise)
			.mockResolvedValue(undefined);

		// Act
		document.getElementById("tabBtn-projects")?.click();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(15_100);
		});

		// Assert
		expect(document.getElementById("refreshStatus")?.dataset.refreshState).toBe("error");

		// Act
		document.getElementById("tabBtn-projects")?.click();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Assert
		expect(mocks.loadProjectsData).toHaveBeenCalledTimes(2);
		expect(document.getElementById("refreshStatus")?.dataset.refreshState).toBe("idle");
	});

	it("does not start a debounced refresh after the tab becomes hidden", async () => {
		// Objective: pausing must clear refresh work that has not started yet.
		// Act
		document.getElementById("tabBtn-projects")?.click();
		visibilityState = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});

		// Assert
		expect(mocks.loadProjectsData).not.toHaveBeenCalled();
		expect(document.getElementById("refreshStatus")?.dataset.refreshState).toBe("paused");
	});

	it("marks an active refresh paused when Settings stops polling", async () => {
		const activeRefresh = deferred<boolean>();
		mocks.loadProjectsData.mockReturnValueOnce(activeRefresh.promise);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});

		mocks.stopPolling?.();

		expect(document.getElementById("refreshStatus")?.dataset.refreshState).toBe("paused");
		await act(async () => {
			activeRefresh.resolve(false);
			await activeRefresh.promise;
			await vi.advanceTimersByTimeAsync(0);
		});
	});

	it("drops a queued refresh when an active refresh is hidden", async () => {
		// Objective: cancellation must not drain queued work while refreshes are paused.
		// Arrange
		const activeRefresh = deferred<boolean>();
		mocks.loadProjectsData.mockReturnValueOnce(activeRefresh.promise);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4_980);
		});

		// Act
		visibilityState = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		activeRefresh.resolve(true);
		await act(async () => {
			await activeRefresh.promise;
			await vi.advanceTimersByTimeAsync(0);
		});

		// Assert
		expect(mocks.loadProjectsData).toHaveBeenCalledTimes(1);
		expect(document.getElementById("refreshStatus")?.dataset.refreshState).toBe("paused");
	});

	it("does not let a canceled timeout probe replace the hidden-tab state", async () => {
		// Objective: cancellation during the post-timeout readiness probe must revoke write ownership.
		// Arrange
		mocks.stopPolling?.();
		const timedOutRefresh = deferred<boolean>();
		const readinessProbe = deferred<boolean>();
		mocks.loadProjectsData.mockImplementationOnce(({ signal }) =>
			rejectOnAbort(timedOutRefresh.promise, signal),
		);
		mocks.pingViewerReady.mockReturnValueOnce(readinessProbe.promise);
		document.getElementById("tabBtn-projects")?.click();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
			await vi.advanceTimersByTimeAsync(15_000);
		});

		// Act
		visibilityState = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		readinessProbe.resolve(false);
		await act(async () => {
			await readinessProbe.promise;
			await vi.advanceTimersByTimeAsync(0);
		});

		// Assert
		expect(document.getElementById("refreshStatus")?.dataset.refreshState).toBe("paused");
		expect(document.getElementById("viewerReconnectOverlay")?.hidden).toBe(true);
	});
});
