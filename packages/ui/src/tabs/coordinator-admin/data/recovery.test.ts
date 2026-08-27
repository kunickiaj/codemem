import { describe, expect, it } from "vitest";

import {
	beginSurfaceRefresh,
	completeSurfaceRefresh,
	coordinatorAdminRecoveryNotice,
	failSurfaceRefresh,
	initialCoordinatorAdminRecovery,
	markSurfaceNotApplicable,
	surfacesAreFresh,
} from "./recovery";

describe("coordinator administration recovery copy", () => {
	it("reports stale and unavailable surfaces without backend errors or identifiers", () => {
		const recovery = initialCoordinatorAdminRecovery();
		completeSurfaceRefresh(recovery, "groups");
		beginSurfaceRefresh(recovery, "groups");
		failSurfaceRefresh(recovery, "groups");
		beginSurfaceRefresh(recovery, "devices");
		failSurfaceRefresh(recovery, "devices");

		const notice = coordinatorAdminRecoveryNotice(recovery);

		expect(notice).toEqual({
			stale: ["coordinator groups"],
			unavailable: ["devices"],
			retrying: false,
		});
		expect(JSON.stringify(notice)).not.toContain("group-a");
		expect(JSON.stringify(notice)).not.toContain("secret");
	});

	it("does not treat refreshing or not-applicable surfaces as mutation-fresh", () => {
		const recovery = initialCoordinatorAdminRecovery();
		completeSurfaceRefresh(recovery, "status");
		expect(surfacesAreFresh(recovery, "status")).toBe(true);

		beginSurfaceRefresh(recovery, "status");
		expect(surfacesAreFresh(recovery, "status")).toBe(false);

		markSurfaceNotApplicable(recovery, "status");
		expect(surfacesAreFresh(recovery, "status")).toBe(false);
		expect(coordinatorAdminRecoveryNotice(recovery)).toBeNull();
	});
});
