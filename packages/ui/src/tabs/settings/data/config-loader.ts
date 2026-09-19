/* Config load/render lifecycle — fetches /settings from the viewer
 * backend, normalizes the payload into SettingsFormState, and pushes
 * the result into settingsState + the Preact shell. */

import * as api from "../../../lib/api";
import type { ReadRequestOptions } from "../../../lib/read-request";
import { state } from "../../../lib/state";
import { collectSettingsPayload as collectSettingsPayloadRaw } from "./collect-payload";
import { PROTECTED_VIEWER_CONFIG_KEYS } from "./constants";
import { type ConfigPayload, formStateFromPayload } from "./form-state";
import { isProtectedConfigKey as isProtectedConfigKeyRaw } from "./model-accessors";
import { settingsState } from "./state";
import { getSettingsViewState, setDirty, updateRenderState } from "./state-ops";
import { mergeOverrideBaseline, toProviderList } from "./value-helpers";

export function isSettingsOpen(): boolean {
	return getSettingsViewState().open;
}

export function isProtectedConfigKey(key: string): boolean {
	return isProtectedConfigKeyRaw(key, settingsState.protectedKeys, PROTECTED_VIEWER_CONFIG_KEYS);
}

export function collectSettingsPayload(
	options: { allowUntouchedParseErrors?: boolean } = {},
): Record<string, unknown> {
	return collectSettingsPayloadRaw({
		values: getSettingsViewState().renderState.values,
		touchedKeys: settingsState.touchedKeys,
		baseline: settingsState.baseline,
		allowUntouchedParseErrors: options.allowUntouchedParseErrors,
	});
}

export function renderObserverStatusBanner(status: unknown) {
	updateRenderState({
		observerStatus:
			status && typeof status === "object" ? (status as Record<string, unknown>) : null,
	});
}

export function describeEffectiveSettings(
	effective: ConfigPayload["effective"],
	hasEnvironmentOverrides: boolean,
): string {
	const hasEffectiveValues =
		effective && typeof effective === "object" && Object.keys(effective).length > 0;
	if (!hasEffectiveValues) {
		return "Effective values are unavailable. Reload Settings; if this persists, restart the viewer and inspect its configuration.";
	}
	if (hasEnvironmentOverrides) {
		return "Fields show configuration-resolved values. Runtime behavior may apply automatic provider defaults. Environment settings supply some fields.";
	}
	return "Fields show configuration-resolved values. Runtime behavior may apply automatic provider defaults. Restart-dependent changes are labeled below.";
}

export function renderConfigModal(payload: unknown) {
	if (!payload || typeof payload !== "object") return;
	const data = payload as ConfigPayload;
	const defaults = data.defaults || {};
	const config = data.config || {};
	const envOverrides =
		data.env_overrides && typeof data.env_overrides === "object" ? data.env_overrides : {};
	const protectedKeys = Array.isArray(data.protected_keys)
		? data.protected_keys.filter(
				(value): value is string => typeof value === "string" && value.trim().length > 0,
			)
		: [];
	const values = formStateFromPayload(data);

	settingsState.envOverrides = envOverrides;
	settingsState.protectedKeys = new Set(protectedKeys);
	state.configDefaults = defaults;
	state.configPath = data.path || "";

	updateRenderState({
		effectiveText: describeEffectiveSettings(data.effective, Object.keys(envOverrides).length > 0),
		overridesVisible: Object.keys(envOverrides).length > 0,
		pathText: state.configPath ? `Config path: ${state.configPath}` : "Config path: n/a",
		providers: toProviderList(data.providers),
		statusText: "No unsaved changes",
		values,
	});

	settingsState.touchedKeys = new Set<string>();
	try {
		const baseline = collectSettingsPayload({ allowUntouchedParseErrors: true });
		settingsState.baseline = mergeOverrideBaseline(baseline, config, envOverrides);
	} catch {
		settingsState.baseline = {};
	}

	setDirty(false);
}

export async function loadConfigData(options: ReadRequestOptions = {}) {
	if (getSettingsViewState().open) return;
	try {
		const [payload, status] = await Promise.all([
			api.loadConfig(options),
			api.loadObserverStatus(options).catch(() => null),
		]);
		if (options.signal?.aborted) return;
		renderConfigModal(payload);
		renderObserverStatusBanner(status);
	} catch {}
}
