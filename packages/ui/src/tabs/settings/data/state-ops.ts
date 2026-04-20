/* State mutation helpers that dispatch through `settingsState.controller`
 * when the React shell is mounted, or update `settingsState` directly
 * when it is not. All of these read/write `settingsState` — they live
 * here rather than in settings.tsx so the lifecycle module, the modal
 * shell, and future slices can share them without a circular import. */

import { state } from "../../../lib/state";
import { settingsState } from "./state";
import type { SettingsFormState, SettingsRenderState, SettingsTabId } from "./types";

export function hideHelpTooltip() {
	settingsState.controller?.hideTooltip();
}

export function updateRenderState(patch: Partial<SettingsRenderState>) {
	if (settingsState.controller) {
		settingsState.controller.setRenderState(patch);
		return;
	}
	settingsState.renderState = {
		...settingsState.renderState,
		...patch,
	};
}

export function updateFormState(patch: Partial<SettingsFormState>) {
	updateRenderState({
		values: {
			...settingsState.renderState.values,
			...patch,
		},
	});
}

export function setSettingsTab(tab: string) {
	const nextTab: SettingsTabId = ["observer", "queue", "sync"].includes(tab)
		? (tab as SettingsTabId)
		: "observer";
	settingsState.activeTab = nextTab;
	settingsState.controller?.setActiveTab(nextTab);
}

export function setDirty(dirty: boolean, rerender = true) {
	state.settingsDirty = dirty;
	if (rerender) settingsState.controller?.setDirty(dirty);
}

export function onAdvancedToggle(checked: boolean) {
	settingsState.showAdvanced = checked;
	settingsState.controller?.setShowAdvanced(checked);
}
