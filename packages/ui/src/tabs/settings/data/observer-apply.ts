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
	const draftConnection = [
		"observer_runtime",
		"observer_provider",
		"observer_model",
		"observer_auth_source",
		"observer_tier_routing_enabled",
	].some((key) => settingsState.touchedKeys.has(key));
	if (draftConnection) {
		updateRenderState({});
		return;
	}
	updateFormState({ observerTierRoutingEnabled: routing });
}
