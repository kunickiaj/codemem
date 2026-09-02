import { beforeEach, describe, expect, it, vi } from "vitest";

import { state } from "../../../lib/state";
import { createCoordinatorAdminActions } from "./actions";
import { beginSurfaceRefresh, completeSurfaceRefresh, failSurfaceRefresh } from "./recovery";
import { beginCoordinatorAdminLoadGeneration, coordinatorAdminState } from "./state";

const mocks = vi.hoisted(() => ({
	createCoordinatorAdminGroup: vi.fn(),
	archiveCoordinatorAdminGroup: vi.fn(),
	createCoordinatorInvite: vi.fn(),
	disableCoordinatorAdminDevice: vi.fn(),
	enableCoordinatorAdminDevice: vi.fn(),
	openSyncConfirmDialog: vi.fn(),
	renameCoordinatorAdminGroup: vi.fn(),
	renameCoordinatorAdminDevice: vi.fn(),
	removeCoordinatorAdminDevice: vi.fn(),
	reviewCoordinatorAdminJoinRequest: vi.fn(),
	showGlobalNotice: vi.fn(),
	unarchiveCoordinatorAdminGroup: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
	archiveCoordinatorAdminGroup: mocks.archiveCoordinatorAdminGroup,
	createCoordinatorAdminGroup: mocks.createCoordinatorAdminGroup,
	createCoordinatorInvite: mocks.createCoordinatorInvite,
	disableCoordinatorAdminDevice: mocks.disableCoordinatorAdminDevice,
	enableCoordinatorAdminDevice: mocks.enableCoordinatorAdminDevice,
	renameCoordinatorAdminGroup: mocks.renameCoordinatorAdminGroup,
	renameCoordinatorAdminDevice: mocks.renameCoordinatorAdminDevice,
	removeCoordinatorAdminDevice: mocks.removeCoordinatorAdminDevice,
	reviewCoordinatorAdminJoinRequest: mocks.reviewCoordinatorAdminJoinRequest,
	unarchiveCoordinatorAdminGroup: mocks.unarchiveCoordinatorAdminGroup,
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

vi.mock("../../../lib/notice", () => ({
	showGlobalNotice: mocks.showGlobalNotice,
}));

vi.mock("../../sync/sync-dialogs", () => ({
	openSyncConfirmDialog: mocks.openSyncConfirmDialog,
}));

describe("coordinator admin actions", () => {
	beforeEach(() => {
		mocks.archiveCoordinatorAdminGroup.mockReset();
		mocks.createCoordinatorAdminGroup.mockReset();
		mocks.createCoordinatorInvite.mockReset();
		mocks.disableCoordinatorAdminDevice.mockReset();
		mocks.enableCoordinatorAdminDevice.mockReset();
		mocks.openSyncConfirmDialog.mockReset();
		mocks.openSyncConfirmDialog.mockResolvedValue(true);
		mocks.renameCoordinatorAdminGroup.mockReset();
		mocks.renameCoordinatorAdminDevice.mockReset();
		mocks.removeCoordinatorAdminDevice.mockReset();
		mocks.reviewCoordinatorAdminJoinRequest.mockReset();
		mocks.showGlobalNotice.mockReset();
		mocks.unarchiveCoordinatorAdminGroup.mockReset();
		state.coordinatorAdminTargetGroup = "";
		state.lastCoordinatorAdminStatus = {
			coordinator_url: "https://coordinator.example",
			readiness: "ready",
		};
		state.lastCoordinatorAdminGroups = [
			{ group_id: "group-alpha", display_name: "Current Alpha", archived_at: null },
		];
		state.lastCoordinatorAdminDevices = [
			{ device_id: "device-a", group_id: "group-alpha", display_name: "Laptop" },
		];
		state.lastTeamInvite = null;
		coordinatorAdminState.loadGeneration = 0;
		coordinatorAdminState.createGroupId = "";
		coordinatorAdminState.createGroupDisplayName = "";
		coordinatorAdminState.groupActionPendingKind = "";
		coordinatorAdminState.groupActionPendingId = "";
		coordinatorAdminState.groupRenameDrafts.clear();
		coordinatorAdminState.groupPresentationAliases.clear();
		coordinatorAdminState.deviceActionPendingId = "";
		coordinatorAdminState.deviceActionPendingKind = "";
		coordinatorAdminState.joinRequestsSnapshotTarget = {
			coordinatorUrl: "https://coordinator.example",
			groupId: "group-alpha",
		};
		coordinatorAdminState.devicesSnapshotTarget = {
			coordinatorUrl: "https://coordinator.example",
			groupId: "group-alpha",
		};
		coordinatorAdminState.deviceRenameDrafts.clear();
		coordinatorAdminState.inviteGroup = "";
		coordinatorAdminState.invitePending = false;
		coordinatorAdminState.invitePolicy = "auto_admit";
		coordinatorAdminState.inviteTtlHours = "24";
		coordinatorAdminState.teamSetupGuide = null;
		completeSurfaceRefresh(coordinatorAdminState.recovery, "status");
		completeSurfaceRefresh(coordinatorAdminState.recovery, "groups");
		completeSurfaceRefresh(coordinatorAdminState.recovery, "joinRequests");
		completeSurfaceRefresh(coordinatorAdminState.recovery, "devices");
		localStorage.clear();
	});

	it("opens the guided setup callout after creating a Team with a default Space", async () => {
		mocks.createCoordinatorAdminGroup.mockResolvedValue({
			group: { group_id: "team-alpha", display_name: "Team Alpha" },
			default_space: {
				scope: { scope_id: "team:team-alpha:default", label: "Team Alpha" },
				membership: { device_id: "dev-a" },
				preferences: { auto_grant_default_space_on_join: true },
			},
		});
		coordinatorAdminState.createGroupId = "team-alpha";
		coordinatorAdminState.createGroupDisplayName = "Team Alpha";
		const reloadData = vi.fn().mockResolvedValue(undefined);
		const actions = createCoordinatorAdminActions({ renderShell: vi.fn(), reloadData });

		await actions.createGroupFromAdminPanel();

		expect(state.coordinatorAdminTargetGroup).toBe("team-alpha");
		expect(coordinatorAdminState.teamSetupGuide).toEqual({
			groupId: "team-alpha",
			displayName: "Team Alpha",
			defaultSpaceScopeId: "team:team-alpha:default",
			defaultSpaceLabel: "Team Alpha",
			autoGrantDefaultSpaceOnJoin: true,
			setupWarning: null,
		});
		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"Legacy coordinator group created with a default Space. Sharing policy is unchanged.",
			"success",
		);
		expect(reloadData).toHaveBeenCalledTimes(2);
	});

	it("keeps setup warnings visible when default Space creation needs repair", async () => {
		mocks.createCoordinatorAdminGroup.mockResolvedValue({
			group: { group_id: "team-beta", display_name: "Team Beta" },
			default_space: null,
			setup_warning: { step: "default_space", error: "coordinator unavailable" },
		});
		coordinatorAdminState.createGroupId = "team-beta";
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.createGroupFromAdminPanel();

		expect(coordinatorAdminState.teamSetupGuide?.setupWarning).toEqual({
			step: "default_space",
			error: "coordinator unavailable",
		});
		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"Legacy coordinator group created, but default Space setup needs repair. Sharing policy is unchanged.",
			"warning",
		);
	});

	it("reports a created group accurately when the follow-up refresh fails", async () => {
		mocks.createCoordinatorAdminGroup.mockResolvedValue({
			group: { group_id: "team-alpha", display_name: "Team Alpha" },
			default_space: null,
		});
		coordinatorAdminState.createGroupId = "team-alpha";
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockRejectedValue(new Error("refresh failed")),
		});

		await actions.createGroupFromAdminPanel();

		expect(mocks.showGlobalNotice).toHaveBeenLastCalledWith(
			"Legacy coordinator group created, but coordinator data could not refresh. Check coordinator recovery status before retrying.",
			"warning",
		);
	});

	it("selects the created Team after refreshing stale group data", async () => {
		mocks.createCoordinatorAdminGroup.mockResolvedValue({
			group: { group_id: "team-new", display_name: "Team New" },
			default_space: {
				scope: { scope_id: "team:team-new:default", label: "Team New" },
				preferences: { auto_grant_default_space_on_join: true },
			},
		});
		state.coordinatorAdminTargetGroup = "team-old";
		coordinatorAdminState.createGroupId = "team-new";
		const reloadData = vi
			.fn()
			.mockImplementationOnce(async () => {
				state.coordinatorAdminTargetGroup = "team-old";
			})
			.mockResolvedValue(undefined);
		const actions = createCoordinatorAdminActions({ renderShell: vi.fn(), reloadData });

		await actions.createGroupFromAdminPanel();

		expect(reloadData).toHaveBeenCalledTimes(2);
		expect(state.coordinatorAdminTargetGroup).toBe("team-new");
	});

	it("keeps a new unnamed group ID out of presentation state", async () => {
		mocks.createCoordinatorAdminGroup.mockResolvedValue({
			group: { group_id: "group-private", display_name: null },
			default_space: null,
		});
		coordinatorAdminState.createGroupId = "group-private";
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.createGroupFromAdminPanel();

		expect(coordinatorAdminState.teamSetupGuide).toMatchObject({
			groupId: "group-private",
			displayName: "",
		});
	});

	it("states that a legacy coordinator invite does not grant Sharing access", async () => {
		mocks.createCoordinatorInvite.mockResolvedValue({ token: "invite-token", warnings: [] });
		coordinatorAdminState.inviteGroup = "team-alpha";
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.createInviteFromAdminPanel();

		expect(mocks.createCoordinatorInvite).toHaveBeenCalledWith({
			group_id: "team-alpha",
			policy: "auto_admit",
			ttl_hours: 24,
		});
		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"Legacy coordinator invite created. It does not grant Sharing Project access.",
			"success",
		);
	});

	it.each([
		[
			"Group not found: private-group-id",
			"This legacy coordinator group no longer exists. Choose an active group or refresh coordinator groups.",
		],
		[
			"Remote coordinator request failed (404): group_not_found",
			"This legacy coordinator group no longer exists. Choose an active group or refresh coordinator groups.",
		],
		[
			"group_archived: private-group-id",
			"This legacy coordinator group is archived. Choose an active group or refresh coordinator groups.",
		],
		[
			"Group is archived: private-group-id",
			"This legacy coordinator group is archived. Choose an active group or refresh coordinator groups.",
		],
		[
			"Remote coordinator request failed (409): group_archived",
			"This legacy coordinator group is archived. Choose an active group or refresh coordinator groups.",
		],
	] as const)("preserves actionable invite guidance for %s", async (message, expected) => {
		mocks.createCoordinatorInvite.mockRejectedValue(new Error(message));
		coordinatorAdminState.inviteGroup = "private-group-id";
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.createInviteFromAdminPanel();

		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(expected, "warning");
		expect(mocks.showGlobalNotice.mock.calls.flat().join(" ")).not.toContain("private-group-id");
	});

	it.each([new Error("private coordinator detail"), "group_archived"])(
		"keeps generic recovery guidance for an unknown invite failure (%o)",
		async (cause) => {
			mocks.createCoordinatorInvite.mockRejectedValue(cause);
			coordinatorAdminState.inviteGroup = "team-alpha";
			const actions = createCoordinatorAdminActions({
				renderShell: vi.fn(),
				reloadData: vi.fn().mockResolvedValue(undefined),
			});

			await actions.createInviteFromAdminPanel();

			expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
				"Could not create the legacy coordinator invite. Sharing policy is unchanged; check coordinator recovery status and retry.",
				"warning",
			);
			expect(mocks.showGlobalNotice.mock.calls.flat().join(" ")).not.toContain(
				"private coordinator detail",
			);
		},
	);

	it("does not restore an invite returned after coordinator data is superseded", async () => {
		const invite = deferred<{ token: string; warnings: string[] }>();
		mocks.createCoordinatorInvite.mockReturnValueOnce(invite.promise);
		coordinatorAdminState.inviteGroup = "team-alpha";
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});
		const action = actions.createInviteFromAdminPanel();
		await vi.waitFor(() => expect(mocks.createCoordinatorInvite).toHaveBeenCalled());
		beginCoordinatorAdminLoadGeneration();
		coordinatorAdminState.inviteGroup = "";
		invite.resolve({ token: "stale-invite", warnings: ["stale warning"] });

		await action;

		expect(state.lastTeamInvite).toBeNull();
		expect(coordinatorAdminState.inviteGroup).toBe("");
		expect(mocks.showGlobalNotice).not.toHaveBeenCalled();
	});

	it("keeps an invite returned after an ordinary refresh for the same coordinator and group", async () => {
		const invite = deferred<{ token: string; warnings: string[] }>();
		mocks.createCoordinatorInvite.mockReturnValueOnce(invite.promise);
		coordinatorAdminState.inviteGroup = "team-alpha";
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});
		const action = actions.createInviteFromAdminPanel();
		await vi.waitFor(() => expect(mocks.createCoordinatorInvite).toHaveBeenCalled());
		beginCoordinatorAdminLoadGeneration();
		const result = { token: "current-invite", warnings: [] };
		invite.resolve(result);

		await action;

		expect(state.lastTeamInvite).toBe(result);
		expect(coordinatorAdminState.inviteGroup).toBe("team-alpha");
		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"Legacy coordinator invite created. It does not grant Sharing Project access.",
			"success",
		);
	});

	it("does not restore setup guidance returned after coordinator data is superseded", async () => {
		const group = deferred<{
			group: { group_id: string; display_name: string };
			default_space: null;
		}>();
		mocks.createCoordinatorAdminGroup.mockReturnValueOnce(group.promise);
		coordinatorAdminState.createGroupId = "team-alpha";
		const reloadData = vi.fn().mockResolvedValue(undefined);
		const actions = createCoordinatorAdminActions({ renderShell: vi.fn(), reloadData });
		const action = actions.createGroupFromAdminPanel();
		await vi.waitFor(() => expect(mocks.createCoordinatorAdminGroup).toHaveBeenCalled());
		beginCoordinatorAdminLoadGeneration();
		state.lastCoordinatorAdminStatus = {
			coordinator_url: "https://other-coordinator.example",
			readiness: "ready",
		};
		coordinatorAdminState.teamSetupGuide = null;
		group.resolve({
			group: { group_id: "team-alpha", display_name: "Team Alpha" },
			default_space: null,
		});

		await action;

		expect(coordinatorAdminState.teamSetupGuide).toBeNull();
		expect(reloadData).not.toHaveBeenCalled();
		expect(mocks.showGlobalNotice).not.toHaveBeenCalled();
	});

	it("keeps setup guidance returned after an ordinary refresh for the same coordinator", async () => {
		const group = deferred<{
			group: { group_id: string; display_name: string };
			default_space: null;
		}>();
		mocks.createCoordinatorAdminGroup.mockReturnValueOnce(group.promise);
		coordinatorAdminState.createGroupId = "team-alpha";
		const reloadData = vi.fn().mockResolvedValue(undefined);
		const actions = createCoordinatorAdminActions({ renderShell: vi.fn(), reloadData });
		const action = actions.createGroupFromAdminPanel();
		await vi.waitFor(() => expect(mocks.createCoordinatorAdminGroup).toHaveBeenCalled());
		beginCoordinatorAdminLoadGeneration();
		group.resolve({
			group: { group_id: "team-alpha", display_name: "Team Alpha" },
			default_space: null,
		});

		await action;

		expect(coordinatorAdminState.teamSetupGuide).toMatchObject({ groupId: "team-alpha" });
		expect(reloadData).toHaveBeenCalledTimes(2);
	});

	it.each([
		["approve", "join request not found: private-request-id"],
		["approve", "Remote coordinator request failed (404): request_not_found"],
		["deny", "join request not found: private-request-id"],
		["deny", "Remote coordinator request failed (404): request_not_found"],
	] as const)(
		"refreshes pending requests when %s reports a missing request (%s)",
		async (action, message) => {
			mocks.reviewCoordinatorAdminJoinRequest.mockRejectedValue(new Error(message));
			const reloadData = vi.fn().mockResolvedValue(undefined);
			const actions = createCoordinatorAdminActions({ renderShell: vi.fn(), reloadData });

			await actions.reviewJoinRequestFromAdminPanel("private-request-id", action);

			expect(reloadData).toHaveBeenCalledTimes(1);
			expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
				"This legacy coordinator join request no longer exists. Pending requests were refreshed.",
				"warning",
			);
			expect(mocks.showGlobalNotice.mock.calls.flat().join(" ")).not.toContain(
				"private-request-id",
			);
		},
	);

	it.each([new Error("private coordinator detail"), "request_not_found"])(
		"keeps recovery guidance for an unknown join-review failure (%o)",
		async (cause) => {
			mocks.reviewCoordinatorAdminJoinRequest.mockRejectedValue(cause);
			const reloadData = vi.fn().mockResolvedValue(undefined);
			const actions = createCoordinatorAdminActions({ renderShell: vi.fn(), reloadData });

			await actions.reviewJoinRequestFromAdminPanel("join-1", "approve");

			expect(reloadData).not.toHaveBeenCalled();
			expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
				"Could not review the legacy coordinator join request. Sharing policy is unchanged; check coordinator recovery status and retry.",
				"warning",
			);
			expect(mocks.showGlobalNotice.mock.calls.flat().join(" ")).not.toContain(
				"private coordinator detail",
			);
		},
	);

	it("keeps missing-request guidance when refreshing the pending list fails", async () => {
		mocks.reviewCoordinatorAdminJoinRequest.mockRejectedValue(new Error("join request not found"));
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockRejectedValue(new Error("refresh failed")),
		});

		await expect(
			actions.reviewJoinRequestFromAdminPanel("join-1", "approve"),
		).resolves.toBeUndefined();

		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"This legacy coordinator join request no longer exists. Refresh pending requests before reviewing another request.",
			"warning",
		);
	});

	it("reports an accurate result when a successful review cannot refresh", async () => {
		mocks.reviewCoordinatorAdminJoinRequest.mockResolvedValue({});
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockRejectedValue(new Error("refresh failed")),
		});

		await expect(
			actions.reviewJoinRequestFromAdminPanel("join-1", "approve"),
		).resolves.toBeUndefined();

		expect(mocks.showGlobalNotice).toHaveBeenLastCalledWith(
			"Join request approved, but pending requests could not refresh. Check coordinator recovery status before reviewing another request.",
			"warning",
		);
	});

	it("keeps a join review result after an ordinary refresh for the same target", async () => {
		const review = deferred<Record<string, never>>();
		mocks.reviewCoordinatorAdminJoinRequest.mockReturnValueOnce(review.promise);
		const reloadData = vi.fn().mockResolvedValue(undefined);
		const actions = createCoordinatorAdminActions({ renderShell: vi.fn(), reloadData });
		const action = actions.reviewJoinRequestFromAdminPanel("join-1", "approve");
		await vi.waitFor(() => expect(mocks.reviewCoordinatorAdminJoinRequest).toHaveBeenCalled());
		beginCoordinatorAdminLoadGeneration();
		review.resolve({});

		await action;

		expect(reloadData).toHaveBeenCalledTimes(1);
		expect(mocks.showGlobalNotice).toHaveBeenCalledWith("Join request approved.", "success");
	});

	it("refuses coordinator mutations when required state is stale", async () => {
		coordinatorAdminState.inviteGroup = "team-alpha";
		failSurfaceRefresh(coordinatorAdminState.recovery, "groups");
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.createInviteFromAdminPanel();

		expect(mocks.createCoordinatorInvite).not.toHaveBeenCalled();
		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"Coordinator data changed or is refreshing. Wait for recovery to finish, then try again.",
			"warning",
		);
	});

	it("refuses enrollment mutations from a snapshot loaded for another group", async () => {
		state.coordinatorAdminTargetGroup = "group-beta";
		coordinatorAdminState.deviceRenameDrafts.set("device-a", "Renamed Laptop");
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.reviewJoinRequestFromAdminPanel("join-1", "approve");
		await actions.runDeviceAction("device-a", "group-alpha", "Laptop", "rename");

		expect(mocks.reviewCoordinatorAdminJoinRequest).not.toHaveBeenCalled();
		expect(mocks.renameCoordinatorAdminDevice).not.toHaveBeenCalled();
	});

	it("aborts a confirmed group mutation when refresh starts during confirmation", async () => {
		const confirmation = deferred<boolean>();
		mocks.openSyncConfirmDialog.mockReturnValueOnce(confirmation.promise);
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});
		const action = actions.runGroupAction("group-alpha", "Legacy Alpha", "archive");
		await vi.waitFor(() => expect(mocks.openSyncConfirmDialog).toHaveBeenCalled());
		beginCoordinatorAdminLoadGeneration();
		beginSurfaceRefresh(coordinatorAdminState.recovery, "groups");
		confirmation.resolve(true);

		await action;

		expect(mocks.archiveCoordinatorAdminGroup).not.toHaveBeenCalled();
		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"Coordinator group data changed while confirmation was open. Review the current group and try again.",
			"warning",
		);
	});

	it("allows a confirmed group mutation after a completed refresh for the same target", async () => {
		const confirmation = deferred<boolean>();
		mocks.openSyncConfirmDialog.mockReturnValueOnce(confirmation.promise);
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});
		const action = actions.runGroupAction("group-alpha", "Legacy Alpha", "archive");
		await vi.waitFor(() => expect(mocks.openSyncConfirmDialog).toHaveBeenCalled());
		beginCoordinatorAdminLoadGeneration();
		beginSurfaceRefresh(coordinatorAdminState.recovery, "groups");
		completeSurfaceRefresh(coordinatorAdminState.recovery, "groups");
		confirmation.resolve(true);

		await action;

		expect(mocks.archiveCoordinatorAdminGroup).toHaveBeenCalledWith("group-alpha");
	});

	it("uses the current rename draft after group confirmation", async () => {
		const confirmation = deferred<boolean>();
		mocks.openSyncConfirmDialog.mockReturnValueOnce(confirmation.promise);
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});
		const action = actions.runGroupAction("group-alpha", "Legacy Alpha", "rename");
		await vi.waitFor(() => expect(mocks.openSyncConfirmDialog).toHaveBeenCalled());
		coordinatorAdminState.groupRenameDrafts.set("group-alpha", "Current Alpha");
		confirmation.resolve(true);

		await action;

		expect(mocks.renameCoordinatorAdminGroup).toHaveBeenCalledWith("group-alpha", "Current Alpha");
	});

	it("reports a renamed group accurately when the follow-up refresh fails", async () => {
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockRejectedValue(new Error("refresh failed")),
		});

		await actions.runGroupAction("group-alpha", "Legacy Alpha", "rename");

		expect(mocks.showGlobalNotice).toHaveBeenLastCalledWith(
			"Legacy coordinator group renamed, but coordinator data could not refresh. Check coordinator recovery status before retrying.",
			"warning",
		);
	});

	it("aborts a confirmed device mutation when refresh starts during confirmation", async () => {
		const confirmation = deferred<boolean>();
		mocks.openSyncConfirmDialog.mockReturnValueOnce(confirmation.promise);
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});
		const action = actions.runDeviceAction("device-a", "group-alpha", "Laptop", "remove");
		await vi.waitFor(() => expect(mocks.openSyncConfirmDialog).toHaveBeenCalled());
		beginCoordinatorAdminLoadGeneration();
		beginSurfaceRefresh(coordinatorAdminState.recovery, "devices");
		confirmation.resolve(true);

		await action;

		expect(mocks.removeCoordinatorAdminDevice).not.toHaveBeenCalled();
		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"Coordinator device data changed while confirmation was open. Review the current device and try again.",
			"warning",
		);
	});

	it("does not fall back to a raw device id in confirmation copy", async () => {
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.runDeviceAction("private-device-id", "group-alpha", "", "remove");

		expect(mocks.openSyncConfirmDialog).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Remove this device?" }),
		);
	});

	it("confirms that renaming a coordinator group does not rename a Sharing Team", async () => {
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.runGroupAction("group-alpha", "Legacy Alpha", "rename");

		expect(mocks.openSyncConfirmDialog).toHaveBeenCalledWith(
			expect.objectContaining({
				description: expect.stringMatching(/Target: Current Alpha.*does not rename a policy Team/),
				confirmLabel: "Rename coordinator group",
				tone: "default",
			}),
		);
		expect(mocks.renameCoordinatorAdminGroup).toHaveBeenCalledWith("group-alpha", "Current Alpha");
	});

	it("rejects an empty legacy group name before confirmation", async () => {
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.runGroupAction("group-alpha", "   ", "rename");

		expect(mocks.openSyncConfirmDialog).not.toHaveBeenCalled();
		expect(mocks.renameCoordinatorAdminGroup).not.toHaveBeenCalled();
		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"Enter a legacy group display name before renaming it.",
			"warning",
		);
	});

	it("uses a privacy-safe alias when an unnamed group is renamed", async () => {
		state.lastCoordinatorAdminGroups = [
			{ group_id: "group-alpha", display_name: null, archived_at: null },
			{ group_id: "group-beta", display_name: null, archived_at: null },
		];
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.runGroupAction("group-alpha", "Legacy Alpha", "rename");

		expect(mocks.openSyncConfirmDialog).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Rename Unnamed coordinator group 1?",
				description: expect.stringContaining(
					"Target: Unnamed coordinator group 1. New name: Legacy Alpha.",
				),
			}),
		);
	});

	it("warns that archiving a coordinator group leaves Sharing policy unchanged", async () => {
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.runGroupAction("group-alpha", "Legacy Alpha", "archive");

		expect(mocks.openSyncConfirmDialog).toHaveBeenCalledWith(
			expect.objectContaining({
				description: expect.stringMatching(
					/Target: Current Alpha.*coordinator presence, peer discovery, Space grants, legacy invites, and joins stop.*removes this group from this device's local coordinator configuration.*Policy Team membership and Project access in Sharing are separate and unchanged/,
				),
				confirmLabel: "Archive coordinator group",
				tone: "danger",
			}),
		);
		expect(mocks.archiveCoordinatorAdminGroup).toHaveBeenCalledWith("group-alpha");
	});

	it("identifies the target when unarchiving a coordinator group", async () => {
		state.lastCoordinatorAdminGroups = [
			{
				group_id: "group-alpha",
				display_name: "Archived Alpha",
				archived_at: "2026-08-27T00:00:00.000Z",
			},
		];
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.runGroupAction("group-alpha", "Archived Alpha", "unarchive");

		expect(mocks.openSyncConfirmDialog).toHaveBeenCalledWith(
			expect.objectContaining({
				description: expect.stringMatching(
					/Target: Archived Alpha.*reactivates the remote coordinator group for devices still configured for it.*does not re-add this group to this device's local coordinator configuration.*restore that separately before expecting coordinator presence or peer discovery here/,
				),
				confirmLabel: "Unarchive coordinator group",
				tone: "default",
			}),
		);
		expect(mocks.unarchiveCoordinatorAdminGroup).toHaveBeenCalledWith("group-alpha");
		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"Legacy coordinator group unarchived. This device's local coordinator configuration and Sharing policy are unchanged.",
			"success",
		);
	});

	it.each([
		["rename", "group_not_found: private-group-id"],
		["archive", "group_not_found_or_already_archived: private-group-id"],
		["unarchive", "group_not_found_or_not_archived: private-group-id"],
	] as const)("refreshes groups when %s finds stale coordinator state", async (kind, message) => {
		const mutation =
			kind === "rename"
				? mocks.renameCoordinatorAdminGroup
				: kind === "archive"
					? mocks.archiveCoordinatorAdminGroup
					: mocks.unarchiveCoordinatorAdminGroup;
		mutation.mockRejectedValue(new Error(message));
		const reloadData = vi.fn().mockResolvedValue(undefined);
		const actions = createCoordinatorAdminActions({ renderShell: vi.fn(), reloadData });

		await actions.runGroupAction("group-alpha", "Legacy Alpha", kind);

		expect(reloadData).toHaveBeenCalledTimes(1);
		expect(mocks.showGlobalNotice).toHaveBeenLastCalledWith(
			"This legacy coordinator group changed or no longer exists. Coordinator groups were refreshed.",
			"warning",
		);
		expect(mocks.showGlobalNotice.mock.calls.flat().join(" ")).not.toContain("private-group-id");
	});

	it("keeps stale-group guidance when refreshing groups fails", async () => {
		mocks.archiveCoordinatorAdminGroup.mockRejectedValue(
			new Error("group_not_found_or_already_archived"),
		);
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockRejectedValue(new Error("refresh failed")),
		});

		await expect(
			actions.runGroupAction("group-alpha", "Legacy Alpha", "archive"),
		).resolves.toBeUndefined();

		expect(mocks.showGlobalNotice).toHaveBeenLastCalledWith(
			"This legacy coordinator group changed or no longer exists. Refresh coordinator groups before trying another action.",
			"warning",
		);
	});

	it("keeps default Space grant warnings visible after approving a join request", async () => {
		mocks.reviewCoordinatorAdminJoinRequest.mockResolvedValue({
			setup_warning: { step: "default_space_grant", error: "grant failed" },
		});
		const reloadData = vi.fn().mockResolvedValue(undefined);
		const actions = createCoordinatorAdminActions({ renderShell: vi.fn(), reloadData });

		await actions.reviewJoinRequestFromAdminPanel("join-1", "approve");

		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"Join request approved, but default Space access needs repair.",
			"warning",
		);
		expect(reloadData).toHaveBeenCalledTimes(1);
	});

	it.each([
		["display_name_required", "Enter a device name before renaming it."],
		["display_name_invalid", "Enter a valid device name and retry."],
		["display_name_too_long", "The device name is too long. Use a shorter name and retry."],
	])("shows a useful notice for the known device rename error %s", async (error, notice) => {
		mocks.renameCoordinatorAdminDevice.mockRejectedValue(new Error(error));
		coordinatorAdminState.deviceRenameDrafts.set("device-a", "New device name");
		const reloadData = vi.fn().mockResolvedValue(undefined);
		const actions = createCoordinatorAdminActions({ renderShell: vi.fn(), reloadData });

		await actions.runDeviceAction("device-a", "group-alpha", "Laptop", "rename");

		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(notice, "warning");
		expect(reloadData).not.toHaveBeenCalled();
	});

	it("does not expose unknown coordinator details after a device rename failure", async () => {
		mocks.renameCoordinatorAdminDevice.mockRejectedValue(new Error("private coordinator detail"));
		coordinatorAdminState.deviceRenameDrafts.set("device-a", "New device name");
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockResolvedValue(undefined),
		});

		await actions.runDeviceAction("device-a", "group-alpha", "Laptop", "rename");

		expect(mocks.showGlobalNotice).toHaveBeenCalledWith(
			"Could not rename the legacy coordinator device. Sharing policy is unchanged; check coordinator recovery status and retry.",
			"warning",
		);
		expect(mocks.showGlobalNotice).not.toHaveBeenCalledWith(
			expect.stringContaining("private coordinator detail"),
			expect.anything(),
		);
	});

	it.each(["rename", "disable", "enable", "remove"] as const)(
		"refreshes devices when %s finds a missing enrollment",
		async (kind) => {
			const mutation =
				kind === "rename"
					? mocks.renameCoordinatorAdminDevice
					: kind === "disable"
						? mocks.disableCoordinatorAdminDevice
						: kind === "enable"
							? mocks.enableCoordinatorAdminDevice
							: mocks.removeCoordinatorAdminDevice;
			mutation.mockRejectedValue(new Error("device_not_found: private-device-id"));
			coordinatorAdminState.deviceRenameDrafts.set("device-a", "New device name");
			const reloadData = vi.fn().mockResolvedValue(undefined);
			const actions = createCoordinatorAdminActions({ renderShell: vi.fn(), reloadData });

			await actions.runDeviceAction("device-a", "group-alpha", "Laptop", kind);

			expect(reloadData).toHaveBeenCalledTimes(1);
			expect(mocks.showGlobalNotice).toHaveBeenLastCalledWith(
				"This legacy coordinator device no longer exists. Enrolled devices were refreshed.",
				"warning",
			);
			expect(mocks.showGlobalNotice.mock.calls.flat().join(" ")).not.toContain("private-device-id");
		},
	);

	it("keeps missing-device guidance when refreshing devices fails", async () => {
		mocks.removeCoordinatorAdminDevice.mockRejectedValue(new Error("device_not_found"));
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockRejectedValue(new Error("refresh failed")),
		});

		await expect(
			actions.runDeviceAction("device-a", "group-alpha", "Laptop", "remove"),
		).resolves.toBeUndefined();

		expect(mocks.showGlobalNotice).toHaveBeenLastCalledWith(
			"This legacy coordinator device no longer exists. Refresh enrolled devices before trying another action.",
			"warning",
		);
	});

	it("reports a renamed device accurately when the follow-up refresh fails", async () => {
		coordinatorAdminState.deviceRenameDrafts.set("device-a", "New device name");
		const actions = createCoordinatorAdminActions({
			renderShell: vi.fn(),
			reloadData: vi.fn().mockRejectedValue(new Error("refresh failed")),
		});

		await actions.runDeviceAction("device-a", "group-alpha", "Laptop", "rename");

		expect(mocks.showGlobalNotice).toHaveBeenLastCalledWith(
			"Device renamed, but coordinator data could not refresh. Check coordinator recovery status before retrying.",
			"warning",
		);
	});
});
