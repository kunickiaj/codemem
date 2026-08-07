import { describe, expect, it } from "vitest";
import { collectSettingsPayload } from "./collect-payload";
import { EMPTY_FORM_STATE } from "./constants";
import { formStateFromPayload } from "./form-state";
import { formatAuthMethod } from "./format";
import { inferObserverModel, mergeOverrideBaseline } from "./value-helpers";

describe("Codex sidecar settings helpers", () => {
	it("infers the current Codex-sidecar default model", () => {
		expect(inferObserverModel("codex_sidecar", "openai", "")).toEqual({
			model: "gpt-5.1-codex-mini",
			source: "Recommended (local Codex session)",
		});
	});

	it("formats Codex-sidecar authentication status", () => {
		expect(formatAuthMethod("codex_sidecar")).toBe("Local Codex session");
	});

	it("loads the protected Codex command into form state", () => {
		const values = formStateFromPayload({
			effective: {
				observer_runtime: "codex_sidecar",
				codex_command: ["/Applications/ChatGPT.app/Contents/Resources/codex"],
			},
		});

		expect(values.observerRuntime).toBe("codex_sidecar");
		expect(values.codexCommand).toContain("ChatGPT.app/Contents/Resources/codex");
	});

	it("loads and saves shared observer reasoning defaults", () => {
		const values = formStateFromPayload({
			config: {
				observer_reasoning_effort: "low",
				observer_reasoning_summary: "concise",
			},
			effective: {
				observer_reasoning_effort: "medium",
				observer_reasoning_summary: "auto",
			},
		});

		expect(values.observerReasoningEffort).toBe("medium");
		expect(values.observerReasoningSummary).toBe("auto");

		const payload = collectSettingsPayload({
			values: {
				...EMPTY_FORM_STATE,
				observerReasoningEffort: values.observerReasoningEffort,
				observerReasoningSummary: values.observerReasoningSummary,
			},
			touchedKeys: new Set(["observer_reasoning_effort", "observer_reasoning_summary"]),
			baseline: {},
		});

		expect(payload.observer_reasoning_effort).toBe("medium");
		expect(payload.observer_reasoning_summary).toBe("auto");

		expect(
			mergeOverrideBaseline(
				{
					observer_reasoning_effort: "medium",
					observer_reasoning_summary: "auto",
				},
				{
					observer_reasoning_effort: " medium ",
					observer_reasoning_summary: " auto ",
				},
				{
					observer_reasoning_effort: "CODEMEM_OBSERVER_REASONING_EFFORT",
					observer_reasoning_summary: "CODEMEM_OBSERVER_REASONING_SUMMARY",
				},
			),
		).toEqual({
			observer_reasoning_effort: "medium",
			observer_reasoning_summary: "auto",
		});
	});
});
