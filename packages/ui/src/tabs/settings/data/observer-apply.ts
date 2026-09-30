import type { ObserverApplyPayload } from "./form-state";
import { settingsState, settingsView } from "./state";
import { updateFormState, updateRenderState } from "./state-ops";
import { normalizeTextValue } from "./value-helpers";

function hasConnectionDraft(): boolean {
	const fields = [
		["observer_runtime", "observerRuntime"],
		["observer_provider", "observerProvider"],
		["observer_model", "observerModel"],
		["observer_auth_source", "observerAuthSource"],
	] as const;
	return fields.some(
		([key, id]) =>
			settingsState.touchedKeys.has(key) &&
			normalizeTextValue(settingsView.value.renderState.values[id]) !== settingsState.baseline[key],
	);
}

export function updateObserverApply(payload: unknown): void {
	if (!payload || typeof payload !== "object") return;
	const apply = (payload as { observer_apply?: ObserverApplyPayload }).observer_apply;
	if (!apply || !["active", "applying", "failed"].includes(apply.state)) return;
	settingsState.observerApply = apply;
	const routing = apply.active?.tierRoutingEnabled;
	if (
		apply.state !== "active" ||
		typeof routing !== "boolean" ||
		settingsState.observerTierRoutingExplicit ||
		settingsState.touchedKeys.has("observer_tier_routing_enabled")
	) {
		updateRenderState({});
		return;
	}
	const draftConnection = hasConnectionDraft();
	if (draftConnection) {
		updateRenderState({});
		return;
	}
	settingsState.baseline.observer_tier_routing_enabled = routing;
	updateFormState({ observerTierRoutingEnabled: routing });
}
