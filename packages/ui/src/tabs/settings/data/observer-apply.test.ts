import { expect, it } from "vitest";
import { collectSettingsPayload, renderConfigModal } from "./config-loader";
import { diffSettingsPayload } from "./diff-payload";
import { createSettingsEventHandlers } from "./event-handlers";
import type { ObserverApplyPayload } from "./form-state";
import { reconcileObserverRouting, updateObserverApply } from "./observer-apply";
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

it("does not save stale routing when a connection draft is reverted after refresh", () => {
	renderConfigModal({ config: {}, observer_apply: { state: "applying" } });
	settingsState.touchedKeys.add("observer_provider");
	updateFormState({ observerProvider: "anthropic" });
	updateObserverApply({ observer_apply: active });
	updateFormState({ observerProvider: "" });
	expect(pendingChanges()).not.toHaveProperty("observer_tier_routing_enabled");
});

it.each([false, true])(
	"reconciles cached active routing %s after reverting a connection draft",
	(routing) => {
		renderConfigModal({
			config: {},
			effective: { observer_tier_routing_enabled: !routing },
			observer_apply: { state: "applying" },
		});
		const events = createSettingsEventHandlers({
			getTouchedKeys: () => settingsState.touchedKeys,
			getValues: () => settingsView.value.renderState.values,
			updateFormState,
			setDirty: () => {},
			onValuesChanged: reconcileObserverRouting,
		});
		events.updateField("observerProvider", "anthropic");
		updateObserverApply({
			observer_apply: { ...active, active: { ...active.active, tierRoutingEnabled: routing } },
		});
		expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(!routing);
		events.updateField("observerProvider", "");
		expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(routing);
		expect(pendingChanges()).not.toHaveProperty("observer_tier_routing_enabled");
		events.updateField("observerModel", "new-model");
		expect(pendingChanges().observer_tier_routing_enabled).toBe(routing);
	},
);

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

it("keeps explicit routing and other connection drafts during edit reconciliation", () => {
	renderConfigModal({ config: {}, observer_apply: { state: "applying" } });
	const events = createSettingsEventHandlers({
		getTouchedKeys: () => settingsState.touchedKeys,
		getValues: () => settingsView.value.renderState.values,
		updateFormState,
		setDirty: () => {},
		onValuesChanged: reconcileObserverRouting,
	});
	events.updateField("observerProvider", "anthropic");
	events.updateField("observerModel", "draft-model");
	updateObserverApply({ observer_apply: active });
	events.updateField("observerProvider", "");
	expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(false);
	events.updateField("observerTierRoutingEnabled", false);
	events.updateField("observerModel", "");
	expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(false);
	expect(pendingChanges().observer_tier_routing_enabled).toBe(false);
});

it.each(["applying", "failed"])("does not adopt stale active routing while %s", (state) => {
	renderConfigModal({ config: {} });
	updateObserverApply({ observer_apply: { ...active, state } });
	expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(false);
});
