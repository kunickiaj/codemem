/// <reference types="vite/client" />

import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../static/index.html?raw";

const mocks = vi.hoisted(() => ({
	loadProjectScopeInventory: vi.fn(),
	loadRecipientPolicyIntent: vi.fn(),
	loadRecipientPolicyReconciliationStatus: vi.fn(),
	loadSyncData: vi.fn(),
}));

vi.mock("./components/primitives/toast", () => ({ mountToastHost: vi.fn() }));
vi.mock("./lib/api", () => ({
	loadCoordinatorAdminStatus: vi.fn(async () => ({ has_admin_secret: false })),
	loadProjectScopeInventory: mocks.loadProjectScopeInventory,
	loadProjects: vi.fn(async () => ["Codemem"]),
	loadRecipientPolicyIntent: mocks.loadRecipientPolicyIntent,
	loadRecipientPolicyReconciliationStatus: mocks.loadRecipientPolicyReconciliationStatus,
	loadRuntimeInfo: vi.fn(async () => ({ version: "test" })),
	loadSyncStatus: vi.fn(async () => ({})),
	pingViewerReady: vi.fn(async () => true),
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
vi.mock("./tabs/projects", () => ({
	initProjectsTab: vi.fn(),
	loadProjectsData: vi.fn(async () => undefined),
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
			state.lastSyncPeers = [
				{ peer_device_id: "device-private", status: { peer_state: "online", fresh: true } },
			];
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
		expect(mocks.loadRecipientPolicyIntent).toHaveBeenCalledOnce();
		expect(mocks.loadRecipientPolicyReconciliationStatus).toHaveBeenCalledOnce();
		expect(mocks.loadSyncData).toHaveBeenCalledOnce();
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

	it("preserves stale cards, announces post-load failures, and marks refresh aggregation failed", async () => {
		mocks.loadRecipientPolicyIntent.mockRejectedValueOnce(new Error("refresh failed"));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});

		const panel = document.getElementById("tab-devices");
		expect(panel?.textContent).toContain("Work Laptop");
		expect(panel?.querySelector('[role="alert"]')?.textContent).toBe(
			"Refresh failed; showing previous device information.",
		);
		expect(document.getElementById("refreshStatus")?.textContent).toBe("refresh failed");
		expect(document.getElementById("refreshAnnouncer")?.textContent).toBe("Refresh failed.");
		expect(document.getElementById("refreshStatus")?.textContent).not.toContain("updated");
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
