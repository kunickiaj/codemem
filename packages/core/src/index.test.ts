import { describe, expect, it } from "vitest";
import { VERSION } from "./index.js";

describe("core", () => {
	it("exports a version string", () => {
		expect(VERSION).toBe("0.20.0-alpha.2");
	});
});
