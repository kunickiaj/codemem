/* Settings modal lifecycle — mounts the Preact dialog shell, wires
 * the public open/close/save/init API, and binds the SettingsDialogShell
 * to SettingsDialogContent + the settingsState-driven handlers. */

import { render } from "preact";
import * as api from "../../lib/api";
import { $, $button } from "../../lib/dom";
import { showGlobalNotice } from "../../lib/notice";
import { state } from "../../lib/state";
import type { ObserverStatusShape } from "./components/ObserverStatusBanner";
import { ObserverStatusBanner as ObserverStatusBannerComponent } from "./components/ObserverStatusBanner";
import { SettingsDialogShell } from "./components/SettingsDialogShell";
import { SettingsModalContent } from "./components/SettingsModalContent";
import { collectSettingsPayload, isProtectedConfigKey } from "./data/config-loader";
import { diffSettingsPayload } from "./data/diff-payload";
import { createSettingsEventHandlers } from "./data/event-handlers";
import {
	getObserverModelDescription as getObserverModelDescriptionRaw,
	getObserverModelHint as getObserverModelHintRaw,
	getObserverModelLabel as getObserverModelLabelRaw,
	getObserverModelTooltip as getObserverModelTooltipRaw,
	getTieredRoutingHelperText as getTieredRoutingHelperTextRaw,
	hiddenUnlessAdvanced as hiddenUnlessAdvancedRaw,
	protectedConfigHelp,
} from "./data/model-accessors";
import { buildSettingsNotice } from "./data/notice";
import { settingsState } from "./data/state";
import {
	hideHelpTooltip,
	onAdvancedToggle,
	setDirty,
	setSettingsTab,
	updateFormState,
	updateRenderState,
} from "./data/state-ops";
import type { SettingsPanelProps } from "./data/types";

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
const hiddenUnlessAdvanced = (): boolean => hiddenUnlessAdvancedRaw(settingsState.showAdvanced);

const { onTextInput, onSelectValueChange, onSwitchInput } = createSettingsEventHandlers({
	getTouchedKeys: () => settingsState.touchedKeys,
	getValues: () => settingsState.renderState.values,
	updateFormState,
	setDirty: (dirty) => setDirty(dirty),
});

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

function SettingsDialogShellBound() {
	return <SettingsDialogShell DialogContent={SettingsDialogContent} onClose={closeSettings} />;
}

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
