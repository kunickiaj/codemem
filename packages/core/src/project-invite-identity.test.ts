import { describe, expect, it } from "vitest";
import {
	friendlyDeviceName,
	normalizeIdentityDisplayName,
	normalizeProjectInviteSummaries,
} from "./project-invite-identity.js";

describe("project invite identity", () => {
	it("uses the approved friendly device-name precedence", () => {
		expect(
			friendlyDeviceName({
				explicitName: "Codemem laptop",
				osName: "host-name.local",
				coordinatorName: "Coordinator name",
				fallbackSeed: "abcd-1234",
			}),
		).toBe("Codemem laptop");
		expect(friendlyDeviceName({ osName: "host-name.local", coordinatorName: "Remote" })).toBe(
			"host name",
		);
		expect(friendlyDeviceName({ coordinatorName: "Remote" })).toBe("Remote");
		expect(friendlyDeviceName({ fallbackSeed: "abcd-1234" })).toBe("Codemem device abcd12");
	});

	it("rejects empty, overlong, and control-character identity labels", () => {
		expect(() => normalizeIdentityDisplayName(" ", "recipient_display_name")).toThrow(
			"recipient_display_name_required",
		);
		expect(() => normalizeIdentityDisplayName("x".repeat(121), "recipient_display_name")).toThrow(
			"recipient_display_name_too_long",
		);
		expect(() => normalizeIdentityDisplayName("Brian\u0000", "recipient_display_name")).toThrow(
			"recipient_display_name_invalid",
		);
	});

	it("retains only safe project summaries", () => {
		expect(
			normalizeProjectInviteSummaries([{ display_name: "codemem", existing_memory_count: 3 }]),
		).toEqual([{ display_name: "codemem", existing_memory_count: 3 }]);
		expect(() =>
			normalizeProjectInviteSummaries([{ display_name: "codemem", existing_memory_count: -1 }]),
		).toThrow("project_summaries_invalid");
	});
});
