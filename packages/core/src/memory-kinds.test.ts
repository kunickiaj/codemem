import { describe, expect, it } from "vitest";
import {
	ALLOWED_MEMORY_KINDS,
	MEMORY_KIND_DESCRIPTIONS,
	REMEMBER_MEMORY_KINDS,
	validateMemoryKind,
} from "./memory-kinds.js";

describe("memory kind catalog", () => {
	it("defines exactly the seven remember kinds", () => {
		expect(Object.keys(MEMORY_KIND_DESCRIPTIONS)).toEqual([
			"discovery",
			"change",
			"feature",
			"bugfix",
			"refactor",
			"decision",
			"exploration",
		]);
		expect(REMEMBER_MEMORY_KINDS).toEqual(Object.keys(MEMORY_KIND_DESCRIPTIONS));
	});

	it("keeps session_summary out of the remember kinds but in the allowed set", () => {
		expect(REMEMBER_MEMORY_KINDS).not.toContain("session_summary");
		expect(Object.keys(MEMORY_KIND_DESCRIPTIONS)).not.toContain("session_summary");
		expect(ALLOWED_MEMORY_KINDS.has("session_summary")).toBe(true);
		expect(ALLOWED_MEMORY_KINDS.size).toBe(REMEMBER_MEMORY_KINDS.length + 1);
	});

	it("validateMemoryKind accepts session_summary and the remember kinds", () => {
		expect(validateMemoryKind("session_summary")).toBe("session_summary");
		expect(validateMemoryKind(" Decision ")).toBe("decision");
	});

	it("validateMemoryKind rejects unknown kinds", () => {
		expect(() => validateMemoryKind("not-a-kind")).toThrow(/Invalid memory kind/);
	});
});
