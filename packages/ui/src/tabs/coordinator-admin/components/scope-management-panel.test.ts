import { describe, expect, it } from "vitest";
import { safeSpaceOperationError } from "./scope-management-panel";

describe("legacy Space operation errors", () => {
	it.each([
		["Group is archived", "Restore this legacy coordinator group before changing Space access."],
		[
			"group_not_found: private-group-id",
			"This legacy coordinator group no longer exists. Refresh Advanced administration.",
		],
		[
			"scope_not_found: private-scope-id",
			"This Space no longer exists. Refresh legacy Spaces before retrying.",
		],
		[
			"device_not_enrolled_for_scope_group: private-device-id",
			"This device is no longer enrolled in the legacy coordinator group. Refresh devices before retrying.",
		],
		["scope_not_active", "Restore this legacy Space before changing its access."],
		[
			"membership_not_found",
			"This device no longer has access to the Space. Refresh legacy Spaces.",
		],
		[
			"scopeId already exists.: private-scope-id",
			"A Space already uses that ID. Choose a different Space ID or refresh legacy Spaces. Sharing policy is unchanged.",
		],
	] as const)("maps %s to safe actionable guidance", (message, expected) => {
		expect(safeSpaceOperationError(new Error(message), "recovery fallback")).toBe(expected);
		expect(safeSpaceOperationError(new Error(message), "recovery fallback")).not.toContain(
			"private-",
		);
	});

	it("keeps the recovery fallback for unknown failures", () => {
		expect(
			safeSpaceOperationError(new Error("private coordinator detail"), "recovery fallback"),
		).toBe("recovery fallback");
		expect(safeSpaceOperationError("group_archived", "recovery fallback")).toBe(
			"recovery fallback",
		);
	});
});
