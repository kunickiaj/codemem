import type { ComponentChildren } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { state } from "../../lib/state";
import {
	coordinatorAdminRecoveryNotice,
	initialCoordinatorAdminRecovery,
	surfaceHasSnapshot,
} from "./data/recovery";
import { coordinatorAdminState } from "./data/state";
import {
	beginStandaloneCoordinatorAdminStatusRefresh,
	refreshCoordinatorAdminStatusForGeneration,
} from "./data/status-refresh";
import { adminSnapshotTargetMatchesCurrent } from "./data/target-group";

const mocks = vi.hoisted(() => ({
	loadCoordinatorAdminDevices: vi.fn(),
	loadCoordinatorAdminGroupsFiltered: vi.fn(),
	loadCoordinatorAdminJoinRequests: vi.fn(),
	loadCoordinatorAdminStatus: vi.fn(),
	loadProjects: vi.fn(),
	loadShareOperations: vi.fn(),
}));

vi.mock("../../lib/api", () => mocks);

vi.mock("../../components/primitives/radix-tabs", async () => {
	const { h } = await import("preact");
	return {
		RadixTabs: ({ children, className }: { children?: ComponentChildren; className?: string }) =>
			h("div", { class: className }, children),
		RadixTabsContent: ({
			children,
			className,
		}: {
			children?: ComponentChildren;
			className?: string;
		}) => h("div", { class: className }, children),
	};
});
vi.mock("../../components/primitives/radix-switch", async () => {
	const { h } = await import("preact");
	return { RadixSwitch: () => h("button", { type: "button" }) };
});
vi.mock("../../components/primitives/radix-select", async () => {
	const { h } = await import("preact");
	return { RadixSelect: () => h("select", null) };
});

import { initCoordinatorAdminTab, loadCoordinatorAdminData } from "./lifecycle";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function successfulPayloads() {
	mocks.loadCoordinatorAdminStatus.mockResolvedValue({
		active_group: "group-a",
		coordinator_url: "https://coordinator.example",
		readiness: "ready",
	});
	mocks.loadCoordinatorAdminGroupsFiltered.mockResolvedValue({
		items: [{ group_id: "group-a", display_name: "Group A" }],
	});
	mocks.loadCoordinatorAdminJoinRequests.mockResolvedValue({
		items: [{ request_id: "request-a", device_id: "device-a" }],
	});
	mocks.loadCoordinatorAdminDevices.mockResolvedValue({
		items: [{ device_id: "device-a", group_id: "group-a", display_name: "Laptop" }],
	});
	mocks.loadProjects.mockResolvedValue([]);
	mocks.loadShareOperations.mockResolvedValue({ items: [] });
}

function seedCoordinatorScopedDrafts(): void {
	coordinatorAdminState.groupRenameDrafts.set("group-a", "Renamed Group A");
	coordinatorAdminState.groupPresentationAliases.set("group-a", "Unnamed coordinator group 1");
	coordinatorAdminState.groupPreferencesOpen.add("group-a");
	coordinatorAdminState.groupPreferencesDrafts.set("group-a", {
		projects_include: ["project-a"],
		projects_exclude: [],
		auto_seed_scope: false,
		default_space_scope_id: "scope-a",
		auto_grant_default_space_on_join: false,
		loaded: true,
		loading: false,
		availability: "fresh",
		loadGeneration: 1,
		recoveryAnnouncement: "",
		recoveryFocusPending: false,
		recoveryRetryRequested: false,
		saving: false,
		error: "",
	});
	coordinatorAdminState.groupScopeManagementOpen.add("group-a");
	coordinatorAdminState.groupScopeManagementDrafts.set("group-a", {
		loaded: true,
		loading: false,
		availability: "fresh",
		error: "",
		includeInactive: false,
		devicesLoaded: true,
		scopes: [],
		membersByScope: new Map(),
		memberAvailabilityByScope: new Map(),
		devices: [],
		createScopeId: "scope-a",
		createLabel: "Space A",
		createKind: "team",
		actionPendingKey: "",
		actionPendingKind: "",
		loadGeneration: 1,
		recoveryAnnouncement: "",
		recoveryFocusPending: false,
		recoveryRetryRequested: false,
	});
}

describe("coordinator administration recovery lifecycle", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		successfulPayloads();
		document.body.innerHTML = "";
		localStorage.clear();
		state.lastCoordinatorAdminStatus = null;
		state.lastCoordinatorAdminGroups = [];
		state.lastCoordinatorAdminJoinRequests = [];
		state.lastCoordinatorAdminDevices = [];
		state.lastTeamInvite = null;
		state.coordinatorAdminTargetGroup = "";
		coordinatorAdminState.recovery = initialCoordinatorAdminRecovery();
		coordinatorAdminState.loadGeneration = 0;
		coordinatorAdminState.recoveryAnnouncement = "";
		coordinatorAdminState.recoveryFocusPending = false;
		coordinatorAdminState.recoveryRetryRequested = false;
		coordinatorAdminState.joinRequestsSnapshotTarget = null;
		coordinatorAdminState.devicesSnapshotTarget = null;
		coordinatorAdminState.groupRenameDrafts.clear();
		coordinatorAdminState.groupPresentationAliases.clear();
		coordinatorAdminState.deviceRenameDrafts.clear();
		coordinatorAdminState.deviceRenameServerNames.clear();
		coordinatorAdminState.groupPreferencesOpen.clear();
		coordinatorAdminState.groupPreferencesDrafts.clear();
		coordinatorAdminState.groupScopeManagementOpen.clear();
		coordinatorAdminState.groupScopeManagementDrafts.clear();
		coordinatorAdminState.teamSetupGuide = null;
	});

	it("marks first-load failures unavailable instead of treating them as empty snapshots", async () => {
		mocks.loadCoordinatorAdminStatus.mockRejectedValue(new Error("secret backend detail"));

		await loadCoordinatorAdminData();

		expect(coordinatorAdminState.recovery.status.availability).toBe("unavailable");
		expect(coordinatorAdminState.recovery.groups.availability).toBe("unavailable");
		expect(surfaceHasSnapshot(coordinatorAdminState.recovery, "devices")).toBe(false);
	});

	it("retains successful snapshots across repeated refresh failures", async () => {
		await loadCoordinatorAdminData();
		const groups = state.lastCoordinatorAdminGroups;
		const joins = state.lastCoordinatorAdminJoinRequests;
		const devices = state.lastCoordinatorAdminDevices;
		mocks.loadCoordinatorAdminGroupsFiltered.mockRejectedValue(new Error("groups failed"));
		mocks.loadCoordinatorAdminJoinRequests.mockRejectedValue(new Error("joins failed"));
		mocks.loadCoordinatorAdminDevices.mockRejectedValue(new Error("devices failed"));

		await loadCoordinatorAdminData();
		await loadCoordinatorAdminData();

		expect(state.lastCoordinatorAdminGroups).toEqual(groups);
		expect(state.lastCoordinatorAdminJoinRequests).toEqual(joins);
		expect(state.lastCoordinatorAdminDevices).toEqual(devices);
		expect(coordinatorAdminState.recovery.groups.availability).toBe("stale");
		expect(coordinatorAdminState.recovery.joinRequests.availability).toBe("stale");
		expect(coordinatorAdminState.recovery.devices.availability).toBe("stale");
	});

	it("shows retained enrollment snapshots only for the group that produced them", async () => {
		document.body.innerHTML = '<div id="coordinatorAdminMount"></div>';
		initCoordinatorAdminTab();
		mocks.loadCoordinatorAdminGroupsFiltered.mockResolvedValue({
			items: [
				{ group_id: "group-a", display_name: "Group A" },
				{ group_id: "group-b", display_name: "Group B" },
			],
		});
		await loadCoordinatorAdminData();
		expect(document.body.textContent).toContain("Laptop");

		mocks.loadCoordinatorAdminJoinRequests.mockRejectedValue(new Error("joins failed"));
		mocks.loadCoordinatorAdminDevices.mockRejectedValue(new Error("devices failed"));
		state.coordinatorAdminTargetGroup = "group-b";

		await loadCoordinatorAdminData();

		expect(state.lastCoordinatorAdminJoinRequests).toHaveLength(1);
		expect(state.lastCoordinatorAdminDevices).toHaveLength(1);
		expect(coordinatorAdminState.recovery.joinRequests.availability).toBe("unavailable");
		expect(coordinatorAdminState.recovery.devices.availability).toBe("unavailable");
		expect(document.body.textContent).not.toContain("device-a");
		expect(document.body.textContent).not.toContain("Laptop");
		expect(document.body.textContent).toContain("Unavailable join requests · Unavailable devices");

		state.coordinatorAdminTargetGroup = "group-a";
		await loadCoordinatorAdminData();

		expect(coordinatorAdminState.recovery.joinRequests.availability).toBe("stale");
		expect(coordinatorAdminState.recovery.devices.availability).toBe("stale");
		expect(document.body.textContent).toContain("device-a");
		expect(document.body.textContent).toContain("Laptop");
		expect(document.body.textContent).toContain("1 join requests · 1 devices");
	});

	it("does not mark another group's enrollment snapshots stale after status refresh fails", async () => {
		mocks.loadCoordinatorAdminGroupsFiltered.mockResolvedValue({
			items: [
				{ group_id: "group-a", display_name: "Group A" },
				{ group_id: "group-b", display_name: "Group B" },
			],
		});
		await loadCoordinatorAdminData();
		state.coordinatorAdminTargetGroup = "group-b";
		mocks.loadCoordinatorAdminStatus.mockRejectedValueOnce(new Error("status failed"));

		await loadCoordinatorAdminData();

		expect(coordinatorAdminState.recovery.joinRequests.availability).toBe("unavailable");
		expect(coordinatorAdminState.recovery.devices.availability).toBe("unavailable");
	});

	it("marks enrollment surfaces unavailable when their source cannot be identified", async () => {
		mocks.loadCoordinatorAdminStatus.mockResolvedValue({
			active_group: "group-a",
			readiness: "ready",
		});

		await loadCoordinatorAdminData();

		expect(coordinatorAdminState.recovery.joinRequests.availability).toBe("unavailable");
		expect(coordinatorAdminState.recovery.devices.availability).toBe("unavailable");
		expect(coordinatorAdminRecoveryNotice(coordinatorAdminState.recovery)).not.toBeNull();
	});

	it("clears stale state and replaces snapshots after retry succeeds", async () => {
		await loadCoordinatorAdminData();
		mocks.loadCoordinatorAdminDevices.mockRejectedValueOnce(new Error("devices failed"));
		await loadCoordinatorAdminData();
		mocks.loadCoordinatorAdminDevices.mockResolvedValue({
			items: [{ device_id: "device-b", group_id: "group-a", display_name: "Desktop" }],
		});

		await loadCoordinatorAdminData();

		expect(coordinatorAdminState.recovery.devices.availability).toBe("fresh");
		expect(state.lastCoordinatorAdminDevices).toEqual([
			{ device_id: "device-b", group_id: "group-a", display_name: "Desktop" },
		]);
	});

	it("isolates partial panel failures while refreshing healthy surfaces", async () => {
		await loadCoordinatorAdminData();
		mocks.loadCoordinatorAdminGroupsFiltered.mockRejectedValue(new Error("groups failed"));
		mocks.loadCoordinatorAdminJoinRequests.mockResolvedValue({ items: [] });
		mocks.loadCoordinatorAdminDevices.mockResolvedValue({ items: [] });

		await loadCoordinatorAdminData();

		expect(coordinatorAdminState.recovery.groups.availability).toBe("stale");
		expect(coordinatorAdminState.recovery.joinRequests.availability).toBe("fresh");
		expect(coordinatorAdminState.recovery.devices.availability).toBe("fresh");
		expect(state.lastCoordinatorAdminGroups).toHaveLength(1);
		expect(state.lastCoordinatorAdminJoinRequests).toEqual([]);
		expect(state.lastCoordinatorAdminDevices).toEqual([]);
	});

	it("distinguishes a confirmed zero count from an unknown count", async () => {
		mocks.loadCoordinatorAdminGroupsFiltered.mockResolvedValue({ items: [] });
		mocks.loadCoordinatorAdminJoinRequests.mockResolvedValue({ items: [] });
		mocks.loadCoordinatorAdminDevices.mockResolvedValue({ items: [] });

		await loadCoordinatorAdminData();

		expect(state.lastCoordinatorAdminDevices).toEqual([]);
		expect(surfaceHasSnapshot(coordinatorAdminState.recovery, "devices")).toBe(true);
		coordinatorAdminState.recovery = initialCoordinatorAdminRecovery();
		expect(surfaceHasSnapshot(coordinatorAdminState.recovery, "devices")).toBe(false);
	});

	it("ignores an older load after a newer generation completes", async () => {
		const olderStatus = deferred<{
			active_group: string;
			coordinator_url: string;
			readiness: "ready";
		}>();
		mocks.loadCoordinatorAdminStatus
			.mockImplementationOnce(() => olderStatus.promise)
			.mockResolvedValueOnce({
				active_group: "group-new",
				coordinator_url: "https://coordinator.example",
				readiness: "ready",
			});

		const olderLoad = loadCoordinatorAdminData();
		await loadCoordinatorAdminData();
		olderStatus.resolve({
			active_group: "group-old",
			coordinator_url: "https://old.example",
			readiness: "ready",
		});
		await olderLoad;

		expect(state.lastCoordinatorAdminStatus?.active_group).toBe("group-new");
		expect(coordinatorAdminState.recovery.status.availability).toBe("fresh");
	});

	it("shares generation authority with the feed status writer", async () => {
		const lifecycleStatus = deferred<{
			active_group: string;
			coordinator_url: string;
			readiness: "ready";
		}>();
		mocks.loadCoordinatorAdminStatus
			.mockImplementationOnce(() => lifecycleStatus.promise)
			.mockResolvedValueOnce({
				active_group: "feed-group",
				coordinator_url: "https://feed.example",
				readiness: "ready",
			});
		const lifecycleLoad = loadCoordinatorAdminData();
		const feedGeneration = beginStandaloneCoordinatorAdminStatusRefresh();

		await refreshCoordinatorAdminStatusForGeneration(feedGeneration);
		lifecycleStatus.resolve({
			active_group: "stale-lifecycle-group",
			coordinator_url: "https://stale.example",
			readiness: "ready",
		});
		await lifecycleLoad;

		expect(state.lastCoordinatorAdminStatus?.active_group).toBe("feed-group");
		expect(coordinatorAdminState.recovery.status.availability).toBe("fresh");
		expect(coordinatorAdminState.recovery.groups.retrying).toBe(false);
		expect(coordinatorAdminState.recovery.joinRequests.retrying).toBe(false);
		expect(coordinatorAdminState.recovery.devices.retrying).toBe(false);
	});

	it("invalidates coordinator-scoped snapshots and drafts when the coordinator URL changes", async () => {
		state.lastTeamInvite = {
			encoded: "invite-from-coordinator-a",
			warnings: ["warning from coordinator a"],
		};
		state.lastCoordinatorAdminStatus = {
			active_group: "group-a",
			coordinator_url: "https://coordinator-a.example",
			readiness: "ready",
		};
		state.lastCoordinatorAdminGroups = [{ group_id: "group-a", display_name: "Group A" }];
		state.lastCoordinatorAdminJoinRequests = [{ request_id: "request-a", device_id: "device-a" }];
		state.lastCoordinatorAdminDevices = [
			{ device_id: "device-a", group_id: "group-a", display_name: "Laptop" },
		];
		state.coordinatorAdminTargetGroup = "group-a";
		coordinatorAdminState.recovery.status.availability = "fresh";
		coordinatorAdminState.recovery.groups.availability = "fresh";
		coordinatorAdminState.recovery.joinRequests.availability = "fresh";
		coordinatorAdminState.recovery.devices.availability = "fresh";
		coordinatorAdminState.joinRequestsSnapshotTarget = {
			coordinatorUrl: "https://coordinator-a.example",
			groupId: "group-a",
		};
		coordinatorAdminState.devicesSnapshotTarget = {
			coordinatorUrl: "https://coordinator-a.example",
			groupId: "group-a",
		};
		seedCoordinatorScopedDrafts();
		mocks.loadCoordinatorAdminStatus.mockResolvedValueOnce({
			active_group: "group-b",
			coordinator_url: " https://coordinator-b.example/ ",
			readiness: "ready",
		});

		const generation = beginStandaloneCoordinatorAdminStatusRefresh();
		await refreshCoordinatorAdminStatusForGeneration(generation);

		expect(state.lastCoordinatorAdminStatus?.coordinator_url).toBe(
			" https://coordinator-b.example/ ",
		);
		expect(state.lastCoordinatorAdminGroups).toEqual([]);
		expect(state.lastCoordinatorAdminJoinRequests).toEqual([]);
		expect(state.lastCoordinatorAdminDevices).toEqual([]);
		expect(state.lastTeamInvite).toBeNull();
		expect(state.coordinatorAdminTargetGroup).toBe("");
		expect(coordinatorAdminState.recovery.groups.availability).toBe("unavailable");
		expect(coordinatorAdminState.recovery.joinRequests.availability).toBe("unavailable");
		expect(coordinatorAdminState.recovery.devices.availability).toBe("unavailable");
		expect(coordinatorAdminState.joinRequestsSnapshotTarget).toBeNull();
		expect(coordinatorAdminState.devicesSnapshotTarget).toBeNull();
		expect(coordinatorAdminState.groupRenameDrafts.size).toBe(0);
		expect(coordinatorAdminState.groupPresentationAliases.size).toBe(0);
		expect(coordinatorAdminState.groupPreferencesOpen.size).toBe(0);
		expect(coordinatorAdminState.groupPreferencesDrafts.size).toBe(0);
		expect(coordinatorAdminState.groupScopeManagementOpen.size).toBe(0);
		expect(coordinatorAdminState.groupScopeManagementDrafts.size).toBe(0);
	});

	it("clears an unscoped retained invite when the first coordinator status loads", async () => {
		state.lastTeamInvite = {
			encoded: "invite-with-unknown-coordinator",
			warnings: ["warning with unknown coordinator"],
		};
		mocks.loadCoordinatorAdminStatus.mockResolvedValueOnce({
			active_group: "group-a",
			coordinator_url: "https://coordinator.example",
			readiness: "ready",
		});

		const generation = beginStandaloneCoordinatorAdminStatusRefresh();
		await refreshCoordinatorAdminStatusForGeneration(generation);

		expect(state.lastTeamInvite).toBeNull();
	});

	it("keeps coordinator-scoped snapshots when status only adds a trailing slash", async () => {
		const retainedInvite = {
			encoded: "retained-invite",
			warnings: ["retained warning"],
		};
		state.lastTeamInvite = retainedInvite;
		state.lastCoordinatorAdminStatus = {
			active_group: "group-a",
			coordinator_url: "https://coordinator.example",
			readiness: "ready",
		};
		state.lastCoordinatorAdminGroups = [{ group_id: "group-a", display_name: "Group A" }];
		state.coordinatorAdminTargetGroup = "group-a";
		coordinatorAdminState.recovery.groups.availability = "fresh";
		coordinatorAdminState.joinRequestsSnapshotTarget = {
			coordinatorUrl: "https://coordinator.example",
			groupId: "group-a",
		};
		coordinatorAdminState.devicesSnapshotTarget = {
			coordinatorUrl: "https://coordinator.example",
			groupId: "group-a",
		};
		seedCoordinatorScopedDrafts();
		mocks.loadCoordinatorAdminStatus.mockResolvedValueOnce({
			active_group: "group-a",
			coordinator_url: "https://coordinator.example/",
			readiness: "ready",
		});

		const generation = beginStandaloneCoordinatorAdminStatusRefresh();
		await refreshCoordinatorAdminStatusForGeneration(generation);

		expect(state.lastCoordinatorAdminStatus?.coordinator_url).toBe("https://coordinator.example/");
		expect(state.lastCoordinatorAdminGroups).toEqual([
			{ group_id: "group-a", display_name: "Group A" },
		]);
		expect(state.lastTeamInvite).toBe(retainedInvite);
		expect(state.coordinatorAdminTargetGroup).toBe("group-a");
		expect(coordinatorAdminState.recovery.groups.availability).toBe("fresh");
		expect(
			adminSnapshotTargetMatchesCurrent(coordinatorAdminState.joinRequestsSnapshotTarget),
		).toBe(true);
		expect(adminSnapshotTargetMatchesCurrent(coordinatorAdminState.devicesSnapshotTarget)).toBe(
			true,
		);
		expect(coordinatorAdminState.groupPreferencesOpen.has("group-a")).toBe(true);
		expect(coordinatorAdminState.groupScopeManagementOpen.has("group-a")).toBe(true);
	});

	it.each([
		"partial",
		"not_configured",
	])("treats %s readiness as known setup state rather than downstream failure", async (readiness) => {
		document.body.innerHTML = '<div id="coordinatorAdminMount"></div>';
		initCoordinatorAdminTab();
		mocks.loadCoordinatorAdminStatus.mockResolvedValue({
			active_group: "",
			coordinator_url: "https://coordinator.example",
			readiness,
		});

		await loadCoordinatorAdminData();

		expect(coordinatorAdminState.recovery.status.availability).toBe("fresh");
		expect(coordinatorAdminState.recovery.groups.availability).toBe("not_applicable");
		expect(coordinatorAdminState.recovery.joinRequests.availability).toBe("not_applicable");
		expect(coordinatorAdminState.recovery.devices.availability).toBe("not_applicable");
		expect(mocks.loadCoordinatorAdminGroupsFiltered).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain(
			"Complete legacy coordinator setup before loading coordinator groups",
		);
		expect(document.body.textContent).toContain(
			"Complete legacy coordinator setup to load join requests",
		);
		expect(document.body.textContent).toContain(
			"Complete legacy coordinator setup to load enrolled devices",
		);
	});

	it("keeps the recovery status node stable and focuses it after retry succeeds", async () => {
		document.body.innerHTML = '<div id="coordinatorAdminMount"></div>';
		initCoordinatorAdminTab();
		mocks.loadCoordinatorAdminStatus.mockRejectedValueOnce(new Error("status failed"));
		await loadCoordinatorAdminData();
		const statusNode = document.getElementById("coordinatorAdminRecoveryStatus");
		const retry = statusNode?.querySelector<HTMLButtonElement>("button");
		expect(statusNode).not.toBeNull();
		expect(retry).not.toBeNull();

		retry?.click();
		await vi.waitFor(() => {
			expect(coordinatorAdminState.recovery.status.availability).toBe("fresh");
			expect(document.activeElement).toBe(statusNode);
		});

		expect(document.getElementById("coordinatorAdminRecoveryStatus")).toBe(statusNode);
		expect(statusNode?.textContent).toContain("Coordinator data refreshed");
	});

	it("announces a repeated retry failure in the persistent recovery region", async () => {
		document.body.innerHTML = '<div id="coordinatorAdminMount"></div>';
		initCoordinatorAdminTab();
		mocks.loadCoordinatorAdminStatus.mockRejectedValueOnce(new Error("first failure"));
		await loadCoordinatorAdminData();
		const statusNode = document.getElementById("coordinatorAdminRecoveryStatus");
		mocks.loadCoordinatorAdminStatus.mockRejectedValueOnce(new Error("second failure"));

		statusNode?.querySelector<HTMLButtonElement>("button")?.click();
		await vi.waitFor(() => expect(statusNode?.textContent).toContain("Retry finished"));
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		expect(document.getElementById("coordinatorAdminRecoveryStatus")).toBe(statusNode);
		expect(statusNode?.textContent).toContain("Retained data remains unchanged");
		expect(document.activeElement).toBe(statusNode);
	});
});
