import { beforeEach, describe, expect, it } from "vitest";

import { state } from "../../../lib/state";
import { coordinatorAdminState } from "./state";
import {
	adminSnapshotTargetMatchesCurrent,
	coordinatorGroupPresentationName,
	currentAdminSnapshotTarget,
	readStoredAdminTargetGroup,
	reconcileDeviceRenameDrafts,
	reconcileGroupRenameDrafts,
	writeStoredAdminTargetGroup,
} from "./target-group";

describe("coordinator admin target group helpers", () => {
	beforeEach(() => {
		state.lastCoordinatorAdminStatus = null;
		state.lastCoordinatorAdminDevices = [];
		state.lastCoordinatorAdminGroups = [];
		state.coordinatorAdminTargetGroup = "";
		coordinatorAdminState.groupRenameDrafts.clear();
		coordinatorAdminState.groupPresentationAliases.clear();
		coordinatorAdminState.deviceRenameDrafts.clear();
		coordinatorAdminState.deviceRenameServerNames.clear();
		localStorage.clear();
	});

	it("uses one stored target for trailing-slash-equivalent coordinator URLs", () => {
		writeStoredAdminTargetGroup("https://coordinator.example", "group-a");

		expect(readStoredAdminTargetGroup(" https://coordinator.example/// ")).toBe("group-a");
	});

	it("identifies the current coordinator and selected group as the snapshot target", () => {
		state.lastCoordinatorAdminStatus = {
			active_group: "group-a",
			coordinator_url: " https://coordinator.example ",
			readiness: "ready",
		};
		state.lastCoordinatorAdminGroups = [
			{ group_id: "group-a", display_name: "Group A" },
			{ group_id: "group-b", display_name: "Group B" },
		];
		state.coordinatorAdminTargetGroup = "group-b";

		expect(currentAdminSnapshotTarget()).toEqual({
			coordinatorUrl: "https://coordinator.example",
			groupId: "group-b",
		});
		expect(
			adminSnapshotTargetMatchesCurrent({
				coordinatorUrl: "https://coordinator.example",
				groupId: "group-b",
			}),
		).toBe(true);
		expect(
			adminSnapshotTargetMatchesCurrent({
				coordinatorUrl: "https://coordinator.example/",
				groupId: "group-b",
			}),
		).toBe(true);
		expect(
			adminSnapshotTargetMatchesCurrent({
				coordinatorUrl: "https://other.example",
				groupId: "group-b",
			}),
		).toBe(false);
	});

	it("does not treat an unidentified coordinator snapshot as current", () => {
		state.lastCoordinatorAdminStatus = { active_group: "group-a", readiness: "ready" };

		expect(currentAdminSnapshotTarget()).toBeNull();
		expect(adminSnapshotTargetMatchesCurrent(null)).toBe(false);
	});

	it("preserves dirty device rename drafts across refreshes", () => {
		state.lastCoordinatorAdminDevices = [
			{ device_id: "dev-1", display_name: "NAS", group_id: "team-a" },
		];
		reconcileDeviceRenameDrafts();
		coordinatorAdminState.deviceRenameDrafts.set("dev-1", "NAS storage box");

		state.lastCoordinatorAdminDevices = [
			{ device_id: "dev-1", display_name: "NAS", group_id: "team-a" },
		];
		reconcileDeviceRenameDrafts();

		expect(coordinatorAdminState.deviceRenameDrafts.get("dev-1")).toBe("NAS storage box");
	});

	it("updates clean device rename drafts from refreshed server state", () => {
		state.lastCoordinatorAdminDevices = [
			{ device_id: "dev-1", display_name: "NAS", group_id: "team-a" },
		];
		reconcileDeviceRenameDrafts();

		state.lastCoordinatorAdminDevices = [
			{ device_id: "dev-1", display_name: "NAS seed peer", group_id: "team-a" },
		];
		reconcileDeviceRenameDrafts();

		expect(coordinatorAdminState.deviceRenameDrafts.get("dev-1")).toBe("NAS seed peer");
	});

	it("assigns collision-free privacy-safe aliases to unnamed coordinator groups", () => {
		state.lastCoordinatorAdminGroups = [
			{ group_id: "group-zulu", display_name: null, archived_at: null },
			{ group_id: "group-alpha", display_name: "", archived_at: null },
			{ group_id: "group-named", display_name: "Named group", archived_at: null },
			{
				group_id: "group-reserved",
				display_name: "Unnamed coordinator group 1",
				archived_at: null,
			},
		];

		expect(coordinatorGroupPresentationName("group-alpha", "")).toBe("Unnamed coordinator group 2");
		expect(coordinatorGroupPresentationName("group-zulu", null)).toBe(
			"Unnamed coordinator group 3",
		);
		expect(coordinatorGroupPresentationName("group-named", " Named group ")).toBe("Named group");
	});

	it("keeps aliases stable when the available group set changes", () => {
		state.lastCoordinatorAdminGroups = [
			{ group_id: "group-zulu", display_name: null, archived_at: null },
		];
		const originalAlias = coordinatorGroupPresentationName("group-zulu", null);

		state.lastCoordinatorAdminGroups = [
			{ group_id: "group-alpha", display_name: null, archived_at: null },
			{ group_id: "group-zulu", display_name: null, archived_at: null },
		];

		expect(coordinatorGroupPresentationName("group-zulu", null)).toBe(originalAlias);
		expect(coordinatorGroupPresentationName("group-alpha", null)).not.toBe(originalAlias);
	});

	it("reallocates an unnamed alias when a later explicit group name reserves it", () => {
		state.lastCoordinatorAdminGroups = [
			{ group_id: "group-unnamed", display_name: null, archived_at: null },
		];
		expect(coordinatorGroupPresentationName("group-unnamed", null)).toBe(
			"Unnamed coordinator group 1",
		);

		state.lastCoordinatorAdminGroups = [
			{ group_id: "group-unnamed", display_name: null, archived_at: null },
			{
				group_id: "group-named",
				display_name: "Unnamed coordinator group 1",
				archived_at: null,
			},
		];

		expect(coordinatorGroupPresentationName("group-named", "Unnamed coordinator group 1")).toBe(
			"Unnamed coordinator group 1",
		);
		expect(coordinatorGroupPresentationName("group-unnamed", null)).toBe(
			"Unnamed coordinator group 2",
		);
		expect(coordinatorAdminState.groupPresentationAliases.has("group-named")).toBe(false);
	});

	it("assigns a distinct stable alias when the group is absent from the current snapshot", () => {
		const alias = coordinatorGroupPresentationName("group-hidden", null);

		expect(alias).toBe("Unnamed coordinator group 1");
		expect(coordinatorGroupPresentationName("group-hidden", null)).toBe(alias);
	});

	it("keeps unnamed presentation aliases out of rename payload drafts", () => {
		state.lastCoordinatorAdminGroups = [
			{ group_id: "group-alpha", display_name: null, archived_at: null },
		];

		reconcileGroupRenameDrafts();

		expect(coordinatorAdminState.groupRenameDrafts.get("group-alpha")).toBe("");
	});
});
