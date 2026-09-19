import { describe, expect, it } from "vitest";
import { describeEffectiveSettings } from "./config-loader";

describe("describeEffectiveSettings", () => {
	it("describes configuration-resolved values without claiming they match runtime resolution", () => {
		expect(describeEffectiveSettings({ observer_model: "fixture" }, false)).toBe(
			"Fields show configuration-resolved values. Runtime behavior may apply automatic provider defaults. Restart-dependent changes are labeled below.",
		);
		expect(describeEffectiveSettings({ observer_model: "fixture" }, true)).toContain(
			"Environment settings supply some fields",
		);
	});

	it("gives a recovery step instead of presenting configured values as effective", () => {
		const message = describeEffectiveSettings(undefined, false);

		expect(message).toContain("Effective values are unavailable");
		expect(message).toContain("Reload Settings");
		expect(message).toContain("restart the viewer");
	});
});
