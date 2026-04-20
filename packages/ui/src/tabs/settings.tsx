/* Settings modal — observer config, sync settings. */

import { render } from "preact";
import * as api from "../lib/api";
import { $, $button } from "../lib/dom";
import { showGlobalNotice } from "../lib/notice";
import { state } from "../lib/state";

import { SettingsDialogShell } from "./settings/components/SettingsDialogShell";
import { SettingsModalContent } from "./settings/components/SettingsModalContent";
import { PROTECTED_VIEWER_CONFIG_KEYS } from "./settings/data/constants";
import { createSettingsEventHandlers } from "./settings/data/event-handlers";
import {
	getObserverModelDescription as getObserverModelDescriptionRaw,
	getObserverModelHint as getObserverModelHintRaw,
	getObserverModelLabel as getObserverModelLabelRaw,
	getObserverModelTooltip as getObserverModelTooltipRaw,
	getTieredRoutingHelperText as getTieredRoutingHelperTextRaw,
	hiddenUnlessAdvanced as hiddenUnlessAdvancedRaw,
	isProtectedConfigKey as isProtectedConfigKeyRaw,
	protectedConfigHelp,
} from "./settings/data/model-accessors";
import { settingsState } from "./settings/data/state";
import type { SettingsPanelProps } from "./settings/data/types";
import { mergeOverrideBaseline, toProviderList } from "./settings/data/value-helpers";

const getObserverModelHint = (): string =>
	getObserverModelHintRaw(settingsState.renderState.values, settingsState.envOverrides);
const getTieredRoutingHelperText = (): string =>
	getTieredRoutingHelperTextRaw(settingsState.renderState.values);
const getObserverModelLabel = (): string =>
	getObserverModelLabelRaw(settingsState.renderState.values);
const getObserverModelTooltip = (): string =>
	getObserverModelTooltipRaw(settingsState.renderState.values);
const getObserverModelDescription = (): string =>
	getObserverModelDescriptionRaw(settingsState.renderState.values);

import {
	hideHelpTooltip,
	onAdvancedToggle,
	setDirty,
	setSettingsTab,
	updateFormState,
	updateRenderState,
} from "./settings/data/state-ops";

function renderSettingsShell() {
	const mount = $("settingsDialogMount");
	if (!mount) return;
	render(<SettingsDialogShellBound />, mount);
	// Lucide icon replacement happens in the shell's open-state effect — the
	// Dialog renders children only while open, so createIcons() here would
	// no-op against the unmounted tree.
}

function ensureSettingsShell() {
	const mount = $("settingsDialogMount");
	if (!mount) return;
	if (settingsState.shellMounted) return;
	renderSettingsShell();
	settingsState.shellMounted = true;
}

function SettingsDialogShellBound() {
	return <SettingsDialogShell DialogContent={SettingsDialogContent} onClose={closeSettings} />;
}

export function isSettingsOpen(): boolean {
	return settingsState.open;
}

import { buildSettingsNotice } from "./settings/data/notice";

const isProtectedConfigKey = (key: string): boolean =>
	isProtectedConfigKeyRaw(key, settingsState.protectedKeys, PROTECTED_VIEWER_CONFIG_KEYS);

import { type ConfigPayload, formStateFromPayload } from "./settings/data/form-state";

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
		effectiveText:
			Object.keys(envOverrides).length > 0
				? "Some fields are managed by environment settings."
				: "",
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

import { collectSettingsPayload as collectSettingsPayloadRaw } from "./settings/data/collect-payload";
import { diffSettingsPayload } from "./settings/data/diff-payload";

function collectSettingsPayload(
	options: { allowUntouchedParseErrors?: boolean } = {},
): Record<string, unknown> {
	return collectSettingsPayloadRaw({
		values: settingsState.renderState.values,
		touchedKeys: settingsState.touchedKeys,
		baseline: settingsState.baseline,
		allowUntouchedParseErrors: options.allowUntouchedParseErrors,
	});
}

export function openSettings(stopPolling: () => void) {
	if (!settingsState.shellMounted) {
		ensureSettingsShell();
	}
	settingsState.open = true;
	settingsState.previouslyFocused = document.activeElement as HTMLElement | null;
	stopPolling();
	settingsState.controller?.setOpen(true);
}

export function closeSettings(startPolling: () => void, refreshCallback: () => void) {
	if (state.settingsDirty) {
		if (!globalThis.confirm("Discard unsaved changes?")) {
			settingsState.controller?.setOpen(true);
			return;
		}
	}
	settingsState.open = false;
	settingsState.controller?.setOpen(false);
	hideHelpTooltip();
	const restoreTarget =
		settingsState.previouslyFocused && typeof settingsState.previouslyFocused.focus === "function"
			? settingsState.previouslyFocused
			: $button("settingsButton");
	restoreTarget?.focus();
	settingsState.previouslyFocused = null;
	settingsState.touchedKeys = new Set<string>();
	startPolling();
	refreshCallback();
}

export async function saveSettings(startPolling: () => void, refreshCallback: () => void) {
	if (settingsState.renderState.isSaving) return;
	updateRenderState({ isSaving: true, statusText: "Saving changes…" });

	try {
		const current = collectSettingsPayload({ allowUntouchedParseErrors: true });
		const changed = diffSettingsPayload({
			current,
			baseline: settingsState.baseline,
			envOverrides: settingsState.envOverrides,
			touchedKeys: settingsState.touchedKeys,
			isProtected: isProtectedConfigKey,
		});
		if (Object.keys(changed).length === 0) {
			updateRenderState({ isSaving: false, statusText: "No unsaved changes" });
			setDirty(false);
			closeSettings(startPolling, refreshCallback);
			return;
		}

		const result = await api.saveConfig(changed);
		const notice = buildSettingsNotice(result);
		updateRenderState({ isSaving: false, statusText: "Saved changes" });
		setDirty(false);
		closeSettings(startPolling, refreshCallback);
		showGlobalNotice(notice.message, notice.type);
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown error";
		updateRenderState({ isSaving: false, statusText: `Save failed: ${message}` });
	}
}

function renderObserverStatusBanner(status: unknown) {
	updateRenderState({
		observerStatus:
			status && typeof status === "object" ? (status as Record<string, unknown>) : null,
	});
}

export async function loadConfigData() {
	if (settingsState.open) return;
	try {
		const [payload, status] = await Promise.all([
			api.loadConfig(),
			api.loadObserverStatus().catch(() => null),
		]);
		renderConfigModal(payload);
		renderObserverStatusBanner(status);
	} catch {}
}

const { onTextInput, onSelectValueChange, onSwitchInput } = createSettingsEventHandlers({
	getTouchedKeys: () => settingsState.touchedKeys,
	getValues: () => settingsState.renderState.values,
	updateFormState,
	setDirty: (dirty) => setDirty(dirty),
});

const hiddenUnlessAdvanced = (): boolean => hiddenUnlessAdvancedRaw(settingsState.showAdvanced);

import {
	ObserverStatusBanner as ObserverStatusBannerComponent,
	type ObserverStatusShape,
} from "./settings/components/ObserverStatusBanner";

function ObserverStatusBanner() {
	const status = settingsState.renderState.observerStatus as ObserverStatusShape | null;
	return <ObserverStatusBannerComponent status={status} />;
}

function SettingsDialogContent() {
	const values = settingsState.renderState.values;
	const observerMaxCharsDefault = String(state.configDefaults?.observer_max_chars || "");
	const showAuthFile = values.observerAuthSource === "file";
	const showAuthCommand = values.observerAuthSource === "command";
	const showTieredRouting = values.observerTierRoutingEnabled;
	const providerOptions = Array.from(
		new Set(
			settingsState.renderState.providers.concat(
				values.observerProvider ? [values.observerProvider] : [],
			),
		),
	)
		.sort((left, right) => left.localeCompare(right))
		.map((provider) => ({ label: provider, value: provider }));

	const panelProps: SettingsPanelProps = {
		values,
		observerMaxCharsDefault,
		providerOptions,
		showAuthFile,
		showAuthCommand,
		showTieredRouting,
		hiddenUnlessAdvanced,
		onTextInput,
		onSelectValueChange,
		onSwitchInput,
		getObserverModelLabel,
		getObserverModelTooltip,
		getObserverModelDescription,
		getObserverModelHint,
		getTieredRoutingHelperText,
		protectedConfigHelp,
	};

	return (
		<SettingsModalContent
			panelProps={panelProps}
			activeTab={settingsState.activeTab}
			showAdvanced={settingsState.showAdvanced}
			renderState={settingsState.renderState}
			settingsDirty={state.settingsDirty}
			onClose={() => {
				if (settingsState.startPolling && settingsState.refresh) {
					closeSettings(settingsState.startPolling, settingsState.refresh);
				}
			}}
			onSave={() => {
				if (settingsState.startPolling && settingsState.refresh) {
					void saveSettings(settingsState.startPolling, settingsState.refresh);
				}
			}}
			onActiveTabChange={setSettingsTab}
			onAdvancedToggle={onAdvancedToggle}
			observerStatusBannerSlot={<ObserverStatusBanner />}
		/>
	);
}

export function initSettings(
	stopPolling: () => void,
	startPolling: () => void,
	refreshCallback: () => void,
) {
	settingsState.startPolling = startPolling;
	settingsState.refresh = refreshCallback;
	ensureSettingsShell();

	const settingsButton = $button("settingsButton");
	settingsButton?.addEventListener("click", () => openSettings(stopPolling));
}
