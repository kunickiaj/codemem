/// <reference types="vite/client" />

import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../static/index.html?raw";

const mocks = vi.hoisted(() => ({
	loadProjectScopeInventory: vi.fn(),
	loadDeviceIdentityInventory: vi.fn(),
	loadLegacyTeamSetupDetail: vi.fn(),
	loadProjectsData: vi.fn(),
	loadRecipientPolicyIntent: vi.fn(),
	loadRecipientPolicyReconciliationStatus: vi.fn(),
	loadRecipientPolicySharingData: vi.fn(),
	loadSyncData: vi.fn(),
	mountLegacyTeamSetupDialog: vi.fn(),
}));

vi.mock("./app-sharing", () => ({
	createRecipientPolicySharingLoader: vi.fn(() => mocks.loadRecipientPolicySharingData),
}));
vi.mock("./components/primitives/toast", () => ({ mountToastHost: vi.fn() }));
vi.mock("./lib/api", () => ({
	clearLegacyTeamSetupDecision: vi.fn(),
	finishLegacyTeamSetup: vi.fn(),
	loadCoordinatorAdminStatus: vi.fn(async () => ({ has_admin_secret: false })),
	loadDeviceIdentityInventory: mocks.loadDeviceIdentityInventory,
	loadLegacyTeamSetupSummary: vi.fn(async () => ({ version: 1, candidates: [] })),
	loadLegacyTeamSetupDetail: mocks.loadLegacyTeamSetupDetail,
	loadProjectScopeInventory: mocks.loadProjectScopeInventory,
	loadProjects: vi.fn(async () => ["Codemem"]),
	loadRecipientPolicyIntent: mocks.loadRecipientPolicyIntent,
	loadRecipientPolicyReconciliationStatus: mocks.loadRecipientPolicyReconciliationStatus,
	loadRuntimeInfo: vi.fn(async () => ({ version: "test" })),
	loadSyncStatus: vi.fn(async () => ({})),
	pingViewerReady: vi.fn(async () => true),
	refreshLegacyTeamSetupCandidate: vi.fn(),
	saveLegacyTeamSetupAssignment: vi.fn(),
	saveLegacyTeamSetupDecision: vi.fn(),
	saveLegacyTeamSetupProjectMapping: vi.fn(),
}));
vi.mock("./tabs/coordinator-admin", () => ({
	initCoordinatorAdminTab: vi.fn(),
	loadCoordinatorAdminData: vi.fn(async () => undefined),
}));
vi.mock("./tabs/feed", () => ({
	initFeedTab: vi.fn(),
	loadFeedData: vi.fn(async () => undefined),
	updateFeedView: vi.fn(),
}));
vi.mock("./tabs/health", () => ({
	initHealthTab: vi.fn(),
	loadHealthData: vi.fn(async () => undefined),
}));
vi.mock("./tabs/legacy-team-setup-dialog", () => ({
	mountLegacyTeamSetupDialog: mocks.mountLegacyTeamSetupDialog,
	openLegacyTeamSetup: vi.fn(() => true),
}));
vi.mock("./tabs/projects", () => ({
	initProjectsTab: vi.fn(),
	loadProjectsData: mocks.loadProjectsData,
}));
vi.mock("./tabs/recipient-policy-management", () => ({
	mountRecipientPolicyManagement: vi.fn(),
}));
vi.mock("./tabs/recipient-policy-sharing", () => ({
	mountRecipientPolicySharing: vi.fn(),
}));
vi.mock("./tabs/settings", () => ({
	initSettings: vi.fn(),
	isSettingsOpen: vi.fn(() => false),
	loadConfigData: vi.fn(async () => undefined),
}));
vi.mock("./tabs/sync", () => ({
	initSyncTab: vi.fn(),
	invalidateSyncPeerScopeCache: vi.fn(),
	loadPairingData: vi.fn(async () => undefined),
	loadSyncData: mocks.loadSyncData,
}));
vi.mock("./tabs/sync/sync-view-controller", () => ({ applySyncSubView: vi.fn() }));

const intent = {
	version: 1 as const,
	identities: [
		{
			version: 1 as const,
			identityId: "identity-private",
			displayName: "Adam",
			kind: "personal" as const,
			verification: "local" as const,
			status: "active" as const,
			mergedIntoIdentityId: null,
		},
	],
	teams: [],
	teamMemberships: [],
	identityDevices: [
		{
			version: 1 as const,
			identityId: "identity-private",
			deviceId: "device-private",
			displayName: "Work Laptop",
			status: "active" as const,
		},
		{
			version: 1 as const,
			identityId: "identity-private",
			deviceId: "coordinator-only-device",
			displayName: "Coordinator Tablet",
			status: "active" as const,
		},
	],
	projectRecipients: [
		{
			version: 1 as const,
			canonicalProjectIdentity: "project-private",
			recipientKind: "identity" as const,
			identityId: "identity-private",
			intentSource: "user" as const,
			policyRevision: "revision-private",
			status: "active" as const,
		},
	],
};

function configuredDeviceInventory() {
	return {
		version: 1 as const,
		items: intent.identityDevices.map((device) => ({
			version: 1 as const,
			deviceId: device.deviceId,
			evidenceDeviceIds: [device.deviceId],
			displayName: device.displayName,
			state: "configured" as const,
			identityId: device.identityId,
			suggestedIdentityId: null,
			validatedFingerprint: null,
			isLocal: device.deviceId === "device-private",
			sources: ["identity_binding"] as const,
			conflictCodes: [],
		})),
		coordinatorEvidence: { availability: "available" as const, safeErrorCode: null },
		truncated: false,
	};
}

function bodyMarkup(): string {
	return html.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1] ?? "";
}

describe("Devices app integration", () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		vi.resetModules();
		localStorage.clear();
		localStorage.setItem("codemem-theme", "light");
		document.body.innerHTML = bodyMarkup();
		window.location.hash = "devices";
		mocks.loadProjectScopeInventory.mockResolvedValue({
			projects: [
				{
					workspace_identity: "project-private",
					identity_source: "git_remote",
					display_project: "Codemem",
					memory_count: 10,
					read_only: false,
				},
			],
			has_more: false,
			limit: 250,
			offset: 0,
		});
		mocks.loadRecipientPolicyIntent.mockResolvedValue(intent);
		mocks.loadProjectsData.mockResolvedValue(true);
		mocks.loadRecipientPolicySharingData.mockResolvedValue(true);
		mocks.loadLegacyTeamSetupDetail.mockResolvedValue({
			version: 1,
			candidate: {
				candidateRef: "opaque-candidate-ref",
				displayName: "Example Team",
				status: "in_progress",
				deviceCount: 0,
				projectCount: 0,
				unresolvedDeviceCount: 0,
				unresolvedProjectCount: 0,
			},
			attemptId: "opaque-attempt",
			draftState: "in_progress",
			unresolvedDeviceCount: 0,
			unresolvedProjectCount: 0,
			devices: [],
			projects: [],
			identityChoices: [],
			canFinish: false,
			conflictState: null,
		});
		if (expect.getState().currentTestName?.includes("first Devices load")) {
			mocks.loadDeviceIdentityInventory.mockRejectedValue(new Error("inventory unavailable"));
		} else {
			mocks.loadDeviceIdentityInventory.mockResolvedValue(configuredDeviceInventory());
		}
		mocks.loadRecipientPolicyReconciliationStatus.mockResolvedValue({
			version: 1,
			items: [
				{
					canonicalProjectIdentity: "project-private",
					state: "needs_attention",
					label: "Needs attention",
					explanation: "Current access remains in place until it is safe to retry.",
					deliveredCopiesMayRemain: true,
					revocationWarning: "internal warning",
				},
			],
		});
		mocks.loadSyncData.mockImplementation(async () => {
			const { state } = await import("./lib/state");
			state.lastSyncStatus = {
				coordinator_enrollment_reconciliation_issues: { counts: { open: 2, resolved: 1 } },
			};
			state.lastSyncPeers = [
				{
					peer_device_id: "device-private",
					runtime_version: "0.42.0",
					runtime_version_observed_at: "2026-08-11T12:00:00.000Z",
					status: { peer_state: "online", fresh: true },
				},
				{
					peer_device_id: "unmatched-paired-device",
					runtime_version: "9.9.9",
					runtime_version_observed_at: "2026-08-11T12:00:00.000Z",
					status: { peer_state: "online", fresh: true },
				},
			];
			state.lastSyncCoordinator = {
				discovered_devices: [
					{
						device_id: "coordinator-only-device",
						display_name: "Coordinator Tablet",
						stale: false,
					},
				],
			};
		});
		await import("./app");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		document.body.innerHTML = "";
		window.location.hash = "";
	});

	it("refreshes read-only inputs, routes actions canonically, and preserves polling focus", async () => {
		const panel = document.getElementById("tab-devices");
		expect(panel?.hidden).toBe(false);
		expect(panel?.textContent).toContain("Work Laptop");
		expect(panel?.textContent).toContain("Available");
		expect(panel?.textContent).toContain("Needs attention");
		expect(panel?.textContent).toContain(
			"2 coordinator enrollments could not be safely reconciled",
		);
		expect(mocks.loadRecipientPolicyIntent).toHaveBeenCalledOnce();
		expect(mocks.loadRecipientPolicyReconciliationStatus).toHaveBeenCalledOnce();
		expect(mocks.loadSyncData).toHaveBeenCalledOnce();
		expect(mocks.loadDeviceIdentityInventory).toHaveBeenCalledOnce();
		expect(panel?.textContent).not.toMatch(
			/identity-private|device-private|project-private|revision-private|internal warning/i,
		);
		expect(panel?.textContent).not.toMatch(
			/\b(scope|grant|address|fingerprint|filter|epoch|cursor)\b/i,
		);

		const action = [...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
			(button) => button.textContent === "Review sharing",
		);
		if (!action) throw new Error("Devices action missing");
		action.focus();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});
		expect(mocks.loadRecipientPolicyIntent).toHaveBeenCalledTimes(2);
		expect(document.activeElement).toBe(action);

		act(() => action.click());
		await Promise.resolve();
		expect(window.location.hash).toBe("#sharing");
		expect(document.activeElement).toBe(document.getElementById("tabBtn-sharing"));
	});

	it("opens Sharing from the legacy coordinator notice and moves focus to its navigation control", async () => {
		act(() => document.getElementById("coordinatorAdminOpenSharing")?.click());
		await Promise.resolve();

		expect(window.location.hash).toBe("#sharing");
		expect(document.getElementById("tab-sharing")?.hidden).toBe(false);
		expect(document.activeElement).toBe(document.getElementById("tabBtn-sharing"));
	});

	it("focuses the legacy notice when switching into coordinator administration", async () => {
		act(() => document.getElementById("tabBtn-advanced")?.click());
		await Promise.resolve();
		act(() => document.getElementById("advancedTeamsButton")?.click());
		await Promise.resolve();

		expect(window.location.hash).toBe("#advanced/teams");
		expect(document.getElementById("advancedTeamsContent")?.hidden).toBe(false);
		expect(document.activeElement).toBe(
			document.getElementById("coordinatorAdminLegacyNoticeTitle"),
		);
	});

	it("opens the global Team setup dialog from Projects without changing tabs", async () => {
		const { initProjectsTab } = await import("./tabs/projects");
		const { openLegacyTeamSetup } = await import("./tabs/legacy-team-setup-dialog");
		const options = vi.mocked(initProjectsTab).mock.calls[0]?.[1];
		expect(options?.onOpenTeamSetup).toEqual(expect.any(Function));

		act(() => options?.onOpenTeamSetup?.("opaque-candidate-ref"));
		await Promise.resolve();

		expect(openLegacyTeamSetup).toHaveBeenCalledWith("opaque-candidate-ref");
		expect(window.location.hash).toBe("#devices");
		expect(document.getElementById("tab-devices")?.hidden).toBe(false);
	});

	it("refreshes Sharing and Projects with the active surface mounting last", async () => {
		const options = mocks.mountLegacyTeamSetupDialog.mock.calls[0]?.[1];
		expect(options?.onCompleted).toEqual(expect.any(Function));
		const { state } = await import("./lib/state");
		const refreshOrder: string[] = [];
		mocks.loadProjectsData.mockImplementation(async () => {
			refreshOrder.push("projects");
			return true;
		});
		mocks.loadRecipientPolicySharingData.mockImplementation(async () => {
			refreshOrder.push("sharing");
			return true;
		});

		state.activeTab = "sharing";
		await expect(options?.onCompleted?.("opaque-attempt")).resolves.toBeUndefined();
		expect(refreshOrder).toEqual(["projects", "sharing"]);
		expect(mocks.loadProjectsData).toHaveBeenLastCalledWith({ requireTeamSetupSummary: true });
		expect(mocks.loadRecipientPolicySharingData).toHaveBeenLastCalledWith({
			requireTeamSetupSummary: true,
		});

		refreshOrder.length = 0;
		state.activeTab = "projects";
		await expect(options?.onCompleted?.("opaque-attempt")).resolves.toBeUndefined();
		expect(refreshOrder).toEqual(["sharing", "projects"]);
		expect(mocks.loadProjectsData).toHaveBeenLastCalledWith({ requireTeamSetupSummary: true });
		expect(mocks.loadRecipientPolicySharingData).toHaveBeenLastCalledWith({
			requireTeamSetupSummary: true,
		});
	});

	it("reports a partial Team setup completion refresh failure", async () => {
		const options = mocks.mountLegacyTeamSetupDialog.mock.calls[0]?.[1];
		mocks.loadProjectsData.mockResolvedValueOnce(false);
		await expect(options?.onCompleted?.("opaque-attempt")).rejects.toThrow(
			"team_setup_refresh_failed",
		);
	});

	it("keeps existing device details usable when inventory fails on the first Devices load", () => {
		const panel = document.getElementById("tab-devices");
		expect(panel?.textContent).toContain("Work Laptop");
		expect(panel?.textContent).toContain("Needs attention");
		expect(panel?.textContent).toContain("Device ownership information is temporarily unavailable");
		expect(panel?.textContent).not.toContain("Devices are unavailable");
		expect(mocks.loadRecipientPolicyIntent).toHaveBeenCalled();
		expect(mocks.loadRecipientPolicyReconciliationStatus).toHaveBeenCalled();
	});

	it("restores Identity controls after a first Devices load inventory failure", async () => {
		mocks.loadDeviceIdentityInventory.mockResolvedValueOnce(configuredDeviceInventory());

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});

		const panel = document.getElementById("tab-devices");
		expect(panel?.textContent).not.toContain(
			"Device ownership information is temporarily unavailable",
		);
		const rebind = [...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
			(button) => button.textContent === "Change Identity…",
		);
		expect(rebind?.disabled).toBe(false);
	});

	it("retains the inventory-unavailable explanation after a failed refresh following the first Devices load", async () => {
		mocks.loadRecipientPolicyIntent.mockRejectedValueOnce(new Error("refresh failed"));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});

		const panel = document.getElementById("tab-devices");
		expect(panel?.textContent).toContain(
			"Refresh failed; showing previous device information. Identity setup is disabled until a refresh succeeds.",
		);
		expect(panel?.textContent).toContain("Device ownership information is temporarily unavailable");
	});

	it("retains cached inventory but disables Identity controls during a later inventory outage", async () => {
		mocks.loadDeviceIdentityInventory.mockRejectedValueOnce(new Error("inventory unavailable"));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});

		const panel = document.getElementById("tab-devices");
		expect(panel?.textContent).toContain("Device ownership information is temporarily unavailable");
		const staleRebind = [...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
			(button) => button.textContent === "Change Identity…",
		);
		expect(staleRebind?.disabled).toBe(true);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});

		expect(panel?.textContent).not.toContain(
			"Device ownership information is temporarily unavailable",
		);
		const refreshedRebind = [...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
			(button) => button.textContent === "Change Identity…",
		);
		expect(refreshedRebind?.disabled).toBe(false);
	});

	it("preserves inventory unavailability when the next required refresh fails", async () => {
		mocks.loadDeviceIdentityInventory.mockRejectedValueOnce(new Error("inventory unavailable"));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});
		expect(document.getElementById("tab-devices")?.textContent).toContain(
			"Device ownership information is temporarily unavailable",
		);

		mocks.loadRecipientPolicyIntent.mockRejectedValueOnce(new Error("intent unavailable"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});

		const panel = document.getElementById("tab-devices");
		expect(panel?.textContent).toContain(
			"Refresh failed; showing previous device information. Identity setup is disabled until a refresh succeeds.",
		);
		expect(panel?.textContent).toContain("Device ownership information is temporarily unavailable");
	});

	it("joins runtime metadata only from the matched paired peer", () => {
		const cards = [...document.querySelectorAll<HTMLElement>("#tab-devices article")];
		const workLaptop = cards.find(
			(card) => card.querySelector("h3")?.textContent === "Work Laptop",
		);
		const coordinatorTablet = cards.find(
			(card) => card.querySelector("h3")?.textContent === "Coordinator Tablet",
		);
		if (!workLaptop || !coordinatorTablet) throw new Error("Expected device cards missing");

		expect(workLaptop.textContent).toContain("Codemem version0.42.0");
		expect(coordinatorTablet.textContent).not.toContain("Codemem version");
		expect(document.getElementById("tab-devices")?.textContent).not.toContain("9.9.9");
	});

	it("routes pairing recovery to Advanced Sync even when Teams was selected", async () => {
		const { state } = await import("./lib/state");
		state.advancedSection = "teams";
		mocks.loadDeviceIdentityInventory.mockResolvedValueOnce({
			version: 1,
			items: [
				{
					version: 1,
					deviceId: "pair-device",
					evidenceDeviceIds: ["pair-device"],
					displayName: "Pairing laptop",
					state: "pairing_required",
					identityId: null,
					suggestedIdentityId: null,
					validatedFingerprint: null,
					isLocal: false,
					sources: ["coordinator_enrollment"],
					conflictCodes: [],
				},
			],
			coordinatorEvidence: { availability: "available", safeErrorCode: null },
			truncated: false,
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});
		const pairingAction = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Go to pairing",
		);
		if (!pairingAction) throw new Error("Pairing action missing");

		act(() => pairingAction.click());
		await Promise.resolve();

		expect(window.location.hash).toBe("#advanced/sync");
		expect(document.getElementById("advancedSyncContent")?.hidden).toBe(false);
		expect(document.getElementById("advancedTeamsContent")?.hidden).toBe(true);
	});

	it("preserves stale cards, announces post-load failures, and marks refresh aggregation failed", async () => {
		mocks.loadRecipientPolicyIntent.mockRejectedValueOnce(new Error("refresh failed"));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});

		const panel = document.getElementById("tab-devices");
		expect(panel?.textContent).toContain("Work Laptop");
		expect(panel?.querySelector('[role="alert"]')?.textContent).toBe(
			"Refresh failed; showing previous device information. Identity setup is disabled until a refresh succeeds.",
		);
		expect(panel?.textContent).not.toContain(
			"Device ownership information is temporarily unavailable",
		);
		expect(document.getElementById("refreshStatus")?.textContent).toBe("refresh failed");
		expect(document.getElementById("refreshAnnouncer")?.textContent).toBe("Refresh failed.");
		expect(document.getElementById("refreshStatus")?.textContent).not.toContain("updated");
	});

	it("uses a fresh Devices inventory instead of accepting cached Sync ownership", async () => {
		const { state } = await import("./lib/state");
		state.lastDeviceIdentityInventory = {
			version: 1,
			items: intent.identityDevices.map((device) => ({
				version: 1,
				deviceId: device.deviceId,
				evidenceDeviceIds: [device.deviceId],
				displayName: device.displayName,
				state: "configured" as const,
				identityId: device.identityId,
				suggestedIdentityId: null,
				validatedFingerprint: null,
				isLocal: device.deviceId === "device-private",
				sources: ["identity_binding" as const],
				conflictCodes: [],
			})),
			coordinatorEvidence: { availability: "available", safeErrorCode: null },
			truncated: false,
		};
		mocks.loadDeviceIdentityInventory.mockClear();
		mocks.loadSyncData.mockImplementationOnce(async () => {
			state.deviceIdentityInventoryLoadError = true;
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});

		expect(mocks.loadDeviceIdentityInventory).toHaveBeenCalledOnce();
		expect(document.getElementById("tab-devices")?.textContent).toContain("Work Laptop");
		expect(document.querySelector('#tab-devices [role="alert"]')).toBeNull();
		expect(document.getElementById("refreshStatus")?.textContent).not.toBe("refresh failed");
		expect(state.lastDeviceIdentityInventory).toEqual(configuredDeviceInventory());
		expect(state.deviceIdentityInventoryLoadError).toBe(false);
	});

	it("moves focus to the Devices tab when a focused device action is removed", async () => {
		const action = document.querySelector<HTMLButtonElement>(
			'#tab-devices button[aria-label="Review sharing for Work Laptop"]',
		);
		if (!action) throw new Error("Devices action missing");
		action.focus();
		mocks.loadRecipientPolicyIntent.mockResolvedValueOnce({
			...intent,
			identityDevices: intent.identityDevices.map((device) => ({
				...device,
				status: "revoked" as const,
			})),
		});
		mocks.loadDeviceIdentityInventory.mockResolvedValueOnce({
			version: 1,
			items: [],
			coordinatorEvidence: { availability: "available", safeErrorCode: null },
			truncated: false,
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});

		expect(document.querySelector("#tab-devices article")).toBeNull();
		expect(document.activeElement).toBe(document.getElementById("tabBtn-devices"));
	});

	it("does not steal focus from outside Devices during polling", async () => {
		const healthTab = document.getElementById("tabBtn-health");
		if (!healthTab) throw new Error("Health tab missing");
		healthTab.focus();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});

		expect(document.activeElement).toBe(healthTab);
	});
});
