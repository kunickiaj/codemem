import { beforeEach, describe, expect, it, vi } from "vitest";

import { state } from "../../../lib/state";
import { createCoordinatorAdminActions } from "./actions";
import { coordinatorAdminState } from "./state";

const mocks = vi.hoisted(() => ({
	createCoordinatorAdminGroup: vi.fn(),
	createCoordinatorInvite: vi.fn(),
	reviewCoordinatorAdminJoinRequest: vi.fn(),
	showGlobalNotice: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
	createCoordinatorAdminGroup: mocks.createCoordinatorAdminGroup,
	createCoordinatorInvite: mocks.createCoordinatorInvite,
	reviewCoordinatorAdminJoinRequest: mocks.reviewCoordinatorAdminJoinRequest,
}));

vi.mock("../../../lib/notice", () => ({
	showGlobalNotice: mocks.showGlobalNotice,
}));

vi.mock("../../sync/sync-dialogs", () => ({
	openSyncConfirmDialog: vi.fn(),
}));

describe("coordinator admin actions", () => {
	beforeEach(() => {
		mocks.createCoordinatorAdminGroup.mockReset();
		mocks.createCoordinatorInvite.mockReset();
		mocks.reviewCoordinatorAdminJoinRequest.mockReset();
		mocks.showGlobalNotice.mockReset();
		state.coordinatorAdminTargetGroup = "";
		state.lastCoordinatorAdminStatus = {
			coordinator_url: "https://coordinator.example",
			readiness: "ready",
		};
		coordinatorAdminState.createGroupId = "";
		coordinatorAdminState.createGroupDisplayName = "";
		coordinatorAdminState.groupActionPendingKind = "";
		coordinatorAdminState.inviteGroup = "";
		coordinatorAdminState.invitePending = false;
		coordinatorAdminState.invitePolicy = "auto_admit";
		coordinatorAdminState.inviteTtlHours = "24";
		coordinatorAdminState.teamSetupGuide = null;
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
			"Team created with a default Space.",
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
			"Team created, but default Space setup needs repair.",
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

	it("points successful invite sharing copy at Teams", async () => {
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
			"Invite created. Copy it from Teams and share it with your teammate.",
			"success",
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
});
