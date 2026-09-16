/* Synchronous reads and narrow mutations for the settings view signal. */

import { settingsState, settingsView } from "./state";
import type {
	SettingsFormState,
	SettingsRenderState,
	SettingsTabId,
	SettingsViewState,
} from "./types";
import { persistAdvancedPreference } from "./value-helpers";

export function getSettingsViewState(): SettingsViewState {
	return settingsView.value;
}

function updateSettingsView(patch: Partial<SettingsViewState>) {
	settingsView.value = { ...settingsView.value, ...patch };
}

export function hideHelpTooltip() {
	settingsState.hideTooltip?.();
}

export function updateRenderState(patch: Partial<SettingsRenderState>) {
	updateSettingsView({ renderState: { ...settingsView.value.renderState, ...patch } });
}

export function updateFormState(patch: Partial<SettingsFormState>) {
	updateRenderState({
		values: {
			...settingsView.value.renderState.values,
			...patch,
		},
	});
}

export function setSettingsTab(tab: string) {
	const nextTab: SettingsTabId = ["observer", "queue", "sync"].includes(tab)
		? (tab as SettingsTabId)
		: "observer";
	updateSettingsView({ activeTab: nextTab });
}

export function setDirty(dirty: boolean) {
	updateSettingsView({ dirty });
}

export function setSettingsOpen(open: boolean) {
	updateSettingsView({ open });
}

export function onAdvancedToggle(checked: boolean) {
	persistAdvancedPreference(checked);
	updateSettingsView({ showAdvanced: checked });
}
