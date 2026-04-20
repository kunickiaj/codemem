/* Pure accessors for the Observer tab's dynamic labels, tooltips, and
 * descriptions. Take the form values + environment overrides as input
 * so the extracted panel can call them without module-state access. */

import type { SettingsFormState } from "./types";
import { hasOwn, inferObserverModel, normalizeTextValue } from "./value-helpers";

export function getObserverModelHint(
	values: SettingsFormState,
	envOverrides: Record<string, unknown>,
): string {
	if (values.observerTierRoutingEnabled) {
		return "Tiered routing is enabled: simple/rich model selection now lives in Processing.";
	}
	const inferred = inferObserverModel(
		values.observerRuntime.trim() || "api_http",
		values.observerProvider.trim(),
		normalizeTextValue(values.observerModel),
	);
	const overrideActive = ["observer_model", "observer_provider", "observer_runtime"].some((key) =>
		hasOwn(envOverrides, key),
	);
	const source = overrideActive ? "Env override" : inferred.source;
	return `${source}: ${inferred.model}`;
}

export function getTieredRoutingHelperText(values: SettingsFormState): string {
	if (!values.observerTierRoutingEnabled) {
		return "Off: codemem uses the base observer settings from the Connection tab for all batches.";
	}
	return "On: codemem can route simpler batches to a lighter model and richer batches to a higher-quality configuration.";
}

export function getObserverModelLabel(values: SettingsFormState): string {
	return values.observerTierRoutingEnabled ? "Base model fallback" : "Model";
}

export function getObserverModelTooltip(values: SettingsFormState): string {
	return values.observerTierRoutingEnabled
		? "Tiered routing is enabled, so Processing controls the simple/rich models. This base model is only a fallback."
		: "Leave blank to use a recommended model for your selected mode/provider.";
}

export function getObserverModelDescription(values: SettingsFormState): string {
	return values.observerTierRoutingEnabled
		? "Tiered routing is active. Use this only as a fallback while the Processing tab owns simple/rich model selection."
		: "Default: `gpt-5.1-codex-mini` for Direct API; `claude-4.5-haiku` for Local Claude session.";
}

export function hiddenUnlessAdvanced(showAdvanced: boolean): boolean {
	return !showAdvanced;
}

export function isProtectedConfigKey(
	key: string,
	protectedKeys: Set<string>,
	viewerProtectedKeys: Set<string>,
): boolean {
	return protectedKeys.has(key) || viewerProtectedKeys.has(key);
}

export function protectedConfigHelp(key: string): string {
	return `${key} is read-only in the viewer for security. Edit the config file or environment instead.`;
}
