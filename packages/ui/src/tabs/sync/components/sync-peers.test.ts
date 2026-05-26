import { describe, expect, it } from "vitest";
import { canManageSpacesInTeams } from "./sync-peers";

describe("canManageSpacesInTeams", () => {
	it("allows the Teams management action only for ready coordinator admin devices", () => {
		expect(canManageSpacesInTeams({ has_admin_secret: true, readiness: "ready" })).toBe(true);
	});

	it("blocks the Teams management action when admin capability is absent", () => {
		expect(canManageSpacesInTeams({ has_admin_secret: false, readiness: "ready" })).toBe(false);
		expect(canManageSpacesInTeams({ has_admin_secret: true, readiness: "partial" })).toBe(false);
		expect(canManageSpacesInTeams(null)).toBe(false);
	});
});
