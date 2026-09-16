import { describe, expect, it } from "vitest";
import { normalizeProjectLabel } from "./project-label.js";

describe("normalizeProjectLabel", () => {
	it.each([
		[" project ", "project"],
		["/work/project/", "project"],
		["C:\\work\\project\\", "project"],
		["", null],
		[42, null],
	])("normalizes %j to %j", (input, expected) => {
		expect(normalizeProjectLabel(input)).toBe(expected);
	});
});
