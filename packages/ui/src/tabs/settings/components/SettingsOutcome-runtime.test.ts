import { afterEach, expect, it } from "vitest";
import { collectSettingsPayload, renderConfigModal } from "../data/config-loader";
import { settingsState, settingsView } from "../data/state";
import { settingsOutcomeFor } from "./SettingsOutcome";

afterEach(() => {
	settingsState.resolvedObserverRuntime = null;
	settingsState.envOverrides = {};
	settingsState.touchedKeys.clear();
});

it.each(["claude_sidecar", "codex_sidecar"])(
	"loads automatic %s into controls and outcomes",
	(runtime) => {
		renderConfigModal({
			config: {},
			effective: { observer_runtime: "api_http" },
			resolved_observer_runtime: runtime,
		});
		expect(settingsView.value.renderState.values.observerRuntime).toBe(runtime);
		expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("No effect");
		expect(settingsOutcomeFor("observerProvider")?.scope).toBe("No current effect");
		expect(settingsOutcomeFor("observerRichReasoningEffort")?.scope).toBe("No current effect");
		expect(collectSettingsPayload({ allowUntouchedParseErrors: true }).observer_runtime).toBe(
			settingsState.baseline.observer_runtime,
		);
		settingsState.touchedKeys.add("observer_runtime");
		settingsView.value = {
			...settingsView.value,
			renderState: {
				...settingsView.value.renderState,
				values: { ...settingsView.value.renderState.values, observerRuntime: "api_http" },
			},
		};
		expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("model requests");
		expect(collectSettingsPayload({ allowUntouchedParseErrors: true }).observer_runtime).toBe(
			"api_http",
		);
	},
);

it.each([
	[" CLAUDE_SIDECAR ", "claude_sidecar", true],
	[" CoDeX_SiDeCaR ", "codex_sidecar", true],
	["invalid", "api_http", false],
	["   ", "api_http", false],
	["", "claude_sidecar", true],
] as const)(
	"uses resolved environment runtime %j despite draft edits",
	(raw, resolved, sidecar) => {
		renderConfigModal({
			config: {},
			effective: { observer_runtime: raw },
			resolved_observer_runtime: resolved,
			env_overrides: { observer_runtime: "CODEMEM_OBSERVER_RUNTIME" },
		});
		settingsState.touchedKeys.add("observer_runtime");
		const draft = sidecar ? "api_http" : "claude_sidecar";
		expect(
			settingsOutcomeFor("observerAuthSource", { observerRuntime: draft })?.scope.includes(
				"No effect",
			),
		).toBe(sidecar);
	},
);

it("keeps an explicit API runtime active and allows a sidecar draft", () => {
	renderConfigModal({
		config: { observer_runtime: "api_http" },
		resolved_observer_runtime: "api_http",
	});
	expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("model requests");
	settingsState.touchedKeys.add("observer_runtime");
	expect(
		settingsOutcomeFor("observerAuthSource", { observerRuntime: "claude_sidecar" })?.scope,
	).toContain("No effect");
});
