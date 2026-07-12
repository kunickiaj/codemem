import { describe, expect, it } from "vitest";
import { formStateFromPayload } from "./form-state";
import { formatAuthMethod } from "./format";
import { inferObserverModel } from "./value-helpers";

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
});
