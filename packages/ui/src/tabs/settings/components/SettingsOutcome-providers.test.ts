import { afterEach, describe, expect, it } from "vitest";
import { renderConfigModal } from "../data/config-loader";
import { settingsState } from "../data/state";
import { settingsOutcomeFor } from "./SettingsOutcome";

afterEach(() => {
	settingsState.envOverrides = {};
	settingsState.effectiveConfig = {};
	settingsState.resolvedObserverRuntime = null;
	settingsState.observerRuntimeByAuthSource = {};
	settingsState.touchedKeys.clear();
});

describe.each(["simple", "rich"] as const)("effective %s tier provider", (tier) => {
	it.each([
		["openai", " AnThRoPiC ", true, true],
		["anthropic", " OPENAI ", false, true],
		["anthropic", "", true, true],
		["anthropic", "   ", true, true],
		["anthropic", "custom", true, true],
		["opencode", "anthropic", true, true],
		["opencode", "openai", false, true],
		["opencode", "custom", false, false],
		["opencode", "", false, false],
	] as const)(
		"base %s with env tier %j matches transport and fallback",
		(base, provider, inactiveTemperature, overridesBase) => {
			const otherTier = tier === "simple" ? "rich" : "simple";
			const key = `observer_${tier}_provider`;
			renderConfigModal({
				config: {
					observer_provider: base,
					[key]: "openai",
					observer_tier_routing_enabled: true,
					[`observer_${otherTier}_model`]: "explicit-other-tier",
				},
				effective: { [key]: provider },
				env_overrides: { [key]: `CODEMEM_OBSERVER_${tier.toUpperCase()}_PROVIDER` },
				resolved_observer_runtime: "api_http",
			});
			const control = tier === "simple" ? "observerSimpleTemperature" : "observerRichTemperature";
			expect(settingsOutcomeFor(control)?.scope === "No current effect").toBe(inactiveTemperature);
			expect(settingsOutcomeFor("observerModel")?.scope === "No current effect").toBe(
				overridesBase,
			);
		},
	);
});
