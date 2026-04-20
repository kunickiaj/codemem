/* Settings modal — public API surface. Implementation lives under
 * ./settings/ (data/ for pure state/reducers, components/ for each
 * React component, hooks/ for shared hooks, lifecycle.tsx for the
 * mount + open/close/save orchestration). */

export {
	collectSettingsPayload,
	isProtectedConfigKey,
	isSettingsOpen,
	loadConfigData,
	renderConfigModal,
} from "./settings/data/config-loader";
export {
	closeSettings,
	initSettings,
	openSettings,
	saveSettings,
} from "./settings/lifecycle";
