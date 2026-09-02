import { describe, expect, it } from "vitest";
import {
	humanGroupLabelAlias,
	safeLabel,
	setupLabelForbiddenIds,
} from "./legacy-team-setup-label-policy.js";

describe("legacy Team setup label policy", () => {
	it.each(["api.example.invalid", "ssh-ed25519 secret", "safe/name", "api\u202E.example"])(
		"redacts unsafe label %s",
		(value) => {
			expect(safeLabel(value, "Fallback", new Set())).toBe("Fallback");
		},
	);

	it("checks forbidden identifiers beyond the emitted label boundary", () => {
		const value = `${"A".repeat(130)} private-id`;
		expect(safeLabel(value, "Fallback", new Set(["private-id"]))).toBe("Fallback");
	});

	it("allows a proven human group alias in presentation labels", () => {
		const alias = humanGroupLabelAlias("api", "API");
		const forbidden = setupLabelForbiddenIds([], "api", alias, [], [], [], []);
		expect(safeLabel("API", "Legacy Team", forbidden)).toBe("API");
		expect(safeLabel("API laptop", "Device", forbidden)).toBe("API laptop");
	});

	it.each(["a", "group-1", "thisgroupnameislongerthantwentyfour"])(
		"does not treat opaque group ID %s as a human alias",
		(groupId) => {
			expect(humanGroupLabelAlias(groupId, groupId)).toBeNull();
		},
	);
});
