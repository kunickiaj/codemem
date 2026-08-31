import { describe, expect, it } from "vitest";
import { planBlockedFocus, planLoadFocus, planStepFocus } from "./legacy-team-setup-focus";

describe("legacy Team setup focus planning", () => {
	it("targets step headings for explicit navigation", () => {
		expect(planStepFocus(1, "projects")).toEqual({
			id: 1,
			targetId: "legacy-team-setup-step-projects",
		});
	});

	it("targets the first unresolved row when navigation is blocked", () => {
		expect(planBlockedFocus(2, "devices", 3)).toEqual({
			id: 2,
			targetId: "legacy-team-device-row-3",
		});
	});

	it("falls back to the blocked step heading when no unresolved row is found", () => {
		expect(planBlockedFocus(3, "projects", -1)).toEqual({
			id: 3,
			targetId: "legacy-team-setup-step-projects",
		});
	});

	it("targets the visible recovery control", () => {
		expect(planLoadFocus(3, { hasError: true, recovery: true, step: "devices" })).toEqual({
			id: 3,
			targetId: "legacy-team-setup-retry",
		});
		expect(planLoadFocus(4, { hasError: true, step: "devices" })).toEqual({
			id: 4,
			targetId: "legacy-team-setup-retry",
		});
	});
});
