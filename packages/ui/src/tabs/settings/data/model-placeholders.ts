import type { ObserverModelDefaults } from "./form-state";
import type { SettingsFormState } from "./types";

export function modelPlaceholder(
	values: SettingsFormState,
	defaults: ObserverModelDefaults | undefined,
	tier?: "simple" | "rich",
	tierProvider?: string,
): string {
	if (!defaults) return "";
	if (values.observerRuntime === "claude_sidecar") {
		if (tier) return defaults[tier].anthropic ?? defaults.claude;
		return defaults.claude;
	}
	if (values.observerRuntime === "codex_sidecar") {
		if (!tier) return defaults.codex;
		return values.observerModel.trim() || defaults[tier].openai || defaults.codex;
	}
	const provider = placeholderProvider(values, defaults);
	if (tier) {
		return tierPlaceholder(values, defaults, tier, provider, tierProvider);
	}
	return defaults.base[provider] ?? "";
}

function tierPlaceholder(
	values: SettingsFormState,
	defaults: ObserverModelDefaults,
	tier: "simple" | "rich",
	provider: string,
	tierProvider?: string,
): string {
	const override = tierProvider?.trim().toLowerCase();
	const knownProvider = defaults[tier][override ?? ""] ? override : provider;
	return (
		defaults[tier][knownProvider ?? ""] ||
		values.observerModel.trim() ||
		defaults.base[override || provider] ||
		""
	);
}

function placeholderProvider(values: SettingsFormState, defaults: ObserverModelDefaults): string {
	const provider = values.observerProvider.trim().toLowerCase();
	if (provider) return provider;
	const model = values.observerModel.trim().toLowerCase();
	const prefix = model.split("/")[0] ?? "";
	if (Object.hasOwn(defaults.base, prefix)) return prefix;
	return model.startsWith("claude") ? "anthropic" : "openai";
}
