import { afterEach, expect, it } from "vitest";
import { collectSettingsPayload, renderConfigModal } from "../data/config-loader";
import { diffSettingsPayload } from "../data/diff-payload";
import { settingsState, settingsView } from "../data/state";
import { updateFormState } from "../data/state-ops";
import { settingsOutcomeFor } from "./SettingsOutcome";

afterEach(() => {
	settingsState.resolvedObserverRuntime = null;
	settingsState.observerRuntimeByAuthSource = {};
	settingsState.envOverrides = {};
	settingsState.touchedKeys.clear();
});

function editAuthSource(source: string) {
	settingsState.touchedKeys.add("observer_auth_source");
	updateFormState({ observerAuthSource: source });
}

function changedSettings() {
	return diffSettingsPayload({
		current: collectSettingsPayload({ allowUntouchedParseErrors: true }),
		baseline: settingsState.baseline,
		envOverrides: settingsState.envOverrides,
		touchedKeys: settingsState.touchedKeys,
		isProtected: () => false,
	});
}

it("previews auto Codex to command API and back without persisting an automatic runtime", () => {
	renderConfigModal({
		config: {},
		resolved_observer_runtime: "codex_sidecar",
		observer_runtime_by_auth_source: { auto: "codex_sidecar", command: "api_http" },
	});
	editAuthSource("command");
	expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("model requests");
	expect(settingsOutcomeFor("observerAuthTimeoutMs")?.scope).not.toBe("No current effect");
	expect(settingsOutcomeFor("observerRichReasoningEffort")?.scope).toContain("Responses");
	expect(changedSettings()).toEqual({ observer_auth_source: "command" });
	settingsState.touchedKeys.add("observer_runtime");
	updateFormState({ observerRuntime: "api_http" });
	updateFormState({ observerRuntime: "codex_sidecar" });
	expect(changedSettings()).toEqual({ observer_auth_source: "command" });
	expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("model requests");
	editAuthSource("auto");
	expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("No effect");
	expect(changedSettings()).toEqual({});
	settingsState.touchedKeys.add("observer_provider");
	updateFormState({ observerProvider: "anthropic" });
	expect(changedSettings()).toEqual({ observer_provider: "anthropic" });
});

it("previews restoring auto from saved command authentication", () => {
	renderConfigModal({
		config: { observer_auth_source: "command" },
		resolved_observer_runtime: "api_http",
		observer_runtime_by_auth_source: { auto: "codex_sidecar", command: "api_http" },
	});
	editAuthSource("auto");
	expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("No effect");
	expect(changedSettings()).toEqual({ observer_auth_source: "auto" });
	editAuthSource("command");
	expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("model requests");
});

it("keeps an explicit runtime draft ahead of automatic auth previews", () => {
	renderConfigModal({
		config: {},
		resolved_observer_runtime: "api_http",
		observer_runtime_by_auth_source: { command: "api_http" },
	});
	settingsState.touchedKeys.add("observer_runtime");
	updateFormState({ observerRuntime: "claude_sidecar" });
	editAuthSource("command");
	expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("No effect");
	expect(changedSettings()).toEqual({
		observer_runtime: "claude_sidecar",
		observer_auth_source: "command",
	});
});

it("uses server preview under an empty runtime env override despite a runtime draft", () => {
	renderConfigModal({
		config: {},
		resolved_observer_runtime: "codex_sidecar",
		observer_runtime_by_auth_source: { command: "api_http" },
		env_overrides: { observer_runtime: "CODEMEM_OBSERVER_RUNTIME" },
	});
	settingsState.touchedKeys.add("observer_runtime");
	updateFormState({ observerRuntime: "claude_sidecar" });
	editAuthSource("command");
	expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("model requests");
});

it("keeps environment-managed authentication ahead of its draft", () => {
	renderConfigModal({
		config: {},
		effective: { observer_auth_source: "command" },
		resolved_observer_runtime: "api_http",
		observer_runtime_by_auth_source: { auto: "api_http", command: "api_http" },
		env_overrides: { observer_auth_source: "CODEMEM_OBSERVER_AUTH_SOURCE" },
	});
	editAuthSource("auto");
	expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("model requests");
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
