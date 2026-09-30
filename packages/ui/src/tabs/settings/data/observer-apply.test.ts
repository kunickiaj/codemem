import { expect, it } from "vitest";
import { collectSettingsPayload, renderConfigModal } from "./config-loader";
import { diffSettingsPayload } from "./diff-payload";
import type { ObserverApplyPayload } from "./form-state";
import { updateObserverApply } from "./observer-apply";
import { settingsState, settingsView } from "./state";
import { updateFormState } from "./state-ops";

const active: ObserverApplyPayload = {
	state: "active",
	active: {
		provider: "openai",
		model: "model",
		runtime: "api_http",
		authType: "oauth",
		tierRoutingEnabled: true,
	},
};

function pendingChanges() {
	return diffSettingsPayload({
		current: collectSettingsPayload(),
		baseline: settingsState.baseline,
		envOverrides: settingsState.envOverrides,
		touchedKeys: settingsState.touchedKeys,
		isProtected: () => false,
	});
}

it("refreshes implicit routing and its baseline after apply completes", () => {
	renderConfigModal({
		config: {},
		effective: { observer_tier_routing_enabled: false },
		observer_apply: { ...active, state: "applying" },
	});
	expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(false);
	updateObserverApply({ observer_apply: active });
	expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(true);
	expect(pendingChanges()).not.toHaveProperty("observer_tier_routing_enabled");
	settingsState.touchedKeys.add("observer_provider");
	updateFormState({ observerProvider: "anthropic" });
	expect(pendingChanges().observer_tier_routing_enabled).toBe(true);
});

it.each([false, true])(
	"persists explicit routing %s even when active routing matches",
	(routing) => {
		renderConfigModal({ config: {}, observer_apply: { state: "applying" } });
		settingsState.touchedKeys.add("observer_tier_routing_enabled");
		updateFormState({ observerTierRoutingEnabled: routing });
		updateObserverApply({ observer_apply: active });
		expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(routing);
		expect(pendingChanges().observer_tier_routing_enabled).toBe(routing);
	},
);

it("preserves draft connection routing when the saved observer finishes applying", () => {
	renderConfigModal({ config: {}, observer_apply: { state: "applying" } });
	settingsState.touchedKeys.add("observer_runtime");
	updateFormState({ observerRuntime: "codex_sidecar" });
	updateObserverApply({ observer_apply: active });
	expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(false);
	expect(pendingChanges().observer_tier_routing_enabled).toBe(false);
});

it("adopts active routing after a provider edit is reverted", () => {
	renderConfigModal({ config: {}, observer_apply: { state: "applying" } });
	settingsState.touchedKeys.add("observer_provider");
	updateFormState({ observerProvider: "anthropic" });
	updateFormState({ observerProvider: "" });
	updateObserverApply({ observer_apply: active });
	expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(true);
	expect(pendingChanges()).not.toHaveProperty("observer_tier_routing_enabled");
});

it.each([
	{ config: { observer_tier_routing_enabled: false } },
	{
		config: {},
		effective: { observer_tier_routing_enabled: false },
		env_overrides: { observer_tier_routing_enabled: "CODEMEM_OBSERVER_TIER_ROUTING_ENABLED" },
	},
])("preserves configured and environment-controlled routing", (payload) => {
	renderConfigModal(payload);
	updateObserverApply({ observer_apply: active });
	expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(false);
});

it.each(["applying", "failed"])("does not adopt stale active routing while %s", (state) => {
	renderConfigModal({ config: {} });
	updateObserverApply({ observer_apply: { ...active, state } });
	expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(false);
});
