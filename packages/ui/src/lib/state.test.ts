import { describe, expect, it } from "vitest";

import {
	type CachedCoordinatorAdminStatus,
	getVisibleTabs,
	resolveAccessibleTab,
	shouldShowCoordinatorAdminTab,
} from "./state";

describe("Coordinator Admin tab gating", () => {
	it("keeps the tab visible while admin status is still unknown", () => {
		expect(shouldShowCoordinatorAdminTab(null)).toBe(true);
		expect(getVisibleTabs(null)).toContain("coordinator-admin");
	});

	it("hides the tab when the admin secret is missing", () => {
		const status: CachedCoordinatorAdminStatus = {
			has_admin_secret: false,
			readiness: "partial",
		};

		expect(shouldShowCoordinatorAdminTab(status)).toBe(false);
		expect(getVisibleTabs(status)).not.toContain("coordinator-admin");
	});

	it("keeps the tab visible when the admin secret is configured", () => {
		const status: CachedCoordinatorAdminStatus = {
			has_admin_secret: true,
			readiness: "ready",
		};

		expect(shouldShowCoordinatorAdminTab(status)).toBe(true);
		expect(getVisibleTabs(status)).toContain("coordinator-admin");
	});

	it("falls back to sync when the current tab becomes inaccessible", () => {
		const status: CachedCoordinatorAdminStatus = {
			has_admin_secret: false,
			readiness: "partial",
		};

		expect(resolveAccessibleTab("coordinator-admin", status)).toBe("sync");
		expect(resolveAccessibleTab("feed", status)).toBe("feed");
	});
});
