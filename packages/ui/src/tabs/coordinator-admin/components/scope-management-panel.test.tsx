import { h, render } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	beginSurfaceRefresh,
	completeSurfaceRefresh,
	initialCoordinatorAdminRecovery,
} from "../data/recovery";
import { coordinatorAdminState } from "../data/state";

const mocks = vi.hoisted(() => ({
	grantCoordinatorAdminScopeMember: vi.fn(),
	loadCoordinatorAdminDevices: vi.fn(),
	loadCoordinatorAdminScopeMembers: vi.fn(),
	loadCoordinatorAdminScopes: vi.fn(),
	openSyncConfirmDialog: vi.fn(),
	revokeCoordinatorAdminScopeMember: vi.fn(),
	showGlobalNotice: vi.fn(),
}));

vi.mock("../../../lib/api", () => mocks);
vi.mock("../../../lib/notice", () => ({ showGlobalNotice: mocks.showGlobalNotice }));
vi.mock("../../sync/sync-dialogs", () => ({
	openSyncConfirmDialog: mocks.openSyncConfirmDialog,
}));
vi.mock("../../../components/primitives/radix-switch", async () => {
	const { h: createElement } = await import("preact");
	return {
		RadixSwitch: (props: {
			"aria-labelledby"?: string;
			checked?: boolean;
			disabled?: boolean;
			onCheckedChange?: (checked: boolean) => void;
		}) =>
			createElement("button", {
				"aria-labelledby": props["aria-labelledby"],
				disabled: props.disabled,
				onClick: () => props.onCheckedChange?.(!props.checked),
				type: "button",
			}),
	};
});

import {
	MAX_EAGER_SPACE_MEMBERSHIP_LOADS,
	openGroupScopeManagement,
	renderGroupScopeManagementPanel,
} from "./scope-management-panel";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("legacy Space recovery", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		document.body.innerHTML = "";
		coordinatorAdminState.recovery = initialCoordinatorAdminRecovery();
		completeSurfaceRefresh(coordinatorAdminState.recovery, "status");
		completeSurfaceRefresh(coordinatorAdminState.recovery, "groups");
		coordinatorAdminState.groupScopeManagementOpen.clear();
		coordinatorAdminState.groupScopeManagementDrafts.clear();
		coordinatorAdminState.loadGeneration = 0;
		mocks.openSyncConfirmDialog.mockResolvedValue(true);
		mocks.loadCoordinatorAdminScopes.mockResolvedValue({
			items: [{ scope_id: "space-a", label: "Space A", status: "active" }],
		});
		mocks.loadCoordinatorAdminDevices.mockResolvedValue({
			items: [{ device_id: "device-a", group_id: "group-a", display_name: "Laptop" }],
		});
		mocks.loadCoordinatorAdminScopeMembers.mockResolvedValue({
			items: [{ device_id: "device-a", role: "member", status: "active" }],
		});
	});

	it("shows first-load Space failure as unavailable rather than an empty snapshot", async () => {
		mocks.loadCoordinatorAdminScopes.mockRejectedValue(new Error("backend identifier"));

		openGroupScopeManagement("group-a", vi.fn());

		await vi.waitFor(() => {
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.availability).toBe(
				"unavailable",
			);
		});
		expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.loaded).toBe(false);
		expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.error).not.toContain(
			"backend identifier",
		);
	});

	it("retains Space and membership details through failure and replaces them after retry", async () => {
		openGroupScopeManagement("group-a", vi.fn());
		await vi.waitFor(() => {
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.availability).toBe(
				"fresh",
			);
		});
		mocks.loadCoordinatorAdminScopes.mockRejectedValueOnce(new Error("refresh failed"));

		openGroupScopeManagement("group-a", vi.fn());
		await vi.waitFor(() => {
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.availability).toBe(
				"stale",
			);
		});
		expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.scopes).toEqual([
			{ scope_id: "space-a", label: "Space A", status: "active" },
		]);
		mocks.loadCoordinatorAdminScopes.mockResolvedValue({
			items: [{ scope_id: "space-b", label: "Space B", status: "active" }],
		});

		openGroupScopeManagement("group-a", vi.fn());
		await vi.waitFor(() => {
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.availability).toBe(
				"fresh",
			);
		});
		expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.scopes).toEqual([
			{ scope_id: "space-b", label: "Space B", status: "active" },
		]);
	});

	it("ignores an older Space load after a newer generation completes", async () => {
		const olderScopes = deferred<{ items: Array<{ scope_id: string; label: string }> }>();
		mocks.loadCoordinatorAdminScopes
			.mockImplementationOnce(() => olderScopes.promise)
			.mockResolvedValueOnce({ items: [{ scope_id: "space-new", label: "New" }] });

		openGroupScopeManagement("group-a", vi.fn());
		openGroupScopeManagement("group-a", vi.fn());
		await vi.waitFor(() => {
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.scopes).toEqual([
				{ scope_id: "space-new", label: "New" },
			]);
		});
		olderScopes.resolve({ items: [{ scope_id: "space-old", label: "Old" }] });
		await vi.waitFor(() => {
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.scopes).toEqual([
				{ scope_id: "space-new", label: "New" },
			]);
		});
	});

	it("caps total eager membership requests and defers the remainder", async () => {
		mocks.loadCoordinatorAdminScopes.mockResolvedValue({
			items: Array.from({ length: MAX_EAGER_SPACE_MEMBERSHIP_LOADS + 4 }, (_, index) => ({
				scope_id: `space-${index}`,
				label: `Space ${index}`,
			})),
		});
		let active = 0;
		let maximum = 0;
		mocks.loadCoordinatorAdminScopeMembers.mockImplementation(async () => {
			active += 1;
			maximum = Math.max(maximum, active);
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			active -= 1;
			return { items: [] };
		});

		openGroupScopeManagement("group-a", vi.fn());
		await vi.waitFor(() => {
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.loading).toBe(false);
		});

		expect(maximum).toBe(4);
		expect(mocks.loadCoordinatorAdminScopeMembers).toHaveBeenCalledTimes(
			MAX_EAGER_SPACE_MEMBERSHIP_LOADS,
		);
		expect(
			coordinatorAdminState.groupScopeManagementDrafts
				.get("group-a")
				?.memberAvailabilityByScope.get(`space-${MAX_EAGER_SPACE_MEMBERSHIP_LOADS}`),
		).toBe("deferred");
	});

	it("preserves prior membership data when a Space moves beyond the eager cap", async () => {
		const initialScopes = Array.from({ length: MAX_EAGER_SPACE_MEMBERSHIP_LOADS }, (_, index) => ({
			scope_id: `space-${index}`,
			label: `Space ${index}`,
		}));
		mocks.loadCoordinatorAdminScopes.mockResolvedValueOnce({ items: initialScopes });
		mocks.loadCoordinatorAdminScopeMembers.mockImplementation((_groupId: string, scopeId: string) =>
			Promise.resolve({ items: [{ device_id: `device-${scopeId}`, status: "active" }] }),
		);
		openGroupScopeManagement("group-a", vi.fn());
		await vi.waitFor(() =>
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.loading).toBe(false),
		);
		mocks.loadCoordinatorAdminScopes.mockResolvedValueOnce({
			items: [
				...Array.from({ length: MAX_EAGER_SPACE_MEMBERSHIP_LOADS }, (_, index) => ({
					scope_id: `new-space-${index}`,
					label: `New Space ${index}`,
				})),
				initialScopes[0],
			],
		});

		openGroupScopeManagement("group-a", vi.fn());
		await vi.waitFor(() =>
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.loading).toBe(false),
		);
		const draft = coordinatorAdminState.groupScopeManagementDrafts.get("group-a");

		expect(draft?.memberAvailabilityByScope.get("space-0")).toBe("stale");
		expect(draft?.membersByScope.get("space-0")).toEqual([
			{ device_id: "device-space-0", status: "active" },
		]);
	});

	it("loads a deferred membership list on demand", async () => {
		document.body.innerHTML = '<div id="spacesMount"></div>';
		const mount = document.getElementById("spacesMount");
		if (!mount) throw new Error("Missing test mount");
		mocks.loadCoordinatorAdminScopes.mockResolvedValue({
			items: Array.from({ length: MAX_EAGER_SPACE_MEMBERSHIP_LOADS + 1 }, (_, index) => ({
				scope_id: `space-${index}`,
				label: `Space ${index}`,
			})),
		});
		mocks.loadCoordinatorAdminScopeMembers.mockResolvedValue({ items: [] });
		const renderShell = () => {
			render(
				h(renderGroupScopeManagementPanel, {
					groupId: "group-a",
					ready: true,
					renderShell,
					summary: { readiness: "ready", title: "Ready", detail: "Ready" },
				}),
				mount,
			);
		};
		openGroupScopeManagement("group-a", renderShell);
		await vi.waitFor(() => expect(mount.textContent).toContain("Load membership"));
		const deferredCard = Array.from(
			mount.querySelectorAll<HTMLElement>(".coordinator-admin-scope-card"),
		).find((card) => card.textContent?.includes(`Space ${MAX_EAGER_SPACE_MEMBERSHIP_LOADS}`));
		deferredCard?.querySelector<HTMLButtonElement>("button")?.click();

		await vi.waitFor(() =>
			expect(
				coordinatorAdminState.groupScopeManagementDrafts
					.get("group-a")
					?.memberAvailabilityByScope.get(`space-${MAX_EAGER_SPACE_MEMBERSHIP_LOADS}`),
			).toBe("fresh"),
		);
		expect(mocks.loadCoordinatorAdminScopeMembers).toHaveBeenCalledTimes(
			MAX_EAGER_SPACE_MEMBERSHIP_LOADS + 1,
		);
	});

	it("keeps the eager request cap when a membership mutation reloads Spaces", async () => {
		document.body.innerHTML = '<div id="spacesMount"></div>';
		const mount = document.getElementById("spacesMount");
		if (!mount) throw new Error("Missing test mount");
		mocks.loadCoordinatorAdminScopes.mockResolvedValue({
			items: Array.from({ length: MAX_EAGER_SPACE_MEMBERSHIP_LOADS + 3 }, (_, index) => ({
				scope_id: `space-${index}`,
				label: `Space ${index}`,
			})),
		});
		mocks.loadCoordinatorAdminScopeMembers.mockResolvedValue({ items: [] });
		mocks.grantCoordinatorAdminScopeMember.mockResolvedValue({});
		const renderShell = () => {
			render(
				h(renderGroupScopeManagementPanel, {
					groupId: "group-a",
					ready: true,
					renderShell,
					summary: { readiness: "ready", title: "Ready", detail: "Ready" },
				}),
				mount,
			);
		};
		openGroupScopeManagement("group-a", renderShell);
		await vi.waitFor(() => expect(mount.textContent).toContain("Grant access"));
		const grant = Array.from(mount.querySelectorAll("button")).find(
			(button) => button.textContent === "Grant access",
		);
		grant?.click();
		await vi.waitFor(() => expect(mocks.grantCoordinatorAdminScopeMember).toHaveBeenCalled());
		await vi.waitFor(() =>
			expect(mocks.loadCoordinatorAdminScopeMembers).toHaveBeenCalledTimes(
				MAX_EAGER_SPACE_MEMBERSHIP_LOADS * 2,
			),
		);
	});

	it("isolates a failed membership refresh and retains only that Space snapshot", async () => {
		mocks.loadCoordinatorAdminScopes.mockResolvedValue({
			items: [
				{ scope_id: "space-a", label: "Space A" },
				{ scope_id: "space-b", label: "Space B" },
			],
		});
		mocks.loadCoordinatorAdminScopeMembers.mockImplementation((_groupId: string, scopeId: string) =>
			Promise.resolve({ items: [{ device_id: `device-${scopeId}`, status: "active" }] }),
		);
		openGroupScopeManagement("group-a", vi.fn());
		await vi.waitFor(() => {
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.availability).toBe(
				"fresh",
			);
		});
		mocks.loadCoordinatorAdminScopeMembers.mockImplementation(
			(_groupId: string, scopeId: string) =>
				scopeId === "space-a"
					? Promise.reject(new Error("member failure"))
					: Promise.resolve({ items: [] }),
		);

		openGroupScopeManagement("group-a", vi.fn());
		await vi.waitFor(() => {
			expect(
				coordinatorAdminState.groupScopeManagementDrafts
					.get("group-a")
					?.memberAvailabilityByScope.get("space-a"),
			).toBe("stale");
		});
		const draft = coordinatorAdminState.groupScopeManagementDrafts.get("group-a");
		expect(draft?.memberAvailabilityByScope.get("space-b")).toBe("fresh");
		expect(draft?.membersByScope.get("space-a")).toEqual([
			{ device_id: "device-space-a", status: "active" },
		]);
		expect(draft?.membersByScope.get("space-b")).toEqual([]);
	});

	it("aborts revoke when Space data refreshes while confirmation is open", async () => {
		document.body.innerHTML = '<div id="spacesMount"></div>';
		const mount = document.getElementById("spacesMount");
		if (!mount) throw new Error("Missing test mount");
		const renderShell = () => {
			render(
				h(renderGroupScopeManagementPanel, {
					groupId: "group-a",
					ready: true,
					renderShell,
					summary: { readiness: "ready", title: "Ready", detail: "Ready" },
				}),
				mount,
			);
		};
		const confirmation = deferred<boolean>();
		mocks.openSyncConfirmDialog.mockReturnValueOnce(confirmation.promise);
		openGroupScopeManagement("group-a", renderShell);
		await vi.waitFor(() => expect(mount.textContent).toContain("Revoke access"));
		const revoke = Array.from(mount.querySelectorAll("button")).find(
			(button) => button.textContent === "Revoke access",
		);
		revoke?.click();
		await vi.waitFor(() => expect(mocks.openSyncConfirmDialog).toHaveBeenCalled());

		openGroupScopeManagement("group-a", renderShell);
		await vi.waitFor(() =>
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.loading).toBe(false),
		);
		confirmation.resolve(true);
		await vi.waitFor(() =>
			expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
				"Space membership data changed while confirmation was open. Review current access and try again.",
				"warning",
			),
		);

		expect(mocks.revokeCoordinatorAdminScopeMember).not.toHaveBeenCalled();
	});

	it("warns when an already-rendered mutation is attempted during refresh", async () => {
		document.body.innerHTML = '<div id="spacesMount"></div>';
		const mount = document.getElementById("spacesMount");
		if (!mount) throw new Error("Missing test mount");
		const renderShell = () => {
			render(
				h(renderGroupScopeManagementPanel, {
					groupId: "group-a",
					ready: true,
					renderShell,
					summary: { readiness: "ready", title: "Ready", detail: "Ready" },
				}),
				mount,
			);
		};
		openGroupScopeManagement("group-a", renderShell);
		await vi.waitFor(() => expect(mount.textContent).toContain("Create Space"));
		const create = Array.from(mount.querySelectorAll("button")).find(
			(button) => button.textContent === "Create Space",
		);
		beginSurfaceRefresh(coordinatorAdminState.recovery, "groups");
		create?.click();

		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"Coordinator data changed or is refreshing. Wait for recovery to finish, then try again.",
			"warning",
		);
	});

	it("disables Space refresh controls while a mutation is pending", async () => {
		document.body.innerHTML = '<div id="spacesMount"></div>';
		const mount = document.getElementById("spacesMount");
		if (!mount) throw new Error("Missing test mount");
		const renderShell = () => {
			render(
				h(renderGroupScopeManagementPanel, {
					groupId: "group-a",
					ready: true,
					renderShell,
					summary: { readiness: "ready", title: "Ready", detail: "Ready" },
				}),
				mount,
			);
		};
		openGroupScopeManagement("group-a", renderShell);
		await vi.waitFor(() => expect(mount.textContent).toContain("Refresh"));
		const current = coordinatorAdminState.groupScopeManagementDrafts.get("group-a");
		if (!current) throw new Error("Missing Space draft");
		coordinatorAdminState.groupScopeManagementDrafts.set("group-a", {
			...current,
			actionPendingKey: "grant:space-a:device-a",
			actionPendingKind: "grant",
			memberAvailabilityByScope: new Map([["space-a", "unavailable"]]),
		});
		renderShell();

		const refresh = Array.from(mount.querySelectorAll<HTMLButtonElement>("button")).find(
			(button) => button.textContent === "Refresh",
		);
		const showInactive = mount.querySelector<HTMLButtonElement>(
			'button[aria-labelledby="coord-admin-domain-inactive-group-a"]',
		);
		const retry = Array.from(mount.querySelectorAll<HTMLButtonElement>("button")).find(
			(button) => button.textContent === "Retry",
		);
		expect(refresh?.disabled).toBe(true);
		expect(showInactive?.disabled).toBe(true);
		expect(retry?.disabled).toBe(true);

		const loadCount = mocks.loadCoordinatorAdminScopes.mock.calls.length;
		if (!retry) throw new Error("Missing recovery Retry button");
		retry.disabled = false;
		retry.click();
		expect(mocks.loadCoordinatorAdminScopes).toHaveBeenCalledTimes(loadCount);
		expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.actionPendingKey).toBe(
			"grant:space-a:device-a",
		);
	});

	it("releases mutation controls when a successful grant reload fails", async () => {
		document.body.innerHTML = '<div id="spacesMount"></div>';
		const mount = document.getElementById("spacesMount");
		if (!mount) throw new Error("Missing test mount");
		mocks.loadCoordinatorAdminScopeMembers.mockResolvedValue({ items: [] });
		mocks.loadCoordinatorAdminScopes
			.mockResolvedValueOnce({ items: [{ scope_id: "space-a", label: "Space A" }] })
			.mockRejectedValueOnce(new Error("reload failed"));
		mocks.grantCoordinatorAdminScopeMember.mockResolvedValue({});
		const renderShell = () => {
			render(
				h(renderGroupScopeManagementPanel, {
					groupId: "group-a",
					ready: true,
					renderShell,
					summary: { readiness: "ready", title: "Ready", detail: "Ready" },
				}),
				mount,
			);
		};
		openGroupScopeManagement("group-a", renderShell);
		await vi.waitFor(() => expect(mount.textContent).toContain("Grant access"));
		const grant = Array.from(mount.querySelectorAll<HTMLButtonElement>("button")).find(
			(button) => button.textContent === "Grant access",
		);
		grant?.click();

		await vi.waitFor(() => {
			const draft = coordinatorAdminState.groupScopeManagementDrafts.get("group-a");
			expect(draft?.loading).toBe(false);
			expect(draft?.actionPendingKey).toBe("");
		});
		const refresh = Array.from(mount.querySelectorAll<HTMLButtonElement>("button")).find(
			(button) => button.textContent === "Refresh",
		);
		expect(refresh?.disabled).toBe(false);
	});

	it("updates the persistent Space status after a repeated retry failure", async () => {
		document.body.innerHTML = '<div id="spacesMount"></div>';
		const mount = document.getElementById("spacesMount");
		if (!mount) throw new Error("Missing test mount");
		const renderShell = () => {
			render(
				h(renderGroupScopeManagementPanel, {
					groupId: "group-a",
					ready: true,
					renderShell,
					summary: { readiness: "ready", title: "Ready", detail: "Ready" },
				}),
				mount,
			);
		};
		mocks.loadCoordinatorAdminScopes.mockRejectedValueOnce(new Error("first failure"));
		openGroupScopeManagement("group-a", renderShell);
		await vi.waitFor(() =>
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.availability).toBe(
				"unavailable",
			),
		);
		const statusNode = document.getElementById("coordinatorAdminSpacesStatus-group-a");
		mocks.loadCoordinatorAdminScopes.mockRejectedValueOnce(new Error("second failure"));
		statusNode?.querySelector<HTMLButtonElement>("button")?.click();
		await vi.waitFor(() => expect(statusNode?.textContent).toContain("Retry finished"));
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		expect(document.getElementById("coordinatorAdminSpacesStatus-group-a")).toBe(statusNode);
		expect(statusNode?.textContent).toContain("No empty result is being shown");
		expect(document.activeElement).toBe(statusNode);
	});

	it("keeps the Space recovery target stable and focuses it after retry succeeds", async () => {
		document.body.innerHTML = '<div id="spacesMount"></div>';
		const mount = document.getElementById("spacesMount");
		if (!mount) throw new Error("Missing test mount");
		const renderShell = () => {
			render(
				h(renderGroupScopeManagementPanel, {
					groupId: "group-a",
					ready: true,
					renderShell,
					summary: { readiness: "ready", title: "Ready", detail: "Ready" },
				}),
				mount,
			);
		};
		mocks.loadCoordinatorAdminScopes.mockRejectedValueOnce(new Error("first load failed"));
		openGroupScopeManagement("group-a", renderShell);
		await vi.waitFor(() => {
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.availability).toBe(
				"unavailable",
			);
		});
		const statusNode = document.getElementById("coordinatorAdminSpacesStatus-group-a");
		const retry = statusNode?.querySelector<HTMLButtonElement>("button");
		expect(statusNode).not.toBeNull();
		expect(retry).not.toBeNull();

		retry?.click();
		await vi.waitFor(() => {
			expect(coordinatorAdminState.groupScopeManagementDrafts.get("group-a")?.availability).toBe(
				"fresh",
			);
		});
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		expect(document.getElementById("coordinatorAdminSpacesStatus-group-a")).toBe(statusNode);
		expect(document.activeElement).toBe(statusNode);
		expect(statusNode?.textContent).toContain("Spaces and membership details refreshed");
	});
});
