import { describe, expect, it } from "vitest";

import { formatTokenCount } from "./format";

describe("formatTokenCount", () => {
	it("keeps small values fully written out", () => {
		expect(formatTokenCount(842)).toBe("842 tokens");
	});

	it("abbreviates thousands and millions with readable suffixes", () => {
		expect(formatTokenCount(842_000)).toBe("842K tokens");
		expect(formatTokenCount(2_106_527)).toBe("2.1M tokens");
	});

	it("abbreviates billions without falling back to raw comma groups", () => {
		expect(formatTokenCount(2_106_527_459)).toBe("2.1B tokens");
	});

	it("promotes rounded counts into the next suffix tier", () => {
		expect(formatTokenCount(999_950)).toBe("1M tokens");
		expect(formatTokenCount(999_950_000)).toBe("1B tokens");
	});
});
