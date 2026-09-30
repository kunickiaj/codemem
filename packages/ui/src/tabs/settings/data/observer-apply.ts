import type { ObserverApplyPayload } from "./form-state";
import { settingsState } from "./state";
import { updateFormState, updateRenderState } from "./state-ops";

export function updateObserverApply(payload: unknown): void {
	if (!payload || typeof payload !== "object") return;
	const apply = (payload as { observer_apply?: ObserverApplyPayload }).observer_apply;
	if (!apply || !["active", "applying", "failed"].includes(apply.state)) return;
	settingsState.observerApply = apply;
	const routing = apply.active?.tierRoutingEnabled;
	if (
		apply.state !== "active" ||
		typeof routing !== "boolean" ||
		settingsState.observerTierRoutingExplicit
	) {
		updateRenderState({});
		return;
	}
	settingsState.baseline.observer_tier_routing_enabled = routing;
	if (settingsState.touchedKeys.has("observer_tier_routing_enabled")) {
		updateRenderState({});
		return;
	}
	updateFormState({ observerTierRoutingEnabled: routing });
}
