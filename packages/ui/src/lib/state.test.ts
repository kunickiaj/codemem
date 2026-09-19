import { beforeEach, describe, expect, it } from "vitest";

import {
	ALL_TAB_IDS,
	type CachedCoordinatorAdminStatus,
	FEED_VIEW_MODE_KEY,
	getActiveAdvancedSection,
	getActiveTab,
	getPreferredFeedViewMode,
	getVisibleTabs,
	initState,
	isCoordinatorAdministrationRoute,
	parseAdvancedSectionFromHash,
	parseTabFromHash,
	resolveAccessibleTab,
	setActiveTab,
	setAdvancedSection,
	setPreferredFeedViewMode,
	shouldShowCoordinatorAdminTab,
	state,
} from "./state";

describe("Viewer tab routing", () => {
	beforeEach(() => {
		localStorage.clear();
		window.location.hash = "";
	});

	it("orders canonical tabs around the promoted project workflow", () => {
		expect(ALL_TAB_IDS).toEqual(["feed", "projects", "sharing", "devices", "health", "advanced"]);
	});

	it("clears the retired persisted pairing disclosure", () => {
		localStorage.setItem("codemem-sync-pairing", "1");
		state.syncPairingOpen = true;

		initState();

		expect(state.syncPairingOpen).toBe(false);
		expect(localStorage.getItem("codemem-sync-pairing")).toBeNull();
	});

	it.each(["feed", "projects", "sharing", "devices", "health", "advanced"])(
		"recognizes #%s as a canonical route",
		(tab) => {
			expect(parseTabFromHash(`#${tab}`)).toBe(tab);
		},
	);

	it.each([
		["#sync", "sync"],
		["#sync/diagnostics", "sync"],
		["#coordinator-admin", "teams"],
		["#advanced/sync/diagnostics", "sync"],
		["#advanced/teams", "teams"],
	] as const)("maps compatibility route %s into Advanced %s content", (hash, section) => {
		expect(parseTabFromHash(hash)).toBe("advanced");
		expect(parseAdvancedSectionFromHash(hash)).toBe(section);
	});

	it.each([
		["#coordinator-admin", null],
		["#advanced/teams/administration", null],
		["", "coordinator-admin"],
	] as const)("recognizes administration route %s with saved tab %s", (hash, savedTab) => {
		expect(isCoordinatorAdministrationRoute(hash, savedTab)).toBe(true);
	});

	it("does not let a saved legacy tab override an explicit route", () => {
		expect(isCoordinatorAdministrationRoute("#feed", "coordinator-admin")).toBe(false);
	});

	it("falls back to feed for an unknown hash", () => {
		window.location.hash = "unknown";
		expect(getActiveTab()).toBe("feed");
	});

	it.each([
		["sync", "sync"],
		["coordinator-admin", "teams"],
	] as const)("migrates saved %s state into Advanced %s", (saved, section) => {
		localStorage.setItem("codemem-tab", saved);
		expect(getActiveTab()).toBe("advanced");
		expect(getActiveAdvancedSection()).toBe(section);
	});

	it("writes canonical hashes for new navigation clicks", () => {
		window.location.hash = "sync";
		setActiveTab("advanced", { canonicalHash: true });

		expect(window.location.hash).toBe("#advanced");
		expect(localStorage.getItem("codemem-tab")).toBe("advanced");
	});

	it("writes canonical Advanced section hashes", () => {
		setAdvancedSection("teams", true);

		expect(window.location.hash).toBe("#advanced/teams");
		expect(localStorage.getItem("codemem-advanced-section")).toBe("teams");
	});

	it("preserves a saved legacy Team destination while canonicalizing its hash", () => {
		setAdvancedSection("teams");
		setActiveTab("coordinator-admin");

		expect(window.location.hash).toBe("#advanced/teams");
		expect(localStorage.getItem("codemem-tab")).toBe("advanced");
	});
});

describe("Advanced access and Team admin gating", () => {
	it("keeps Advanced visible while admin status is still unknown", () => {
		expect(shouldShowCoordinatorAdminTab(null)).toBe(true);
		expect(getVisibleTabs(null)).toContain("advanced");
	});

	it("keeps Advanced reachable when the Team admin secret is missing", () => {
		const status: CachedCoordinatorAdminStatus = {
			has_admin_secret: false,
			readiness: "partial",
		};

		expect(shouldShowCoordinatorAdminTab(status)).toBe(false);
		expect(getVisibleTabs(status)).toContain("advanced");
		expect(resolveAccessibleTab("coordinator-admin", status)).toBe("advanced");
	});

	it("keeps Advanced visible when the Team admin secret is configured", () => {
		const status: CachedCoordinatorAdminStatus = {
			has_admin_secret: true,
			readiness: "ready",
		};

		expect(shouldShowCoordinatorAdminTab(status)).toBe(true);
		expect(getVisibleTabs(status)).toContain("advanced");
	});

	it("keeps canonical tabs accessible and uses feed as the fallback", () => {
		const status: CachedCoordinatorAdminStatus = {
			has_admin_secret: false,
			readiness: "partial",
		};

		expect(resolveAccessibleTab("coordinator-admin", status)).toBe("advanced");
		expect(resolveAccessibleTab("sharing", status)).toBe("sharing");
		expect(resolveAccessibleTab("feed", status)).toBe("feed");
	});
});

describe("Feed view preference", () => {
	it("persists one versioned global mode and rejects unknown stored values", () => {
		localStorage.clear();
		setPreferredFeedViewMode("narrative");
		expect(localStorage.getItem(FEED_VIEW_MODE_KEY)).toBe("narrative");
		expect(getPreferredFeedViewMode()).toBe("narrative");
		expect(state.preferredFeedViewMode).toBe("narrative");

		localStorage.setItem(FEED_VIEW_MODE_KEY, "obsolete-mode");
		expect(getPreferredFeedViewMode()).toBe("summary");
	});
});
