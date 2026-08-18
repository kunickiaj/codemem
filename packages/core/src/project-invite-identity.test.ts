import { describe, expect, it } from "vitest";
import {
	humanPresentationLabel,
	MACHINE_PRESENTATION_LABEL_FIXTURES,
} from "../../ui/src/lib/identity-presentation.js";
import {
	friendlyDeviceName,
	isHumanPresentationName,
	normalizeHumanPresentationName,
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
		expect(friendlyDeviceName({ osName: "e67fda8c4b44", fallbackSeed: "e67fda8c4b44" })).toBe(
			"Codemem device e67fda",
		);
		expect(
			friendlyDeviceName({
				osName: "0ea043cc-c61c-427d-8b77-572331b9855c",
				fallbackSeed: "abcd-1234",
			}),
		).toBe("Codemem device abcd12");
		expect(friendlyDeviceName({ osName: "device_abc123def", fallbackSeed: "abcd-1234" })).toBe(
			"Codemem device abcd12",
		);
		expect(friendlyDeviceName({ explicitName: "x".repeat(121), fallbackSeed: "abcd-1234" })).toBe(
			"Codemem device abcd12",
		);
		expect(
			friendlyDeviceName({ explicitName: "Travel\u200bLaptop", fallbackSeed: "abcd-1234" }),
		).toBe("Codemem device abcd12");
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

	it.each([
		"local:a57f7c7c-d531-4148-9917-78acb586caad",
		"a57f7c7c-d531-4148-9917-78acb586caad",
		"identity:S5gx0LqXsmllifW-1XvXiLfZ",
		"actor_a57f7c7c",
		"e67fda8c4b44",
	])("rejects machine-shaped human presentation name %s", (value) => {
		expect(isHumanPresentationName(value)).toBe(false);
		expect(() => normalizeHumanPresentationName(value, "recipient_display_name")).toThrow(
			"recipient_display_name_invalid",
		);
	});

	it.each(
		MACHINE_PRESENTATION_LABEL_FIXTURES,
	)("keeps core and browser presentation classifiers aligned for %s", (value) => {
		expect(isHumanPresentationName(value)).toBe(false);
		expect(humanPresentationLabel(value)).toBe("");
	});

	it("normalizes human actor and device presentation names", () => {
		expect(normalizeHumanPresentationName("  Brian   Example  ", "recipient_display_name")).toBe(
			"Brian Example",
		);
		expect(normalizeHumanPresentationName("Brian's MacBook", "device_display_name")).toBe(
			"Brian's MacBook",
		);
	});

	it("retains only safe project summaries", () => {
		expect(
			normalizeProjectInviteSummaries([{ display_name: "codemem", existing_memory_count: 3 }]),
		).toEqual([{ display_name: "codemem", existing_memory_count: 3 }]);
		expect(() =>
			normalizeProjectInviteSummaries([{ display_name: "codemem", existing_memory_count: -1 }]),
		).toThrow("project_summaries_invalid");
		expect(
			normalizeProjectInviteSummaries([{ display_name: "e67fda8c4b44", existing_memory_count: 0 }]),
		).toEqual([{ display_name: "e67fda8c4b44", existing_memory_count: 0 }]);
	});
});
