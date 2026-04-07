import { describe, expect, it } from "vitest";
import { canonicalMemoryKind, isSummaryLikeMemory } from "./summary-memory.js";

describe("summary memory normalization", () => {
	it("treats legacy summary metadata rows as summary memories", () => {
		expect(isSummaryLikeMemory({ kind: "change", metadata: { is_summary: true } })).toBe(true);
		expect(canonicalMemoryKind("change", { is_summary: true })).toBe("session_summary");
	});

	it("treats observer_summary source rows as summary memories", () => {
		expect(isSummaryLikeMemory({ kind: "change", metadata: { source: "observer_summary" } })).toBe(
			true,
		);
		expect(canonicalMemoryKind("change", { source: "observer_summary" })).toBe("session_summary");
	});

	it("leaves ordinary non-summary memories alone", () => {
		expect(isSummaryLikeMemory({ kind: "change", metadata: { source: "observer" } })).toBe(false);
		expect(canonicalMemoryKind("change", { source: "observer" })).toBe("change");
	});
});
