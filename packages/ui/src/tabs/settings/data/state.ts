/* Non-render lifecycle metadata plus the authoritative reactive view state
 * for the Settings modal. */

import { signal } from "@preact/signals";
import { EMPTY_FORM_STATE } from "./constants";
import type { SettingsViewState } from "./types";
import { loadAdvancedPreference } from "./value-helpers";

export interface SettingsState {
	previouslyFocused: HTMLElement | null;
	baseline: Record<string, unknown>;
	effectiveConfig: Record<string, unknown>;
	resolvedObserverRuntime: string | null;
	observerRuntimeByAuthSource: Record<string, string>;
	envOverrides: Record<string, unknown>;
	touchedKeys: Set<string>;
	shellMounted: boolean;
	protectedKeys: Set<string>;
	startPolling: (() => void) | null;
	refresh: (() => void) | null;
	hideTooltip: (() => void) | null;
}

export const settingsState: SettingsState = {
	previouslyFocused: null,
	baseline: {},
	effectiveConfig: {},
	resolvedObserverRuntime: null,
	observerRuntimeByAuthSource: {},
	envOverrides: {},
	touchedKeys: new Set<string>(),
	shellMounted: false,
	protectedKeys: new Set<string>(),
	startPolling: null,
	refresh: null,
	hideTooltip: null,
};

export const settingsView = signal<SettingsViewState>({
	open: false,
	activeTab: "observer",
	dirty: false,
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
	showAdvanced: loadAdvancedPreference(),
});
