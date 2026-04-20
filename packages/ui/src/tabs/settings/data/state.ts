/* Shared module state for the Settings modal — all mutable vars live
 * on a single exported object so any file in the split can read and
 * write them without running into ES-module `export let` reassignment
 * limits (imports of `let` bindings are read-only from other modules). */

import { EMPTY_FORM_STATE } from "./constants";
import type { SettingsController, SettingsRenderState } from "./types";
import { loadAdvancedPreference } from "./value-helpers";

export interface SettingsState {
	open: boolean;
	previouslyFocused: HTMLElement | null;
	activeTab: string;
	baseline: Record<string, unknown>;
	envOverrides: Record<string, unknown>;
	touchedKeys: Set<string>;
	shellMounted: boolean;
	protectedKeys: Set<string>;
	startPolling: (() => void) | null;
	refresh: (() => void) | null;
	showAdvanced: boolean;
	controller: SettingsController | null;
	renderState: SettingsRenderState;
}

export const settingsState: SettingsState = {
	open: false,
	previouslyFocused: null,
	activeTab: "observer",
	baseline: {},
	envOverrides: {},
	touchedKeys: new Set<string>(),
	shellMounted: false,
	protectedKeys: new Set<string>(),
	startPolling: null,
	refresh: null,
	showAdvanced: loadAdvancedPreference(),
	controller: null,
	renderState: {
		effectiveText: "",
		isSaving: false,
		observerStatus: null,
		overridesVisible: false,
		pathText: "Config path: n/a",
		providers: [],
		statusText: "Ready",
		values: { ...EMPTY_FORM_STATE },
	},
};
