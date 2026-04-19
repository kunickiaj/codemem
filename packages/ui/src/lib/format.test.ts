import { describe, expect, it } from "vitest";

import { collapseHome, formatBytes, formatTokenCount } from "./format";

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
		// Keep readable unit boundaries instead of surfacing awkward values like 1000K.
		expect(formatTokenCount(999_950)).toBe("1M tokens");
		expect(formatTokenCount(999_950_000)).toBe("1B tokens");
	});
});

describe("collapseHome", () => {
	it("replaces macOS user home with ~", () => {
		expect(collapseHome("/Users/adam/workspace/codemem")).toBe("~/workspace/codemem");
	});
	it("replaces Linux user home with ~", () => {
		expect(collapseHome("/home/adam/projects/db.sqlite")).toBe("~/projects/db.sqlite");
	});
	it("replaces Windows user home with ~", () => {
		expect(collapseHome("C:\\Users\\adam\\codemem\\mem.sqlite")).toBe("~\\codemem\\mem.sqlite");
	});
	it("leaves non-home paths alone", () => {
		expect(collapseHome("/var/run/codemem.sock")).toBe("/var/run/codemem.sock");
	});
	it("treats bare home dir as ~", () => {
		expect(collapseHome("/Users/adam")).toBe("~");
	});
	it("returns empty string for nullish input", () => {
		expect(collapseHome(null)).toBe("");
		expect(collapseHome(undefined)).toBe("");
	});
});

describe("formatBytes", () => {
	it("shows raw bytes under 1024", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(0)).toBe("0 B");
	});
	it("scales through KB / MB / GB / TB", () => {
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
		expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5 GB");
		expect(formatBytes(3 * 1024 ** 4)).toBe("3 TB");
	});
	it("rounds to integer once the scaled value crosses 10", () => {
		expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
	});
	it("returns n/a for invalid input", () => {
		expect(formatBytes("not a number")).toBe("n/a");
		expect(formatBytes(-5)).toBe("n/a");
	});
});
