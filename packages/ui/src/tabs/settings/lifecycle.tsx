/* Settings modal lifecycle — mounts the Preact dialog shell, wires
 * the public open/close/save/init API, and binds the SettingsDialogShell
 * to SettingsDialogContent + the settingsState-driven handlers. */

import { render } from "preact";
import { openDiagnosticsDrawer } from "../../components/diagnostics";
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
import { settingsState, settingsView } from "./data/state";
import {
	getSettingsViewState,
	hideHelpTooltip,
	onAdvancedToggle,
	setDirty,
	setSettingsOpen,
	setSettingsTab,
	updateFormState,
	updateRenderState,
} from "./data/state-ops";
import type { SettingsPanelProps } from "./data/types";

const getObserverModelHint = (): string =>
	getObserverModelHintRaw(getSettingsViewState().renderState.values, settingsState.envOverrides);
const getTieredRoutingHelperText = (): string =>
	getTieredRoutingHelperTextRaw(getSettingsViewState().renderState.values);
const getObserverModelLabel = (): string =>
	getObserverModelLabelRaw(getSettingsViewState().renderState.values);
const getObserverModelTooltip = (): string =>
	getObserverModelTooltipRaw(getSettingsViewState().renderState.values);
const getObserverModelDescription = (): string =>
	getObserverModelDescriptionRaw(getSettingsViewState().renderState.values);
const hiddenUnlessAdvanced = (): boolean =>
	hiddenUnlessAdvancedRaw(getSettingsViewState().showAdvanced);

const { onTextInput, onSelectValueChange, onSwitchInput } = createSettingsEventHandlers({
	getTouchedKeys: () => settingsState.touchedKeys,
	getValues: () => getSettingsViewState().renderState.values,
	updateFormState,
	setDirty: (dirty) => setDirty(dirty),
});

function ObserverStatusBanner() {
	const status = settingsView.value.renderState.observerStatus as ObserverStatusShape | null;
	return (
		<ObserverStatusBannerComponent
			status={status}
			onOpenDiagnostics={openObserverDiagnosticsFromSettings}
		/>
	);
}

export function openObserverDiagnosticsFromSettings(options: {
	severity: "error";
	subsystem: "observer";
}): void {
	if (!settingsState.startPolling || !settingsState.refresh) return;
	closeSettings(settingsState.startPolling, settingsState.refresh);
	if (getSettingsViewState().open) return;
	const trigger = $button("settingsButton");
	queueMicrotask(() => openDiagnosticsDrawer({ ...options, trigger }));
}

function SettingsDialogContent() {
	const view = settingsView.value;
	const values = view.renderState.values;
	const observerMaxCharsDefault = String(state.configDefaults?.observer_max_chars || "");
	const showAuthFile = values.observerAuthSource === "file";
	const showAuthCommand = values.observerAuthSource === "command";
	const showTieredRouting = values.observerTierRoutingEnabled;
	const providerOptions = Array.from(
		new Set(
			view.renderState.providers.concat(values.observerProvider ? [values.observerProvider] : []),
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
			activeTab={view.activeTab}
			showAdvanced={view.showAdvanced}
			renderState={view.renderState}
			settingsDirty={view.dirty}
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
	setSettingsOpen(true);
	settingsState.previouslyFocused = document.activeElement as HTMLElement | null;
	stopPolling();
}

export function closeSettings(startPolling: () => void, refreshCallback: () => void) {
	if (getSettingsViewState().dirty) {
		if (!globalThis.confirm("Discard unsaved changes?")) {
			setSettingsOpen(true);
			return;
		}
	}
	setSettingsOpen(false);
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
	if (getSettingsViewState().renderState.isSaving) return;
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
