import { type ComponentChildren, render } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { state } from "../../../lib/state";
import {
	completeSurfaceRefresh,
	initialCoordinatorAdminRecovery,
	markSurfaceNotApplicable,
} from "../data/recovery";
import { coordinatorAdminState } from "../data/state";

const mocks = vi.hoisted(() => ({
	loadCoordinatorGroupPreferences: vi.fn(),
}));

vi.mock("../../../lib/api", () => mocks);
vi.mock("@radix-ui/react-collapsible", () => ({
	Content: ({ children }: { children?: ComponentChildren }) => children,
	Root: ({ children }: { children?: ComponentChildren }) => children,
	Trigger: ({ children }: { children?: ComponentChildren }) => children,
}));
vi.mock("../../../components/primitives/project-scope-picker", async () => {
	const { h: createElement } = await import("preact");
	return {
		ProjectScopePicker: () => createElement("div", null),
	};
});
vi.mock("../../../components/primitives/radix-switch", async () => {
	const { h: createElement } = await import("preact");
	return {
		RadixSwitch: () => createElement("button", { type: "button" }),
	};
});
vi.mock("../../../components/primitives/radix-tabs", async () => {
	const { h: createElement } = await import("preact");
	return {
		RadixTabsContent: ({ children }: { children?: ComponentChildren }) =>
			createElement("div", null, children),
	};
});

import { loadGroupPreferences, renderGroupsPanel } from "./groups-panel";

function deferred<T>() {
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((_resolve, nextReject) => {
		reject = nextReject;
	});
	return { promise, reject };
}

describe("legacy group-default recovery", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		document.body.innerHTML = "";
		coordinatorAdminState.groupPreferencesDrafts.clear();
		coordinatorAdminState.groupPreferencesOpen.clear();
		coordinatorAdminState.recovery = initialCoordinatorAdminRecovery();
		completeSurfaceRefresh(coordinatorAdminState.recovery, "status");
		completeSurfaceRefresh(coordinatorAdminState.recovery, "groups");
		coordinatorAdminState.showArchivedGroups = false;
		state.coordinatorAdminTargetGroup = "group-a";
		state.lastCoordinatorAdminStatus = { readiness: "ready" };
		state.lastCoordinatorAdminGroups = [
			{ group_id: "group-a", display_name: "Group A", archived_at: null },
		];
	});

	it("does not turn a first-load failure into editable asserted defaults", async () => {
		mocks.loadCoordinatorGroupPreferences.mockRejectedValue(new Error("backend detail"));

		await loadGroupPreferences("group-a", vi.fn());

		const draft = coordinatorAdminState.groupPreferencesDrafts.get("group-a");
		expect(draft?.loaded).toBe(false);
		expect(draft?.availability).toBe("unavailable");
		expect(draft?.error).not.toContain("backend detail");
	});

	it("shows setup guidance when legacy group management is not applicable", () => {
		markSurfaceNotApplicable(coordinatorAdminState.recovery, "groups");
		document.body.innerHTML = '<div id="groupsMount"></div>';
		const mount = document.getElementById("groupsMount");
		if (!mount) throw new Error("Missing test mount");
		render(
			renderGroupsPanel({
				summary: { readiness: "not_configured", title: "Setup required", detail: "Setup" },
				fresh: false,
				createGroup: vi.fn(),
				runGroup: vi.fn(),
				renderShell: vi.fn(),
				reloadData: vi.fn(),
			}),
			mount,
		);

		expect(mount.textContent).toContain("Complete legacy coordinator setup");
		expect(mount.textContent).not.toContain("Legacy group data is unavailable");
	});

	it("retains a known snapshot when a refresh fails", async () => {
		mocks.loadCoordinatorGroupPreferences.mockResolvedValueOnce({
			projects_include: ["known-project"],
			projects_exclude: [],
			auto_seed_scope: false,
			default_space_scope_id: "space-known",
			auto_grant_default_space_on_join: true,
		});
		await loadGroupPreferences("group-a", vi.fn());
		mocks.loadCoordinatorGroupPreferences.mockRejectedValueOnce(new Error("refresh failed"));

		await loadGroupPreferences("group-a", vi.fn());

		const draft = coordinatorAdminState.groupPreferencesDrafts.get("group-a");
		expect(draft?.availability).toBe("stale");
		expect(draft?.projects_include).toEqual(["known-project"]);
		expect(draft?.auto_seed_scope).toBe(false);
		expect(draft?.default_space_scope_id).toBe("space-known");
		expect(draft?.auto_grant_default_space_on_join).toBe(true);
	});

	it("announces retry start and repeated failure, then restores retry focus", async () => {
		mocks.loadCoordinatorGroupPreferences.mockResolvedValueOnce({
			projects_include: [],
			projects_exclude: [],
			auto_seed_scope: false,
			default_space_scope_id: "",
			auto_grant_default_space_on_join: false,
		});
		await loadGroupPreferences("group-a", vi.fn());
		mocks.loadCoordinatorGroupPreferences.mockRejectedValueOnce(new Error("refresh unavailable"));
		await loadGroupPreferences("group-a", vi.fn());
		coordinatorAdminState.groupPreferencesOpen.add("group-a");
		const retry = deferred<never>();
		mocks.loadCoordinatorGroupPreferences.mockReturnValueOnce(retry.promise);
		document.body.innerHTML = '<div id="groupsMount"></div>';
		const mount = document.getElementById("groupsMount");
		if (!mount) throw new Error("Missing test mount");
		const renderShell = () => {
			render(
				renderGroupsPanel({
					summary: { readiness: "ready", title: "Ready", detail: "Ready" },
					fresh: true,
					createGroup: vi.fn(),
					runGroup: vi.fn(),
					renderShell,
					reloadData: vi.fn(),
				}),
				mount,
			);
		};
		renderShell();
		const retryButton = Array.from(mount.querySelectorAll<HTMLButtonElement>("button")).find(
			(button) => button.textContent === "Retry",
		);
		retryButton?.click();
		expect(
			mount.querySelector("#coord-admin-group-defaults-recovery-group-a")?.textContent,
		).toContain("Retrying group defaults");

		retry.reject(new Error("still unavailable"));
		await vi.waitFor(() =>
			expect(
				mount.querySelector("#coord-admin-group-defaults-recovery-group-a")?.textContent,
			).toContain("Retry finished"),
		);
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(
				mount.querySelector("#coord-admin-group-defaults-recovery-group-a"),
			),
		);
	});
});
