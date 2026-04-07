import { describe, expect, it } from "vitest";
import {
	getInjectionEvalScenarioPack,
	getInjectionEvalScenarioPrompts,
	INJECTION_EVAL_SCENARIO_PACKS,
} from "./eval-scenarios.js";

describe("injection eval scenarios", () => {
	it("exposes the expected built-in scenario packs", () => {
		expect(INJECTION_EVAL_SCENARIO_PACKS.map((pack) => pack.id)).toEqual([
			"track3-core",
			"track3-explicit-recap",
		]);
	});

	it("looks up scenario packs case-insensitively", () => {
		expect(getInjectionEvalScenarioPack("TRACK3-CORE")?.id).toBe("track3-core");
	});

	it("expands scenario prompts without duplicates", () => {
		const prompts = getInjectionEvalScenarioPrompts(["track3-core", "track3-explicit-recap"]);
		expect(prompts).toContain("memory retrieval issues");
		expect(prompts).toContain("summary of oauth");
		expect(new Set(prompts).size).toBe(prompts.length);
	});
});
