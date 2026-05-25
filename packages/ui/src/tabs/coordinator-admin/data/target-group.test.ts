import { beforeEach, describe, expect, it } from "vitest";

import { state } from "../../../lib/state";
import { coordinatorAdminState } from "./state";
import { reconcileDeviceRenameDrafts } from "./target-group";

describe("coordinator admin target group helpers", () => {
	beforeEach(() => {
		state.lastCoordinatorAdminDevices = [];
		coordinatorAdminState.deviceRenameDrafts.clear();
		coordinatorAdminState.deviceRenameServerNames.clear();
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
});
