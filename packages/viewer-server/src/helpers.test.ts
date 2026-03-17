import { describe, expect, it } from "vitest";
import { queryInt } from "./helpers.js";

describe("queryInt", () => {
	it("parses full integer strings", () => {
		expect(queryInt("10", 25)).toBe(10);
		expect(queryInt("  -7  ", 25)).toBe(-7);
	});

	it("rejects partial or non-integer strings", () => {
		expect(queryInt("10abc", 25)).toBe(25);
		expect(queryInt("1.0", 25)).toBe(25);
		expect(queryInt("1e2", 25)).toBe(25);
		expect(queryInt("", 25)).toBe(25);
	});
});
