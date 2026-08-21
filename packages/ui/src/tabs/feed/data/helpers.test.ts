import { beforeEach, describe, expect, it } from "vitest";
import { MACHINE_PRESENTATION_LABEL_FIXTURES } from "../../../lib/identity-presentation";
import { state } from "../../../lib/state";
import { authorLabel, deviceLabel, itemTags } from "./helpers";

beforeEach(() => {
	state.lastStatsPayload = null;
});

describe("itemTags", () => {
	it("uses persisted tags_text when the legacy tags field is absent", () => {
		expect(itemTags({ tags_text: "release-hotfix searchable-tag" })).toEqual([
			"release-hotfix",
			"searchable-tag",
		]);
	});

	it("prefers an explicit tags field when both shapes are present", () => {
		expect(itemTags({ tags: ["legacy"], tags_text: "persisted" })).toEqual(["legacy"]);
	});
});

describe("Feed identity labels", () => {
	it("prefers resolved actor and device labels", () => {
		const item = {
			actor_id: "local:0ea043cc-c61c-427d-8b77-572331b9855c",
			origin_device_id: "0ea043cc-c61c-427d-8b77-572331b9855c",
			resolved_actor_display_name: "Ada Lovelace",
			resolved_device_display_name: "Ada's MacBook",
		};

		expect(authorLabel(item)).toBe("Ada Lovelace");
		expect(deviceLabel(item)).toBe("Device Ada's MacBook");
	});

	it("uses neutral labels for unresolved legacy provenance", () => {
		const item = {
			actor_display_name: "local:0ea043cc-c61c-427d-8b77-572331b9855c",
			actor_id: "local:0ea043cc-c61c-427d-8b77-572331b9855c",
			origin_device_id: "0ea043cc-c61c-427d-8b77-572331b9855c",
			resolved_actor_display_name: "local:0ea043cc-c61c-427d-8b77-572331b9855c",
			resolved_device_display_name: "0ea043cc-c61c-427d-8b77-572331b9855c",
		};

		expect(authorLabel(item)).toBe("Teammate");
		expect(deviceLabel(item)).toBe("Shared device");
	});

	it.each(
		MACHINE_PRESENTATION_LABEL_FIXTURES,
	)("never promotes machine-shaped label %s", (value) => {
		expect(authorLabel({ actor_id: "remote-actor", resolved_actor_display_name: value })).toBe(
			"Teammate",
		);
		expect(
			deviceLabel({ origin_device_id: "remote-device", resolved_device_display_name: value }),
		).toBe("Shared device");
	});

	it("uses unknown author when no actor provenance exists", () => {
		expect(authorLabel({})).toBe("Unknown author");
	});
});
