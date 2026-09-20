import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_FORM_STATE } from "../data/constants";
import { settingsState, settingsView } from "../data/state";
import { settingsOutcomeFor } from "./SettingsOutcome";

function values(update: Partial<typeof EMPTY_FORM_STATE>) {
	settingsView.value = {
		...settingsView.value,
		renderState: { ...settingsView.value.renderState, values: { ...EMPTY_FORM_STATE, ...update } },
	};
}
afterEach(() => {
	settingsState.envOverrides = {};
	settingsState.effectiveConfig = {};
	values({});
});

describe("effective Settings outcomes", () => {
	it.each(["claude_sidecar", "codex_sidecar"])(
		"uses effective %s despite a draft API runtime",
		(runtime) => {
			values({ observerRuntime: "api_http" });
			settingsState.envOverrides = { observer_runtime: "CODEMEM_OBSERVER_RUNTIME" };
			settingsState.effectiveConfig = { observer_runtime: runtime };
			expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("No effect");
			expect(settingsOutcomeFor("observerProvider")?.scope).toBe("No current effect");
			expect(settingsOutcomeFor("observerRichReasoningEffort")?.scope).toBe("No current effect");
		},
	);
	it("does not use a draft sidecar when API runtime is overridden", () => {
		values({ observerRuntime: "claude_sidecar" });
		settingsState.envOverrides = { observer_runtime: "CODEMEM_OBSERVER_RUNTIME" };
		settingsState.effectiveConfig = { observer_runtime: "api_http" };
		expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("model requests");
	});
	it("marks base model inactive behind tier defaults", () => {
		values({ observerProvider: "openai", observerTierRoutingEnabled: true });
		expect(settingsOutcomeFor("observerModel")?.scope).toBe("No current effect");
	});
	it("qualifies transport-dependent tuning", () => {
		values({ observerProvider: "anthropic" });
		expect(settingsOutcomeFor("observerSimpleTemperature")?.scope).toBe("No current effect");
		expect(settingsOutcomeFor("observerRichReasoningSummary")?.scope).toContain("Responses");
	});
	it("qualifies authentication controls by source", () => {
		values({ observerAuthSource: "env" });
		expect(settingsOutcomeFor("observerAuthTimeoutMs")?.scope).toBe("No current effect");
		values({ observerAuthSource: "auto" });
		expect(settingsOutcomeFor("observerAuthCacheTtlS")?.scope).toBe("No current effect");
	});
	it("describes disabled sync, advertisement, and immediate pairing address changes", () => {
		values({ syncEnabled: false });
		expect(settingsOutcomeFor("syncEnabled")?.existingData).toContain("does not retract");
		expect(settingsOutcomeFor("syncMdns")?.scope).toContain("Advertise");
		expect(settingsOutcomeFor("syncPort")?.timing).toContain("restart the viewer before sharing");
	});
});
